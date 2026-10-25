/**
 * 书库 · 语音
 *
 * 把一章讲解变成能听的音频。用的豆包（火山引擎）语音合成，钥匙沿用本机既有的那份，
 * 也可以在面板里换音色、调速、重新填钥匙。
 *
 * 钱的问题：按字数计费。所以合成过的章会存成 mp3 缓存（lecture/NNN.mp3），再听不重复花钱。
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

const DSH_HOME =
  process.env.DSH_HOME && String(process.env.DSH_HOME).trim() !== ''
    ? String(process.env.DSH_HOME).trim()
    : path.join(os.homedir(), '.dsh');

const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml');
const AHA_PREFS = path.join(DSH_HOME, 'aha-tutor', 'prefs.json');
const VOICE_DIR = path.join(DSH_HOME, 'book-library');
const VOICE_FILE = path.join(VOICE_DIR, 'voice.json');

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const CHUNK_CHARS = 900;
const MAX_AUDIO_BYTES = 60 * 1024 * 1024;
const TIMEOUT_MS = 120 * 1000;

/** 能选的音色。前四个是常用款，最后一个允许自己填名字。 */
export const VOICES = [
  { id: 'saturn_zh_female_cancan_tob', name: '灿灿 · 女声，清亮' },
  { id: 'saturn_zh_female_chengshujiejie_tob', name: '成熟姐姐 · 女声，稳重' },
  { id: 'saturn_zh_female_keainvsheng_tob', name: '可爱女生 · 女声，轻快' },
  { id: 'saturn_zh_female_tiaopigongzhu_tob', name: '调皮公主 · 女声，俏皮' },
  { id: 'saturn_zh_male_shuanglangshaonian_tob', name: '爽朗少年 · 男声' },
  { id: 'saturn_zh_male_tiancaitongzhuo_tob', name: '天才同桌 · 男声，偏少年' },
];

const DEFAULT_VOICE = 'saturn_zh_female_cancan_tob';

/** 用哪家的声音念。system 是 Mac 自带的朗读，不花钱，音色差一些。 */
export const SOURCES = [
  { id: 'volc', name: '豆包云端（声音自然，按字数计费）' },
  { id: 'system', name: 'Mac 自带朗读（免费，音色偏机器）' },
];

/** 情绪色彩。选「不指定」就不往服务端传，用音色本来的调子。 */
export const EMOTIONS = [
  { id: '', name: '不指定（按故事本来讲）' },
  { id: 'neutral', name: '平静' },
  { id: 'happy', name: '轻松' },
  { id: 'sad', name: '低沉' },
  { id: 'angry', name: '紧绷' },
  { id: 'surprised', name: '起伏大' },
];

