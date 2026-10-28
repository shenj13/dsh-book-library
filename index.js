/**
 * 书库 · Host 半体
 *
 * 把精读插件存在磁盘上的书库整理成面板能用的形状，并提供三个能力：
 *   1. 看书架（每本读了几章）
 *   2. 导入新书（面板选文件 → 拆章）
 *   3. 听讲解（把一章讲解用豆包的声音念出来，边合成边播）
 *
 * 书库布局（与 dsh-deep-reading 共用）：
 *   books/<ID>/book.json                     ← 书名、章节目录（存在即表示导入完成）
 *   books/<ID>/chapters/NNN.md               ← 第 N 章正文
 *   books/<ID>/lecture/NNN.md                ← 第 N 章讲解稿（有＝这章精读过）
 *   books/<ID>/lecture/NNN.mp3               ← 讲解的语音版（合成一次就存着，不重复花钱）
 *   books/<ID>/memory/NNN.md                 ← 第 N 章记忆（有＝这章精读过）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { IMPORTABLE_EXTS, importBook, newBookId } from './borrower.js';
import {
  EMOTIONS,
  SOURCES,
  SYSTEM_VOICES,
  VOICES,
  cleanForSpeech,
  loadVoiceConfig,
  saveVoiceConfig,
  streamChapter,
  synthesizeProbe,
  synthesizeSystem,
  stripToneMarks,
} from './tts.js';
import { answerStream, consultStream, lectureStream, resolveLlm, resolveModel } from './tutor.js';

export const ROUTE_BOOKS = '/dsh-book-library/books';
export const ROUTE_IMPORT = '/dsh-book-library/import';
export const ROUTE_CHAPTER = '/dsh-book-library/chapter';
export const ROUTE_TTS = '/dsh-book-library/tts';
export const ROUTE_VOICE = '/dsh-book-library/voice';
export const ROUTE_PROBE = '/dsh-book-library/voice/probe';
export const ROUTE_LECTURE = '/dsh-book-library/lecture';
export const ROUTE_ASK = '/dsh-book-library/ask';
export const ROUTE_CONSULT = '/dsh-book-library/consult';
export const ROUTE_CONSULT_HISTORY = '/dsh-book-library/consult/history';
export const ROUTE_CONSULT_EXPORT = '/dsh-book-library/consult/export';
export const ROUTE_RENAME = '/dsh-book-library/rename';
export const ROUTE_DELETE = '/dsh-book-library/delete';
export const ROUTE_PREFERENCE = '/dsh-book-library/preference';
export const ROUTE_EXPORT = '/dsh-book-library/export';

const PLUGIN_VERSION = '1.28.8';

/** 上传体积上限：200 MB。一本电子书远到不了这么大，超了直接拒。 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** 语音设置这类小 JSON 的上限。 */
const MAX_JSON_BYTES = 64 * 1024;

/** 能导的源：EPUB / Markdown / TXT（PDF 这一版不接）。 */
const ALLOWED_EXTS = new Set(IMPORTABLE_EXTS);

export const BOOKS_ROOT =
  process.env.DSH_BOOK_LIBRARY_ROOT && String(process.env.DSH_BOOK_LIBRARY_ROOT).trim() !== ''
    ? path.resolve(String(process.env.DSH_BOOK_LIBRARY_ROOT).trim())
    : path.join(
        process.env.DSH_HOME && String(process.env.DSH_HOME).trim() !== ''
          ? String(process.env.DSH_HOME).trim()
          : path.join(os.homedir(), '.dsh'),
        'deep-reading',
        'books',
      );

/** 插件自己的配置目录（语音设置、阅读偏好都放这儿，跟着 DSH 走）。 */
export const CONFIG_ROOT = path.join(
  process.env.DSH_HOME && String(process.env.DSH_HOME).trim() !== ''
    ? String(process.env.DSH_HOME).trim()
    : path.join(os.homedir(), '.dsh'),
  'book-library',
);

/** 读者要我怎么讲：全库通用的一份偏好，讲解和答疑都会带上。 */
export const PREFERENCE_FILE = path.join(CONFIG_ROOT, 'preference.md');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function isCrossSite(headers) {
  return String((headers && headers['sec-fetch-site']) || '').toLowerCase() === 'cross-site';
}

/** 书 id 只允许常规字符，并确认目录里真有 book.json —— 挡掉 ../ 这类路径花招。 */
function resolveBookDir(bookId) {
  const raw = String(bookId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw)) return null;
  const dir = path.join(BOOKS_ROOT, raw);
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  if (!fs.existsSync(path.join(dir, 'book.json'))) return null;
  return dir;
}

