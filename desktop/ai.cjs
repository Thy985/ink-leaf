'use strict';

// AI 能力层：Provider Adapter、Context Builder、Action Registry、Document Operation Layer
// 独立于 web/app.js 和 desktop/main.cjs，避免 AI 逻辑散落在渲染层。

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;

// ---------------------------------------------------------------------------
// Provider Adapter
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER = {
  name: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  maxTokens: 4096,
};

const providerStorePath = () => path.join(process.env.INKSTONE_USER_DATA || require('electron').app.getPath('userData'), 'ai-provider.json');

async function readProviderConfig() {
  try {
    const data = JSON.parse(await fsp.readFile(providerStorePath(), 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('invalid');
    return {
      name: typeof data.name === 'string' ? data.name : DEFAULT_PROVIDER.name,
      baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl.replace(/\/+$/, '') : DEFAULT_PROVIDER.baseUrl,
      model: typeof data.model === 'string' ? data.model : DEFAULT_PROVIDER.model,
      apiKey: typeof data.apiKey === 'string' ? data.apiKey : '',
      maxTokens: typeof data.maxTokens === 'number' && data.maxTokens > 0 ? Math.min(data.maxTokens, 8192) : DEFAULT_PROVIDER.maxTokens,
    };
  } catch {
    return { ...DEFAULT_PROVIDER, apiKey: '' };
  }
}

async function writeProviderConfig(config) {
  const dir = path.dirname(providerStorePath());
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${providerStorePath()}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(config), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await fsp.rename(tmp, providerStorePath());
}

const DEFAULT_TIMEOUT_MS = 120000;

// 部分网关会在 JSON 后追加 `data: [DONE]`，或直接用 SSE 格式返回（即使请求了 stream:false）。
// provider.mjs 里的纠偏中间件共用同一套解析规则；这里保留同步版本供单元测试与调用方使用。
function parseProviderPayload(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* 继续尝试非标准格式 */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* 继续尝试 SSE */ }
  }
  let payload = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const match = /^data:\s*(.+)$/.exec(line.trim());
    if (!match || match[1].trim() === '[DONE]') continue;
    try { payload = JSON.parse(match[1]); } catch { /* 跳过无法解析的事件 */ }
  }
  return payload;
}

// 上游常见配额错误里带 429 / rate limit / rpm，但网关会把它包装成 503，
// 只看状态码会误报成「服务暂时不可用」，所以文本也要参与判断。
const RATE_LIMIT_PATTERN = /(^|\D)429(\D|$)|rate.?limit|too many requests|\brpm\b|请求过于频繁|限流/i;
const MODEL_UNAVAILABLE_PATTERN = /no active credentials|model_not_found|unknown model|invalid model|model does not exist/i;

function providerErrorMessage(statusCode, message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (statusCode === 401) return 'API Key 无效或已过期';
  if (statusCode === 403) return 'API Key 无权访问该模型，请检查服务配置';
  if (statusCode === 404) return 'AI 服务地址或模型不存在，请检查服务地址与模型名称';
  if (statusCode === 429 || RATE_LIMIT_PATTERN.test(text)) return 'AI 服务请求过于频繁，请稍后重试';
  if (MODEL_UNAVAILABLE_PATTERN.test(text)) return '该模型暂不可用，请检查模型名称或服务地址';
  if (statusCode >= 500) return 'AI 服务暂时不可用，请稍后重试';
  if (text) return text;
  return statusCode >= 400 ? `AI 服务返回错误（HTTP ${statusCode}）` : 'AI 服务返回解析失败';
}

// 用 Vercel AI SDK 发一次非流式对话。
// 原先这里是手写 http/https 请求；改用 SDK 后协议细节交给 SDK，
// 但保持对外签名与错误语义完全不变，调用方无需感知底层更换。
// provider.mjs 是 ESM（ai/ 目录下），通过动态 import 从 CommonJS 加载。
// 这里只依赖 SDK 的 provider 工厂与错误映射；其余逻辑仍是 CommonJS。
let providerModule = null;
async function loadProvider() {
  if (!providerModule) providerModule = await import('./ai/provider.mjs');
  return providerModule;
}