/** Mac 上可用的中文音色。没装的那些会被系统换成默认音色。 */
export const SYSTEM_VOICES = [
  { id: 'Tingting', name: '婷婷 · 女声（系统内置）' },
  { id: 'Meijia', name: '美佳 · 女声（台腔）' },
  { id: 'Sinji', name: '善怡 · 女声（粤语）' },
];

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 从 DSH 凭据库里取火山那把钥匙（不打印、不外传）。 */
function readKeyFromCredentials() {
  let txt;
  try {
    txt = fs.readFileSync(CRED_FILE, 'utf8');
  } catch {
    return '';
  }
  const at = txt.indexOf('aha-tutor/tts-volcengine:');
  if (at < 0) return '';
  const block = txt.slice(at, at + 1200);
  const m = block.match(/^\s*key:\s*(.+)$/m);
  if (!m) return '';
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

/** 火山应用号：先看自己的配置，再看开窍那边的。 */
function readAppId() {
  const own = safeReadJson(VOICE_FILE);
  if (own && typeof own.appId === 'string' && own.appId.trim()) return own.appId.trim();
  const aha = safeReadJson(AHA_PREFS);
  const id = aha && aha.tts && aha.tts.volcengine && aha.tts.volcengine.appId;
  return typeof id === 'string' ? id.trim() : '';
}

export function loadVoiceConfig() {
  const own = safeReadJson(VOICE_FILE) || {};
  const aha = safeReadJson(AHA_PREFS) || {};
  const ahaVolc = (aha.tts && aha.tts.volcengine) || {};
  const key = (typeof own.key === 'string' && own.key.trim()) || readKeyFromCredentials();
  return {
    provider: 'volcengine',
    source: own.source === 'system' ? 'system' : 'volc',
    voice: (typeof own.voice === 'string' && own.voice.trim()) || DEFAULT_VOICE,
    systemVoice: (typeof own.systemVoice === 'string' && own.systemVoice.trim()) || 'Tingting',
    loudness: Number.isFinite(Number(own.loudness)) ? Math.min(2, Math.max(0.5, Number(own.loudness))) : 1,
    emotion: typeof own.emotion === 'string' ? own.emotion.trim() : '',
    sampleRate: [16000, 24000, 48000].includes(Number(own.sampleRate)) ? Number(own.sampleRate) : 24000,
    rate: Number.isFinite(Number(own.rate)) ? Math.min(2, Math.max(0.5, Number(own.rate))) : Number(aha.voiceRate) || 1,
    appId: readAppId(),
    cluster: (typeof own.cluster === 'string' && own.cluster.trim()) || String(ahaVolc.cluster || 'seed-tts-2.0'),
    hasKey: key !== '',
    // 改过设置的时间：比它旧的 mp3 都是按老音色/老语速合成的，要重来
    updatedAt: Number.isFinite(Number(own.updatedAt)) ? Number(own.updatedAt) : 0,
    // 钥匙本身不回给面板，只回有没有
  };
}

export function saveVoiceConfig(patch) {
  const cur = safeReadJson(VOICE_FILE) || {};
  const next = { ...cur };
  let touched = false;
  if (patch && typeof patch === 'object') {
    if (typeof patch.voice === 'string' && patch.voice.trim() && patch.voice.trim() !== cur.voice) {
      next.voice = patch.voice.trim();
      touched = true;
    }
    if (patch.rate !== undefined && Number.isFinite(Number(patch.rate))) {
      const r = Math.min(2, Math.max(0.5, Number(patch.rate)));
      if (Number(cur.rate) !== r) touched = true;
      next.rate = r;
    }
    if (patch.source === 'system' || patch.source === 'volc') {
      if (cur.source !== patch.source) touched = true;
      next.source = patch.source;
    }
    if (typeof patch.systemVoice === 'string' && patch.systemVoice.trim()) {
      if (cur.systemVoice !== patch.systemVoice.trim()) touched = true;
      next.systemVoice = patch.systemVoice.trim();
    }
    if (patch.loudness !== undefined && Number.isFinite(Number(patch.loudness))) {
      const v = Math.min(2, Math.max(0.5, Number(patch.loudness)));
      if (Number(cur.loudness) !== v) touched = true;
      next.loudness = v;
    }
    if (patch.emotion !== undefined) {
      const e = String(patch.emotion || '').trim();
      if (String(cur.emotion || '') !== e) touched = true;
      next.emotion = e;
    }
    if (patch.sampleRate !== undefined && [16000, 24000, 48000].includes(Number(patch.sampleRate))) {
      if (Number(cur.sampleRate) !== Number(patch.sampleRate)) touched = true;
      next.sampleRate = Number(patch.sampleRate);
    }
    if (typeof patch.appId === 'string' && patch.appId.trim()) next.appId = patch.appId.trim();
    if (typeof patch.cluster === 'string' && patch.cluster.trim()) next.cluster = patch.cluster.trim();
    if (typeof patch.key === 'string' && patch.key.trim()) next.key = patch.key.trim();
    if (patch.clearKey === true) delete next.key;
  }
  if (touched) next.updatedAt = Date.now();
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  fs.writeFileSync(VOICE_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return loadVoiceConfig();
}

function resolveKey() {
  const own = safeReadJson(VOICE_FILE);
  const ownKey = own && typeof own.key === 'string' ? own.key.trim() : '';
  return ownKey || readKeyFromCredentials();
}

/** 把讲解稿洗成适合念的稿：去 markdown 记号，长句子留停顿。 */
export function cleanForSpeech(markdown) {
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^#{1,6}[ \t]*/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[[0-9]{1,3}\]/g, '')
    .replace(/[ \t]*·[ \t]*/g, '，')
    .replace(/——+/g, '，')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** 讲解里能用的语气词。模型按情节自己挑，用户不用管。 */
export const TONE_WORDS = ['平淡', '轻松', '低沉', '紧绷', '起伏'];

const TONE_MAP = {
  平淡: 'neutral',
  平静: 'neutral',
  轻松: 'happy',
  轻快: 'happy',
  低沉: 'sad',
  悲伤: 'sad',
  紧绷: 'angry',
  紧张: 'angry',
  起伏: 'surprised',
  惊讶: 'surprised',
};

const TONE_LINE_RE = /^\s*【\s*语气\s*[:：]\s*([^】]{1,8})\s*】\s*$/;

/** 去掉讲解里的语气标记行，只留给眼睛看的那份文字。 */
export function stripToneMarks(markdown) {
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !TONE_LINE_RE.test(line))
    .join('\n');
}

/** 按语气标记把讲解切段，每段带一个情绪。没标记就整段平淡。 */
export function splitByTone(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const segs = [];
  let emotion = 'neutral';
  let buf = [];
  const flush = () => {
    const text = cleanForSpeech(buf.join('\n'));
    if (text) segs.push({ emotion, text });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(TONE_LINE_RE);
    if (m) {
      flush();
      emotion = TONE_MAP[m[1].trim()] || 'neutral';
      continue;
    }
    // 讲解稿第一行是「# 第 N 章 · 标题」，那是标题不是正文，别念出来
    if (/^#{1,6}\s/.test(line)) continue;
    buf.push(line);
  }
  flush();
  return segs;
}

/** 把整章讲解变成「该念的碎片」：先按语气分段，再按长度切块。 */
function speechPieces(markdown) {
  const out = [];
  for (const seg of splitByTone(markdown)) {
    for (const chunk of splitChunks(seg.text)) out.push({ text: chunk, emotion: seg.emotion });
  }
  return out;
}

function splitChunks(text, size = CHUNK_CHARS) {
  if (text.length <= size) return text ? [text] : [];
  const parts = text.split(/(?<=[。！？；…」』\n])/);
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > size) {
      if (buf.trim()) out.push(buf.trim());
      buf = p;
    } else {
      buf += p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.flatMap((s) =>
    s.length <= size ? [s] : s.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) || [s],
  );
}

/** 把面板上的设置拼成一次调用要的参数。 */
function paramsOf(cfg, appId, accessKey, speechRate, emotion) {
  return {
    appId,
    accessKey,
    cluster: cfg.cluster || 'seed-tts-2.0',
    voice: cfg.voice,
    speechRate,
    loudness: cfg.loudness,
    emotion: emotion !== undefined ? emotion : cfg.emotion,
    sampleRate: cfg.sampleRate,
  };
}

function withTimeout(promise, ms) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('合成超时（网络或服务没响应）')), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * 合成一段文本，边收边把音频喂给 onAudio(buffer)。
 * 全部成功返回总字节数；失败抛错。
 */
async function speakInto(text, { appId, accessKey, cluster, voice, speechRate, loudness, emotion, sampleRate }, onAudio) {
  const res = await withTimeout(
    fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-Api-App-Id': appId,
        'X-Api-Access-Key': accessKey,
        'X-Api-Resource-Id': cluster,
        'X-Api-Request-Id': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user: { uid: 'book-library' },
        req_params: Object.assign(
          {
            text,
            speaker: voice,
            audio_params: {
              format: 'mp3',
              sample_rate: Number(sampleRate) || 24000,
              speech_rate: speechRate,
              loudness_rate: Math.max(-50, Math.min(100, Math.round((Number(loudness || 1) - 1) * 100))),
            },
          },
          emotion ? { emotion } : {},
        ),
      }),
    }),
    TIMEOUT_MS,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`语音服务返回 HTTP ${res.status}：${body.slice(0, 200)}`);
  }
  if (!res.body) throw new Error('语音服务没有返回音频流');

  let total = 0;
  let pending = '';
  let apiErr = null;

  const handleLine = (line) => {
    const s = line.trim();
    if (!s) return;
    let part;
    try {
      part = JSON.parse(s);
    } catch {
      return;
    }
    if (part && part.code !== undefined && part.code !== 0 && part.code !== 20000000) {
      if (!apiErr) apiErr = { code: part.code, message: part.message };
      return;
    }
    if (typeof part.data === 'string' && part.data) {
      const buf = Buffer.from(part.data, 'base64');
      if (buf.length) {
        total += buf.length;
        if (total > MAX_AUDIO_BYTES) throw new Error('合成出来的音频太大了');
        onAudio(buf);
      }
    }
  };

  for await (const chunk of Readable.fromWeb(res.body)) {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() || '';
    for (const line of lines) {
      const err = handleLine(line);
      if (err) throw err;
      if (apiErr) break;
    }
    if (apiErr) break;
  }
  if (pending.trim()) handleLine(pending);
  if (apiErr && total === 0) {
    const auth = [3001, 3003, 45000030].includes(apiErr.code);
    throw new Error(
      `语音服务报错 ${apiErr.code} ${apiErr.message || ''}` +
        (auth ? '（多半是钥匙过期了，去火山控制台重新复制一串）' : ''),
    );
  }
  if (total === 0) throw new Error('语音服务没有返回任何音频');
  return total;
}

