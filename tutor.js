/**
 * 书库 · 讲台
 *
 * 面板里的「讲这一章」和「举手提问」都由这里出活：
 *   - 讲这一章：拿这一章正文，让模型按读者喜欢的口径写一篇讲解稿
 *   - 举手提问：拿这一章正文 + 已有讲解，就着他问的问题回答
 *
 * 只用 DSH 自己的模型服务（ctx.llm）和默认模型（ctx.agentDefaultModel），
 * 不额外配钥匙、不联网。
 */

/** 一章讲解的篇幅：几百字，够讲清又不啰嗦。 */
const LECTURE_MAX_TOKENS = 2000;
/** 回答提问的篇幅。 */
const ANSWER_MAX_TOKENS = 1400;
/** 单次调用最久等多久（模型慢的时候别把面板卡死在那儿）。 */
const CALL_TIMEOUT_MS = 180000;

const LECTURE_SYSTEM = `你的活儿不是给这一章写摘要，也不是把章节名翻译一遍——是陪读者把这一章真正读懂。读完你的讲解，他要能说出「这一章在写什么、作者为什么这么写、我该拿它怎么办」。

必须分成五个小节，五个小标题一字不差，各占一行，顺序固定，不许合并、不许增减、不许换顺序：

### 本段落概括
用两三句话把这一章讲了什么说清楚：谁、在哪、发生了什么、这一章停在什么地方。只交代事实，不评论、不抒情、不写「通过……展现了」。

### 文章美句
挑两到三句原书里的句子，逐字抄下来（一个字都不许改），每句后面用一句话说它为什么好——好在哪个字、哪个比喻、哪个停顿。抄的句子前面标上它所在的段号，例如 [7]。实在没有值得抄的句子，就直接说「这一章没有特别值得单拎的句子」，不许自己造。

### 作者表达
作者想说什么、是怎么说出来的：这个人为什么此刻出现、这个细节为什么搁在这儿、这句话为什么不点破；这一章在整本书里是起势、铺陈、转弯还是收口。写法和内容是一回事，只讲情节等于没读。

### AI 观点
你自己的判断，别和上一段混着说：哪里写得好、好在哪；哪里作者偷懒了、急了、绕远了；你信不信这个处理。允许不同意作者，说清为什么。用「我」来说，不要说「AI 认为」。

### AI 认为需要补充点
作者漏掉、绕开或没往下写的地方：他回避了什么、哪个前提没交代、哪个结论跳得太快。再说清读者该自己去补什么——可以是一段亲历、一本旁证、一个反问。要具体，不许写「可以多思考」这种空话。

绝不能这样写：
- 不许「本章讲述了……」「主要内容是……」「通过……展现了……」这类摘要腔。
- 不许按顺序把情节复述一遍，冒充讲解。
- 不许摆「三个要点」「四层含义」这种整齐排比。
- 不许编正文里没有的人、事、情节。
- 不许在这三个小标题之外再加别的标题。

写法：
- 篇幅跟着正文走，绝不许硬凑。下面我会告诉你这一章正文有多少字：
  · 正文不到 150 字（多半是目录页、版权页、片断）：直接说「这一章只有几行，是书的目录或片断，没什么可讲的」，再补两句它在全书里的位置就够，总共不超过 150 字。
  · 正文 150 到 500 字：三段合起来不超过 500 字。
  · 正文 500 到 1200 字：三段合起来 500 到 800 字。
  · 正文超过 1200 字：三段合起来 800 到 1200 字。
- 硬线：讲解总字数不许超过正文的 1.5 倍。超了就是在凑字数、就是在编。
- 五节的轻重：「本段落概括」最短，两三句就收；「文章美句」「作者表达」「AI 观点」是主体，各占两三成；「AI 认为需要补充点」几句到位、不拖。
- 讲到具体地方带上方括号段号，例如 [7]。
- 用「你」称呼他，不要「亲爱的读者」「让我们一起」。
- 不要开头复述书名和章名，直接进入第一段。

语气（三段都要跟着内容走，别从头到尾一个调子）：
- 你的讲解会被直接念出来给他听。所以语气要跟着内容走：讲到沉重、失去、告别，用低沉；讲到轻松、俏皮、活人活得有劲，用轻松；讲到紧张、冲突、要出事，用紧绷；讲到意外、反常、转折，用起伏；一般的分析和判断，用平淡。
- 要换语气的时候，在换的那一段前面单独占一行写标记，格式必须一模一样，只有这五个词能用：
【语气：低沉】
【语气：轻松】
【语气：紧绷】
【语气：起伏】
【语气：平淡】
- 全篇换 2 到 4 次就够，别每句都换；一次至少两三句，太碎念出来像念课文。
- 标记只能独占一行，不许写进句子里，也不用向读者解释它。第一段前面也要写一个标记。
- 小标题那一行不要加语气标记，标记写在正文段落前。`;