/** 读一个 md 章节文件；读不到返回空串。 */
function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 取文件修改时间，取不到当 0（等于「当作很旧」）。 */
function statMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 从讲解稿里抠一句话小结：跳过标题，取第一段有内容的。 */
function pickSummary(markdown) {
  const lines = stripToneMarks(markdown).split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    return t.replace(/\*\*|`/g, '').slice(0, 120);
  }
  return '';
}

/* ---------- 导入：把面板选中的文件交给内置拆章器 ---------- */

/** 把上传的二进制读进内存，超限直接中断。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('文件太大（超过 200 MB）'));
        try {
          req.destroy();
        } catch {
          /* 已断开 */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(new Error('文件没传完：' + ((err && err.message) || String(err)))));
  });
}

/** 处理 POST：收文件 → 落临时文件 → 拆章 → 清临时文件。 */
async function handleImport(req, res, headers) {
  const rawName = String((headers && headers['x-file-name']) || '');
  let fileName = '';
  try {
    fileName = decodeURIComponent(rawName);
  } catch {
    fileName = rawName;
  }
  if (fileName === '') fileName = 'upload.bin';

  const ext = path.extname(fileName).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    sendJson(res, 200, {
      ok: false,
      error: '这个格式读不了：' + (ext || '没有扩展名'),
      hint: '能导的是 EPUB / TXT / Markdown 三种；PDF 这一版还导不了。',
    });
    return;
  }

  const tmpDir = path.join(os.tmpdir(), 'dsh-book-library-upload');
  const id = newBookId();
  const tmpFile = path.join(tmpDir, id + ext);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const buffer = await readBody(req, MAX_UPLOAD_BYTES);
    if (buffer.length === 0) throw new Error('没收到文件内容');
    fs.writeFileSync(tmpFile, buffer);

    const title = fileName.slice(0, fileName.length - ext.length).trim() || fileName;
    const result = await importBook({ src: tmpFile, id, title, booksRoot: BOOKS_ROOT });

    if (result && result.ok) {
      sendJson(res, 200, {
        ok: true,
        id: result.id,
        title: result.title,
        chapterCount: result.chapterCount,
        skipped: false,
      });
      return;
    }
    sendJson(res, 200, {
      ok: false,
      error: (result && result.error) || '导入没有完成',
      hint: (result && result.hint) || '',
    });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err && err.message) || String(err), hint: '' });
  } finally {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
  }
}

/* ---------- 一章的正文与讲解 ---------- */

/* 把章节文件（# 标题 + [n] 段落）还原成给人读的正文 */
const MAX_CHAPTER_TEXT = 300 * 1024;
function chapterTextOf(raw) {
  if (!raw) return '';
  const lines = String(raw).split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i < lines.length && lines[i].trim().startsWith('#')) lines.splice(i, 1);
  let body = lines
    .join('\n')
    .replace(/^\[(\d+)\]\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (body.length > MAX_CHAPTER_TEXT) {
    body = body.slice(0, MAX_CHAPTER_TEXT) + '\n\n……（这一章太长，先显示到这儿）';
  }
  return body;
}

function chapterSegmentsOf(raw) {
  if (!raw) return [];
  const lines = String(raw).split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i < lines.length && lines[i].trim().startsWith('#')) lines.splice(i, 1);
  const segs = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const text = String(cur.text || '').replace(/[ \t]+$/gm, '').trim();
    if (text) segs.push({ n: cur.n, text });
    cur = null;
  };
  for (const line of lines) {
    const hit = /^\[(\d+)\]\s?([\s\S]*)$/.exec(line);
    if (hit) {
      flush();
      cur = { n: Number(hit[1]), text: hit[2] };
    } else if (cur) {
      cur.text += '\n' + line;
    } else if (line.trim()) {
      cur = { n: segs.length + 1, text: line };
    }
  }
  flush();
  const out = [];
  let total = 0;
  for (const seg of segs) {
    total += seg.text.length;
    if (total > MAX_CHAPTER_TEXT) {
      out.push({ n: 0, text: '……（这一章太长，先显示到这儿）' });
      break;
    }
    out.push(seg);
  }
  return out;
}

async function handleChapter(req, res) {
  const url = new URL(String(req.url || '/'), 'http://localhost');
  const bookId = url.searchParams.get('bookId') || '';
  const n = Number(url.searchParams.get('n') || '0');
  if (!Number.isFinite(n) || n <= 0) {
    sendJson(res, 200, { ok: false, error: '章节号不对' });
    return;
  }
  const bookDir = resolveBookDir(bookId);
  if (!bookDir) {
    sendJson(res, 200, { ok: false, error: '找不到这本书' });
    return;
  }
  lastActive = { bookId: bookId, n: n };

  const lecture = readTextFile(path.join(bookDir, 'lecture', pad3(n) + '.md'));
  const memory = readTextFile(path.join(bookDir, 'memory', pad3(n) + '.md'));
  const rawChapter = readTextFile(path.join(bookDir, 'chapters', pad3(n) + '.md'));

  // 章节标题取正文第一行的 # 标题
  let title = '';
  const firstLine = rawChapter.split('\n').find((l) => l.trim().startsWith('#')) || '';
  if (firstLine) title = firstLine.replace(/^#+\s*/, '').trim();

  sendJson(res, 200, {
    ok: true,
    bookId,
    n,
    title,
    summary: pickSummary(lecture),
    lecture,
    memory,
    text: chapterTextOf(rawChapter),
    segments: chapterSegmentsOf(rawChapter),
    hasLecture: lecture !== '',
    hasMemory: memory !== '',
    hasAudio: fs.existsSync(path.join(bookDir, 'lecture', pad3(n) + '.mp3')),
  });
}

/* ---------- 念出来听 ---------- */

async function handleTts(req, res) {
  const url = new URL(String(req.url || '/'), 'http://localhost');
  const bookId = url.searchParams.get('bookId') || '';
  const n = Number(url.searchParams.get('n') || '0');
  const force = url.searchParams.get('force') === '1';
  if (!Number.isFinite(n) || n <= 0) {
    sendJson(res, 200, { ok: false, error: '章节号不对' });
    return;
  }
  const bookDir = resolveBookDir(bookId);
  if (!bookDir) {
    sendJson(res, 200, { ok: false, error: '找不到这本书' });
    return;
  }
  // source=text 时念原文（章节正文），否则念讲解稿
  const isText = url.searchParams.get('source') === 'text';
  const lectureFile = isText
    ? path.join(bookDir, 'chapters', pad3(n) + '.md')
    : path.join(bookDir, 'lecture', pad3(n) + '.md');
  if (!fs.existsSync(lectureFile)) {
    sendJson(res, 200, {
      ok: false,
      error: isText ? '这一章没有正文可以念' : '这一章还没有讲解，先让我读一遍再听',
    });
    return;
  }
  const text = isText
    ? chapterTextOf(readTextFile(lectureFile))
    : cleanForSpeech(readTextFile(lectureFile));
  if (!text) {
    sendJson(res, 200, { ok: false, error: isText ? '这一章的正文是空的' : '这一章的讲解是空的' });
    return;
  }

  const cfgNow = loadVoiceConfig();
  if (cfgNow.source === 'system') {
    const audioDir = isText ? path.join(bookDir, 'audio-text') : path.join(bookDir, 'lecture');
    try {
      fs.mkdirSync(audioDir, { recursive: true });
    } catch {
      /* 已存在 */
    }
    const m4a = path.join(audioDir, pad3(n) + '.m4a');
    const lectureMtime = statMtimeMs(lectureFile);
    if (!force) {
      try {
        const st = fs.statSync(m4a);
        const fresh =
          (Number(cfgNow.updatedAt || 0) <= 0 || st.mtimeMs >= Number(cfgNow.updatedAt || 0)) &&
          st.mtimeMs >= lectureMtime;
        if (st.size > 1024 && fresh) {
          res.statusCode = 200;
          res.setHeader('content-type', 'audio/mp4');
          res.setHeader('content-length', String(st.size));
          res.setHeader('cache-control', 'no-store');
          res.setHeader('x-book-library-cache', 'hit');
          fs.createReadStream(m4a).pipe(res);
          return;
        }
      } catch {
        /* 没缓存，往下合成 */
      }
    }
    try {
      synthesizeSystem({ text, outFile: m4a, voice: cfgNow.systemVoice, rate: cfgNow.rate });
      const st = fs.statSync(m4a);
      res.statusCode = 200;
      res.setHeader('content-type', 'audio/mp4');
      res.setHeader('content-length', String(st.size));
      res.setHeader('cache-control', 'no-store');
      fs.createReadStream(m4a).pipe(res);
    } catch (err) {
      sendJson(res, 200, { ok: false, error: (err && err.message) || String(err), hint: '面板设置里换个音色再试' });
    }
    return;
  }

  const mp3Dir = isText ? path.join(bookDir, 'audio-text') : path.join(bookDir, 'lecture');
  try {
    fs.mkdirSync(mp3Dir, { recursive: true });
  } catch {
    /* 已存在 */
  }
  const mp3 = path.join(mp3Dir, pad3(n) + '.mp3');
  // 改过音色、语速，或者这一章重讲过，旧 mp3 就该作废重新合成
  const voiceUpdatedAt = Number(loadVoiceConfig().updatedAt || 0);
  const mp3LectureMtime = statMtimeMs(lectureFile);
  if (!force) {
    try {
      const st = fs.statSync(mp3);
      const fresh =
        (voiceUpdatedAt <= 0 || st.mtimeMs >= voiceUpdatedAt) && st.mtimeMs >= mp3LectureMtime;
      if (st.size > 1024 && fresh) {
        res.statusCode = 200;
        res.setHeader('content-type', 'audio/mpeg');
        res.setHeader('content-length', String(st.size));
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-book-library-cache', 'hit');
        fs.createReadStream(mp3).pipe(res);
        return;
      }
    } catch {
      /* 没缓存，往下走 */
    }
  }

  try {
    const bytes = await streamChapter({ res, text, cacheFile: mp3 });
    if (!res.headersSent) sendJson(res, 200, { ok: false, error: '没有合成出音频' });
    else res.end();
    return bytes;
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 200, { ok: false, error: (err && err.message) || String(err), hint: '面板里可以换音色或稍后再试' });
      return;
    }
    try {
      res.end();
    } catch {
      /* 连接可能已经断了 */
    }
  }
}

/* ---------- 语音设置 ---------- */

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error('设置内容太大'));
        try {
          req.destroy();
        } catch {
          /* 已断开 */
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('设置内容不是合法 JSON'));
      }
    });
    req.on('error', (err) => reject(new Error((err && err.message) || '读取失败')));
  });
}

function voicePayload() {
  const cfg = loadVoiceConfig();
  return {
    ok: true,
    provider: cfg.provider,
    source: cfg.source,
    voice: cfg.voice,
    systemVoice: cfg.systemVoice,
    rate: cfg.rate,
    loudness: cfg.loudness,
    emotion: cfg.emotion,
    sampleRate: cfg.sampleRate,
    cluster: cfg.cluster,
    hasKey: cfg.hasKey,
    hasAppId: Boolean(cfg.appId),
    updatedAt: cfg.updatedAt,
    voices: VOICES,
    sources: SOURCES,
    systemVoices: SYSTEM_VOICES,
    emotions: EMOTIONS,
    sampleRates: [16000, 24000, 48000],
  };
}

async function handleVoice(req, res) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    try {
      sendJson(res, 200, voicePayload());
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err && err.message) || String(err) });
    }
    return;
  }
  if (method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }
  try {
    const patch = await readJsonBody(req);
    saveVoiceConfig(patch);
    sendJson(res, 200, voicePayload());
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
  }
}

async function handleProbe(req, res) {
  try {
    const patch = await readJsonBody(req);
    const text =
      typeof patch.text === 'string' && patch.text.trim()
        ? patch.text.trim()
        : '这一段是我念给你听的效果，语速和音色都可以调。';
    const cfgProbe = loadVoiceConfig();
    const wantSystem = patch.source === 'system' || (patch.source === undefined && cfgProbe.source === 'system');
    if (wantSystem) {
      const outFile = path.join(os.tmpdir(), 'bl-probe-' + Date.now() + '.m4a');
      try {
        synthesizeSystem({
          text,
          outFile,
          voice: (typeof patch.systemVoice === 'string' && patch.systemVoice) || cfgProbe.systemVoice,
          rate: patch.rate !== undefined ? patch.rate : cfgProbe.rate,
        });
        const buf = fs.readFileSync(outFile);
        res.statusCode = 200;
        res.setHeader('content-type', 'audio/mp4');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-length', String(buf.length));
        res.end(buf);
      } finally {
        try {
          fs.rmSync(outFile, { force: true });
        } catch {
          /* 清不掉就算了 */
        }
      }
      return;
    }
    const buf = await synthesizeProbe(text, {
      voice: typeof patch.voice === 'string' ? patch.voice : undefined,
      rate: patch.rate !== undefined ? patch.rate : undefined,
      loudness: patch.loudness !== undefined ? patch.loudness : undefined,
      emotion: typeof patch.emotion === 'string' ? patch.emotion : undefined,
      sampleRate: patch.sampleRate !== undefined ? patch.sampleRate : undefined,
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'audio/mpeg');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-length', String(buf.length));
    res.end(buf);
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
  }
}

/* ---------- 书架 ---------- */

/** 目录里的 NNN.md 编号集合；目录不存在就返回空。 */
function listChapterNums(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const nums = [];
  for (const name of names) {
    const m = /^(\d{3})\.md$/.exec(name);
    if (m) nums.push(Number(m[1]));
  }
  return nums;
}

function safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 把一本书的目录读成面板要的结构；没有 book.json 就当没导完，忽略。 */
function readOneBook(dirName) {
  const dir = path.join(BOOKS_ROOT, dirName);
  const meta = safeJson(path.join(dir, 'book.json'));
  if (!meta || typeof meta !== 'object') return null;

  const lectureNums = new Set(listChapterNums(path.join(dir, 'lecture')));
  const memoryNums = new Set(listChapterNums(path.join(dir, 'memory')));
  const chapterFileNums = new Set(listChapterNums(path.join(dir, 'chapters')));

  const rawChapters = Array.isArray(meta.chapters) ? meta.chapters : [];
  const chapters = rawChapters
    .map((c) => {
      const n = Number(c && c.n);
      if (!Number.isFinite(n)) return null;
      const hasLecture = lectureNums.has(n);
      const hasMemory = memoryNums.has(n);
      return {
        n,
        title: typeof (c && c.title) === 'string' ? c.title : '',
        hasLecture,
        hasMemory,
        imported: chapterFileNums.has(n) || rawChapters.length > 0,
        // 讲解或记忆任一存在即视为读过
        read: hasLecture || hasMemory,
        // 讲解已经配了语音
        hasAudio: hasLecture && fs.existsSync(path.join(dir, 'lecture', pad3(n) + '.mp3')),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);

  const readCount = chapters.filter((c) => c.read).length;
  const next = chapters.find((c) => !c.read) || null;

  let updatedAt = 0;
  try {
    updatedAt = Math.max(
      fs.statSync(dir).mtimeMs || 0,
      fs.existsSync(path.join(dir, 'book.json')) ? fs.statSync(path.join(dir, 'book.json')).mtimeMs || 0 : 0,
    );
  } catch {
    /* 时间读不到不影响使用 */
  }

  return {
    id: String(meta.id || dirName),
    title:
      (typeof meta.title === 'string' && meta.title.trim()) ||
      (typeof meta.bookTitle === 'string' && meta.bookTitle.trim()) ||
      (typeof meta.name === 'string' && meta.name.trim()) ||
      dirName,
    author: typeof meta.author === 'string' ? meta.author : '',
    importedAt: typeof meta.importedAt === 'string' ? meta.importedAt : '',
    updatedAt,
    chapterCount: chapters.length,
    readCount,
    next: next ? { n: next.n, title: next.title } : null,
    chapters,
  };
}

export function collectBooks() {
  let entries;
  try {
    entries = fs.readdirSync(BOOKS_ROOT, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const books = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 导入中途的临时目录（.tmp- / .old-）不上架
    if (entry.name.startsWith('.')) continue;
    if (entry.name.includes('.bak-')) continue;
    const book = readOneBook(entry.name);
    if (book) books.push(book);
  }
  books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { booksRoot: BOOKS_ROOT, books };
}

/* ---------- 讲这一章 / 举手提问 ---------- */

/** apply 时挂上，好让讲台拿得到 llm 与默认模型。 */
let hostCtx = null;
/** 面板最近一次打开的「书 + 章」，工具写讲解时没指定目标就用它。 */
let lastActive = { bookId: '', n: 0 };

/** 边生成边往下送，所以用 NDJSON：一行一个事件。 */
function ndjson(res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-store, no-transform');
  res.setHeader('x-accel-buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function emit(res, payload) {
  if (res.writableEnded) return;
  try {
    res.write(JSON.stringify(payload) + '\n');
  } catch {
    /* 面板那边可能已经关了 */
  }
}

function bookTitleOf(bookDir) {
  const book = safeJson(path.join(bookDir, 'book.json')) || {};
  const title = String(book.title || book.bookTitle || book.name || '').trim();
  return title || path.basename(bookDir);
}

/* 全书章节标题清单，给讲解当「这一章在书里什么位置」的参照 */
function bookCatalogOf(bookDir) {
  const meta = safeJson(path.join(bookDir, 'book.json'));
  const chapters = meta && Array.isArray(meta.chapters) ? meta.chapters : [];
  const lines = chapters
    .slice(0, 80)
    .map((c) => `${c && c.n ? c.n : '?'}. ${String((c && c.title) || '').slice(0, 60)}`);
  return lines.join('\n');
}

function chapterTitleOf(text) {
  const first = String(text || '').split('\n').find((l) => l.trim().startsWith('#')) || '';
  return first ? first.replace(/^#+\s*/, '').trim() : '';
}

/** 这个人自己写的阅读偏好，讲的时候带上。 */
function readerPreferenceOf(bookDir) {
  const own = readTextFile(PREFERENCE_FILE);
  if (own && String(own).trim()) return String(own).trim().slice(0, 900);
  const raw = readTextFile(path.join(bookDir, 'reader.md'));
  if (!raw) return '';
  return raw
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .join('\n')
    .trim();
}

/** 上一章讲了什么，接着讲别断片。 */
/* 最近两章已经讲过的内容：让讲解能接上前文，形成累积理解而不是每章从头讲 */
function previousLectureOf(bookDir, n) {
  const parts = [];
  for (const back of [2, 1]) {
    const k = n - back;
    if (k <= 0) continue;
    const prev = readTextFile(path.join(bookDir, 'lecture', pad3(k) + '.md'));
    if (!prev) continue;
    const body = prev
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .join('\n')
      .trim();
    if (body) parts.push(`第 ${k} 章：\n${body.slice(0, 520)}`);
  }
  return parts.join('\n\n');
}

function normalizeLecture(text, n, chapterTitle) {
  const body = String(text || '').trim();
  if (!body) return '';
  const heading = `# 第 ${n} 章${chapterTitle ? ` · ${chapterTitle}` : ''}`;
  const stripped = body.replace(/^#[^\n]*\n+/, '');
  return `${heading}\n\n${stripped}\n`;
}

function writeLectureFile(bookDir, n, text) {
  const dir = path.join(bookDir, 'lecture');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, pad3(n) + '.md'), text, 'utf8');
}

