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