async function callProvider(messages, options = {}) {
  const config = await readProviderConfig();
  if (!config.apiKey) throw new Error('尚未配置 AI 服务 API Key');
  if (!config.baseUrl) throw new Error('尚未配置 AI 服务地址');

  const { createProvider, mapSdkError } = await loadProvider();
  const { generateText } = await import('ai');

  // 超时语义沿用原先的 DEFAULT_TIMEOUT_MS（可由 options.timeoutMs 覆盖）。
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const provider = createProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, name: config.name, timeoutMs });

  // 系统消息从 messages 里取出交给 system 参数；SDK 对「首条 system」有更严格的约束，
  // 拆开传能保持与原先完全一致的发送顺序。
  const system = messages.find((m) => m.role === 'system')?.content;
  const rest = messages.filter((m) => m.role !== 'system');

  try {
    const result = await generateText({
      model: provider(config.model),
      system,
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: config.maxTokens,
      // 与原实现一致：失败立刻上报，不自动重试。
      maxRetries: 0,
    });
    return result.text;
  } catch (error) {
    throw mapSdkError(error);
  }
}

// ---------------------------------------------------------------------------
// Context Builder
// ---------------------------------------------------------------------------

const CONTEXT_LIMITS = {
  selection: 8000,
  // document 同时是「整篇内联还是走检索」的分界点（见 askDocument）。
  // 前端不硬编码这个值，而是经 ai:limits 通道取，避免两边漂移导致
  // 「提示说的发送范围」与「实际发送范围」不一致——那等于对用户撒谎。
  document: 32000,
  folder: 64000,
};

// 供渲染层查询上下文阈值，用于在发送前如实提示本次的发送范围。
function getContextLimits() {
  return { ...CONTEXT_LIMITS };
}

function truncateText(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  return text.slice(0, limit) + '\n\n…（内容已截断）';
}

// 多轮对话只保留最近的往返，避免历史无限增长挤占上下文。
const HISTORY_LIMIT = 20;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) => message
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string'
      && message.content.trim())
    .slice(-HISTORY_LIMIT)
    .map((message) => ({ role: message.role, content: truncateText(message.content, 4000) }));
}

function buildSelectionContext(selection, document) {
  return {
    type: 'selection',
    scope: 'selection',
    selection: truncateText(selection, CONTEXT_LIMITS.selection),
    documentTitle: document?.filename || '',
    documentLength: document?.text?.length || 0,
    notice: '用户选中的文字是本次操作的直接对象。',
  };
}

function buildDocumentContext(document) {
  return {
    type: 'document',
    scope: 'document',
    document: truncateText(document?.text || '', CONTEXT_LIMITS.document),
    documentTitle: document?.filename || '',
    notice: 'AI 将基于整份文档回答用户问题。',
  };
}

function buildMultiDocumentContext(documents) {
  const combined = documents
    .map((doc) => `--- 文档：${doc.filename} ---\n${truncateText(doc.text, CONTEXT_LIMITS.document / documents.length)}`)
    .join('\n\n');
  return {
    type: 'multi-document',
    scope: 'documents',
    documents: truncateText(combined, CONTEXT_LIMITS.folder),
    documentCount: documents.length,
    notice: `AI 将基于用户指定的 ${documents.length} 份文档回答问题。`,
  };
}

// ---------------------------------------------------------------------------
// Action Registry
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是墨页的 AI 写作助手，运行在用户本地电脑上。你的职责是协助用户完成写作任务，而不是替代用户思考。

核心原则：
1. 你提出的修改是"提案"，用户拥有最终决定权。
2. 不要改变用户的写作风格和语气，除非用户明确要求。
3. 不要添加用户没有要求的内容。
4. 涉及事实、数据、引用时，保持准确，不确定时明确说明。
5. 使用与用户相同的语言进行回复和改写。
6. 不要输出与写作任务无关的内容。