const ANSWER_SYSTEM = `你是读者的读书助教，正在陪他读某一章。他就这一章提问，你回答。

规矩：
- 只依据给你的这一章正文和这一章的讲解回答。问到正文之外的事，直接说「这一章里没写」。
- 先给答案，再给依据；依据要落到具体段落，用 [1] [2] 这样的段号。
- 有不同看法就说不同看法，不要一味顺着问话。
- 用「你」称呼他，不要客服腔。
- 200 到 500 字，说清楚就停。`;

/** 从 DSH 默认模型里取 provider / model。拿不到就明确报错，别静默降级。 */
export function resolveModel(ctx) {
  let selection = null;
  try {
    selection = ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? null;
  } catch {
    selection = null;
  }
  const provider = String((selection && selection.provider) || '').trim();
  const model = String((selection && selection.model) || '').trim();
  if (!provider || !model) {
    throw new Error('DSH 还没选好模型。先在对话里随便问一句让它跑起来，或者去设置里挑一个模型，再回来点讲。');
  }
  return { provider, model };
}

/** 拿 llm 服务。 */
export function resolveLlm(ctx) {
  const llm = ctx.get?.('llm') ?? ctx.llm ?? null;
  if (!llm || typeof llm.prepareCall !== 'function') {
    throw new Error('这个 DSH 里没有可用的模型服务，讲台起不来。');
  }
  return llm;
}

/**
 * 逐段流式调用模型。
 * 只吐正文增量，调用结束就正常返回；出错抛异常。
 */
export async function* runChat({ llm, target, system, user, maxTokens, signal }) {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const fused = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let prepared;
  try {
    prepared = await llm.prepareCall({ provider: target.provider, model: target.model, maxTokens }, fused);
  } catch (err) {
    throw new Error(`模型没接上：${(err && err.message) || String(err)}`);
  }

  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }];
  let finish = null;
  try {
    for await (const chunk of prepared.stream({
      ...prepared.config,
      ...(system ? { system } : {}),
      messages,
      signal: fused,
    })) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        if (chunk.text) yield chunk.text;
      } else if (chunk.type === 'finish') {
        finish = chunk.reason ?? null;
      }
    }
  } catch (err) {
    if (signal && signal.aborted) throw new Error('已经停下了');
    throw new Error(`讲到一半断了：${(err && err.message) || String(err)}`);
  }
  if (finish && finish.kind === 'error') {
    throw new Error(`模型报错：${(finish.failure && finish.failure.message) || '未知原因'}`);
  }
}

/** 拼出「讲这一章」的提示词。 */
export function lecturePrompt({
  bookTitle,
  chapterNo,
  chapterTitle,
  chapterText,
  preference,
  previous,
  catalog,
}) {
  const lines = [];
  lines.push(`书名：${bookTitle || '（没有书名）'}`);
  lines.push(`这一章：第 ${chapterNo} 章${chapterTitle ? ` · ${chapterTitle}` : ''}`);
  if (catalog && String(catalog).trim()) {
    lines.push('');
    lines.push('这本书的章节目录（用来判断这一章在全书的什么位置，别把目录搬进讲解）：');
    lines.push(String(catalog).trim().slice(0, 1800));
  }
  if (previous && String(previous).trim()) {
    lines.push('');
    lines.push('上一章你已经讲过的（接着往深里讲，不要重复它说过的话）：');
    lines.push(String(previous).trim().slice(0, 900));
  }
  if (preference && String(preference).trim()) {
    lines.push('');
    lines.push('这个人的阅读偏好：');
    lines.push(String(preference).trim().slice(0, 600));
  }
  lines.push('');
  lines.push(`这一章正文约 ${String(chapterText || '').replace(/\s/g, '').length} 字。`);
  lines.push('');
  lines.push('这一章正文：');
  lines.push(String(chapterText || '').trim());
  lines.push('');
  lines.push('现在写这一章的讲解。');
  return { system: LECTURE_SYSTEM, user: lines.join('\n') };
}

