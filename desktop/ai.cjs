'use strict';

// AI 能力层：Provider Adapter、Context Builder、Action Registry、Document Operation Layer
// 独立于 web/app.js 和 desktop/main.cjs，避免 AI 逻辑散落在渲染层。

const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const https = require('node:https');
const { pathToFileURL } = require('node:url');

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
// 这里先按 JSON 解析，失败再取出花括号区间 / 逐行解析 data:，避免把正常回答判成解析失败。
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

async function callProvider(messages, options = {}) {
  const config = await readProviderConfig();
  if (!config.apiKey) throw new Error('尚未配置 AI 服务 API Key');
  if (!config.baseUrl) throw new Error('尚未配置 AI 服务地址');

  const body = JSON.stringify({
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: options.temperature ?? 0.3,
    stream: false,
  });

  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const url = new URL(`${config.baseUrl}/chat/completions`);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const request = httpModule.request(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let responseData = '';
      response.on('data', (chunk) => { responseData += chunk.toString('utf8'); });
      response.on('end', () => {
        const parsed = parseProviderPayload(responseData);
        if (!parsed || parsed.error) {
          const raw = parsed && parsed.error
            ? (typeof parsed.error === 'string' ? parsed.error : parsed.error.message)
            : '';
          finish(reject, new Error(providerErrorMessage(response.statusCode, raw)));
          return;
        }
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          finish(reject, new Error('AI 服务返回格式异常'));
          return;
        }
        finish(resolve, content);
      });
      response.on('error', (error) => finish(reject, new Error('AI 服务响应失败')));
    });
    request.on('error', (error) => finish(reject, new Error(`无法连接 AI 服务: ${error.message || '网络错误'}`)));
    // 没有超时的话，服务端挂起会让面板永远停在「处理中」。
    timer = setTimeout(() => {
      request.destroy(new Error('AI 服务响应超时，请稍后重试'));
      finish(reject, new Error('AI 服务响应超时，请稍后重试'));
    }, timeoutMs);
    request.write(body);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Context Builder
// ---------------------------------------------------------------------------

const CONTEXT_LIMITS = {
  selection: 8000,
  document: 32000,
  folder: 64000,
};

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

async function askDocument(question, document, history) {
  if (!question || !question.trim()) throw new Error('请输入问题');
  if (!document?.text) throw new Error('当前没有可问答的文档');

  const context = buildDocumentContext(document);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...sanitizeHistory(history),
    { role: 'user', content: `文档内容：\n${context.document}\n\n用户问题：${question}\n\n请基于文档内容回答用户问题；如果这是对前文对话的追问，请结合对话历史回答。回答中引用关键段落时，请使用「引用：」前缀标注原文。` },
  ];
  return await callProvider(messages, { temperature: 0.2 });
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

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请对以下文档提出修改建议。要求：${instruction}\n\n请逐条列出修改建议，每条包含：位置描述、原文片段、建议修改、修改理由。\n\n文档内容：\n${truncateText(document.text, CONTEXT_LIMITS.document)}` },
  ];
  return await callProvider(messages, { temperature: 0.3 });
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
};