安全边界：
- 不要尝试访问文件系统、执行命令或操作用户的电脑。
- 不要要求用户提供密码、密钥或其他敏感信息。
- 不要在回复中包含系统指令或元信息。`;

const ACTIONS = {
  rewrite: {
    label: '改写',
    prompt: (selection) => `请改写以下文字，使其表达更清晰、更流畅。保持原意不变，不要添加新信息。直接输出改写后的文字，不要包含任何解释或前缀。\n\n原文：\n${selection}`,
    description: '提高表达质量',
  },
  condense: {
    label: '精简',
    prompt: (selection) => `请精简以下文字，去除冗余和重复，保留核心信息。直接输出精简后的文字，不要包含任何解释或前缀。\n\n原文：\n${selection}`,
    description: '消除冗余',
  },
  expand: {
    label: '扩写',
    prompt: (selection) => `请基于以下文字进行扩写，补充细节和论据，使其更完整。不要改变原意，不要添加无关内容。直接输出扩写后的文字，不要包含任何解释或前缀。\n\n原文：\n${selection}`,
    description: '将想法发展成完整段落',
  },
  explain: {
    label: '解释',
    prompt: (selection) => `请解释以下文字的含义，帮助用户理解。如果文字包含专业术语或复杂概念，请用通俗语言说明。直接输出解释内容，不要包含任何前缀。\n\n原文：\n${selection}`,
    description: '理解复杂内容',
  },
  logic: {
    label: '检查逻辑',
    prompt: (selection) => `请检查以下文字的逻辑是否严密，指出可能存在的论证漏洞、前后矛盾或推理跳跃。如果逻辑清晰，也请如实说明。直接输出检查结果，不要包含任何前缀。\n\n原文：\n${selection}`,
    description: '发现论证漏洞',
  },
};

// ---------------------------------------------------------------------------
// Document Operation Layer
// ---------------------------------------------------------------------------

function createProposal(action, originalText, suggestedText, context = '', actionKey = '') {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    action,
    // 触发本次提案的操作 key（如 rewrite），供「重新生成」复用原操作。
    actionKey,
    originalText,
    suggestedText,
    context: context.slice(0, 500),
    createdAt: new Date().toISOString(),
    status: 'pending', // pending | accepted | rejected
  };
}

function diffText(original, suggested) {
  // 简单行级 diff，用于展示修改
  const originalLines = original.split('\n');
  const suggestedLines = suggested.split('\n');
  const maxLen = Math.max(originalLines.length, suggestedLines.length);
  const diff = [];
  for (let i = 0; i < maxLen; i++) {
    const orig = originalLines[i];
    const sugg = suggestedLines[i];
    if (orig === sugg) {
      diff.push({ type: 'unchanged', content: orig || '' });
    } else {
      if (orig !== undefined) diff.push({ type: 'removed', content: orig });
      if (sugg !== undefined) diff.push({ type: 'added', content: sugg });
    }
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function runSelectionAction(actionKey, selection, document) {
  const action = ACTIONS[actionKey];
  if (!action) throw new Error(`未知的 AI 操作：${actionKey}`);
  if (!selection || !selection.trim()) throw new Error('请先选中一段文字');

  const context = buildSelectionContext(selection, document);
  // 提示词里同样用截断后的选区，避免超长选区打爆模型上下文。
  const bounded = truncateText(selection, CONTEXT_LIMITS.selection);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: action.prompt(bounded) },
  ];
  const result = await callProvider(messages, { temperature: 0.4 });
  return createProposal(action.label, selection, result.trim(), context.notice, actionKey);
}

async function askDocument(question, document, history, options = {}) {
  if (!question || !question.trim()) throw new Error('请输入问题');
  if (!document?.text) throw new Error('当前没有可问答的文档');

  // 短文档仍整篇发给模型：一次往返、无需工具调用，比多轮检索更便宜也更准。
  // 只有超过 CONTEXT_LIMITS.document 时才改用工具按需检索——
  // 否则整篇截断会悄悄丢掉模型本该看到的段落，而它无从察觉。
  if (document.text.length <= CONTEXT_LIMITS.document) {
    const context = buildDocumentContext(document);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...sanitizeHistory(history),
      { role: 'user', content: `文档内容：\n${context.document}\n\n用户问题：${question}\n\n请基于文档内容回答用户问题；如果这是对前文对话的追问，请结合对话历史回答。回答中引用关键段落时，请使用「引用：」前缀标注原文。` },
    ];
    // 短文档整篇随消息发送，模型确实看到了文档内容，故 retrieved 为 true。
    return { answer: await callProvider(messages, { temperature: 0.2 }), trace: [], retrieved: true };
  }

  // 长文档：交给 Agent 用工具检索，而不是把截断后的整篇塞给它。
  // 检索范围严格限定在「当前这篇文档」——不碰其他已导入文件夹，
  // 这样问答不会把用户没提到的文档内容发出去。
  const result = await runAgent({
    system: SYSTEM_PROMPT,
    temperature: 0.2,
    messages: [
      ...sanitizeHistory(history),
      { role: 'user', content: `用户问题：${question}\n\n当前文档较长（${document.text.length} 字符），请调用 search_document 工具检索与问题相关的段落，再基于命中的内容回答。回答中引用关键段落时，请使用「引用：」前缀标注原文。` },
    ],
    document,
  });

  // 模型可能一次工具都不调用就直接作答（小模型或兼容网关常见）。
  // 此时它并没有读过文档，答案只能来自猜测；必须如实告诉用户，
  // 不能把一条凭空生成的回答当成「基于文档的回答」呈现。
  const retrieved = result.trace.some((step) => step.outcome === 'ok');
  if (!retrieved && result.text.trim()) {
    return {
      answer: result.text,
      trace: result.trace,
      truncatedByStepLimit: result.truncatedByStepLimit,
      retrieved: false,
      notice: '本次回答未检索文档内容，可能是模型自行推测，请谨慎采信。',
    };
  }
  return { answer: result.text, trace: result.trace, truncatedByStepLimit: result.truncatedByStepLimit, retrieved };
}

async function askMultiDocument(question, documents) {
  if (!question || !question.trim()) throw new Error('请输入问题');
  if (!documents?.length) throw new Error('请至少选择一份文档');

  const context = buildMultiDocumentContext(documents);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `文档集合：\n${context.documents}\n\n用户问题：${question}\n\n请基于上述文档回答用户问题，并注明信息来源。` },
  ];
  return await callProvider(messages, { temperature: 0.2 });
}

async function reviewDocument(instruction, document) {
  if (!instruction || typeof instruction !== 'string' || !instruction.trim()) throw new Error('请输入修改要求');
  if (!document?.text) throw new Error('当前没有可修改的文档');

  // 要模型直接给结构化条目，UI 才能逐条展示与定位。
  // 但兼容网关对 response_format 支持不一致，所以用提示词约束 + 宽容解析，
  // 解析不出来时退化成整段文本——宁可少一个结构化列表，也不能让审阅功能整个失败。
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请对以下文档提出修改建议。要求：${instruction}

请只输出一个 JSON 数组，不要包任何解释文字或代码围栏。数组每个元素是一个对象，字段如下：
- "position"：位置描述（如「第 3 段」「## 标题下」）
- "original"：原文片段（必须能从文档中原样找到）
- "suggested"：建议修改后的文字
- "reason"：修改理由

如果文档不需要修改，输出空数组 []。

文档内容：
${truncateText(document.text, CONTEXT_LIMITS.document)}` },
  ];
  const raw = await callProvider(messages, { temperature: 0.3 });
  const { parseReviewItems } = await import('./ai/schema.mjs');
  const items = parseReviewItems(raw);
  // 结构化成功时 items 有值；否则把原文交给 UI 当纯文本展示。
  return items ? { items } : { text: raw.trim() };
}