/**
 * 章节记忆：这一章到底理解了什么，留档备查。
 * 不是给模型看的摘要，是给人看的一章账：什么时候讲的、引了哪些段、三段式全文。
 */
function writeMemoryFile(bookDir, n, chapterTitle, lectureText) {
  const dir = path.join(bookDir, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const segs = [];
  const seen = new Set();
  for (const m of String(lectureText || '').matchAll(/\[(\d+)\]/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0 && !seen.has(v)) {
      seen.add(v);
      segs.push(v);
    }
  }
  segs.sort((a, b) => a - b);
  const head = [
    `# 第 ${n} 章${chapterTitle ? ' · ' + chapterTitle : ''}`,
    '',
    `- 讲于：${new Date().toISOString()}`,
    `- 引用原文段落：${segs.length ? segs.join('、') : '（没有引用段号）'}`,
    `- 三段：这一段到底理解了什么 / 我的看法 / 给你的建议`,
    '',
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, pad3(n) + '.md'), head + String(lectureText || '').trim() + '\n', 'utf8');
}

/** 面板关掉就停手，别让模型一直空转。 */
function abortOnClose(req, res) {
  const controller = new AbortController();
  const stop = () => {
    try {
      controller.abort();
    } catch {
      /* 已经停了 */
    }
  };
  req.on?.('aborted', stop);
  res.on?.('close', stop);
  return controller;
}

