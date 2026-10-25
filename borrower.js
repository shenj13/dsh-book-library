/**
 * 书库 · 导入器
 *
 * 目标：把 EPUB / Markdown / TXT 文件拆成 `books/<ID>/` 结构——chapters/NNN.md
 * 带 [n] 段落锚点、NNN.map.json、index.md、book.json。这个格式是深度阅读插件
 * 定的，照它写，别的工具（包括深度阅读）读起来才不用改。
 *
 * 为什么不用精读插件自己的导入函数：
 * 1. 它的入口 import.js 依赖 `@deepseek-ai/dsh-tools`（只存在于 DSH 应用本体，
 *    profile 里没有），普通 Node 解析不到，import 直接 ERR_MODULE_NOT_FOUND。
 * 2. 它底下的 collect.js 会牵出 `@storyteller-platform/epub` → `@node-rs/crc32`
 *    这个原生模块，本机加载失败（Mach-O 代码签名 Team ID 不匹配），
 *    整个 epub 依赖链是坏的。
 * 所以文本底座（分块、锚点、标题、哈希）抄了一份在本目录的 textkit.js，
 * 解析与拆章全部自己实现：
 *   - EPUB ＝ 系统 unzip 解包 → container.xml → .opf → spine 顺序读 xhtml → 去标签
 *   - MD/TXT ＝ 按一级标题切章，没有标题就整本一章
 * PDF 需要原生/复杂解析链，本版不接，导入时会给出明确提示。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { displayTitle, pad3, rand6, renderChapter, sha256, sha256File, splitBlocks } from './textkit.js'

const SCHEMA_VERSION = 1
const TOOL_NAME = 'dsh-book-library-import'
const TOOL_VERSION = '0.1.0'

/** 只支持这三种：epub（解包）、md、txt。PDF 明确拒绝并提示。 */
export const IMPORTABLE_EXTS = ['.epub', '.md', '.txt', '.markdown']

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 给新书生成一个不重复的目录名（只含字母数字，满足 ID 正则）。 */
export function newBookId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/* ------------------------------ 文本切章 ------------------------------ */

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/
const CHAPTER_LINE_RE = /^(第\s*[0-9０-９一二三四五六七八九十百千零两]+\s*[章回节话篇部卷])[ \t　:：.、]*(.*)$/

/** 从 Markdown/TXT 里切章：优先一级标题，其次「第X章」独立行，最后整本一章。 */
/**
 * 松散章标题：一行以「第」开头、含章/回/节/集/卷/部/篇、且短、不带句末标点。
 * 用来认「第一集 名为生化 第一章 醒来（上）」这类一行包两层序号的老 txt。
 */
function isLooseHeading(line) {
  const s = String(line || '').trim()
  if (s === '' || s.length > 60) return false
  if (/[，。；！？…]/.test(s)) return false
  if (!/^第/.test(s)) return false
  return /[章节回话集卷部篇]/.test(s)
}

export function splitByHeadings(text, fallbackTitle) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')

  // 先判断这本书用什么切：有一级标题就按一级标题；否则按「第X章」行。
  const h1Count = lines.filter((l) => {
    const m = l.match(HEADING_RE)
    return m && m[1].length === 1
  }).length
  const chapterLineCount = lines.filter((l) => CHAPTER_LINE_RE.test(l.trim())).length
  const looseLineCount = lines.filter((l) => isLooseHeading(l.trim())).length
  const mode =
    h1Count >= 2 ? 'h1' : chapterLineCount >= 2 ? 'chapter' : looseLineCount >= 2 ? 'loose' : 'none'

  if (mode === 'none') {
    return [{ title: fallbackTitle, body: lines.join('\n').trim() }]
  }

  const chapters = []
  let title = null
  let buf = []

  const flush = () => {
    const body = buf.join('\n').trim()
    // 开头的书名页 / 版权页通常很短，不单独成一章
    if (title === null && chapters.length === 0 && body.length < 200) {
      buf = []
      return
    }
    if (body !== '' || title !== null) {
      chapters.push({ title: title || '第' + (chapters.length + 1) + '节', body })
    }
    buf = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    let hit = null
    if (mode === 'h1') {
      const m = trimmed.match(HEADING_RE)
      if (m && m[1].length === 1) hit = m[2].trim()
    } else if (mode === 'chapter') {
      const m = trimmed.match(CHAPTER_LINE_RE)
      if (m) hit = (m[1] + (m[2] ? ' ' + m[2] : '')).trim()
    } else if (isLooseHeading(trimmed)) {
      hit = trimmed.replace(/^[#\s]+/, '').trim()
    }
    if (hit !== null) {
      // 封面/版权页之类的前置内容很短，直接并进第一章，不单独成章。
      if (title !== null || buf.join('').trim().length > 0) flush()
      title = hit
    } else {
      buf.push(line)
    }
  }
  flush()

  // 前面那段乱码式的短内容（书名页等）不成章
  const cleaned = chapters.filter((c) => c.body.trim() !== '' || chapters.length === 1)
  return cleaned.length > 0 ? cleaned : [{ title: fallbackTitle, body: String(text).trim() }]
}

/* ------------------------------ EPUB 解析 ------------------------------ */

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
}