/**
 * 把一章讲解合成成音频文件。已存在就直接返回路径（省钱）。
 * 返回 { file, bytes }。
 */
export async function synthesizeChapter({ bookDir, chapterNo, text, config, force }) {
  const outDir = path.join(bookDir, 'lecture');
  const file = path.join(outDir, `${String(chapterNo).padStart(3, '0')}.mp3`);
  if (!force) {
    try {
      const st = fs.statSync(file);
      if (st.size > 1024) return { file, bytes: st.size, cached: true };
    } catch {
      /* 没缓存 */
    }
  }

  const cfg = { ...loadVoiceConfig(), ...(config || {}) };
  const appId = cfg.appId;
  const accessKey = resolveKey();
  if (!appId) throw new Error('缺火山应用号（App ID），面板语音设置里填一下');
  if (!accessKey) throw new Error('缺语音钥匙，面板语音设置里填一下');
  const speechRate = Math.max(-50, Math.min(100, Math.round((Number(cfg.rate || 1) - 1) * 100)));

  const pieces = speechPieces(text);
  if (!pieces.length) throw new Error('这章没有可念的正文');

  fs.mkdirSync(outDir, { recursive: true });
  const tmp = file + '.part';
  const stream = fs.createWriteStream(tmp);
  let written = 0;
  try {
    for (let i = 0; i < pieces.length; i++) {
      await speakInto(
        pieces[i].text,
        paramsOf(cfg, appId, accessKey, speechRate, pieces[i].emotion),
        (buf) => {
          written += buf.length;
          stream.write(buf);
        },
      );
    }
  } catch (err) {
    try {
      stream.end();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
  await new Promise((resolve, reject) => stream.end((e) => (e ? reject(e) : resolve())));
  fs.renameSync(tmp, file);
  return { file, bytes: written, cached: false };
}

/**
 * 流式合成：边合成边把 mp3 写进响应。第一次听只要等两三秒就能出声。
 * 传了 cacheFile 就同时存一份，下次秒开、也不重复花钱。
 */
export async function streamChapter({ res, text, config, cacheFile }) {
  const cfg = { ...loadVoiceConfig(), ...(config || {}) };
  const appId = cfg.appId;
  const accessKey = resolveKey();
  if (!appId) throw new Error('缺火山应用号（App ID），面板语音设置里填一下');
  if (!accessKey) throw new Error('缺钥匙，面板语音设置里填一下');
  const speechRate = Math.max(-50, Math.min(100, Math.round((Number(cfg.rate || 1) - 1) * 100)));
  const pieces = speechPieces(text);
  if (!pieces.length) throw new Error('这章没有可念的正文');

  let cacheStream = null;
  let cacheTmp = '';
  if (cacheFile) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      cacheTmp = cacheFile + '.part';
      cacheStream = fs.createWriteStream(cacheTmp);
    } catch {
      cacheStream = null;
    }
  }

  let started = false;
  let written = 0;
  try {
    for (let i = 0; i < pieces.length; i++) {
      await speakInto(
        pieces[i].text,
        paramsOf(cfg, appId, accessKey, speechRate, pieces[i].emotion),
        (buf) => {
          if (!started) {
            started = true;
            res.statusCode = 200;
            res.setHeader('content-type', 'audio/mpeg');
            res.setHeader('cache-control', 'no-store');
            res.setHeader('x-book-library-stream', '1');
          }
          written += buf.length;
          if (cacheStream) {
            try {
              cacheStream.write(buf);
            } catch {
              /* 存不上就算了，不影响听 */
            }
          }
          try {
            res.write(buf);
          } catch {
            /* 浏览器那边可能已经不听了 */
          }
        },
      );
    }
  } catch (err) {
    if (cacheStream) {
      try {
        cacheStream.end(() => {
          try {
            fs.rmSync(cacheTmp, { force: true });
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
    }
    throw err;
  }

  if (cacheStream) {
    await new Promise((resolve) => {
      cacheStream.end(() => {
        try {
          fs.renameSync(cacheTmp, cacheFile);
        } catch {
          /* 存不上就算了 */
        }
        resolve();
      });
    });
  }
  return written;
}

/** 试听：合成一句短的，直接返回 Buffer。 */
export async function synthesizeProbe(text, config) {
  const cfg = { ...loadVoiceConfig(), ...(config || {}) };
  const accessKey = resolveKey();
  if (!cfg.appId) throw new Error('缺火山应用号（App ID）');
  if (!accessKey) throw new Error('缺钥匙');
  const speechRate = Math.max(-50, Math.min(100, Math.round((Number(cfg.rate || 1) - 1) * 100)));
  const chunks = [];
  await speakInto(
    String(text).slice(0, 200),
    paramsOf(cfg, cfg.appId, accessKey, speechRate),
    (buf) => chunks.push(buf),
  );
  return Buffer.concat(chunks);
}

/**
 * Mac 自带朗读：把文字交给系统合成成 m4a，不联网、不花钱。
 * 音色差一些，胜在随时能用。
 */
export function synthesizeSystem({ text, outFile, voice, rate }) {
  const clean = cleanForSpeech(text);
  if (!clean) throw new Error('这章没有可念的正文');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-say-'));
  const txtFile = path.join(tmpDir, 'in.txt');
  const aiff = path.join(tmpDir, 'out.aiff');
  try {
    fs.writeFileSync(txtFile, clean, 'utf8');
    const wpm = Math.max(90, Math.min(400, Math.round(190 * (Number(rate) || 1))));
    const args = ['-v', voice || 'Tingting', '-r', String(wpm), '-o', aiff, '-f', txtFile];
    try {
      execFileSync('/usr/bin/say', args, { stdio: 'pipe', timeout: 180000 });
    } catch (err) {
      const msg = err && err.stderr ? String(err.stderr).slice(0, 200) : '';
      throw new Error('系统朗读没出声' + (msg ? '：' + msg : '（音色名可能不被系统认识）'));
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const tmpOut = outFile + '.part';
    execFileSync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', aiff, tmpOut], {
      stdio: 'pipe',
      timeout: 120000,
    });
    fs.renameSync(tmpOut, outFile);
    return { file: outFile, bytes: fs.statSync(outFile).size };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

/** 试听一条：系统朗读版。 */
export function probeSystem({ text, voice, rate, outFile }) {
  return synthesizeSystem({ text, outFile, voice, rate });
}