// ---------------------------------------------------------------------------
// Document Analysis (v0.12)
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const MAX_OUTLINE_DEPTH = 6;
const MAX_OUTLINE_ITEMS = 200;
// CJK 统一表意文字、日文假名、韩文音节：这些文字不以空格分词。
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

// 中文按字计数、西文按词计数：直接 split(/\s+/) 会把整段中文算成 1 个词。
function countWords(line) {
  const cjk = (line.match(CJK_CHAR_RE) || []).length;
  const western = line.replace(CJK_CHAR_RE, ' ').split(/\s+/).filter(Boolean).length;
  return cjk + western;
}

function analyzeDocument(document) {
  const text = document?.text || '';
  const lines = text.split('\n');
  const outline = [];
  let wordCount = 0;
  let charCount = 0;
  let paragraphCount = 0;
  let codeBlockCount = 0;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) codeBlockCount++;
      continue;
    }
    if (inCodeBlock) continue;

    const heading = line.match(HEADING_RE);
    if (heading && outline.length < MAX_OUTLINE_ITEMS) {
      const level = Math.min(heading[1].length, MAX_OUTLINE_DEPTH);
      outline.push({ level, title: heading[2].trim(), line: i + 1 });
    }

    if (line.trim() && !line.trim().startsWith('#')) {
      paragraphCount++;
      wordCount += countWords(line);
      charCount += line.length;
    }
  }

  return {
    outline,
    stats: {
      wordCount,
      charCount,
      paragraphCount,
      codeBlockCount,
      lineCount: lines.length,
      headingCount: outline.length,
    },
  };
}