function decodeEntities(s) {
  let out = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  out = out.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  out = out.replace(/&[a-zA-Z]+;/g, (m) => ENTITIES[m] || m)
  return out
}

/** XHTML/HTML → 纯文本 Markdown（保留段落分隔，丢掉标签与脚本样式）。 */
function htmlToText(html) {
  let s = String(html)
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '')
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n\n')
  s = s.replace(/<h([1-6])[^>]*>/gi, '\n\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/** 从 html 里取第一个标题，取不到返回 null。 */
function firstHeading(html) {
  const m = String(html).match(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/i)
  if (!m) return null
  const t = htmlToText(m[2]).replace(/\s+/g, ' ').trim()
  return t === '' ? null : t
}

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8')
}

/** 解析 EPUB：返回 {bookTitle, chapters:[{title, body}]}。 */
function parseEpub(file, fallbackTitle) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bl-epub-'))
  try {
    execFileSync('unzip', ['-o', '-qq', file, '-d', tmp], { stdio: 'pipe' })
    const containerPath = path.join(tmp, 'META-INF', 'container.xml')
    if (!fs.existsSync(containerPath)) throw new Error('这个 EPUB 结构不完整（缺 container.xml）')
    const container = readUtf8(containerPath)
    const rootMatch = container.match(/<rootfile[^>]*full-path\s*=\s*"([^"]+)"/i)
    if (!rootMatch) throw new Error('这个 EPUB 里找不到正文清单（.opf）')
    const opfPath = path.join(tmp, decodeURIComponent(rootMatch[1]))
    if (!fs.existsSync(opfPath)) throw new Error('这个 EPUB 的正文清单文件缺失')
    const opf = readUtf8(opfPath)
    const opfDir = path.dirname(opfPath)

    // manifest: id → href
    const manifest = new Map()
    const itemRe = /<item\b[^>]*>/gi
    let im
    while ((im = itemRe.exec(opf)) !== null) {
      const tag = im[0]
      const id = (tag.match(/\bid\s*=\s*"([^"]*)"/i) || [])[1]
      const href = (tag.match(/\bhref\s*=\s*"([^"]*)"/i) || [])[1]
      if (!id || !href) continue
      manifest.set(id, decodeURIComponent(href))
    }

    // spine: 顺序
    const spineMatch = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i)
    if (!spineMatch) throw new Error('这个 EPUB 里找不到阅读顺序（spine）')
    const order = []
    const refRe = /<itemref\b[^>]*>/gi
    let rm
    while ((rm = refRe.exec(spineMatch[1])) !== null) {
      const idref = (rm[0].match(/\bidref\s*=\s*"([^"]*)"/i) || [])[1]
      if (idref && manifest.has(idref)) order.push(manifest.get(idref))
    }
    if (order.length === 0) throw new Error('这个 EPUB 没有可读的正文文件')

    // 书名
    let bookTitle = null
    const titleMatch = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)
    if (titleMatch) {
      const t = decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim()
      if (t !== '') bookTitle = t
    }
    if (!bookTitle) bookTitle = fallbackTitle

    const chapters = []
    for (const href of order) {
      const abs = path.resolve(opfDir, href)
      // 防目录穿越
      if (!abs.startsWith(tmp + path.sep)) continue
      if (!fs.existsSync(abs)) continue
      const raw = readUtf8(abs)
      let body = htmlToText(raw)
      if (body.replace(/\s/g, '').length < 2) continue // 空白页 / 纯图片页
      const h = firstHeading(raw)
      // 正文开头那行标题会重复（章节文件自己会加 # 标题），去掉首行
      if (h) {
        const lines = body.split('\n')
        if (lines[0] && lines[0].replace(/\s+/g, ' ').trim() === h.replace(/\s+/g, ' ').trim()) {
          body = lines.slice(1).join('\n').trim()
        }
      }
      if (body.replace(/\s/g, '').length < 2) continue
      chapters.push({ title: h || '第' + (chapters.length + 1) + '节', body })
    }
    if (chapters.length === 0) throw new Error('这个 EPUB 里没有读到文字（可能是图片版）')
    return { bookTitle, chapters }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* 清不掉就算了 */
    }
  }
}

