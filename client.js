/**
 * 书库 · Client 半体
 *
 * 左侧栏一个「书库」图标，点开就是书架：
 *   - 有哪些书、读到第几章、还剩几章
 *   - 点开一本书看章节清单，再点一章能看讲解
 *   - 每章有「听」，讲解用豆包的声音念出来；播完自动接下一章
 *   - 语音可以换音色、调语速、试听
 *
 * 书的目录与讲解数据来自 Host 半体，本文件不碰磁盘。
 */
window.__ModuleLoader__.load({
  id: 'dsh-book-library',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    const API = '/dsh-book-library/books';
    const IMPORT_API = '/dsh-book-library/import';
    const CHAPTER_API = '/dsh-book-library/chapter';
    const TTS_API = '/dsh-book-library/tts';
    const VOICE_API = '/dsh-book-library/voice';
    const PROBE_API = '/dsh-book-library/voice/probe';
    const CONSULT_API = '/dsh-book-library/consult';
    const RENAME_API = '/dsh-book-library/rename';
    const DELETE_API = '/dsh-book-library/delete';
    const LECTURE_API = '/dsh-book-library/lecture';
    const ASK_API = '/dsh-book-library/ask';
    const PREFERENCE_API = '/dsh-book-library/preference';
    const EXPORT_API = '/dsh-book-library/export';
    const PANEL_ID = 'book-library';

    /* ---------- 图标 ---------- */

    // 麦克风图标直接用 🎙️ 表情，彩色、各处一致，不用手画
    function MicIcon({ size = 14 }) {
      return h(
        'span',
        {
          style: {
            fontSize: Math.round(size * 1.2),
            lineHeight: 1,
            display: 'inline-block',
            verticalAlign: '-1px',
          },
          'aria-hidden': 'true',
        },
        '\u{1F399}\u{FE0F}',
      );
    }

    function BookIcon({ size = 18 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4.5 5.2A2.2 2.2 0 0 1 6.7 3H19v15.5H6.7a2.2 2.2 0 0 0-2.2 2.2z' }),
        h('path', { d: 'M4.5 18.5V20.7h14.5' }),
        h('path', { d: 'M9 7.5h6' }),
        h('path', { d: 'M11 10.5a1 1 0 1 1 2 0v3a1 1 0 1 1-2 0z' }),
      );
    }

    /* ---------- 取数 ---------- */

    async function fetchBooks() {
      const res = await fetch(API, { headers: { accept: 'application/json' } });
      let data = null;
      try {
        data = await res.json();
      } catch {
        throw new Error('返回的不是有效数据（HTTP ' + res.status + '）');
      }
      if (!data || data.ok !== true) {
        throw new Error((data && data.error) || '读取书库失败（HTTP ' + res.status + '）');
      }
      return data;
    }

    async function fetchChapter(bookId, n) {
      const url = CHAPTER_API + '?bookId=' + encodeURIComponent(bookId) + '&n=' + n;
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      let data = null;
      try {
        data = await res.json();
      } catch {
        throw new Error('没拿到这一章（HTTP ' + res.status + '）');
      }
      if (!data || data.ok !== true) throw new Error((data && data.error) || '这一章读不出来');
      return data;
    }

    async function uploadBookFile(file) {
      const res = await fetch(IMPORT_API, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        throw new Error('没等到结果（HTTP ' + res.status + '），可能文件太大或在处理中被打断');
      }
      if (!data) throw new Error('没等到结果（HTTP ' + res.status + '）');
      return data;
    }

    async function fetchVoice() {
      const res = await fetch(VOICE_API, { headers: { accept: 'application/json' } });
      const data = await res.json().catch(() => null);
      if (!data || data.ok !== true) throw new Error((data && data.error) || '读不到语音设置');
      return data;
    }

    async function saveVoice(patch) {
      const res = await fetch(VOICE_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => null);
      if (!data || data.ok !== true) throw new Error((data && data.error) || '存不上语音设置');
      return data;
    }

    /*
     * 往 Host 递一个问题，边收边处理。
     * 正常时后台回的是 NDJSON（一行一件事），异常时回一段 JSON——两种都能接。
     */
    async function streamPost(url, payload, onEvent, signal) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      const type = res.headers.get('content-type') || '';
      // 注意：不能写成 type.indexOf('json') >= 0 —— application/x-ndjson 里也含 "json"
      // 子串，会把正常的流响应误判成错误 JSON，导致「后台没接住」。
      const isPlainJson = /^application\/json/i.test(type);
      if (!res.ok || isPlainJson) {
        const data = await res.json().catch(() => null);
        if (data && data.ok === true) return data;
        throw new Error((data && (data.error || data.hint)) || '后台没接住，稍后再试一次');
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rest = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = rest.indexOf('\n')) >= 0) {
          const line = rest.slice(0, cut).trim();
          rest = rest.slice(cut + 1);
          if (!line) continue;
          let evt = null;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt) onEvent(evt);
        }
      }
      const tail = rest.trim();
      if (tail) {
        try {
          onEvent(JSON.parse(tail));
        } catch {
          /* 末尾残行丢掉 */
        }
      }
      return null;
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* 落到下面的兜底 */
      }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }

    /* ---------- 样式底座 ---------- */

    const C = {
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      layer1: 'var(--dsw-alias-bg-layer-1, #f7f7f8)',
      layer2: 'var(--dsw-alias-bg-layer-2, #eef0f3)',
      border: 'var(--dsw-alias-border-l1, #e3e5e8)',
      border2: 'var(--dsw-alias-border-l2, #d0d3d8)',
      text: 'var(--dsw-alias-label-primary, #1b1d21)',
      sub: 'var(--dsw-alias-label-secondary, #6b7280)',
      brand: 'var(--dsw-alias-brand-primary, #3b6ef6)',
      success: 'var(--dsw-alias-state-success-primary, #16a34a)',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      error: 'var(--dsw-alias-state-error-primary, #dc2626)',
    };

    const UI_FONT =
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif';
    const READ_FONT =
      '"Kaiti SC", "KaitiSC", "楷体-简", "STKaiti", "KaiTi", "楷体", "Songti SC", serif';
    const FONT_FAMILY = READ_FONT;
    const FONT_CSS =
      '.bl-root, .bl-root * { font-family: ' + FONT_FAMILY + ' !important; }' +
      '.bl-read, .bl-read * { font-family: ' + READ_FONT + ' !important; }' +
      '.bl-root button { transition: filter .12s ease, opacity .12s ease; }' +
      '.bl-root button:hover:not([disabled]) { filter: brightness(0.93); }' +
      '.bl-root button:active:not([disabled]) { filter: brightness(0.86); }' +
      '.bl-root input:focus, .bl-root select:focus, .bl-root textarea:focus {' +
      ' box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary) !important; }' +
      '.bl-anchor { cursor: pointer; color: var(--dsw-alias-brand-primary); font-weight: 600;' +
      ' padding: 0 1px; border-radius: 3px; }' +
      '.bl-anchor:hover { background: var(--dsw-alias-bg-layer-2); }' +
      '.bl-seg { transition: background .25s ease; }' +
      '.bl-seg.bl-hot { background: rgba(74, 108, 247, 0.16);' +
      ' box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary); }' +
      '.bl-lecture::-webkit-scrollbar, .bl-textbox::-webkit-scrollbar { width: 8px; }' +
      '.bl-lecture::-webkit-scrollbar-thumb, .bl-textbox::-webkit-scrollbar-thumb {' +
      ' background: var(--dsw-alias-border-l2); border-radius: 4px; }' +
      '.bl-lecture::-webkit-scrollbar-track, .bl-textbox::-webkit-scrollbar-track {' +
      ' background: transparent; }' +
      '.bl-seg.bl-hot::selection { background: rgba(74, 108, 247, 0.3); }' +
      '.bl-seg.bl-hit { background: var(--dsw-alias-bg-layer-2);' +
      ' box-shadow: inset 3px 0 0 var(--dsw-alias-brand-primary); }' +
      '.bl-card { transition: border-color .12s ease, box-shadow .12s ease; }' +
      '.bl-card:hover { border-color: var(--dsw-alias-border-l2) !important; }' +
      '.bl-root ::-webkit-scrollbar { width: 10px; height: 10px; }' +
      '.bl-root ::-webkit-scrollbar-thumb {' +
      ' background: var(--dsw-alias-border-l2); border-radius: 5px; }' +
      '.bl-root ::-webkit-scrollbar-track { background: transparent; }';

    function ProgressBar({ value, total }) {
      const pct = total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
      return h(
        'div',
        { style: { height: 6, borderRadius: 999, background: C.layer2, overflow: 'hidden', marginTop: 8 } },
        h('div', {
          style: {
            width: pct + '%',
            height: '100%',
            borderRadius: 999,
            background: pct >= 100 ? C.success : C.brand,
            transition: 'width .25s ease',
          },
        }),
      );
    }

    /* ---------- 讲解稿的简易渲染 ---------- */

    function inline(text) {
      const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
      return parts.map((p, i) =>
        p.length > 4 && p.startsWith('**') && p.endsWith('**')
          ? h('strong', { key: i, style: { fontWeight: 700, color: C.text } }, p.slice(2, -2))
          : p,
      );
    }

    /** 点了讲解里的 [7]，就把下面原文的第 7 段滚到眼前并亮一下。 */
    function gotoSeg(segN) {
      if (typeof document === 'undefined') return;
      const root = document.querySelector('.bl-root');
      const target = root && root.querySelector('[data-seg="' + segN + '"]');
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('bl-hit');
      window.setTimeout(() => {
        try {
          target.classList.remove('bl-hit');
        } catch (err) {}
      }, 2400);
    }

    /** 行内渲染：既要认 **粗体**，也要认 [7] 这种段落锚。 */
    function richInline(text) {
      const out = [];
      inline(text).forEach((part) => {
        if (typeof part !== 'string') {
          out.push(part);
          return;
        }
        String(part)
          .split(/(\[\d+\])/g)
          .forEach((piece) => {
            if (!piece) return;
            const hit = /^\[(\d+)\]$/.exec(piece);
            if (!hit) {
              out.push(piece);
              return;
            }
            const segN = Number(hit[1]);
            out.push(
              h(
                'span',
                {
                  key: 'anc' + out.length,
                  className: 'bl-anchor',
                  title: '跳到下面原文第 ' + segN + ' 段',
                  onClick: (ev) => {
                    ev.stopPropagation();
                    gotoSeg(segN);
                  },
                },
                piece,
              ),
            );
          });
      });
      return out;
    }

    /** 讲解里那些【语气：低沉】是给念的人看的，不摆在屏上。 */
    const TONE_LINE_RE = /^\s*【\s*语气\s*[:：][^】]*】\s*$/;

    function renderLecture(text) {
      const lines = String(text || '')
        .split('\n')
        .filter((line) => !TONE_LINE_RE.test(line));
      const out = [];
      lines.forEach((raw, i) => {
        const line = raw.trim();
        if (!line) return;
        const heading = /^(#{1,6})\s*(.+)$/.exec(line);
        if (heading) {
          const level = heading[1].length;
          const isSection = level >= 3;
          out.push(
            h(
              'div',
              {
                key: i,
                style: {
                  fontSize: isSection ? 16 : level <= 2 ? 17 : 15.5,
                  fontWeight: isSection ? 600 : 700,
                  color: isSection ? C.brand : C.text,
                  marginTop: out.length ? (isSection ? 22 : 12) : 0,
                  marginBottom: isSection ? 8 : 5,
                  paddingLeft: isSection ? 10 : 0,
                  borderLeft: isSection ? '3px solid ' + C.brand : 'none',
                  lineHeight: 1.5,
                },
              },
              richInline(heading[2]),
            ),
          );
          return;
        }
        if (/^[-*·]\s+/.test(line)) {
          out.push(
            h(
              'div',
              { key: i, className: 'bl-read', style: { display: 'flex', gap: 6, marginBottom: 6, fontSize: 15.5, lineHeight: 1.95 } },
              h('span', { style: { color: C.brand, flex: 'none' } }, '·'),
              h('span', { style: { flex: 1 } }, richInline(line.replace(/^[-*·]\s+/, ''))),
            ),
          );
          return;
        }
        out.push(
          h('p', { key: i, className: 'bl-read', style: { margin: '0 0 12px', fontSize: 15.5, lineHeight: 1.95 } }, richInline(line)),
        );
      });
      return out;
    }

    /* ---------- 全局单声道：谁开播就把上一个停掉 ---------- */

    let activeAudioEl = null;

    function claimAudio(el) {
      if (!el) return;
      if (activeAudioEl && activeAudioEl !== el) {
        try { activeAudioEl.pause(); } catch (e) { /* ignore */ }
      }
      activeAudioEl = el;
    }

    /* ---------- 语音设置 ---------- */

    function VoiceBox({ voice, onSaved, onNeedReload }) {
      const [draft, setDraft] = useState(voice || null);
      const [msg, setMsg] = useState({ kind: 'idle', text: '' });
      const [probing, setProbing] = useState(false);
      const audioRef = useRef(null);

      useEffect(() => {
        setDraft(voice || null);
      }, [voice]);

      const patch = useCallback(
        async (p) => {
          try {
            const next = await saveVoice(p);
            setDraft(next);
            setMsg({ kind: 'ok', text: '已保存' });
            if (onSaved) onSaved(next);
            if (onNeedReload) onNeedReload();
          } catch (err) {
            setMsg({ kind: 'err', text: (err && err.message) || String(err) });
          }
        },
        [onSaved, onNeedReload],
      );

      const probe = useCallback(async () => {
        if (probing) return;
        setProbing(true);
        setMsg({ kind: 'idle', text: '正在试听…' });
        try {
          const rate = draft ? draft.rate : 1;
          const vo = draft ? draft.voice : '';
          const res = await fetch(PROBE_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rate, voice: vo }),
          });
          const ct = res.headers.get('content-type') || '';
          if (ct.indexOf('audio') < 0) {
            const data = await res.json().catch(() => null);
            throw new Error((data && data.error) || '试听没合成出来');
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const el = audioRef.current;
          if (el) {
            el.src = url;
            claimAudio(el);
            el.play().catch(() => {});
          }
          setMsg({ kind: 'ok', text: '试听已开始' });
        } catch (err) {
          setMsg({ kind: 'err', text: (err && err.message) || String(err) });
        } finally {
          setProbing(false);
        }
      }, [draft, probing]);

      if (!draft) return h('div', { style: { fontSize: 12, color: C.sub } }, '语音设置读取中…');

      const voices = draft.voices || [];
      const missing = !draft.hasKey || !draft.hasAppId;

      return h(
        'div',
        {
          style: {
            border: '1px solid ' + C.border,
            background: C.layer1,
            borderRadius: 10,
            padding: '10px 11px',
            marginBottom: 12,
          },
        },
        h('div', { style: { fontSize: 12.5, fontWeight: 700, marginBottom: 8 } }, '听的声音'),
        missing
          ? h(
              'div',
              {
                style: {
                  fontSize: 11.5,
                  lineHeight: 1.6,
                  color: C.warn,
                  background: C.layer2,
                  borderRadius: 7,
                  padding: '7px 9px',
                  marginBottom: 9,
                },
              },
              '还没有接上语音服务。这台机器上原本配过一份（开窍插件在用），如果那份还能用，这里应该显示已接上；不然要在下面把钥匙填进来。',
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 } },
          h('span', { style: { fontSize: 12, color: C.sub, width: 34, flex: 'none' } }, '音色'),
          h(
            'select',
            {
              value: draft.voice,
              onChange: (ev) => patch({ voice: ev.target.value }),
              style: {
                flex: 1,
                minWidth: 0,
                fontSize: 12,
                padding: '5px 6px',
                borderRadius: 7,
                border: '1px solid ' + C.border2,
                background: C.bg,
                color: C.text,
              },
            },
            voices.map((v) => h('option', { key: v.id, value: v.id }, v.name)),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 } },
          h('span', { style: { fontSize: 12, color: C.sub, width: 34, flex: 'none' } }, '语速'),
          h('input', {
            type: 'range',
            min: 0.8,
            max: 1.4,
            step: 0.05,
            value: draft.rate,
            onChange: (ev) => setDraft({ ...draft, rate: Number(ev.target.value) }),
            onMouseUp: () => patch({ rate: draft.rate }),
            onTouchEnd: () => patch({ rate: draft.rate }),
            style: { flex: 1, minWidth: 0, accentColor: C.brand },
          }),
          h(
            'span',
            { style: { fontSize: 11.5, color: C.sub, width: 34, textAlign: 'right', flex: 'none' } },
            Number(draft.rate).toFixed(2) + '×',
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 7, alignItems: 'center', marginTop: 2 } },
          h(
            'button',
            {
              onClick: probe,
              type: 'button',
              disabled: probing,
              style: {
                padding: '5px 11px',
                borderRadius: 7,
                border: '1px solid ' + C.border2,
                background: C.bg,
                color: C.text,
                fontSize: 12,
                cursor: probing ? 'default' : 'pointer',
                opacity: probing ? 0.6 : 1,
              },
            },
            probing ? '试听中…' : '试听',
          ),
          msg.kind === 'idle' || !msg.text
            ? h('span', { style: { fontSize: 11.5, color: C.sub } }, '改了音色或语速，已经存过的声音会重新生成')
            : h(
                'span',
                { style: { fontSize: 11.5, color: msg.kind === 'err' ? C.error : C.success, flex: 1, minWidth: 0 } },
                msg.text,
              ),
        ),
        h(
          'div',
          { style: { marginTop: 9, display: 'flex', gap: 7, alignItems: 'center' } },
          h(
            'input',
            {
              type: 'password',
              placeholder: draft.hasKey ? '钥匙已配好，想换就在这里填新的' : '填语音服务的钥匙',
              onChange: (ev) => setDraft({ ...draft, _key: ev.target.value }),
              style: {
                flex: 1,
                minWidth: 0,
                fontSize: 12,
                padding: '5px 8px',
                borderRadius: 7,
                border: '1px solid ' + C.border2,
                background: C.bg,
                color: C.text,
              },
            },
          ),
          h(
            'button',
            {
              onClick: () => {
                if (draft._key && draft._key.trim()) patch({ key: draft._key.trim() });
              },
              type: 'button',
              style: {
                padding: '5px 10px',
                borderRadius: 7,
                border: '1px solid ' + C.border2,
                background: C.layer2,
                color: C.text,
                fontSize: 12,
                cursor: 'pointer',
              },
            },
            '保存钥匙',
          ),
        ),
        h('audio', { ref: audioRef, style: { display: 'none' } }),
      );
    }

    /* ---------- 底部播放器 ---------- */

    function fmtTime(sec) {
      const total = Math.max(0, Math.floor(Number(sec) || 0));
      const m = Math.floor(total / 60);
      const r = total % 60;
      return m + ':' + String(r).padStart(2, '0');
    }

    /* 底部提问栏：一直贴在面板最下方，正在念的文字在它上面 */
    function AskBar({ bookId, n }) {
      const [q, setQ] = useState('');
      const [qa, setQa] = useState({ status: '', text: '', error: '' });
      const abortRef = useRef(null);

      const askNow = useCallback(() => {
        const question = String(q || '').trim();
        if (!question) return;
        if (abortRef.current) {
          try {
            abortRef.current.abort();
          } catch (e) {
            /* 上一问停了就算 */
          }
        }
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setQa({ status: 'working', text: '', error: '' });
        let acc = '';
        const useChapter = Boolean(n);
        streamPost(
          useChapter ? ASK_API : CONSULT_API,
          useChapter ? { bookId: bookId, n: n, question: question } : { bookId: bookId, question: question },
          (ev) => {
            if (ev.type === 'delta' && ev.text) {
              acc += ev.text;
              setQa({ status: 'working', text: acc, error: '' });
            } else if (ev.type === 'done') {
              setQa({ status: 'done', text: ev.text || acc, error: '' });
            } else if (ev.type === 'error') {
              setQa({ status: 'err', text: acc, error: ev.message || '没答上来' });
            }
          },
          ctrl.signal,
        ).catch((e) => {
          setQa({ status: 'err', text: '', error: (e && e.message) || '没答上来' });
        });
      }, [q, bookId, n]);

      useEffect(() => {
        setQ('');
        setQa({ status: '', text: '', error: '' });
      }, [bookId, n]);

      const working = qa.status === 'working';
      return h(
        'div',
        {
          style: {
            flex: 'none',
            borderTop: '1px solid ' + C.border,
            background: C.layer1,
            padding: '10px 16px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
          },
        },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', order: 2 } },
          h('div', { style: { fontSize: 12, color: C.sub, flex: 'none', letterSpacing: 1 } }, '边听边问'),
          h('input', {
            type: 'text',
            value: q,
            placeholder: n ? '这一段为什么这么写？' : '想问这本书什么？',
            onChange: (ev) => setQ(ev.target.value),
            onKeyDown: (ev) => {
              if (ev.key === 'Enter') askNow();
            },
            style: {
              flex: 1,
              minWidth: 0,
              height: 36,
              padding: '0 12px',
              borderRadius: 9,
              border: '1px solid ' + C.border2,
              background: 'rgba(74, 108, 247, 0.07)',
              color: C.text,
              fontSize: 14,
              outline: 'none',
            },
          }),
          h(
            'button',
            {
              type: 'button',
              onClick: askNow,
              disabled: working,
              style: {
                flex: 'none',
                height: 36,
                padding: '0 18px',
                borderRadius: 9,
                border: '1px solid ' + C.brand,
                background: C.brand,
                color: '#ffffff',
                fontSize: 14,
                fontWeight: 600,
                cursor: working ? 'default' : 'pointer',
                opacity: working ? 0.6 : 1,
              },
            },
            working ? '问着…' : '问',
          ),
        ),
        qa.error || qa.text
          ? h(
              'div',
              {
                style: {
                  order: 1,
                  maxHeight: 132,
                  overflowY: 'auto',
                  className: 'bl-read',
                  fontSize: 14,
                  lineHeight: 1.9,
                  padding: '10px 12px',
                  borderRadius: 9,
                  background: C.bg,
                  border: '1px solid ' + C.border,
                  color: qa.error ? C.error : C.text,
                  whiteSpace: 'pre-wrap',
                },
              },
              qa.error || qa.text,
            )
          : null,
      );
    }

    function PlayerBar({ player, onClose, onNext, onPrev, hasNext, hasPrev, onPrepared, askAvailable, askOpen, onToggleAsk }) {
      const audioRef = useRef(null);
      const [ready, setReady] = useState(false);
      const [err, setErr] = useState('');
      const [phase, setPhase] = useState('audio');
      const [genText, setGenText] = useState('');
      const [cur, setCur] = useState(0);
      const [dur, setDur] = useState(0);
      const [playing, setPlaying] = useState(false);
      const [tapNeeded, setTapNeeded] = useState(false);
      const [waited, setWaited] = useState(0);

      const needLecture = Boolean(
        player &&
          player.source !== 'text' &&
          Array.isArray(player.chapters) &&
          !player.chapters.some((c) => c.n === player.n && c.hasLecture),
      );

      useEffect(() => {
        setReady(false);
        setErr('');
        setGenText('');
        setCur(0);
        setDur(0);
        setPlaying(false);
        setTapNeeded(false);
        setWaited(0);
        if (!player) return undefined;
        if (!needLecture) {
          setPhase('audio');
          return undefined;
        }
        // 这一章还没讲过：先让老师讲，讲完自动开念
        setPhase('gen');
        const ctrl = new AbortController();
        let acc = '';
        let dead = false;
        streamPost(
          LECTURE_API,
          { bookId: player.bookId, n: player.n },
          (ev) => {
            if (dead) return;
            if (ev.type === 'delta') {
              acc += ev.text || '';
              setGenText(acc);
            } else if (ev.type === 'error') {
              setErr(ev.message || ev.error || '这一章没讲出来');
            }
          },
          ctrl.signal,
        )
          .then(() => {
            if (dead) return;
            setPhase('audio');
            if (onPrepared) onPrepared();
          })
          .catch((e) => {
            if (dead) return;
            setErr((e && e.message) || String(e));
            setPhase('err');
          });
        return () => {
          dead = true;
          try {
            ctrl.abort();
          } catch (e) {
            /* 已经结束 */
          }
        };
      }, [player && player.bookId, player && player.n, needLecture]);

      // 浏览器会拦掉没经过点击的自动播放：挂载后主动试一次，被拦就把「播放」交给用户点
      useEffect(() => {
        if (phase !== 'audio' || !player) return undefined;
        let dead = false;
        const started = Date.now();
        const ticker = setInterval(() => {
          if (dead) return;
          setWaited(Math.round((Date.now() - started) / 1000));
        }, 1000);
        const timer = setTimeout(() => {
          if (dead) return;
          const a = audioRef.current;
          if (!a) return;
          claimAudio(a);
          const p = a.play();
          if (p && p.catch) p.catch(() => {
            if (!dead) setTapNeeded(true);
          });
        }, 80);
        return () => {
          dead = true;
          clearInterval(ticker);
          clearTimeout(timer);
        };
      }, [phase, player && player.bookId, player && player.n]);

      if (!player) return null;

      const src =
        TTS_API +
        '?bookId=' +
        encodeURIComponent(player.bookId) +
        '&n=' +
        player.n +
        (player.source === 'text' ? '&source=text' : '');
      const navBtn = (label, onClick, enabled, icon) =>
        h(
          'button',
          {
            onClick: onClick,
            type: 'button',
            disabled: !enabled,
            style: {
              height: 32,
              padding: '0 12px',
              borderRadius: 8,
              border: '1px solid ' + C.border2,
              background: C.bg,
              color: C.text,
              fontSize: 12.5,
              cursor: enabled ? 'pointer' : 'default',
              opacity: enabled ? 1 : 0.4,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            },
          },
          icon ? icon : null,
          label,
        );

      return h(
        'div',
        {
          style: {
            flex: 'none',
            borderTop: '1px solid ' + C.border,
            background: 'rgba(74, 108, 247, 0.07)',
            padding: '12px 16px 14px',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 } },
          h(
            'div',
            { style: { flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: C.text, lineHeight: 1.45 } },
            (player.bookTitle ? '《' + player.bookTitle + '》' : '') + '第 ' + player.n + ' 章' + (player.title ? ' · ' + player.title : ''),
            h(
              'div',
              { style: { fontSize: 11, fontWeight: 400, color: C.sub, marginTop: 2, lineHeight: 1.6 } },
              err
                ? err
                : phase === 'gen'
                  ? '这一章还没讲过，我先讲一遍，讲完自动开念…'
                  : tapNeeded && !playing
                    ? '浏览器把自动播放拦住了，点一下「播放」'
                    : ready && playing
                      ? '念完自动接下一章'
                      : '正在合成这一章的声音，第一次大约半分钟，之后就快了' +
                        (waited > 4 ? '（已等 ' + waited + ' 秒）' : '') +
                        '…',
            ),
            phase === 'gen' && genText
              ? h(
                  'div',
                  {
                    style: {
                      fontSize: 11,
                      fontWeight: 400,
                      color: C.sub,
                      marginTop: 3,
                      maxHeight: 34,
                      overflow: 'hidden',
                      lineHeight: 1.5,
                    },
                  },
                  '… ' + genText.slice(-64),
                )
              : null,
          ),
          navBtn('上一章', onPrev, hasPrev),
          navBtn(
            playing ? '暂停' : (tapNeeded ? '播放' : '暂停'),
            () => {
              const a = audioRef.current;
              if (!a) return;
              if (a.paused) {
                claimAudio(a);
                const p = a.play();
                if (p && p.catch) p.catch(() => {});
              } else {
                a.pause();
              }
            },
            phase === 'audio',
            h(MicIcon, { size: 13 }),
          ),
          navBtn('下一章', onNext, hasNext),
          askAvailable
            ? h(
                'button',
                {
                  onClick: onToggleAsk,
                  type: 'button',
                  title: askOpen ? '收起下面的提问区，讲解和阅读照常继续' : '展开提问区',
                  style: {
                    height: 32,
                    padding: '0 12px',
                    borderRadius: 8,
                    border: '1px solid ' + C.border2,
                    background: C.bg,
                    color: C.sub,
                    fontSize: 12.5,
                    cursor: 'pointer',
                  },
                },
                askOpen ? '收起提问' : '展开提问',
              )
            : null,
        ),
        phase === 'audio'
          ? h(
              'div',
              { style: { marginTop: 4 } },
              h(
                'audio',
                {
                  key: player.bookId + ':' + player.n + ':' + (needLecture ? 'g' : 'a') + ':' + (player.source === 'text' ? 't' : 'l'),
                  ref: audioRef,
                  src: src,
                  autoPlay: true,
                  preload: 'auto',
                  onCanPlay: () => setReady(true),
                  onLoadedMetadata: (ev) => {
                    const d = ev.target.duration;
                    if (d && isFinite(d)) setDur(d);
                  },
                  onDurationChange: (ev) => {
                    const d = ev.target.duration;
                    if (d && isFinite(d)) setDur(d);
                  },
                  onTimeUpdate: (ev) => setCur(ev.target.currentTime || 0),
                  onPlay: () => {
                    setReady(true);
                    setPlaying(true);
                    setTapNeeded(false);
                  },
                  onPause: () => setPlaying(false),
                  onError: () => setErr('这一章的声音放不出来'),
                  onEnded: () => {
                    setReady(false);
                    setPlaying(false);
                    if (hasNext) onNext();
                    else setErr('这本书播到最后一章了');
                  },
                  style: { width: '100%', height: 0, opacity: 0, display: 'block', margin: 0, padding: 0, overflow: 'hidden' },
                },
              ),
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 11,
                    color: C.sub,
                    marginTop: 4,
                  },
                },
                h('span', null, dur > 0 && isFinite(dur) ? fmtTime(cur) + ' / ' + fmtTime(dur) : '正在播放 · 已 ' + fmtTime(cur)),
                h(
                  'span',
                  null,
                  '第 ' + player.n + ' 章' + (player.chapters && player.chapters.length ? ' / 共 ' + player.chapters.length + ' 章' : ''),
                ),
              ),
            )
          : h(
              'div',
              { style: { fontSize: 12, color: C.sub, padding: '6px 2px' } },
              phase === 'gen' ? '正在生成讲解，生成完接着念，不用等着看字。' : '这一章没能生成讲解。',
            ),
      );
    }

    /* ---------- 一本书的卡片 ---------- */

    const COVER_COLORS = ['#4a6cf7', '#2f9e6e', '#d2754e', '#7e5bef', '#2a93a8', '#b85580', '#a5791c', '#5a6890'];

    let lastAutoScrollKey = '';

    function ReadingView({ books, onPlay, current, bookId, onRenamed, tick, scale }) {
      const [leftW, setLeftW] = useState(function () {
        try {
          const n = Number(window.localStorage.getItem('book-library.left-width'));
          return n >= 180 && n <= 560 ? n : 256;
        } catch (e) {
          return 256;
        }
      });
      const [dragHover, setDragHover] = useState(false);
      const [splitRatio, setSplitRatio] = useState(function () {
        try {
          const v = Number(window.localStorage.getItem('book-library.split'));
          return v >= 0.18 && v <= 0.82 ? v : 0.5;
        } catch (e) {
          return 0.5;
        }
      });
      const [vDragHover, setVDragHover] = useState(false);
      const splitBoxRef = useRef(null);
      const onSplitStart = useCallback((ev) => {
        if (!ev) return;
        if (ev.preventDefault) ev.preventDefault();
        const box = splitBoxRef.current;
        if (!box) return;
        const rect = box.getBoundingClientRect();
        const move = (e) => {
          if (!rect.height) return;
          const ratio = (e.clientY - rect.top) / rect.height;
          const v = Math.min(0.82, Math.max(0.18, ratio));
          setSplitRatio(v);
          try {
            window.localStorage.setItem('book-library.split', String(v));
          } catch (err) {
            /* 存不了就算了 */
          }
        };
        const up = () => {
          setVDragHover(false);
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        setVDragHover(true);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }, []);
      const dragRef = useRef(0);
      const onDragStart = useCallback(
        (ev) => {
          if (!ev) return;
          if (ev.preventDefault) ev.preventDefault();
          const k = Number(scale) || 1;
          const startX = ev.clientX;
          const startW = leftW;
          dragRef.current = startW;
          const move = (e2) => {
            const next = Math.max(180, Math.min(560, startW + (e2.clientX - startX) / k));
            dragRef.current = next;
            setLeftW(next);
          };
          const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            try {
              window.localStorage.setItem('book-library.left-width', String(Math.round(dragRef.current || startW)));
            } catch (e) {
              /* 存不上就算了 */
            }
          };
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
        },
        [leftW, scale],
      );
      const list = books || [];
      const book =
        list.filter((b) => b.id === bookId)[0] ||
        list.filter((b) => b.next)[0] ||
        list[0] ||
        null;
      const [texts, setTexts] = useState({});
      const [renaming, setRenaming] = useState(false);
      const [draft, setDraft] = useState('');
      const [gen, setGen] = useState({ n: 0, status: '', text: '', error: '' });
      const abortRef = useRef(null);

      const bookKey = book ? book.id : '';
      useEffect(() => {
        setDraft(book ? book.title : '');
      }, [bookKey]);

      const loadText = useCallback(async (id, n) => {
        setTexts((prev) =>
          Object.assign({}, prev, { [n]: Object.assign({}, prev[n] || {}, { status: 'loading' }) }),
        );
        try {
          const r = await fetch(CHAPTER_API + '?bookId=' + encodeURIComponent(id) + '&n=' + n);
          const data = await r.json();
          if (!data || !data.ok) throw new Error((data && data.error) || '这一章打不开');
          setTexts((prev) =>
            Object.assign({}, prev, {
              [n]: { status: 'done', text: data.text || '', lecture: data.lecture || '', error: '' },
            }),
          );
        } catch (e) {
          setTexts((prev) =>
            Object.assign({}, prev, {
              [n]: Object.assign({}, prev[n] || {}, { status: 'err', error: (e && e.message) || '打不开' }),
            }),
          );
        }
      }, []);

      const saveTitle = useCallback(async () => {
        if (!book) return;
        const next = String(draft || '').trim();
        if (!next || next === book.title) {
          setRenaming(false);
          setDraft(book.title);
          return;
        }
        try {
          const r = await fetch(RENAME_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId: book.id, title: next }),
          });
          const data = await r.json();
          if (!data || !data.ok) throw new Error((data && data.error) || '改名没成功');
          setRenaming(false);
          if (onRenamed) onRenamed();
        } catch (e) {
          setRenaming(false);
          setDraft(book.title);
        }
      }, [book ? book.id : '', book ? book.title : '', draft, onRenamed]);

      const genLecture = useCallback(
        async (id, n, again) => {
          if (abortRef.current) {
            try {
              abortRef.current.abort();
            } catch (e) {
              /* 上一个停了就算了 */
            }
          }
          const ctrl = new AbortController();
          abortRef.current = ctrl;
          setGen({ n: n, status: 'working', text: '', error: '' });
          let acc = '';
          try {
            await streamPost(
              LECTURE_API,
              { bookId: id, n: n, regenerate: !!again },
              (evt) => {
                if (evt.type === 'delta' && evt.text) {
                  acc += evt.text;
                  setGen({ n: n, status: 'working', text: acc, error: '' });
                } else if (evt.type === 'done') {
                  acc = evt.text || acc;
                  setGen({ n: n, status: 'done', text: acc, error: '' });
                  setTexts((prev) =>
                    Object.assign({}, prev, {
                      [n]: Object.assign({}, prev[n] || { status: 'done', text: '' }, { lecture: acc }),
                    }),
                  );
                  if (onRenamed) onRenamed();
                } else if (evt.type === 'error') {
                  setGen({ n: n, status: 'err', text: acc, error: evt.message || '没讲成' });
                }
              },
              ctrl.signal,
            );
          } catch (e) {
            setGen({ n: n, status: 'err', text: acc, error: (e && e.message) || '没讲成' });
          }
        },
        [onRenamed],
      );

      const playingN = book && current && current.bookId === book.id ? current.n : 0;

      // 右栏要显示「正在播放这一章」的讲解：换章、或讲解刚生成完（tick 变）都重新取一次
      useEffect(() => {
        if (!book || !playingN) return undefined;
        loadText(book.id, playingN);
        return undefined;
      }, [bookKey, playingN, tick, loadText]);

      if (!book) {
        return h(
          'div',
          { style: { padding: '28px 12px', textAlign: 'center', color: C.sub, fontSize: 14 } },
          '书库还是空的，先去书架导入一本。',
        );
      }

      const chapters = Array.isArray(book.chapters) ? book.chapters : [];
      const startN = book.next ? book.next.n : 1;

      const play = (n, title) => {
        onPlay({ bookId: book.id, bookTitle: book.title, n: n, title: title || '', chapters: chapters });
      };

      const titleRow = renaming
        ? h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'text',
              value: draft,
              autoFocus: true,
              onChange: (e) => setDraft(e.target.value),
              onBlur: () => saveTitle(),
              onKeyDown: (e) => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') {
                  setDraft(book.title);
                  setRenaming(false);
                }
              },
              style: {
                flex: 1,
                minWidth: 0,
                padding: '4px 8px',
                borderRadius: 7,
                border: '1px solid ' + C.brand,
                background: C.layer2,
                color: C.text,
                fontSize: 16,
                fontWeight: 600,
                outline: 'none',
              },
            }),
          )
        : h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(
              'div',
              {
                style: {
                  fontSize: 16,
                  fontWeight: 700,
                  color: C.text,
                  minWidth: 0,
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              book.title,
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  setDraft(book.title);
                  setRenaming(true);
                },
                style: {
                  flex: 'none',
                  fontSize: 12.5,
                  color: C.sub,
                  background: 'transparent',
                  border: '1px solid ' + C.border,
                  borderRadius: 6,
                  padding: '2px 7px',
                  cursor: 'pointer',
                },
              },
              '改名',
            ),
            h(
              'a',
              {
                href: EXPORT_API + '?bookId=' + encodeURIComponent(book.id),
                download: book.title + '-讲解.html',
                title: '把这本书讲过的章节装订成一份网页文件，能打印、能转发',
                style: {
                  flex: 'none',
                  fontSize: 12.5,
                  color: C.sub,
                  background: 'transparent',
                  border: '1px solid ' + C.border,
                  borderRadius: 6,
                  padding: '2px 7px',
                  cursor: 'pointer',
                  textDecoration: 'none',
                },
              },
              '导出',
            ),
          );

      const left = h(
        'div',
        { style: { width: leftW, flex: 'none', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 } },
        h(
          'div',
          {
            style: {
              border: '1px solid ' + C.border,
              background: C.layer1,
              borderRadius: 14,
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            },
          },
          titleRow,
          h(
            'div',
            { style: { fontSize: 13, color: C.sub } },
            '共 ' + book.chapterCount + ' 章 · 已讲 ' + book.readCount + ' 章',
          ),
        ),
        h(
          'div',
          {
            style: {
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingRight: 2,
            },
          },
          chapters.map((c) => {
            const playing = playingN === c.n;
            return h(
              'div',
              {
                key: c.n,
                onClick: () => play(c.n, c.title),
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 42,
                  padding: '0 10px',
                  borderRadius: 9,
                  border: '1px solid transparent',
                  background: playing ? C.layer2 : 'transparent',
                  cursor: 'pointer',
                  userSelect: 'none',
                },
              },
              h(
                'div',
                {
                  style: {
                    flex: 1,
                    minWidth: 0,
                    fontSize: 14.5,
                    color: playing || c.read ? C.text : C.sub,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                c.title || '第 ' + c.n + ' 章',
              ),
              playing
                ? h('div', { style: { fontSize: 12, color: C.brand, flex: 'none', fontWeight: 600 } }, '在听')
                : c.read
                  ? h('div', { style: { fontSize: 12, color: C.success, flex: 'none' } }, '已讲')
                  : null,
            );
          }),
        ),
      );

      const rightChapter = playingN ? chapters.filter((c) => c.n === playingN)[0] : null;
      const rt = playingN ? texts[playingN] : null;
      const genThis = gen.n === playingN;
      const rightLecture = (rt && rt.lecture) || (genThis && gen.text ? gen.text : '');
      const rightBusy = (genThis && gen.status === 'working') || (rt && rt.status === 'loading');
      const rightText = (rt && rt.text) || '';
      const rightSegments = (rt && rt.segments) || [];
      // 讲解正文里点到的段号，让下面原文对应段落淡色同步标出来，一眼对上
      const hotSegs = new Set(
        (String(rightLecture).match(/\[(\d+)\]/g) || []).map((s) => Number(s.replace(/[\[\]]/g, ''))),
      );
      // 讲解讲到哪一段，就把原文滚到哪一段（流式生成时逐段跟着走）
      const segHits = String(rightLecture).match(/\[(\d+)\]/g) || [];
      const activeSeg = segHits.length ? Number(segHits[segHits.length - 1].replace(/[\[\]]/g, '')) : 0;

      // 上块：本章讲解 —— 内容变长时自动跟到底，用户自己上滑看前面时不抢
      useEffect(() => {
        const host = document.querySelector('.bl-lecture');
        if (!host) return undefined;
        const gap = host.scrollHeight - host.scrollTop - host.clientHeight;
        if (gap < 200) host.scrollTop = host.scrollHeight;
        return undefined;
      }, [rightLecture]);

      // 点到哪一章就自动让老师讲哪一章 —— 不用再点按钮，也不用回对话里说
      const autoTriedRef = useRef('');
      useEffect(() => {
        if (!book || !playingN) return undefined;
        const autoKey = String(book.id) + ':' + String(playingN);
        if (autoTriedRef.current === autoKey) return undefined;
        if (rightLecture || rightBusy) return undefined;
        // 等 0.9 秒：播放条自己会先抓好讲解，让它先手，避免同一章生成两遍
        const timer = window.setTimeout(() => {
          autoTriedRef.current = autoKey;
          genLecture(book.id, playingN, false);
        }, 900);
        return () => {
          window.clearTimeout(timer);
        };
      }, [book, playingN, rightLecture, rightBusy, genLecture]);

      // 上块：本章讲解（插件后台跑出来的东西，就在这里体现）
      let lectureBody = null;
      if (!rightChapter) {
        lectureBody = h(
          'div',
          { style: { fontSize: 15, lineHeight: 1.9, color: C.sub } },
          '点左边任意一章，我就开始讲。',
        );
      } else if (rightLecture) {
        lectureBody = renderLecture(rightLecture);
      } else if (rightBusy) {
        lectureBody = h('div', { style: { fontSize: 15, lineHeight: 1.9, color: C.sub } }, '这一章还没讲过，正在现讲，讲完自动开念…');
      } else {
        lectureBody = h(
          'div',
          { style: { fontSize: 15, lineHeight: 1.9, color: C.sub } },
          '这一章还没讲。点右上角的「请老师讲解」，我当场讲给你听。',
        );
      }

      // 下块：文章原文 —— 只留讲解讲到的那几段，跟着讲解往下自动滚
      const focusSegs = hotSegs.size
        ? rightSegments.filter((seg) => seg.n && hotSegs.has(seg.n))
        : rightSegments;
      const textBody = !rightChapter
        ? h('div', { style: { fontSize: 15, lineHeight: 1.9, color: C.sub } }, '还没有选章节。')
        : rightText
          ? (rightSegments.length
              ? h(
                  'div',
                  { className: 'bl-textbox' },
                  hotSegs.size
                    ? h(
                        'div',
                        { style: { fontSize: 12, color: C.sub, margin: '0 0 14px', letterSpacing: 0.5 } },
                        '这里只显示老师讲到的段落（共 ' + focusSegs.length + ' 段），讲到哪段就滚到哪段。',
                      )
                    : h(
                        'div',
                        { style: { fontSize: 12, color: C.sub, margin: '0 0 14px', letterSpacing: 0.5 } },
                        '这一章的讲解没标具体段落，下面是整章原文。',
                      ),
                  focusSegs.map((seg, si) =>
                    h(
                      'div',
                      {
                        key: 'seg' + si,
                        'data-seg': seg.n || undefined,
                        ref: (el) => {
                          if (!el || !seg.n || seg.n !== activeSeg) return;
                          const key = String(book.id) + ':' + String(playingN) + ':' + String(activeSeg);
                          if (lastAutoScrollKey === key) return;
                          lastAutoScrollKey = key;
                          window.setTimeout(() => {
                            try {
                              el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                            } catch (e) {
                              /* 滚动失败不影响阅读 */
                            }
                          }, 80);
                        },
                        className: 'bl-seg' + (seg.n === activeSeg ? ' bl-hot' : ''),
                        style: {
                          margin: '0 0 18px',
                          padding: '5px 11px',
                          borderRadius: 7,
                          marginLeft: -11,
                          fontSize: 16,
                          lineHeight: 2,
                          color: C.text,
                          whiteSpace: 'pre-wrap',
                        },
                      },
                      seg.text,
                    ),
                  ),
                )
              : h(
                  'div',
                  { style: { whiteSpace: 'pre-wrap', fontSize: 16, lineHeight: 2, color: C.text } },
                  rightText,
                ))
          : h(
              'div',
              { style: { fontSize: 15, lineHeight: 1.9, color: C.sub } },
              rightBusy ? '正在打开这一章…' : '这一章的文字读不出来。',
            );

      const peekBtn = (label, onClick, enabled) =>
        h(
          'button',
          {
            type: 'button',
            onClick: onClick,
            disabled: enabled === false,
            style: {
              flex: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 26,
              padding: '0 10px',
              borderRadius: 7,
              border: '1px solid ' + C.border2,
              background: C.bg,
              color: enabled === false ? C.sub : C.text,
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: 0.5,
              cursor: enabled === false ? 'default' : 'pointer',
              opacity: enabled === false ? 0.7 : 1,
            },
          },
          h(MicIcon, { size: 12 }),
          label,
        );

      const blockHead = (label, action) =>
        h(
          'div',
          {
            style: {
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 10px 5px 18px',
              borderBottom: '1px solid ' + C.border,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 1.5,
              color: C.sub,
              background: C.layer2,
            },
          },
          h('span', { style: { flex: 1 } }, label),
          action || null,
        );

      const partition = (head, body, action, grow, bodyClass) =>
        h(
          'div',
          {
            style: {
              flex: grow,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 12,
              border: '1px solid ' + C.border,
              background: 'rgba(74, 108, 247, 0.045)',
              boxShadow: '0 1px 2px rgba(17, 24, 39, 0.04)',
              overflow: 'hidden',
            },
          },
          blockHead(head, action),
          h(
            'div',
            {
              className: bodyClass || undefined,
              style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 20px' },
            },
            body,
          ),
        );

      const canPick = Boolean(rightChapter && playingN);

      const lectureAction = canPick
        ? peekBtn(
            rightBusy ? '正在讲…' : '请老师讲解',
            () => {
              onPlay({
                bookId: book.id,
                bookTitle: book.title,
                n: playingN,
                title: rightChapter.title || '',
                chapters: chapters,
              });
            },
            !rightBusy,
          )
        : null;

      const readAction = canPick
        ? peekBtn('请老师阅读', () =>
            onPlay({
              bookId: book.id,
              bookTitle: book.title,
              n: playingN,
              title: rightChapter.title || '',
              chapters: chapters,
              source: 'text',
            }),
          )
        : null;

      const right = h(
        'div',
        { ref: splitBoxRef, style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 0 } },
        h(
          'div',
          {
            style: {
              flex: 'none',
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              paddingBottom: 8,
            },
          },
          h('div', { style: { fontSize: 12, color: C.sub, letterSpacing: 1.5 } }, '正在读'),
          rightChapter
            ? h(
                'div',
                {
                  style: {
                    fontSize: 15,
                    fontWeight: 700,
                    color: C.text,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                '第 ' + rightChapter.n + ' 章' + (rightChapter.title ? ' · ' + rightChapter.title : ''),
              )
            : null,
        ),
        partition('本章讲解', lectureBody, lectureAction, splitRatio, 'bl-lecture'),
        h('div', {
          key: 'vsplit',
          onMouseDown: onSplitStart,
          title: '上下拖动可以调大小',
          style: {
            flex: 'none',
            height: 10,
            cursor: 'row-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
          h('div', {
            style: {
              width: 46,
              height: 4,
              borderRadius: 2,
              background: vDragHover ? C.brand : C.border2,
              opacity: vDragHover ? 1 : 0.8,
            },
          }),
        ),
        partition('文章原文', textBody, readAction, 1 - splitRatio),
        genThis && gen.status === 'err'
          ? h('div', { style: { fontSize: 13, color: C.error } }, gen.error)
          : null,
      );

      const g = h('div', {
        key: 'drag',
        title: '按住往左右拖，调章节栏的宽窄',
        onMouseDown: onDragStart,
        onMouseEnter: () => setDragHover(true),
        onMouseLeave: () => setDragHover(false),
        style: {
          flex: 'none',
          width: 5,
          alignSelf: 'stretch',
          cursor: 'col-resize',
          borderRadius: 3,
          background: dragHover ? C.brand : C.border,
          opacity: dragHover ? 1 : 0.7,
          transition: 'background 0.12s, opacity 0.12s',
        },
      });

      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 12,
            alignItems: 'stretch',
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            minHeight: 0,
          },
        },
        left,
        g,
        right,
      );
    }

    function ConsultView({ books }) {
      const list = books || [];
      const [bookId, setBookId] = useState(list[0] ? list[0].id : '');
      const [text, setText] = useState('');
      const [items, setItems] = useState([]);
      const [busy, setBusy] = useState(false);
      const seqRef = useRef(0);
      const ctrlRef = useRef(null);

      useEffect(() => {
        if (!bookId && list.length) setBookId(list[0].id);
      }, [bookId, list]);

      useEffect(() => {
        return () => {
          if (ctrlRef.current) {
            try {
              ctrlRef.current.abort();
            } catch {
              /* 关页面时不追异常 */
            }
          }
        };
      }, []);

      const itemsRef = useRef(items);
      useEffect(() => {
        itemsRef.current = items;
      }, [items]);

      const ask = useCallback(async () => {
        const q = text.trim();
        if (!q || busy) return;
        const history = [];
        itemsRef.current
          .filter((it) => it.status === 'done' && it.a)
          .slice(-4)
          .forEach((it) => {
            history.push({ role: 'user', text: it.q });
            history.push({ role: 'assistant', text: it.a });
          });
        const seq = seqRef.current++;
        setText('');
        setBusy(true);
        const ctrl = new AbortController();
        ctrlRef.current = ctrl;
        setItems((prev) => prev.concat([{ seq, q, a: '', status: 'working', error: '' }]));
        let acc = '';
        const patch = (part) =>
          setItems((prev) => prev.map((it) => (it.seq === seq ? Object.assign({}, it, part) : it)));
        try {
          await streamPost(
            CONSULT_API,
            { bookId: bookId, question: q, history: history },
            (evt) => {
              if (evt.type === 'delta' && evt.text) {
                acc += evt.text;
                patch({ a: acc });
              } else if (evt.type === 'done') {
                patch({ a: evt.text || acc, status: 'done' });
              } else if (evt.type === 'error') {
                throw new Error(evt.message || '没答上来');
              }
            },
            ctrl.signal,
          );
        } catch (err) {
          const msg = err && err.name === 'AbortError' ? '停下了。' : (err && err.message) || String(err);
          patch({ status: 'err', error: msg });
        } finally {
          if (ctrlRef.current === ctrl) ctrlRef.current = null;
          setBusy(false);
        }
      }, [bookId, busy, text]);

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: { fontSize: 15, fontWeight: 700 } }, '即时答疑'),
        h(
          'div',
          { style: { fontSize: 12, color: C.sub, lineHeight: 1.75 } },
          '读到哪儿卡住、或者想到个事想问，直接问。我按这本书的内容答；书里没写的，我会说清哪句是我自己的看法。',
        ),
        list.length
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 6,
                  paddingBottom: 2,
                },
              },
              h('div', { style: { fontSize: 12, color: C.sub, flex: 'none' } }, '在问'),
              list.map((b, bi) => {
                const on = b.id === bookId;
                const color = COVER_COLORS[bi % COVER_COLORS.length];
                return h(
                  'button',
                  {
                    key: b.id,
                    type: 'button',
                    title: b.title,
                    onClick: () => setBookId(b.id),
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flex: 'none',
                      maxWidth: 190,
                      padding: '3px 9px 3px 3px',
                      borderRadius: 9,
                      border: '1px solid ' + (on ? C.brand : C.border),
                      background: on ? C.layer2 : 'transparent',
                      cursor: 'pointer',
                    },
                  },
                  h(
                    'div',
                    {
                      style: {
                        width: 24,
                        height: 32,
                        borderRadius: 4,
                        flex: 'none',
                        background: color + '14',
                        border: '1px solid ' + color + '22',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: color,
                        fontSize: 12,
                        fontWeight: 700,
                      },
                    },
                    String(b.title || '书').slice(0, 1),
                  ),
                  h(
                    'div',
                    {
                      style: {
                        fontSize: 12,
                        color: on ? C.text : C.sub,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    },
                    b.title,
                  ),
                );
              }),
            )
          : h('div', { style: { fontSize: 12, color: C.sub } }, '书架还空着，先去导入一本书。'),
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h('input', {
            value: text,
            placeholder: '想问什么？写完按回车',
            onChange: (ev) => setText(ev.target.value),
            onKeyDown: (ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                ask();
              }
            },
            style: {
              flex: 1,
              minWidth: 0,
              padding: '9px 11px',
              borderRadius: 9,
              border: '1px solid ' + C.border,
              background: 'rgba(74, 108, 247, 0.07)',
              color: C.text,
              fontSize: 13,
              outline: 'none',
            },
          }),
          h(
            'button',
            {
              onClick: ask,
              type: 'button',
              disabled: busy || !text.trim(),
              style: {
                flex: 'none',
                padding: '9px 16px',
                borderRadius: 9,
                border: '1px solid ' + C.brand,
                background: C.brand,
                color: '#ffffff',
                fontSize: 13,
                fontWeight: 600,
                cursor: busy || !text.trim() ? 'default' : 'pointer',
                opacity: busy || !text.trim() ? 0.55 : 1,
              },
            },
            busy ? '在想…' : '问',
          ),
        ),
        items.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 2 } },
              items
                .slice()
                .reverse()
                .map((it) =>
                  h(
                    'div',
                    {
                      key: it.seq,
                      style: {
                        padding: '10px 12px',
                        borderRadius: 10,
                        border: '1px solid ' + C.border,
                        background: C.layer1,
                      },
                    },
                    h(
                      'div',
                      { style: { fontSize: 13, fontWeight: 600, lineHeight: 1.6, color: C.text } },
                      '你问：' + it.q,
                    ),
                    it.status === 'working' && !it.a
                      ? h('div', { style: { fontSize: 12, color: C.sub, marginTop: 6 } }, '在想…')
                      : null,
                    it.a
                      ? h(
                          'div',
                          {
                            style: {
                              fontSize: 13,
                              lineHeight: 1.9,
                              marginTop: 7,
                              whiteSpace: 'pre-wrap',
                              color: C.text,
                              wordBreak: 'break-word',
                            },
                          },
                          it.a,
                        )
                      : null,
                    it.status === 'err'
                      ? h('div', { style: { fontSize: 12, color: C.error, marginTop: 6, lineHeight: 1.7 } }, it.error)
                      : null,
                  ),
                ),
            )
          : null,
      );
    }

    function SettingsView({ voice, onSaved, scale, onScale }) {
      const v = voice || {};
      const [form, setForm] = useState(null);
      const [saving, setSaving] = useState(false);
      const [testing, setTesting] = useState(false);
      const [msg, setMsg] = useState(null);
      const [pref, setPref] = useState('');
      const [prefMsg, setPrefMsg] = useState('');
      const [prefSaving, setPrefSaving] = useState(false);

      useEffect(() => {
        let alive = true;
        fetch(PREFERENCE_API)
          .then((r) => r.json())
          .then((d) => {
            if (alive && d && d.ok) setPref(String(d.preference || ''));
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      const savePref = useCallback(async () => {
        setPrefSaving(true);
        setPrefMsg('');
        try {
          const res = await fetch(PREFERENCE_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preference: pref }),
          });
          const data = await res.json();
          if (!data || !data.ok) throw new Error((data && data.error) || '没存进去');
          setPrefMsg('已记下。以后讲这一章、答疑都按这个来。');
        } catch (err) {
          setPrefMsg('没存成：' + ((err && err.message) || String(err)));
        } finally {
          setPrefSaving(false);
        }
      }, [pref]);

      useEffect(() => {
        if (!voice) return;
        setForm({
          source: v.source === 'system' ? 'system' : 'volc',
          voice: v.voice || '',
          customVoice: '',
          systemVoice: v.systemVoice || 'Tingting',
          rate: Number(v.rate) || 1,
          loudness: Number(v.loudness) || 1,
          emotion: v.emotion || '',
          sampleRate: Number(v.sampleRate) || 24000,
          appId: '',
          cluster: v.cluster || 'seed-tts-2.0',
          key: '',
        });
      }, [voice]);

      const set = useCallback((k, val) => {
        setForm((f) => (f ? Object.assign({}, f, { [k]: val }) : f));
      }, []);

      const payloadOf = useCallback(
        (f) => {
          const eff = String(f.customVoice || '').trim() || f.voice;
          const out = {
            source: f.source,
            voice: eff,
            systemVoice: f.systemVoice,
            rate: Number(f.rate),
            loudness: Number(f.loudness),
            emotion: '',
            sampleRate: Number(f.sampleRate),
            cluster: String(f.cluster || '').trim() || 'seed-tts-2.0',
          };
          if (String(f.appId || '').trim()) out.appId = String(f.appId).trim();
          if (String(f.key || '').trim()) out.key = String(f.key).trim();
          return out;
        },
        [],
      );

      const doSave = useCallback(async () => {
        if (!form) return;
        setSaving(true);
        setMsg(null);
        try {
          const data = await saveVoice(form ? payloadOf(form) : {});
          if (onSaved) onSaved(data);
          setForm((f) => (f ? Object.assign({}, f, { key: '', appId: '', customVoice: '' }) : f));
          setMsg({ kind: 'ok', text: '存好了。已经念过的章会按新的声音重新合成一次。' });
        } catch (err) {
          setMsg({ kind: 'err', text: (err && err.message) || String(err) });
        } finally {
          setSaving(false);
        }
      }, [form, onSaved, payloadOf]);

      const doTest = useCallback(async () => {
        if (!form) return;
        setTesting(true);
        setMsg(null);
        try {
          const res = await fetch(PROBE_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payloadOf(form)),
          });
          const type = res.headers.get('content-type') || '';
          if (!res.ok || type.indexOf('json') >= 0) {
            const data = await res.json().catch(() => null);
            throw new Error((data && (data.error || data.hint)) || '试听没成');
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => {
            URL.revokeObjectURL(url);
            if (activeAudioEl === audio) activeAudioEl = null;
          };
          claimAudio(audio);
          audio.play().catch(() => {});
          setMsg({ kind: 'ok', text: '在念了，听听这一段。' });
        } catch (err) {
          setMsg({ kind: 'err', text: (err && err.message) || String(err) });
        } finally {
          setTesting(false);
        }
      }, [form, payloadOf]);

      const box = {
        padding: '7px 9px',
        borderRadius: 8,
        border: '1px solid ' + C.border,
        background: 'rgba(74, 108, 247, 0.07)',
        color: C.text,
        fontSize: 13,
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
      };
      const row = (title, control, hint) =>
        h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'flex-start', paddingTop: 2 } },
          h('div', { style: { fontSize: 12, color: C.sub, width: 74, flex: 'none', paddingTop: 8 } }, title),
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 } },
            control,
            hint ? h('div', { style: { fontSize: 11, color: C.sub, lineHeight: 1.6 } }, hint) : null,
          ),
        );
      const group = (title) =>
        h('div', { style: { fontSize: 12, fontWeight: 600, letterSpacing: 1.5, color: C.sub, marginTop: 8 } }, title);
      const slider = (k, min, max, step, suffix) =>
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 9 } },
          h('input', {
            type: 'range',
            min: min,
            max: max,
            step: step,
            value: form[k],
            onChange: (ev) => set(k, Number(ev.target.value)),
            style: { flex: 1, minWidth: 0, accentColor: C.brand },
          }),
          h(
            'div',
            { style: { fontSize: 12, color: C.text, width: 46, textAlign: 'right', flex: 'none' } },
            Number(form[k]).toFixed(2) + (suffix || ''),
          ),
        );

      if (!form) {
        return h('div', { style: { fontSize: 12, color: C.sub, padding: '8px 2px' } }, '正在读设置…');
      }

      const isVolc = form.source === 'volc';
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: { fontSize: 15, fontWeight: 700 } }, '设置'),
        h(
          'div',
          { style: { fontSize: 12, color: C.sub, lineHeight: 1.75 } },
          '讲每一章用哪个模型、念出来用哪个声音，都在这儿定。文本那一路用的是 DSH 当前的默认模型，不在这儿改。',
        ),
        h(
          'div',
          {
            style: {
              padding: '12px 13px',
              borderRadius: 10,
              border: '1px solid ' + C.border,
              background: C.layer1,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            },
          },
          group('你希望我怎么讲'),
          h('textarea', {
            value: pref,
            onChange: (ev) => setPref(ev.target.value),
            rows: 4,
            placeholder: '比如：少讲文学术语，多说人话；多举生活里的例子；别替我总结，把话说完整。',
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              minHeight: 76,
              padding: '9px 11px',
              borderRadius: 9,
              border: '1px solid ' + C.border2,
              background: C.bg,
              color: C.text,
              fontSize: 13.5,
              lineHeight: 1.75,
              outline: 'none',
            },
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h(
              'button',
              {
                type: 'button',
                onClick: savePref,
                disabled: prefSaving,
                style: {
                  height: 32,
                  padding: '0 16px',
                  borderRadius: 8,
                  border: 'none',
                  background: C.brand,
                  color: '#ffffff',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: prefSaving ? 'default' : 'pointer',
                },
              },
              prefSaving ? '存着…' : '记下来',
            ),
            h(
              'span',
              { style: { fontSize: 12, color: String(prefMsg).indexOf('没存成') === 0 ? C.error : C.success } },
              prefMsg,
            ),
          ),
          h(
            'div',
            { style: { fontSize: 11.5, color: C.sub, lineHeight: 1.7 } },
            '讲解和答疑都按这里的说法来。写一句也行，不写就按默认的讲法。',
          ),
        ),
        h(
          'div',
          {
            style: {
              padding: '12px 13px',
              borderRadius: 10,
              border: '1px solid ' + C.border,
              background: C.layer1,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            },
          },
          group('看字的字号'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 14 } },
            h('input', {
              type: 'range',
              min: 0.8,
              max: 1.6,
              step: 0.05,
              value: Number(scale) || 1,
              onChange: (ev) => {
                if (onScale) onScale(Number(ev.target.value));
              },
              style: { flex: 1, minWidth: 0, accentColor: C.brand, cursor: 'pointer' },
            }),
            h(
              'div',
              {
                style: {
                  flex: 'none',
                  minWidth: 66,
                  textAlign: 'right',
                  fontSize: 16,
                  fontWeight: 600,
                  color: C.brand,
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              (Number(scale) || 1).toFixed(2) + '×',
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  if (onScale) onScale(1);
                },
                title: '回到标准大小',
                style: {
                  flex: 'none',
                  height: 34,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: '1px solid ' + C.border,
                  background: C.layer2,
                  color: C.text,
                  fontSize: 13,
                  cursor: 'pointer',
                },
              },
              '标准',
            ),
          ),
          h(
            'div',
            { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.7 } },
            '往左拖字变小，往右拖字变大，数字就是放大的倍数。改了马上生效，不用按保存；只管书库这一块，不影响 DSH 别的地方。',
          ),
        ),
        h(
          'div',
          {
            style: {
              padding: '12px 13px',
              borderRadius: 10,
              border: '1px solid ' + C.border,
              background: C.layer1,
              display: 'flex',
              flexDirection: 'column',
              gap: 11,
            },
          },
          row(
            '声音来源',
            h(
              'select',
              {
                value: form.source,
                onChange: (ev) => set('source', ev.target.value),
                style: box,
              },
              (v.sources || []).map((it) => h('option', { key: it.id, value: it.id }, it.name)),
            ),
          ),
          isVolc
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 11 } },
                group('音色'),
                row(
                  '音色',
                  h(
                    'select',
                    {
                      value: form.voice,
                      onChange: (ev) => set('voice', ev.target.value),
                      style: box,
                    },
                    (v.voices || []).map((it) => h('option', { key: it.id, value: it.id }, it.name)),
                  ),
                  '想用别的豆包音色，把音色名填在下面这行，会盖掉上面的选择。',
                ),
                row(
                  '自定义音色',
                  h('input', {
                    value: form.customVoice,
                    placeholder: '留空就用上面选的',
                    onChange: (ev) => set('customVoice', ev.target.value),
                    style: box,
                  }),
                ),
                group('念得快慢轻重'),
                row('语速', slider('rate', 0.5, 2, 0.05, '×')),
                row('音量', slider('loudness', 0.5, 2, 0.05, '×')),
                row(
                  '采样率',
                  h(
                    'select',
                    {
                      value: form.sampleRate,
                      onChange: (ev) => set('sampleRate', Number(ev.target.value)),
                      style: box,
                    },
                    (v.sampleRates || [24000]).map((it) => h('option', { key: it, value: it }, it + ' Hz')),
                  ),
                ),
                group('豆包接口'),
                row(
                  '应用号',
                  h('input', {
                    value: form.appId,
                    placeholder: v.hasAppId ? '已存（留空不改）' : '填火山的 App ID',
                    onChange: (ev) => set('appId', ev.target.value),
                    style: box,
                  }),
                ),
                row(
                  '版本号',
                  h('input', {
                    value: form.cluster,
                    placeholder: 'seed-tts-2.0',
                    onChange: (ev) => set('cluster', ev.target.value),
                    style: box,
                  }),
                  '豆包 2.0 就填 seed-tts-2.0。',
                ),
                row(
                  '钥匙',
                  h('input', {
                    type: 'password',
                    value: form.key,
                    placeholder: v.hasKey ? '已存（留空不改）' : '填 Access Key',
                    onChange: (ev) => set('key', ev.target.value),
                    style: box,
                  }),
                  '只存在本机，不会传出去。',
                ),
              )
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 11 } },
                row(
                  '系统音色',
                  h(
                    'select',
                    {
                      value: form.systemVoice,
                      onChange: (ev) => set('systemVoice', ev.target.value),
                      style: box,
                    },
                    (v.systemVoices || []).map((it) => h('option', { key: it.id, value: it.id }, it.name)),
                  ),
                ),
                row('语速', slider('rate', 0.5, 2, 0.05, '×')),
                h(
                  'div',
                  { style: { fontSize: 11.5, color: C.sub, lineHeight: 1.7 } },
                  '系统朗读不联网、不花钱，声音没豆包自然。想听人味儿的就切回豆包。',
                ),
              ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h(
            'button',
            {
              onClick: doTest,
              type: 'button',
              disabled: testing || saving,
              style: {
                padding: '7px 14px',
                borderRadius: 8,
                border: '1px solid ' + C.border,
                background: C.layer1,
                color: C.text,
                fontSize: 12.5,
                cursor: testing ? 'default' : 'pointer',
                opacity: testing ? 0.6 : 1,
              },
            },
            testing ? '正在念…' : '试听',
          ),
          h(
            'button',
            {
              onClick: doSave,
              type: 'button',
              disabled: saving || testing,
              style: {
                padding: '7px 16px',
                borderRadius: 8,
                border: '1px solid ' + C.brand,
                background: C.brand,
                color: '#ffffff',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: saving ? 'default' : 'pointer',
                opacity: saving ? 0.6 : 1,
              },
            },
            saving ? '保存中…' : '保存',
          ),
          msg
            ? h(
                'div',
                {
                  style: {
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: msg.kind === 'err' ? C.error : C.success,
                    flex: 1,
                    minWidth: 0,
                  },
                },
                msg.text,
              )
            : null,
        ),
      );
    }

    function BookCard({ book, index, selected, onSelect, onDelete, onRenamed }) {
      /* 苹果「图书」式书架：封面为主、书脊、柔和投影；右上三点菜单（改名 / 删除 / 内容简介） */
      const color = COVER_COLORS[(index || 0) % COVER_COLORS.length];
      const [menu, setMenu] = useState(false);
      const [intro, setIntro] = useState(false);
      const [renaming, setRenaming] = useState(false);
      const [draft, setDraft] = useState(book.title || '');
      const [saving, setSaving] = useState(false);
      const [err, setErr] = useState('');

      const saveTitle = async () => {
        const t = String(draft || '').trim();
        if (!t) {
          setErr('书名不能空着');
          return;
        }
        if (t === book.title) {
          setRenaming(false);
          setErr('');
          return;
        }
        setSaving(true);
        setErr('');
        try {
          const res = await fetch(RENAME_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId: book.id, title: t }),
          });
          const data = await res.json().catch(() => null);
          if (!res.ok || !data || data.ok === false) {
            throw new Error((data && (data.error || data.hint)) || '改名没成功，再试一次');
          }
          setRenaming(false);
          if (onRenamed) onRenamed();
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setSaving(false);
        }
      };

      const cell = {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 9,
        padding: '10px 10px 12px',
        borderRadius: 12,
        border: '1px solid ' + (selected ? C.brand : 'transparent'),
        background: selected ? color + '1e' : color + '0e',
        minWidth: 0,
        cursor: 'pointer',
      };

      const cover = {
        width: '100%',
        aspectRatio: '2 / 3',
        borderRadius: 5,
        background: 'linear-gradient(160deg, ' + color + '2e 0%, ' + color + '12 100%)',
        border: '1px solid ' + color + '26',
        boxShadow: '0 1px 1px rgba(17, 24, 39, 0.05), 0 6px 16px rgba(17, 24, 39, 0.10)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: color,
        fontSize: 31,
        fontWeight: 700,
        flex: 'none',
        position: 'relative',
        overflow: 'hidden',
      };

      const toggleMenu = (ev) => {
        ev.stopPropagation();
        setMenu((v) => !v);
      };

      const menuRow = (label, onClick, danger) =>
        h(
          'button',
          {
            type: 'button',
            onClick: (ev) => {
              ev.stopPropagation();
              setMenu(false);
              onClick();
            },
            style: {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 12px',
              border: 'none',
              borderRadius: 7,
              background: 'transparent',
              color: danger ? C.error : C.text,
              fontSize: 13,
              cursor: 'pointer',
            },
          },
          label,
        );

      const chapters = Array.isArray(book.chapters) ? book.chapters : [];
      const introLines = [];
      introLines.push('共 ' + (book.chapterCount || 0) + ' 章，已经讲过 ' + (book.readCount || 0) + ' 章。');
      if (book.importedAt) {
        const d = new Date(book.importedAt);
        if (!isNaN(d.getTime())) {
          introLines.push('导入于 ' + d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日。');
        }
      }
      if (chapters.length) {
        introLines.push('');
        introLines.push('开头几章：');
        chapters.slice(0, 8).forEach((c) => {
          introLines.push('　' + String(c.n).padStart(2, '0') + '　' + (c.title || '（未命名）'));
        });
        if (chapters.length > 8) {
          introLines.push('　……后面还有 ' + (chapters.length - 8) + ' 章');
        }
      }

      return h(
        'div',
        {
          className: 'bl-card',
          style: cell,
          onClick: () => {
            if (menu) {
              setMenu(false);
              return;
            }
            if (onSelect) onSelect(book.id);
          },
        },
        h(
          'div',
          { style: cover },
          h('div', {
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 6,
              background: 'linear-gradient(90deg, rgba(17,24,39,0.10), rgba(17,24,39,0))',
            },
          }),
          String(book.title || '书').slice(0, 1),
          book.chapterCount > 0
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: 4,
                    background: 'rgba(255,255,255,0.55)',
                  },
                },
                h('div', {
                  style: {
                    width: Math.round((100 * (book.readCount || 0)) / book.chapterCount) + '%',
                    height: '100%',
                    background: color,
                  },
                }),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              onClick: toggleMenu,
              style: {
                position: 'absolute',
                right: 3,
                top: 3,
                width: 22,
                height: 22,
                padding: 0,
                border: 'none',
                borderRadius: 11,
                background: 'rgba(255,255,255,0.72)',
                color: C.sub,
                fontSize: 13,
                lineHeight: '22px',
                textAlign: 'center',
                cursor: 'pointer',
                letterSpacing: 1,
              },
            },
            '⋯',
          ),
          selected
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    left: 7,
                    bottom: 9,
                    width: 15,
                    height: 15,
                    borderRadius: 8,
                    background: '#ffffff',
                    color: color,
                    fontSize: 11,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                },
                '✓',
              )
            : null,
        ),
        renaming
          ? h(
              'div',
              { style: { width: '100%', display: 'flex', flexDirection: 'column', gap: 4 } },
              h('input', {
                value: draft,
                autoFocus: true,
                onChange: (ev) => setDraft(ev.target.value),
                onClick: (ev) => ev.stopPropagation(),
                onKeyDown: (ev) => {
                  if (ev.key === 'Enter') saveTitle();
                  if (ev.key === 'Escape') setRenaming(false);
                },
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  height: 30,
                  padding: '0 8px',
                  borderRadius: 7,
                  border: '1px solid ' + C.brand,
                  background: C.bg,
                  color: C.text,
                  fontSize: 12.5,
                },
              }),
              err ? h('div', { style: { fontSize: 11, color: C.error } }, err) : null,
              h(
                'div',
                { style: { display: 'flex', gap: 4 } },
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: saving,
                    onClick: (ev) => {
                      ev.stopPropagation();
                      saveTitle();
                    },
                    style: {
                      flex: 1,
                      height: 26,
                      border: 'none',
                      borderRadius: 6,
                      background: C.brand,
                      color: '#ffffff',
                      fontSize: 11.5,
                      cursor: saving ? 'default' : 'pointer',
                      opacity: saving ? 0.6 : 1,
                    },
                  },
                  saving ? '存着…' : '存',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: (ev) => {
                      ev.stopPropagation();
                      setRenaming(false);
                      setErr('');
                    },
                    style: {
                      flex: 1,
                      height: 26,
                      border: '1px solid ' + C.border,
                      borderRadius: 6,
                      background: 'transparent',
                      color: C.sub,
                      fontSize: 11.5,
                      cursor: 'pointer',
                    },
                  },
                  '算了',
                ),
              ),
            )
          : h(
              'div',
              {
                style: {
                  width: '100%',
                  fontSize: 12.5,
                  fontWeight: selected ? 700 : 500,
                  lineHeight: 1.5,
                  textAlign: 'center',
                  color: C.text,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  wordBreak: 'break-word',
                },
              },
              book.title,
            ),
        menu
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: 6,
                  right: 6,
                  width: 132,
                  padding: 4,
                  borderRadius: 10,
                  border: '1px solid ' + C.border,
                  background: C.bg,
                  boxShadow: '0 8px 24px rgba(17, 24, 39, 0.16)',
                  zIndex: 40,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                },
                onClick: (ev) => ev.stopPropagation(),
              },
              menuRow('更改书名', () => {
                setDraft(book.title || '');
                setRenaming(true);
              }),
              menuRow(
                '删除这本书',
                () => {
                  if (onDelete) onDelete(book);
                },
                true,
              ),
              menuRow('内容简介', () => setIntro(true)),
            )
          : null,
        intro
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: 'rgba(17, 24, 39, 0.38)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 99,
                  padding: 24,
                },
                onClick: (ev) => {
                  ev.stopPropagation();
                  setIntro(false);
                },
              },
              h(
                'div',
                {
                  onClick: (ev) => ev.stopPropagation(),
                  style: {
                    width: 420,
                    maxWidth: '100%',
                    maxHeight: '72vh',
                    overflowY: 'auto',
                    padding: '22px 24px 18px',
                    borderRadius: 14,
                    border: '1px solid ' + C.border,
                    background: C.bg,
                    boxShadow: '0 18px 50px rgba(17, 24, 39, 0.26)',
                  },
                },
                h(
                  'div',
                  { style: { fontSize: 17, fontWeight: 700, color: C.text, lineHeight: 1.5, marginBottom: 10 } },
                  book.title,
                ),
                h(
                  'div',
                  { style: { fontSize: 13.5, lineHeight: 1.85, color: C.text, whiteSpace: 'pre-wrap', marginBottom: 16 } },
                  introLines.join('\n'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: (ev) => {
                      ev.stopPropagation();
                      setIntro(false);
                    },
                    style: {
                      height: 34,
                      padding: '0 18px',
                      borderRadius: 8,
                      border: 'none',
                      background: C.brand,
                      color: '#ffffff',
                      fontSize: 13,
                      cursor: 'pointer',
                    },
                  },
                  '知道了',
                ),
              ),
            )
          : null,
      );
    }

    /* ---------- 出错兜底：面板崩了也要把原因显示出来，不能一片空白 ---------- */

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { err: null };
      }

      static getDerivedStateFromError(err) {
        return { err: err };
      }

      componentDidCatch(err) {
        try {
          console.error('[book-library]', err);
        } catch (e) {
          /* 忽略 */
        }
      }

      render() {
        if (this.state.err) {
          const msg = String((this.state.err && this.state.err.message) || this.state.err || '未知错误');
          return h(
            'div',
            {
              className: 'bl-root',
              style: {
                padding: '22px 20px',
                fontFamily: FONT_FAMILY,
                color: C.error,
                fontSize: 14,
                lineHeight: 1.9,
                height: '100%',
                boxSizing: 'border-box',
                overflowY: 'auto',
              },
            },
            h('div', { style: { fontWeight: 700, marginBottom: 8 } }, '书库面板出错了'),
            h('div', { style: { wordBreak: 'break-word' } }, msg),
            h('div', { style: { marginTop: 12, color: C.sub, fontSize: 13 } }, '把这句话告诉助手，就能修。'),
          );
        }
        return this.props.children;
      }
    }

    function BookLibraryPanel() {
      const [state, setState] = useState({ status: 'loading', data: null, error: '' });
      const [imp, setImp] = useState({ kind: 'idle', text: '' });
      const [voice, setVoice] = useState(null);
      const [nav, setNav] = useState('shelf');
      const [focus, setFocus] = useState(null);
      const [tick, setTick] = useState(0);
      const [player, setPlayer] = useState(null);
      const [askOpen, setAskOpen] = useState(true);
      const [scale, setScale] = useState(function () {
        try {
          const raw = window.localStorage.getItem('book-library.font-scale');
          const n = Number(raw);
          return n >= 0.85 && n <= 1.6 ? n : 1;
        } catch (e) {
          return 1;
        }
      });
      const changeScale = useCallback((val) => {
        const n = Math.min(1.6, Math.max(0.8, Number(val) || 1));
        setScale(n);
        try {
          window.localStorage.setItem('book-library.font-scale', String(n));
        } catch (e) {
          /* 存不上就算了，这一轮照样生效 */
        }
      }, []);
      const [selectedBookId, setSelectedBookId] = useState('');
      const fileRef = useRef(null);

      const load = useCallback(async () => {
        setState((prev) => ({ status: 'loading', data: prev.data, error: '' }));
        try {
          const data = await fetchBooks();
          setState({ status: 'ready', data, error: '' });
        } catch (err) {
          setState({ status: 'error', data: null, error: (err && err.message) || String(err) });
        }
      }, []);

      useEffect(() => {
        load();
        fetchVoice()
          .then(setVoice)
          .catch(() => setVoice(null));
      }, [load]);

      const onCopy = useCallback(async (text) => copyText(text), []);

      const removeBook = useCallback(
        async (book) => {
          const name = (book && book.title) || '这本书';
          if (!window.confirm('把《' + name + '》从书架删掉？书里讲过的内容会一起移走。')) return;
          try {
            const res = await fetch(DELETE_API, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ bookId: book.id }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data || !data.ok) {
              throw new Error((data && data.error) || '没删成，权限或文件被占用了');
            }
            setSelectedBookId((cur) => (cur === book.id ? '' : cur));
            setPlayer((cur) => (cur && cur.bookId === book.id ? null : cur));
            await load();
          } catch (err) {
            window.alert('没删成：' + ((err && err.message) || String(err)));
          }
        },
        [load],
      );

      const busy = imp.kind === 'working';

      const pickFile = useCallback(() => {
        if (busy) return;
        if (fileRef.current) fileRef.current.click();
      }, [busy]);

      const onFileChange = useCallback(
        async (ev) => {
          const target = ev && ev.target;
          const file = target && target.files && target.files[0];
          if (target) target.value = '';
          if (!file) return;
          setImp({ kind: 'working', text: '正在拆章节：《' + file.name + '》，大文件要等一会儿，先别关这个面板。' });
          try {
            const data = await uploadBookFile(file);
            if (data && data.ok) {
              setImp({
                kind: 'ok',
                text:
                  '已进书架：《' + (data.title || file.name) + '》，共 ' + (data.chapterCount || 0) + ' 章' +
                  (data.skipped ? '（这本之前导过、内容没变，没有重复拆）' : ''),
              });
              await load();
            } else {
              setImp({
                kind: 'err',
                text:
                  '没导进来：' +
                  ((data && (data.error || data.hint)) || '原因不明') +
                  (data && data.hint && data.error ? '（' + data.hint + '）' : ''),
              });
            }
          } catch (err) {
            setImp({ kind: 'err', text: '上传中断：' + ((err && err.message) || String(err)) });
          }
        },
        [load],
      );

      const playingBook = useCallback(() => {
        if (!player) return null;
        const books = (state.data && state.data.books) || [];
        return books.find((b) => b.id === player.bookId) || null;
      }, [player, state.data]);

      const playableOf = useCallback((chapters, dir, fromN) => {
        if (!Array.isArray(chapters)) return null;
        const list = chapters
          .filter((c) => (dir > 0 ? c.n > fromN : c.n < fromN))
          .sort((a, b) => (dir > 0 ? a.n - b.n : b.n - a.n));
        return list[0] || null;
      }, []);

      const step = useCallback(
        (dir) => {
          if (!player) return;
          const nextOne = playableOf(player.chapters, dir, player.n);
          if (!nextOne) {
            if (dir > 0) setImp({ kind: 'ok', text: '这本书能听的就到这一章了' });
            return;
          }
          setPlayer({
            bookId: player.bookId,
            bookTitle: player.bookTitle,
            n: nextOne.n,
            title: nextOne.title,
            chapters: player.chapters,
          });
        },
        [player, playableOf],
      );

      const onPlay = useCallback((p) => {
        try {
          document.querySelectorAll('.bl-root audio').forEach((a) => { try { a.pause(); } catch (e) {} });
        } catch (e) {}
        setPlayer(p);
      }, []);

      const books = (state.data && state.data.books) || [];
      const totalChapters = books.reduce((s, b) => s + b.chapterCount, 0);
      const totalRead = books.reduce((s, b) => s + b.readCount, 0);

      let body;
      if (state.status === 'loading' && !state.data) {
        body = h('div', { style: { padding: '28px 0', textAlign: 'center', color: C.sub, fontSize: 13 } }, '正在翻书库…');
      } else if (state.status === 'error') {
        body = h(
          'div',
          { style: { padding: '18px 14px', background: C.layer1, border: '1px solid ' + C.border, borderRadius: 12 } },
          h('div', { style: { fontSize: 13, fontWeight: 600, color: C.error, marginBottom: 6 } }, '书库没打开'),
          h('div', { style: { fontSize: 12, color: C.sub, lineHeight: 1.6, wordBreak: 'break-all' } }, state.error),
          h(
            'button',
            {
              onClick: load,
              type: 'button',
              style: {
                marginTop: 10,
                padding: '7px 12px',
                borderRadius: 8,
                border: '1px solid ' + C.border2,
                background: C.layer2,
                color: C.text,
                fontSize: 12,
                cursor: 'pointer',
              },
            },
            '再试一次',
          ),
        );
      } else if (books.length === 0) {
        body = h(
          'div',
          { style: { padding: '26px 16px', textAlign: 'center' } },
          h('div', { style: { fontSize: 34, lineHeight: 1, marginBottom: 12 } }, '📚'),
          h('div', { style: { fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 8 } }, '书库还是空的'),
          h(
            'div',
            { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.75, textAlign: 'left' } },
            '点左下角的「＋ 导入」，从电脑里挑一本书：',
            h(
              'div',
              {
                style: {
                  margin: '8px 0',
                  padding: '8px 10px',
                  background: C.layer1,
                  border: '1px solid ' + C.border,
                  borderRadius: 8,
                  color: C.text,
                  lineHeight: 1.8,
                },
              },
              'EPUB / TXT / Markdown 三种格式',
              h('br'),
              '导入时会拆成章节，几十页的书大概十几秒',
              h('br'),
              '导进来就能看读到第几章、还能听讲解',
            ),
            'PDF 这一版还导不了；真要在手机上读，先用看书软件导成 EPUB 再放进来。',
          ),
        );
      } else if (nav === 'consult') {
        body = h(ConsultView, { books });
      } else if (nav === 'reading') {
        body = h(ReadingView, {
          books: books,
          onPlay: onPlay,
          current: player,
          bookId: selectedBookId,
          onRenamed: load,
          tick: tick,
          scale: scale,
        });
      } else {
        body = h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              gap: 16,
              width: '100%',
            },
          },
          books.map((b, bi) =>
            h(BookCard, {
              key: b.id,
              book: b,
              index: bi,
              selected: b.id === selectedBookId,
              onSelect: (id) => {
                setSelectedBookId(id);
                setNav('reading');
              },
              onDelete: removeBook,
              onRenamed: load,
            }),
          ),
        );
      }

      const pBook = playingBook();
      const hasNext = Boolean(player && playableOf(player.chapters, 1, player.n));
      const hasPrev = Boolean(player && playableOf(player.chapters, -1, player.n));

      const navButton = (label, key) =>
        h(
          'button',
          {
            key,
            type: 'button',
            onClick: () => setNav(key),
            style: {
              width: '100%',
              boxSizing: 'border-box',
              height: 48,
              padding: '0 12px',
              display: 'flex',
              alignItems: 'center',
              borderRadius: 8,
              border: '1px solid transparent',
              background: nav === key ? C.layer2 : 'transparent',
              color: nav === key ? C.text : C.sub,
              fontSize: 17,
              fontWeight: nav === key ? 600 : 400,
              textAlign: 'left',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              cursor: 'pointer',
            },
          },
          label,
        );

      return h(
        'div',
        {
          className: 'bl-root',
          style: {
            height: '100%',
            display: 'flex',
            background: C.layer1,
            color: C.text,
            minHeight: 0,
            fontFamily: FONT_FAMILY,
            zoom: scale,
          },
        },
        h(
          'div',
          {
            style: {
              flex: 'none',
              width: 172,
              background: C.bg,
              borderRight: '1px solid ' + C.border,
              padding: '56px 12px 12px',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            },
          },
          h(
            'div',
            {
              style: {
                fontSize: 18,
                fontWeight: 700,
                color: C.text,
                padding: '0 10px',
                letterSpacing: 2,
                marginBottom: 12,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            '书库',
          ),
          navButton('书架', 'shelf'),
          navButton('继续欣赏', 'reading'),
          navButton('即时答疑', 'consult'),
          navButton('设置', 'settings'),
          h('div', { style: { flex: 1 } }),
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: '.epub,.txt,.md,.markdown,application/epub+zip,text/plain,text/markdown',
            onChange: onFileChange,
            style: { display: 'none' },
          }),
          h(
            'button',
            {
              onClick: pickFile,
              type: 'button',
              title: '选一本书导进来',
              disabled: busy,
              style: {
                width: '100%',
                boxSizing: 'border-box',
                height: 38,
                padding: '0 4px',
                whiteSpace: 'nowrap',
                borderRadius: 8,
                border: '1px solid ' + C.brand,
                background: C.brand,
                color: '#ffffff',
                fontSize: 13.5,
                fontWeight: 600,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.55 : 1,
              },
            },
            busy ? '导入中…' : '＋ 导入',
          ),
        ),
        h(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
        h(
          'div',
          { style: { flex: 1, minHeight: 0, overflowY: nav === 'reading' ? 'hidden' : 'auto', padding: '56px 22px 24px' } },
          nav === 'settings' ? h(SettingsView, { voice, onSaved: setVoice, scale: scale, onScale: changeScale }) : null,
          (nav !== 'shelf' && nav !== 'reading') || imp.kind === 'idle'
            ? null
            : h(
                'div',
                {
                  style: {
                    marginBottom: 12,
                    padding: '9px 11px',
                    borderRadius: 9,
                    border: '1px solid ' + (imp.kind === 'err' ? C.error : imp.kind === 'ok' ? C.success : C.border2),
                    background: C.layer1,
                    color: imp.kind === 'err' ? C.error : imp.kind === 'ok' ? C.success : C.sub,
                    fontSize: 12,
                    lineHeight: 1.6,
                    wordBreak: 'break-word',
                  },
                },
                imp.text,
              ),
          nav === 'settings' ? null : body,
        ),
        h(PlayerBar, {
          player,
          onClose: () => setPlayer(null),
          onNext: () => step(1),
          onPrev: () => step(-1),
          hasNext,
          hasPrev,
          onPrepared: () => {
            load();
            setTick((t) => t + 1);
          },
          askAvailable: nav === 'reading',
          askOpen: askOpen,
          onToggleAsk: () => setAskOpen((v) => !v),
        }),
        nav === 'reading' && askOpen
          ? h(AskBar, {
              bookId: (player && player.bookId) || selectedBookId || (books[0] && books[0].id) || '',
              n: (player && player.n) || 0,
            })
          : null,
        ),
      );
    }

    /* ---------- 注册 ---------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots;
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined;
          const tag = document.createElement('style');
          tag.setAttribute('data-book-library-font', '1');
          tag.textContent = FONT_CSS;
          document.head.appendChild(tag);
          return () => {
            try {
              tag.remove();
            } catch {
              /* 忽略 */
            }
          };
        });
        ctx.effect(() =>
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 25, label: '书库' }, BookIcon),
          ),
        );
        ctx.effect(() =>
          slots.inject('main', () =>
            slots.register({ name: 'main', key: PANEL_ID }, function BookLibraryRoot(props) {
              return h(PanelBoundary, null, h(BookLibraryPanel, props));
            }),
          ),
        );
      },
    };
  },
});