async function summarizeDocument(document) {
  if (!document?.text) throw new Error('当前没有可分析的文档');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请为以下文档生成一段简短的摘要（不超过 100 字），帮助读者快速了解文档内容。直接输出摘要，不要包含任何前缀。\n\n文档内容：\n${truncateText(document.text, CONTEXT_LIMITS.document)}` },
  ];
  return await callProvider(messages, { temperature: 0.2 });
}

function getAvailableActions() {
  return Object.entries(ACTIONS).map(([key, action]) => ({
    key,
    label: action.label,
    description: action.description,
  }));
}

async function getProviderStatus() {
  const config = await readProviderConfig();
  return {
    configured: !!config.apiKey,
    name: config.name,
    baseUrl: config.baseUrl,
    model: config.model,
  };
}

async function saveProviderConfig(config) {
  const current = await readProviderConfig();
  // 空字符串/缺省表示"未修改"：设置面板不回填 API Key，用户只改模型名时不能把已保存的 Key 清掉。
  // 需要丢弃整份配置请使用 clearProviderConfig。
  const pick = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const next = {
    name: pick(config.name, current.name),
    baseUrl: pick(config.baseUrl, current.baseUrl).replace(/\/+$/, ''),
    model: pick(config.model, current.model),
    apiKey: pick(config.apiKey, current.apiKey),
    maxTokens: typeof config.maxTokens === 'number' ? Math.min(config.maxTokens, 8192) : current.maxTokens,
  };
  if (!/^https?:\/\//i.test(next.baseUrl)) throw new Error('AI 服务地址必须是 HTTP(S) URL');
  await writeProviderConfig(next);
  return { configured: !!next.apiKey, name: next.name, baseUrl: next.baseUrl, model: next.model };
}

async function clearProviderConfig() {
  try { await fsp.unlink(providerStorePath()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { configured: false };
}

module.exports = {
  runSelectionAction,
  callProvider,
  askDocument,
  askMultiDocument,
  reviewDocument,
  analyzeDocument,
  summarizeDocument,
  getAvailableActions,
  getProviderStatus,
  saveProviderConfig,
  clearProviderConfig,
  createProposal,
  diffText,
  SYSTEM_PROMPT,
  ACTIONS,
  CONTEXT_LIMITS,
  getContextLimits,
  // H0 Harness：带工具的一轮问答。工具层只读，且只能访问已导入文件夹。
  // 通过动态 import 加载，保持 ai.cjs 在无 Electron/SDK 环境下仍可被单元测试直接 require。
  runAgent,
  createTools,
  // H2 工作区：本地索引查询，不经过模型。
  describeWorkspace,
  documentLinks,
  invalidateWorkspace,
};

// 便捷包装：跑一轮可调用工具的问答。
// options.folders：已导入文件夹的路径数组（session.json 里需先 map 成 path 字符串）。
// options.document：可选的当前文档 { text, filename }，启用 search_document 工具。
async function runAgent(options = {}) {
  const [{ runAgent: run }, { createTools: makeTools }, { createProvider }] = await Promise.all([
    import('./ai/harness.mjs'),
    import('./ai/tools.mjs'),
    import('./ai/provider.mjs'),
  ]);
  const config = await readProviderConfig();
  if (!config.apiKey) throw new Error('尚未配置 AI 服务 API Key');
  if (!config.baseUrl) throw new Error('尚未配置 AI 服务地址');
  const { registry } = makeTools({ folders: options.folders || [], document: options.document || null });
  const provider = createProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, name: config.name, timeoutMs: options.timeoutMs });
  try {
    return await run({
      model: provider(config.model),
      system: options.system || SYSTEM_PROMPT,
      messages: options.messages || [],
      registry,
      maxSteps: options.maxSteps,
      temperature: options.temperature,
    });
  } catch (error) {
    const { mapSdkError } = await import('./ai/provider.mjs');
    throw mapSdkError(error);
  }
}

// 供 main.cjs 在不需要跑模型时直接拿到工具注册表（例如 MCP 服务器复用同一套工具）。
async function createTools({ folders = [], document = null } = {}) {
  const { createTools: makeTools } = await import('./ai/tools.mjs');
  return makeTools({ folders, document });
}

// ---------------------------------------------------------------------------
// 工作区（H2）
// ---------------------------------------------------------------------------
// 侧栏要能展示工作区结构与反向链接，这些查询不经过模型，直接在本地索引上完成。
// 索引按「文件夹集合」缓存，另有显式的失效入口。
//
// 只认文件夹集合是不够的（复审 F4）：用户「移除 → 重建目录 → 重新导入同一路径」后，
// 集合没变但磁盘内容全变了。所以 main.cjs 在文件夹增删与保存文件时调用
// invalidateWorkspace()，清空缓存强制重建。
//
// 缓存的是 **Promise** 而不是结果（复审 F7）：侧栏打开面板时会并发发起
// workspace / links / broken 三个查询，缓存结果的话三者同时 miss，会把整盘扫三遍。
let workspaceCache = { key: '', promise: null };

function getWorkspaceIndex(folders = []) {
  const key = JSON.stringify((Array.isArray(folders) ? folders : []).map((f) => (f && typeof f === 'object' ? f.path : f)));
  if (workspaceCache.promise && workspaceCache.key === key) return workspaceCache.promise;
  const promise = import('./ai/workspace.mjs')
    .then(({ buildWorkspaceIndex }) => buildWorkspaceIndex({ roots: folders }))
    // 建索引失败时不要把失败的 Promise 永久缓存住，否则之后永远拿不到结果。
    .catch((error) => { if (workspaceCache.promise === promise) workspaceCache = { key: '', promise: null }; throw error; });
  workspaceCache = { key, promise };
  return promise;
}

// 让缓存失效：文件夹增删、保存文件、或用户点「重建索引」时调用。
function invalidateWorkspace() {
  workspaceCache = { key: '', promise: null };
}

// 工作区概览：文件夹 + 文档清单（不含正文）。
async function describeWorkspace(folders = []) {
  const { describeWorkspace: describe, findBrokenLinks } = await import('./ai/workspace.mjs');
  const index = await getWorkspaceIndex(folders);
  // 侧栏渲染需要完整清单（不进模型上下文），故传 null 关掉工具侧的体积上限。
  const desc = describe(index, { limit: null });
  return {
    ...desc,
    // 链接统计一并返回，侧栏可以直接显示「N 条链接 / M 条死链」。
    linkCount: countLinks(index),
    brokenCount: findBrokenLinks(index).length,
  };
}

// 某篇文档的反向链接。title 缺省时用 filename 推断。
async function documentLinks(folders = [], { title, filename, broken = false } = {}) {
  const { findBacklinks, findBrokenLinks } = await import('./ai/workspace.mjs');
  const index = await getWorkspaceIndex(folders);
  if (broken) return { broken: findBrokenLinks(index) };
  const target = title || (typeof filename === 'string' ? filename.replace(/\.(md|markdown|txt)$/i, '') : '');
  if (!target) return { title: '', targets: [], backlinks: [] };
  return findBacklinks(index, target);
}

function countLinks(index) {
  let total = 0;
  for (const list of index.backlinks.values()) total += list.length;
  return total;
}