/* ------------------------------ 主流程 ------------------------------ */

/** 读文件文本：优先 UTF-8，乱码明显时退回 GBK（老中文 txt 常见）。 */
function readTextSmart(file) {
  const buf = fs.readFileSync(file)
  const utf8 = buf.toString('utf8')
  const bad = (utf8.match(/\uFFFD/g) || []).length
  if (bad <= 2) return utf8.replace(/^\uFEFF/, '')
  try {
    const gbk = new TextDecoder('gbk').decode(buf)
    const gbkBad = (gbk.match(/\uFFFD/g) || []).length
    return gbkBad < bad ? gbk : utf8
  } catch {
    return utf8.replace(/^\uFEFF/, '')
  }
}

const TITLE_NOISE_RE = /[（(【\[][^）)】\]]{0,16}(全本|全集|完整版|精校|校对|无错|盗版|正版|txt|TXT|epub|PDF|全集|完结|未删减|手打)[^）)】\]]{0,16}[）)】\]]/g

/** 把「《书名》（精校版全本）」这类脏名字洗干净。 */
export function cleanBookTitle(raw) {
  let t = String(raw || '').trim()
  if (t === '') return ''
  t = t.replace(/\.(txt|md|markdown|epub|pdf)$/i, '')
  t = t.replace(TITLE_NOISE_RE, ' ').trim()
  t = t.replace(/^[《【\[]+/, '').replace(/[》】\]]+$/, '').trim()
  t = t.replace(/[\s_\-—·]+/g, ' ').trim()
  return t
}

/** 名字不像书名：纯数字、纯编号、太短。 */
function looksMeaningless(t) {
  const s = String(t || '').trim()
  if (s === '') return true
  if (/^[0-9０-９\s._\-]+$/.test(s)) return true
  if (/^[a-zA-Z]{1,3}[0-9]{1,8}$/.test(s)) return true
  return s.length < 2
}

/** 从正文前几段里找《书名》。 */
function guessTitleFromBody(text) {
  const lines = String(text || '').split('\n').slice(0, 400)
  for (const line of lines) {
    const m = line.match(/《([^》\n]{2,30})》/)
    if (m) {
      const t = cleanBookTitle(m[1])
      if (!looksMeaningless(t)) return t
    }
  }
  return ''
}

function titleFromFileName(p) {
  const base = path.basename(p)
  const ext = path.extname(base)
  const raw = base.slice(0, base.length - ext.length).trim()
  const cleaned = cleanBookTitle(raw)
  return cleaned === '' ? raw : cleaned
}

/** 解析源文件 → {bookTitle, sourceType, chapters}。 */
export function parseSource(absSrc, titleHint) {
  const ext = path.extname(absSrc).toLowerCase()
  const fallbackTitle = String(titleHint || '').trim() || titleFromFileName(absSrc)
  if (ext === '.epub') {
    const r = parseEpub(absSrc, fallbackTitle)
    return { bookTitle: r.bookTitle, sourceType: 'epub', chapters: r.chapters }
  }
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    const text = readTextSmart(absSrc)
    if (text.trim() === '') throw new Error('这个文件是空的')
    // 文件名不像书名（纯编号之类）时，从正文里的《书名》认一个
    let bookTitle = fallbackTitle
    if (looksMeaningless(bookTitle)) {
      const guessed = guessTitleFromBody(text)
      if (guessed) bookTitle = guessed
    }
    return {
      bookTitle: bookTitle,
      sourceType: ext === '.txt' ? 'txt' : 'md',
      chapters: splitByHeadings(text, bookTitle),
    }
  }
  if (ext === '.pdf') {
    throw new Error('PDF 这一版还导不了')
  }
  throw new Error('这个格式导不了：' + (ext || '没有扩展名'))
}

