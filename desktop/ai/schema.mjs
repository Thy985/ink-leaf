// 工具参数与 trace 的结构化定义。
// 这里只描述「模型能看到什么形状」，真正的校验仍然逐字段手写（见 validate），
// 因为模型给出的参数是不可信输入，必须在此之前再拦一道。

// search_folder 的入参：query 必填，folder 可选（缺省表示在全部已导入文件夹中检索）。
export const SEARCH_FOLDER_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 200, description: '要检索的关键词或短语' },
    folder: { type: 'string', description: '可选：限定在某个已导入文件夹的绝对路径内检索' },
    regex: { type: 'boolean', description: '可选：把 query 当作正则表达式' },
  },
  required: ['query'],
  additionalProperties: false,
};

// search_document 的入参：只在「当前这一篇文档」内检索。
// 与 search_folder 分开放，是为了让权限边界在 schema 层就一目了然——
// 问答不应该因为一个参数就扩大到读取其他文档。
export const SEARCH_DOCUMENT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 200, description: '要在当前文档中检索的关键词或短语' },
  },
  required: ['query'],
  additionalProperties: false,
};

// 审阅条目的形状。模型按要求返回一个数组，UI 逐条展示。
// 不依赖 response_format：已实证兼容网关对结构化输出支持不一致，
// 用提示词约束 + 宽容解析更稳，解析失败时退化为整段文本而不是报错。
export const REVIEW_ITEM_KEYS = Object.freeze(['position', 'original', 'suggested', 'reason']);

// 从模型回复里取出审阅条目数组。
// 模型常见的偏离：包一层 ```json 代码块、在数组前后写说明文字、用对象包住数组。
// 这些都不该让功能失败——取不到结构化结果时返回 null，由调用方退化成纯文本。
export function parseReviewItems(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let text = raw.trim();

  // 去掉 markdown 代码围栏，保留其中内容。
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) text = fenced[1].trim();

  const attempt = (candidate) => {
    try { return JSON.parse(candidate); } catch { return undefined; }
  };

  let parsed = attempt(text);
  // 前后夹着说明文字时，截出最外层的数组或对象。
  if (parsed === undefined) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) parsed = attempt(text.slice(start, end + 1));
  }
  if (parsed === undefined) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) parsed = attempt(text.slice(start, end + 1));
  }
  if (parsed === undefined) return null;

  // 允许 { items: [...] } 或 { suggestions: [...] } 这类包装。
  const list = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.items) ? parsed.items
      : (Array.isArray(parsed?.suggestions) ? parsed.suggestions : null));
  if (!list) return null;

  const items = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const item = {};
    for (const key of REVIEW_ITEM_KEYS) {
      const value = entry[key];
      if (typeof value === 'string' && value.trim()) item[key] = value.trim().slice(0, 2000);
    }
    // 一条建议至少要能看出改什么，否则展示出来只是噪音。
    if (!item.suggested && !item.original) continue;
    items.push(item);
    if (items.length >= 50) break;
  }
  return items.length ? items : null;
}

// 单个 trace 步骤的形状。刻意不含文档正文：trace 会进日志与 UI，正文不应外泄。
export const TRACE_STEP_SHAPE = Object.freeze({
  stepIndex: 'number',
  toolName: 'string',
  argsDigest: 'string',
  durationMs: 'number',
  outcome: 'ok | rejected | error',
  reason: 'string?',
});

// 入参摘要：截断并去掉换行，只保留足够定位调用的信息。
// 摘要会展示给用户，因此不拼接完整正文，避免大段文档内容出现在 trace 里。
export function digestArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      const flat = value.replace(/\s+/g, ' ').trim();
      parts.push(`${key}=${flat.length > 60 ? `${flat.slice(0, 60)}…` : flat}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(' ').slice(0, 200);
}

// 把模型给的参数按 schema 收紧。返回 { ok, value } 或 { ok: false, reason }。
// 拒绝时返回结构化原因而不是抛异常：调用方要把原因作为 tool 结果回填给模型，
// 让它有机会自我纠正，而不是整轮对话崩掉。
export function validate(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: '参数必须是对象' };
  }
  const props = schema.properties || {};
  for (const key of Object.keys(args)) {
    if (!props[key]) return { ok: false, reason: `不支持的参数：${key}` };
  }
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return { ok: false, reason: `缺少必填参数：${key}` };
    }
  }
  const value = {};
  for (const [key, spec] of Object.entries(props)) {
    const raw = args[key];
    if (raw === undefined || raw === null) continue;
    if (spec.type === 'string') {
      if (typeof raw !== 'string') return { ok: false, reason: `${key} 必须是字符串` };
      const trimmed = raw.trim();
      if (spec.minLength && trimmed.length < spec.minLength) return { ok: false, reason: `${key} 不能为空` };
      if (spec.maxLength && trimmed.length > spec.maxLength) return { ok: false, reason: `${key} 超过长度限制` };
      value[key] = trimmed;
    } else if (spec.type === 'boolean') {
      if (typeof raw !== 'boolean') return { ok: false, reason: `${key} 必须是布尔值` };
      value[key] = raw;
    } else if (spec.type === 'number') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return { ok: false, reason: `${key} 必须是数字` };
      value[key] = raw;
    } else {
      return { ok: false, reason: `未知参数类型：${key}` };
    }
  }
  return { ok: true, value };
}