/** 拼出「举手提问」的提示词。 */
export function answerPrompt({ bookTitle, chapterNo, chapterTitle, chapterText, lectureText, question }) {
  const lines = [];
  lines.push(`书名：${bookTitle || '（没有书名）'}`);
  lines.push(`正在读：第 ${chapterNo} 章${chapterTitle ? ` · ${chapterTitle}` : ''}`);
  lines.push('');
  lines.push('这一章正文：');
  lines.push(String(chapterText || '').trim());
  if (lectureText && String(lectureText).trim()) {
    lines.push('');
    lines.push('这一章的讲解稿：');
    lines.push(String(lectureText).trim());
  }
  lines.push('');
  lines.push(`他的问题：${String(question || '').trim()}`);
  return { system: ANSWER_SYSTEM, user: lines.join('\n') };
}

/** 讲这一章：返回文本增量流。 */
export async function* lectureStream(options) {
  const { llm, target, signal } = options;
  const prompt = lecturePrompt(options);
  yield* runChat({
    llm,
    target,
    system: prompt.system,
    user: prompt.user,
    maxTokens: LECTURE_MAX_TOKENS,
    signal,
  });
}

/** 回答提问：返回文本增量流。 */
const CONSULT_SYSTEM = `你是读者的读书助教。他读到一半把你叫住，问点事——人物、情节、写法、他自己的感受，都行。

规矩：
- 给了材料就先依据材料；材料里没有的，凭常识和文学判断答，但要说清哪句是材料里的、哪句是你的看法。
- 先给答案，再给依据；依据能落到章或者段就落。
- 有你自己的判断，不要一味顺着问话。觉得他理解偏了就直接说。
- 用「你」称呼他，不要客服腔，不要「首先/其次/总之」这种作文腔。
- 200 到 500 字，说清楚就停。`;

const CONSULT_MAX_TOKENS = 1400;

/** 即时答疑的提示词：书、目录、已听过的讲解摘要、他的口味，加上问题。 */
export function consultPrompt({ bookTitle, catalog, digest, preference, question, history }) {
  const parts = [];
  parts.push(bookTitle ? '书：《' + bookTitle + '》' : '（他没指定哪本书）');
  if (catalog) parts.push('章节目录：\n' + catalog);
  if (digest) parts.push('他已经听过的讲解，摘要如下：\n' + digest);
  if (preference) parts.push('他的阅读口味：' + preference);
  if (Array.isArray(history) && history.length) {
    const lines = history
      .slice(-8)
      .map((h) => (h.role === 'user' ? '他问：' : '你答：') + String(h.text || '').slice(0, 320));
    parts.push('刚才聊过的（顺着往下说，别重复、别提「前面说过」）：\n' + lines.join('\n'));
  }
  parts.push('他问：' + question);
  return { system: CONSULT_SYSTEM, user: parts.join('\n\n') };
}

/** 即时答疑：返回文本增量流。 */
export async function* consultStream(options) {
  const { llm, target, signal } = options;
  const prompt = consultPrompt(options);
  yield* runChat({
    llm,
    target,
    system: prompt.system,
    user: prompt.user,
    maxTokens: CONSULT_MAX_TOKENS,
    signal,
  });
}

export async function* answerStream(options) {
  const { llm, target, signal } = options;
  const prompt = answerPrompt(options);
  yield* runChat({
    llm,
    target,
    system: prompt.system,
    user: prompt.user,
    maxTokens: ANSWER_MAX_TOKENS,
    signal,
  });
}