async function handleLecture(req, res) {
  const body = await readJsonBody(req);
  const bookId = String((body && body.bookId) || '');
  const n = Number((body && body.n) || 0);
  const regenerate = !!(body && body.regenerate);
  if (!Number.isFinite(n) || n <= 0) {
    sendJson(res, 200, { ok: false, error: '章节号不对' });
    return;
  }
  const bookDir = resolveBookDir(bookId);
  if (!bookDir) {
    sendJson(res, 200, { ok: false, error: '找不到这本书' });
    return;
  }
  lastActive = { bookId: bookId, n: n };

  const lectureFile = path.join(bookDir, 'lecture', pad3(n) + '.md');
  const chapterText = readTextFile(path.join(bookDir, 'chapters', pad3(n) + '.md'));
  const chapterTitle = chapterTitleOf(chapterText);
  const existing = readTextFile(lectureFile);

  // 已经有了就不重复花钱：直接把现成的送回去
  if (!regenerate && existing.trim()) {
    ndjson(res);
    emit(res, { type: 'start', n, chapterTitle, cached: true });
    emit(res, { type: 'done', text: existing, chars: existing.length, cached: true, saved: true });
    res.end();
    return;
  }
  if (!chapterText.trim()) {
    sendJson(res, 200, { ok: false, error: '这一章的正文是空的' });
    return;
  }

  let llm;
  let target;
  try {
    llm = resolveLlm(hostCtx);
    target = resolveModel(hostCtx);
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
    return;
  }

  ndjson(res);
  emit(res, { type: 'start', n, chapterTitle, cached: false });
  const controller = abortOnClose(req, res);
  let text = '';
  try {
    for await (const delta of lectureStream({
      llm,
      target,
      bookTitle: bookTitleOf(bookDir),
      chapterNo: n,
      chapterTitle,
      chapterText,
      preference: readerPreferenceOf(bookDir),
      previous: previousLectureOf(bookDir, n),
      catalog: bookCatalogOf(bookDir),
      signal: controller.signal,
    })) {
      text += delta;
      emit(res, { type: 'delta', text: delta });
    }
  } catch (err) {
    emit(res, { type: 'error', message: (err && err.message) || String(err) });
    res.end();
    return;
  }

  const finalText = normalizeLecture(text, n, chapterTitle);
  let saved = false;
  if (finalText) {
    try {
      writeLectureFile(bookDir, n, finalText);
      writeMemoryFile(bookDir, n, chapterTitle, finalText);
      saved = true;
    } catch {
      /* 写不进去也不影响这次听，只是下次得重讲 */
    }
  }
  emit(res, { type: 'done', text: finalText, chars: finalText.length, saved });
  res.end();
}

