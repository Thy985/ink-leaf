// Provider Adapter：用 Vercel AI SDK 的 OpenAI-compatible 客户端替换原先手写的
// http/https 请求。之所以要自己套一层 fetch 中间件，是因为很多网关并不严格遵守协议：
// 明明 stream:false 却回 SSE、在 JSON 后面追加 data: [DONE]。SDK 严格按 content-type
// 解析，遇到这些会直接报 Invalid JSON response——这比原来的手写解析更脆弱。
// 中间件在响应交给 SDK 之前把它归一化成 SDK 认得的形状。
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// 上游常见配额错误里带 429 / rate limit / rpm，但网关会把它包装成 503，
// 只看状态码会误报成「服务暂时不可用」，所以文本也要参与判断。
const RATE_LIMIT_PATTERN = /(^|\D)429(\D|$)|rate.?limit|too many requests|\brpm\b|请求过于频繁|限流/i;
const MODEL_UNAVAILABLE_PATTERN = /no active credentials|model_not_found|unknown model|invalid model|model does not exist/i;

export function providerErrorMessage(statusCode, message) {
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

// 从一段可能是 JSON、也可能是 SSE 的文本里取出 chat completion 对象。
// 逻辑与替换前的 parseProviderPayload 保持一致，避免偏离既有兼容性。
export function parseProviderPayload(text) {
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

// SSE 里每个 data: 行可能只带一个 delta 片段。非流式请求被网关改写成 SSE 时，
// 需要把这些片段拼回一个完整的 message 对象才能交给 SDK。
function assembleSseCompletion(text) {
  const chunks = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^data:\s*(.+)$/.exec(line.trim());
    if (!match || match[1].trim() === '[DONE]') continue;
    try { chunks.push(JSON.parse(match[1])); } catch { /* 跳过无法解析的事件 */ }
  }
  if (!chunks.length) return null;
  // 已经是完整非流式结构（choices[].message）就直接用。
  if (chunks.some((chunk) => chunk?.choices?.[0]?.message)) return chunks.find((chunk) => chunk.choices[0].message);
  // 否则按 delta 拼装。
  let content = '';
  let role = 'assistant';
  const toolCalls = new Map();
  let finishReason = null;
  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.role) role = choice.delta.role;
    if (typeof choice.delta?.content === 'string') content += choice.delta.content;
    for (const call of choice.delta?.tool_calls || []) {
      const index = call.index ?? 0;
      const merged = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (call.id) merged.id = call.id;
      if (call.function?.name) merged.function.name += call.function.name;
      if (call.function?.arguments) merged.function.arguments += call.function.arguments;
      toolCalls.set(index, merged);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  const message = { role, content: content || null };
  if (toolCalls.size) message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return { choices: [{ index: 0, message, finish_reason: finishReason || (toolCalls.size ? 'tool_calls' : 'stop') }] };
}

// 把归一化后的对象包成 JSON 响应，保留原状态码——错误响应也要能正确映射成中文提示。
function asJsonResponse(payload, response) {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers });
}

// 纠偏中间件：应对两种常见的网关偏离。
//   1) 非流式请求却回 SSE —— SDK 按 content-type 选择解析器，会把整个 SSE 当 JSON 解析而报错；
//   2) 正常 JSON 后面追加 `data: [DONE]` —— JSON.parse 遇到尾随字符直接失败。
// 非流式响应体受 maxTokens 约束，整体缓冲的代价可以接受。
export async function normalizingFetch(input, init) {
  const requestBody = typeof init?.body === 'string' ? init.body : '';
  const wantsStream = /"stream"\s*:\s*true/.test(requestBody);
  const response = await globalThis.fetch(input, init);
  if (wantsStream) return response;

  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  if (contentType.includes('text/event-stream')) {
    const assembled = assembleSseCompletion(text);
    if (!assembled) return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    return asJsonResponse(assembled, response);
  }

  // 纯 JSON：能直接解析就原样放行，避免不必要的重新序列化；
  // 解析失败再走宽容解析，清理尾部垃圾或花括号外的前后缀。
  if (!text.trim()) return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  try {
    JSON.parse(text);
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    const payload = parseProviderPayload(text);
    if (!payload) return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    return asJsonResponse(payload, response);
  }
}

// 从错误链上取状态码：SDK 重试后会包成 AI_RetryError，真正的 AI_APICallError 在 cause 里。
function extractStatusCode(error) {
  let current = error;
  let depth = 0;
  while (current && depth < 5) {
    if (typeof current.statusCode === 'number') return current.statusCode;
    if (typeof current.status === 'number') return current.status;
    current = current.cause || current.previous;
    depth += 1;
  }
  return 0;
}

export function mapSdkError(error) {
  if (!error) return new Error('AI 服务返回解析失败');
  if (typeof error === 'string') return new Error(error);

  // 已经在中间件里转好的中文错误直接透传。
  if (error.message && /超时|已取消|无法连接/.test(error.message)) return error;

  const statusCode = extractStatusCode(error);

  // 上游返回体里通常还留着原始 error.message，优先用它判断限流/模型不可用。
  let upstream = '';
  const body = error.responseBody ?? error.data ?? error.cause?.responseBody ?? error.cause?.data;
  if (typeof body === 'string') {
    const parsed = parseProviderPayload(body);
    upstream = parsed?.error
      ? (typeof parsed.error === 'string' ? parsed.error : parsed.error.message || '')
      : body.slice(0, 200);
  } else if (body && typeof body === 'object') {
    upstream = typeof body.error === 'string' ? body.error : body.error?.message || '';
  }
  if (!upstream && error.message) {
    // SDK 的重试包装有多种写法：
    //   "Failed after 3 attempts. Last error: AI_APICallError: [429] ..."
    //   "Last error: AI_APICallError: Bad Gateway"
    // 统一剥掉这些前缀，只留下游原文交给错误映射。
    upstream = error.message
      .replace(/^Failed after \d+ attempts?\.\s*/i, '')
      .replace(/^Last error:\s*/i, '')
      .replace(/^AI_[A-Za-z]*Error:\s*/, '');
  }

  return new Error(providerErrorMessage(statusCode, upstream));
}

// 建立一个指向用户配置端点的 Provider 实例。
// timeoutMs 通过 fetch 的 AbortSignal 实现：SDK 本身没有超时参数，
// 而服务端挂起会让面板永远停在「处理中」。
export function createProvider({ baseUrl, apiKey, timeoutMs = 120000, name = 'openai-compatible' } = {}) {
  return createOpenAICompatible({
    name,
    baseURL: baseUrl,
    apiKey,
    fetch: async (input, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      const upstream = init?.signal;
      // 同时尊重调用方传入的 signal（例如用户取消）。
      const onAbort = () => controller.abort(upstream?.reason);
      if (upstream) {
        if (upstream.aborted) controller.abort(upstream.reason);
        else upstream.addEventListener('abort', onAbort, { once: true });
      }
      try {
        return await normalizingFetch(input, { ...init, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          const reason = controller.signal.reason;
          if (reason instanceof Error && reason.message === 'timeout') throw new Error('AI 服务响应超时，请稍后重试');
          throw new Error('AI 请求已取消');
        }
        throw new Error(`无法连接 AI 服务: ${error?.message || '网络错误'}`);
      } finally {
        clearTimeout(timer);
        if (upstream) upstream.removeEventListener('abort', onAbort);
      }
    },
  });
}