/**
 * 导入一本书：解析 → 分块加锚点 → 写 books/<ID>/。
 * 返回 {ok:true, id, title, chapterCount, chapters:[...]}。
 */
export async function importBook({ src, id, title, booksRoot, force = false }) {

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(id || ''))) throw new Error('书籍编号不合法')
  const absSrc = path.resolve(String(src || ''))
  if (!fs.existsSync(absSrc)) throw new Error('要导入的文件不存在')

  const parsed = parseSource(absSrc, title)
  const chapters = parsed.chapters
  if (chapters.length === 0) throw new Error('这个文件里没有读出内容')

  const bookTitle = parsed.bookTitle || titleFromFileName(absSrc)
  const sourceSha = sha256File(absSrc)
  const sourceInfo = { type: parsed.sourceType, path: absSrc, sha256: sourceSha }

  const bookDir = path.join(booksRoot, String(id))
  if (fs.existsSync(bookDir) && !force) throw new Error('书库里已经有这本书了')

  fs.mkdirSync(booksRoot, { recursive: true })
  const tmpDir = path.join(booksRoot, '.import-' + id + '-' + rand6())
  fs.mkdirSync(path.join(tmpDir, 'chapters'), { recursive: true })

  const chaptersMeta = []
  for (let i = 0; i < chapters.length; i++) {
    const n = i + 1
    const ch = chapters[i]
    const blocks = splitBlocks(ch.body)
    const { text } = renderChapter(n, ch.title, blocks)
    const file = 'chapters/' + pad3(n) + '.md'
    fs.writeFileSync(path.join(tmpDir, file), text, 'utf8')

    const map = {
      schemaVersion: SCHEMA_VERSION,
      book: id,
      chapter: n,
      source: { file: path.basename(absSrc), type: parsed.sourceType },
      paras: blocks.map((b, bi) => ({ n: bi + 1, blockIndex: bi, chars: b.length, head: b.slice(0, 30) })),
    }
    fs.writeFileSync(path.join(tmpDir, 'chapters', pad3(n) + '.map.json'), JSON.stringify(map, null, 2) + '\n', 'utf8')

    chaptersMeta.push({
      n,
      title: ch.title,
      file,
      sha256: sha256(Buffer.from(text, 'utf8')),
      paras: blocks.length,
      chars: text.length,
      state: 'unanalyzed',
      memory: null,
    })
  }

  const importedAt = new Date().toISOString()
  const indexLines = [
    '# 《' + bookTitle + '》目录',
    '',
    '- 来源：' + sourceInfo.type,
    '- 导入：' + importedAt,
    '- 章节数：' + chaptersMeta.length,
    '',
    '## 章节',
    '',
    ...chaptersMeta.map(
      (c) =>
        '- ' + pad3(c.n) + ' ' + displayTitle(c.n, c.title) + ' — ' + c.paras + ' 段 · ' + c.chars + ' 字符 · 未分析',
    ),
    '',
  ]
  fs.writeFileSync(path.join(tmpDir, 'index.md'), indexLines.join('\n'), 'utf8')

  // book.json 最后写：它出现＝这本书建完了。
  const bookJson = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title: bookTitle,
    source: sourceInfo,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    importedAt,
    chapters: chaptersMeta,
  }
  fs.writeFileSync(path.join(tmpDir, 'book.json'), JSON.stringify(bookJson, null, 2) + '\n', 'utf8')

  if (fs.existsSync(bookDir)) {
    const oldDir = path.join(booksRoot, '.old-' + id + '-' + rand6())
    fs.renameSync(bookDir, oldDir)
    try {
      fs.renameSync(tmpDir, bookDir)
    } catch (e) {
      fs.renameSync(oldDir, bookDir)
      fs.rmSync(tmpDir, { recursive: true, force: true })
      throw e
    }
    fs.rmSync(oldDir, { recursive: true, force: true })
  } else {
    fs.renameSync(tmpDir, bookDir)
  }

  return {
    ok: true,
    id,
    title: bookTitle,
    bookDir,
    chapterCount: chaptersMeta.length,
    chapters: chaptersMeta.map((c) => pad3(c.n) + ' ' + displayTitle(c.n, c.title)),
  }
}