async function handleAsk(req, res) {
  const body = await readJsonBody(req);
  const bookId = String((body && body.bookId) || '');
  const n = Number((body && body.n) || 0);
  const question = String((body && body.question) || '').trim();
  if (!question) {
    sendJson(res, 200, { ok: false, error: '还没写问题' });
    return;
  }
  if (!Number.isFinite(n) || n <= 0) {
    sendJson(res, 200, { ok: false, error: '章节号不对' });
    return;
  }
  const bookDir = resolveBookDir(bookId);
  if (!bookDir) {
    sendJson(res, 200, { ok: false, error: '找不到这本书' });
    return;
  }
  const chapterText = readTextFile(path.join(bookDir, 'chapters', pad3(n) + '.md'));
  if (!chapterText.trim()) {
    sendJson(res, 200, { ok: false, error: '这一章的正文是空的' });
    return;
  }

  let llm;
  let target;
  try {
    llm = resolveLlm(hostCtx);
    target = resolveModel(hostCtx);
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
    return;
  }

  ndjson(res);
  emit(res, { type: 'start', n });
  const controller = abortOnClose(req, res);
  let text = '';
  try {
    for await (const delta of answerStream({
      llm,
      target,
      bookTitle: bookTitleOf(bookDir),
      chapterNo: n,
      chapterTitle: chapterTitleOf(chapterText),
      chapterText,
      lectureText: readTextFile(path.join(bookDir, 'lecture', pad3(n) + '.md')),
      question,
      signal: controller.signal,
    })) {
      text += delta;
      emit(res, { type: 'delta', text: delta });
    }
  } catch (err) {
    emit(res, { type: 'error', message: (err && err.message) || String(err) });
    res.end();
    return;
  }
  if (bookId) saveConsultEntry(bookId, question, text);
  emit(res, { type: 'done', text: text.trim(), chars: text.trim().length });
  res.end();
}
/* ---------- 答疑留档 ---------- */

/** 每本书的问答各存一份，换书翻回自己那本的历史。 */
const CONSULT_DIR = path.join(BOOKS_ROOT, 'consult');

function consultFileOf(bookId) {
  const raw = String(bookId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return '';
  return path.join(CONSULT_DIR, raw + '.json');
}

function loadConsultHistory(bookId) {
  const file = consultFileOf(bookId);
  if (!file || !fs.existsSync(file)) return [];
  try {
    const got = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(got) ? got : [];
  } catch {
    return [];
  }
}

function saveConsultEntry(bookId, question, answer) {
  const file = consultFileOf(bookId);
  if (!file) return;
  const one = String(answer || '').trim();
  if (!one) return;
  try {
    fs.mkdirSync(CONSULT_DIR, { recursive: true });
    let list = loadConsultHistory(bookId);
    list.push({ q: String(question || '').slice(0, 2000), a: one, at: new Date().toISOString() });
    if (list.length > 200) list = list.slice(list.length - 200);
    fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n', 'utf8');
  } catch {
    /* 存不下也不影响这次回答 */
  }
}

async function handleConsultHistory(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const bookId = String(url.searchParams.get('bookId') || '');
  const items = loadConsultHistory(bookId).map((it) => ({ q: it.q, a: it.a, at: it.at }));
  sendJson(res, 200, { ok: true, items });
}

/** 能直接把网页打印成 PDF 的浏览器（macOS 常见位置，按顺序探）。 */
const CONSULT_PDF_BROWSERS = [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

function pdfBrowserPath() {
  for (const one of CONSULT_PDF_BROWSERS) {
    try {
      if (fs.existsSync(one)) return one;
    } catch {
      /* 探不到就试下一个 */
    }
  }
  return '';
}

/** 把问答拼成一份 A4 打印页。 */
function consultPrintHtml(bookTitle, pairs) {
  const rows = pairs
    .map(
      (p, i) =>
        '<section class="qa"><h2>' +
        (i + 1) +
        '. 问：' +
        esc(p.q) +
        '</h2><div class="a">' +
        esc(p.a).replace(/\n/g, '<br/>') +
        '</div></section>',
    )
    .join('');
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>' +
    '@page{size:A4;margin:18mm 16mm}' +
    'body{margin:0;color:#1a1a1a;font-family:"Kaiti SC","楷体-简","STKaiti",serif;font-size:12pt;line-height:1.95}' +
    'h1{font-size:18pt;margin:0 0 4pt}' +
    '.meta{color:#666;font-size:9.5pt;margin:0 0 16pt;padding-bottom:8pt;border-bottom:1px solid #ddd}' +
    'h2{font-size:12.5pt;margin:0 0 6pt;font-weight:600}' +
    '.qa{margin:0 0 15pt;padding-bottom:11pt;border-bottom:1px dashed #e2e2e2;page-break-inside:avoid}' +
    '.a{word-break:break-word}' +
    '</style></head><body><h1>《' +
    esc(bookTitle) +
    '》即时答疑</h1><div class="meta">共 ' +
    pairs.length +
    ' 条 · ' +
    new Date().toLocaleString('zh-CN') +
    '</div>' +
    rows +
    '</body></html>'
  );
}

/**
 * 答疑导出真 PDF：先把问答拼成打印页，再用无头浏览器直接打印成 PDF，
 * 落到下载文件夹并打开。不上传、不花钱、不依赖前端弹窗。
 */
async function handleConsultExport(req, res) {
  const body = await readJsonBody(req);
  const bookTitle = String((body && body.bookTitle) || '本书').trim() || '本书';
  const list = Array.isArray(body && body.items) ? body.items : [];
  const pairs = list
    .map((it) => ({ q: String((it && it.q) || '').trim(), a: String((it && it.a) || '').trim() }))
    .filter((p) => p.q && p.a);
  if (!pairs.length) {
    sendJson(res, 200, { ok: false, error: '这本书还没有问答，没东西可导出。' });
    return;
  }
  const browser = pdfBrowserPath();
  if (!browser) {
    sendJson(res, 200, { ok: false, error: '本机没找到能把网页存成 PDF 的浏览器，导不出来。' });
    return;
  }
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp =
    '' + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + '-' + two(d.getHours()) + two(d.getMinutes());
  const safeTitle = String(bookTitle).replace(/[\\/:*?"<>|]/g, '-').slice(0, 40) || '书';
  const outDir = path.join(os.homedir(), 'Downloads');
  const outPath = path.join(outDir, safeTitle + '-即时答疑-' + stamp + '.pdf');
  const tmpHtml = path.join(os.tmpdir(), 'dsh-consult-' + Date.now() + '.html');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(tmpHtml, consultPrintHtml(bookTitle, pairs), 'utf8');
    await new Promise((resolve, reject) => {
      execFile(
        browser,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-pdf-header-footer',
          '--print-to-pdf=' + outPath,
          'file://' + tmpHtml,
        ],
        { timeout: 90000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    if (!fs.existsSync(outPath)) throw new Error('PDF 没生成出来');
    try {
      execFile('open', [outPath], () => {});
    } catch {
      /* 打不开也不影响文件已经存好 */
    }
    sendJson(res, 200, { ok: true, file: outPath, name: path.basename(outPath), count: pairs.length });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: '转 PDF 失败：' + ((err && err.message) || String(err)) });
  } finally {
    try {
      fs.unlinkSync(tmpHtml);
    } catch {
      /* 临时文件清不掉就算了 */
    }
  }
}

/**
 * 即时答疑：不绑章节，拿书名 + 章节目录 + 已听过的讲解摘要当背景回答。
 * 没指定书就纯聊天式地答，不当查书机器。
 */
async function handleConsult(req, res) {
  const body = await readJsonBody(req);
  const bookId = String((body && body.bookId) || '');
  const question = String((body && body.question) || '').trim();
  const rawHistory = body && Array.isArray(body.history) ? body.history : [];
  const history = rawHistory
    .filter((h) => h && typeof h === 'object' && h.text)
    .slice(-8)
    .map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', text: String(h.text).slice(0, 400) }));
  if (!question) {
    sendJson(res, 200, { ok: false, error: '还没写问题' });
    return;
  }

  let bookTitle = '';
  let catalog = '';
  let digest = '';
  let preference = '';
  if (bookId) {
    const bookDir = resolveBookDir(bookId);
    if (!bookDir) {
      sendJson(res, 200, { ok: false, error: '找不到这本书' });
      return;
    }
    bookTitle = bookTitleOf(bookDir);
    const book = safeJson(path.join(bookDir, 'book.json')) || {};
    const chapters = Array.isArray(book.chapters) ? book.chapters : [];
    catalog = chapters
      .slice(0, 80)
      .map((c) => '第' + c.n + '章 ' + String(c.title || ''))
      .join('\n');
    const picked = [];
    for (const c of chapters) {
      const t = readTextFile(path.join(bookDir, 'lecture', pad3(c.n) + '.md'));
      if (t.trim()) {
        picked.push('第' + c.n + '章 ' + String(c.title || '') + '：' + t.trim().slice(0, 320));
        if (picked.length >= 10) break;
      }
    }
    digest = picked.join('\n\n');
    preference = readerPreferenceOf(bookDir);
  }

  let llm;
  let target;
  try {
    llm = resolveLlm(hostCtx);
    target = resolveModel(hostCtx);
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
    return;
  }

  ndjson(res);
  emit(res, { type: 'start' });
  const controller = abortOnClose(req, res);
  let text = '';
  try {
    for await (const delta of consultStream({
      llm,
      target,
      bookTitle,
      catalog,
      digest,
      preference,
      history,
      question,
      signal: controller.signal,
    })) {
      text += delta;
      emit(res, { type: 'delta', text: delta });
    }
  } catch (err) {
    emit(res, { type: 'error', message: (err && err.message) || String(err) });
    res.end();
    return;
  }
  emit(res, { type: 'done', text: text.trim(), chars: text.trim().length });
  res.end();
}

/* ---------- 装配 ---------- */

/** 改书名：只动 book.json 的 title 与 index.md 首行，不碰章节。 */
async function handleRename(req, res) {
  const body = await readJsonBody(req);
  const bookId = String((body && body.bookId) || '').trim();
  const title = String((body && body.title) || '').trim();
  if (title === '') throw new Error('书名不能空着');
  if (title.length > 80) throw new Error('书名太长，控制在 80 字以内');
  if (/[\n\r]/.test(title)) throw new Error('书名里不能换行');

  const dir = resolveBookDir(bookId);
  const bookFile = path.join(dir, 'book.json');
  const book = safeJson(bookFile) || {};
  book.title = title;
  fs.writeFileSync(bookFile, JSON.stringify(book, null, 2) + '\n', 'utf8');

  const idxFile = path.join(dir, 'index.md');
  if (fs.existsSync(idxFile)) {
    const lines = fs.readFileSync(idxFile, 'utf8').split('\n');
    if (lines.length > 0 && /^#\s/.test(lines[0])) lines[0] = '# 《' + title + '》目录';
    else lines.unshift('# 《' + title + '》目录');
    fs.writeFileSync(idxFile, lines.join('\n'), 'utf8');
  }
  sendJson(res, 200, { ok: true, bookId: bookId, title: title });
}

/** 删书：不真删，整本挪进回收站（误删可救，书库目录里立刻消失）。 */
async function handleDelete(req, res) {
  const body = await readJsonBody(req);
  const bookId = String((body && body.bookId) || '').trim();
  const dir = resolveBookDir(bookId);
  const home =
    process.env.DSH_HOME && String(process.env.DSH_HOME).trim() !== ''
      ? String(process.env.DSH_HOME).trim()
      : path.join(os.homedir(), '.dsh');
  const trashRoot = path.join(home, 'book-library', 'trash');
  fs.mkdirSync(trashRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(trashRoot, bookId + '-' + stamp);
  fs.renameSync(dir, target);
  sendJson(res, 200, { ok: true, bookId: bookId, trashPath: target });
}

/** 阅读偏好：告诉我该怎么讲。GET 读、POST 存。 */
async function handlePreference(req, res) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    sendJson(res, 200, { ok: true, preference: readTextFile(PREFERENCE_FILE) || '' });
    return;
  }
  if (method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }
  try {
    const body = await readJsonBody(req);
    const text = String((body && body.preference) || '').slice(0, 4000);
    fs.mkdirSync(CONFIG_ROOT, { recursive: true });
    fs.writeFileSync(PREFERENCE_FILE, text.trim() ? text.trim() + '\n' : '', 'utf8');
    sendJson(res, 200, { ok: true, preference: text.trim() });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err && err.message) || String(err) });
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把一本书已讲过的章节装订成一份单页 HTML（能打印、能转发、能存下来）。 */
async function handleExport(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const bookId = String(url.searchParams.get('bookId') || '').trim();
  const dir = resolveBookDir(bookId);
  const book = safeJson(path.join(dir, 'book.json')) || {};
  const title = String(book.title || '未命名');
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  const lectureDir = path.join(dir, 'lecture');
  const parts = [];
  let words = 0;
  for (const c of chapters) {
    const n = Number(c && c.n);
    if (!Number.isFinite(n) || n <= 0) continue;
    const raw = readTextFile(path.join(lectureDir, pad3(n) + '.md'));
    if (!raw || !raw.trim()) continue;
    words += raw.length;
    parts.push({ n: n, title: String(c.title || ''), text: raw.trim() });
  }
  if (!parts.length) {
    sendJson(res, 200, { ok: false, error: '这本书还一章都没讲过，没东西可导出。' });
    return;
  }
  const bodyHtml = parts
    .map((p) => {
      const text = stripToneMarks(p.text)
        .split('\n')
        .map((line) => {
          const t = line.trim();
          if (!t) return '';
          if (/^#{1,6}\s/.test(t)) return '<h3>' + esc(t.replace(/^#{1,6}\s*/, '')) + '</h3>';
          if (/^[-*·]\s+/.test(t)) return '<li>' + esc(t.replace(/^[-*·]\s+/, '')) + '</li>';
          return '<p>' + esc(t) + '</p>';
        })
        .join('\n')
        .replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (m) => '<ul>' + m + '</ul>');
      return (
        '<section><h2>第 ' +
        p.n +
        ' 章' +
        (p.title ? ' · ' + esc(p.title) : '') +
        '</h2>' +
        text +
        '</section>'
      );
    })
    .join('\n');
  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' +
    esc(title) +
    ' · 讲解</title><style>' +
    'body{max-width:760px;margin:0 auto;padding:48px 24px;font-family:"Kaiti SC","楷体-简","STKaiti","KaiTi",serif;font-size:17px;line-height:1.95;color:#1d1d1f;background:#fff}' +
    'h1{font-size:26px;margin:0 0 6px}h2{font-size:19px;margin:40px 0 12px;padding-bottom:8px;border-bottom:1px solid #e5e5e7}' +
    'h3{font-size:16px;color:#2b5bd7;margin:20px 0 6px}p{margin:0 0 14px}ul{margin:0 0 14px;padding-left:22px}' +
    '.meta{color:#86868b;font-size:13px;margin-bottom:32px}' +
    '@media print{body{padding:0}h2{page-break-after:avoid}}' +
    '</style></head><body><h1>' +
    esc(title) +
    ' · 讲解</h1><div class="meta">' +
    parts.length +
    ' 章 · 约 ' +
    Math.round(words / 1000) +
    ' 千字 · 导出于 ' +
    new Date().toISOString().slice(0, 10) +
    '</div>' +
    bodyHtml +
    '</body></html>';
  const fileName = encodeURIComponent(title + '-讲解.html');
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('content-disposition', "attachment; filename*=UTF-8''" + fileName);
  res.setHeader('cache-control', 'no-store');
  res.end(html);
}

function guard(handler) {
  return (req, res) => {
    const headers = (req && req.headers) || {};
    if (isCrossSite(headers)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    Promise.resolve()
      .then(() => handler(req, res, headers))
      .catch((err) => {
        try {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: (err && err.message) || String(err) });
          else res.end();
        } catch {
          /* 响应已经结束 */
        }
      });
  };
}

/** 等模型服务就绪再起插件：讲台靠它说话，没有它就没得讲。 */
export const inject = ['llm', 'tools'];

/** 工具写讲解时决定落到哪本书哪一章。 */
function resolveLectureTarget(args) {
  const asked = args && args.bookId ? String(args.bookId) : '';
  const bookId = asked || lastActive.bookId;
  if (!bookId) {
    throw new Error('书库还没打开过任何一本书。先让读者在面板里选一本，或者直接告诉我 bookId。');
  }
  const book = collectBooks().books.filter((b) => b.id === bookId)[0];
  if (!book) throw new Error('书库里没有这本书：' + bookId);
  const askedNo = args && args.n ? Math.round(Number(args.n)) : 0;
  let n = askedNo;
  if (!n) {
    if (lastActive.bookId === bookId && lastActive.n) n = lastActive.n;
    else if (book.next && book.next.n) n = book.next.n;
    else n = 1;
  }
  if (!(n >= 1 && n <= (book.chapterCount || 1))) {
    throw new Error('第 ' + n + ' 章不存在，这本书一共 ' + (book.chapterCount || 0) + ' 章。');
  }
  return { bookId: bookId, n: n };
}

export function apply(ctx) {
  hostCtx = ctx;

  // ── 工具注册：模型把「这一章的深度解读」直接推进书库的讲解框 ──
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    try {
      const disposeTool = ctx.tools.register({
        name: 'present_lecture',
        description:
          '当需要向读者展示深度阅读讲解时调用此工具。讲解内容必须按深度阅读分析框架组织（这一段到底理解了什么 / 我的看法 / 给你的建议）。工具会把讲解写进书库面板的「本章讲解」框，读者在面板里直接看到，不用回对话框。',
        parameters: {
          type: 'object',
          properties: {
            lecture: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '讲解标题' },
                body: { type: 'string', description: '完整的讲解正文，Markdown 格式' },
              },
              required: ['title', 'body'],
              additionalProperties: false,
            },
            bookId: {
              type: 'string',
              description: '可选：写进书库里哪本书。不填就用读者最近在面板里打开的那本。',
            },
            n: { type: 'integer', description: '可选：写进第几章。不填就用那本书当前在看的章。' },
          },
          required: ['lecture'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              body: { type: 'string' },
              bookId: { type: 'string' },
              chapterNo: { type: 'integer' },
              saved: { type: 'boolean' },
            },
            required: ['title', 'body', 'saved'],
          },
          render: (_args, value) => [{ type: 'text', text: String((value && value.body) || '') }],
        },
        async execute(args) {
          const lecture = (args && args.lecture) || {};
          const body = String(lecture.body || '').trim();
          if (!body) throw new Error('讲解正文是空的，没东西可写。');
          const title = String(lecture.title || '').trim() || '深度解读';
          const target = resolveLectureTarget(args);
          const bookDir = resolveBookDir(target.bookId);
          if (!bookDir) throw new Error('找不到这本书的目录：' + target.bookId);
          const chapterText = readTextFile(path.join(bookDir, 'chapters', pad3(target.n) + '.md'));
          const chapterTitle = chapterTitleOf(chapterText) || title;
          writeLectureFile(bookDir, target.n, '# 第 ' + target.n + ' 章 · ' + chapterTitle + '\n\n' + body + '\n');
          writeMemoryFile(bookDir, target.n, chapterTitle, body);
          lastActive = { bookId: target.bookId, n: target.n };
          return { title: title, body: body, bookId: target.bookId, chapterNo: target.n, saved: true };
        },
      });
      if (typeof disposeTool === 'function') {
        ctx.on('dispose', () => {
          try {
            disposeTool();
          } catch (err) {
            /* 卸载时忽略 */
          }
        });
      }
    } catch (err) {
      // 没有 tools 服务时静默跳过，面板自己的讲解照旧能用
    }
  }
  ctx.inject(['webServer'], (scoped) => {
    const offs = [];

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_BOOKS,
        handler: guard((req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase();
          if (method === 'GET' || method === 'HEAD') {
            const { booksRoot, books } = collectBooks();
            sendJson(res, 200, {
              ok: true,
              pluginVersion: PLUGIN_VERSION,
              booksRoot,
              books,
              generatedAt: new Date().toISOString(),
            });
            return;
          }
          res.statusCode = 405;
          res.end();
        }),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_IMPORT,
        handler: guard((req, res, headers) => {
          const method = String((req && req.method) || 'GET').toUpperCase();
          if (method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          return handleImport(req, res, headers);
        }),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_CHAPTER,
        handler: guard((req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase();
          if (method === 'GET' || method === 'HEAD') return handleChapter(req, res);
          res.statusCode = 405;
          res.end();
        }),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_TTS,
        handler: guard((req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase();
          if (method === 'GET' || method === 'HEAD') return handleTts(req, res);
          res.statusCode = 405;
          res.end();
        }),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_VOICE,
        handler: guard((req, res) => handleVoice(req, res)),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_PROBE,
        handler: guard((req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase();
          if (method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          return handleProbe(req, res);
        }),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_LECTURE,
        handler: guard((req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase();
          if (method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          return handleLecture(req, res);
        }),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_ASK,
        handler: guard((req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase();
          if (method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          return handleAsk(req, res);
        }),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_CONSULT,
        handler: guard((req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase();
          if (method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          return handleConsult(req, res);
        }),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_RENAME,
        handler: guard((req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase();
          if (method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          return handleRename(req, res);
        }),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_DELETE,
        handler: guard((req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase();
          if (method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          return handleDelete(req, res);
        }),
      }),
      offs.push(
        scoped.webServer.register({
          kind: 'exact',
          path: ROUTE_PREFERENCE,
          handler: guard((req, res) => handlePreference(req, res)),
        }),
      ),
      offs.push(
        scoped.webServer.register({
          kind: 'exact',
          path: ROUTE_EXPORT,
          handler: guard((req, res) => handleExport(req, res)),
        }),
      ),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_CONSULT_HISTORY,
        handler: guard((req, res) => handleConsultHistory(req, res)),
      }),
    );

    offs.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_CONSULT_EXPORT,
        handler: guard((req, res) => handleConsultExport(req, res)),
      }),
    );

    ctx.on('dispose', () => {
      for (const off of offs) {
        try {
          off();
        } catch {
          /* 卸载时路由可能已随宿主消失 */
        }
      }
    });
  });
}
