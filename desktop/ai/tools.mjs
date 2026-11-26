// 工具注册表：Agent 能「动手」的全部范围都在这里，且首期一律只读。
// 每个工具在真正执行前都要过 guard()——这是从 Pi Agent SDK 的 beforeToolCall
// 借鉴来的挂载点：校验发生在执行之前，而不是执行完之后再事后检查。
import path from 'node:path';
import { createRequire } from 'node:module';
import { SEARCH_FOLDER_SCHEMA, validate } from './schema.mjs';

const require = createRequire(import.meta.url);
const folders = require('../folders.cjs');

// 单次检索回传给模型的结果上限。工具结果会直接进上下文，
// 不设上限等于把整个文件夹塞给模型。
const MAX_RESULTS = 12;
const MAX_RESULTS_PER_FILE = 2;
const MAX_CONTEXT_CHARS = 300;

// 已导入文件夹解析：只接受 session 里登记过的绝对路径。
// 模型给的名字不可信，绝不能让它在任意磁盘位置检索。
function resolveRoot(requested, roots) {
  if (!Array.isArray(roots) || !roots.length) return { ok: false, reason: '当前没有已导入的文件夹' };
  if (requested === undefined) return { ok: true, roots };
  const target = path.resolve(requested);
  const matched = roots.find((root) => path.resolve(root) === target);
  if (!matched) return { ok: false, reason: '只能检索已在墨页中导入的文件夹' };
  return { ok: true, roots: [matched] };
}

function trimContext(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_CONTEXT_CHARS ? `${flat.slice(0, MAX_CONTEXT_CHARS)}…` : flat;
}

// 把工具层与文件系统、会话状态解耦：调用方注入已导入文件夹列表。
// 这样工具层不需要知道 session.json 的存在，也便于测试。
export function createTools({ folders: roots = [], io } = {}) {
  const registry = {
    search_folder: {
      label: '检索文件夹',
      description: '在用户已导入的文件夹中全文检索关键词，返回命中的文档路径、行号与上下文片段。只能访问已导入文件夹。',
      schema: SEARCH_FOLDER_SCHEMA,
      // 只读工具：不做任何写操作，因此无需额外确认。
      mutates: false,
      async run(args) {
        const options = {};
        if (args.regex) options.regex = true;
        const collected = [];
        let totalMatches = 0;
        let truncated = false;
        for (const root of roots) {
          const result = await folders.searchFolder(root, args.query, { ...options, io });
          totalMatches += result.totalMatches || 0;
          if (result.truncated) truncated = true;
          for (const file of result.results || []) {
            const hits = (file.matches || []).slice(0, MAX_RESULTS_PER_FILE).map((match) => ({
              line: match.lineNumber,
              context: trimContext(match.context),
            }));
            if (!hits.length) continue;
            collected.push({
              folder: root,
              path: file.path,
              name: file.name,
              hits,
            });
            if (collected.length >= MAX_RESULTS) { truncated = true; break; }
          }
          if (collected.length >= MAX_RESULTS) break;
        }
        return {
          // 空结果要明确说明是「没搜到」而不是「工具坏了」，模型才不会反复重试。
          results: collected,
          totalMatches,
          truncated,
          note: collected.length
            ? '以下为命中片段，路径相对于所属文件夹。'
            : '没有找到匹配内容；可以换一个关键词再试。',
        };
      },
    },
  };
  return { registry, roots };
}

// 执行前的守卫：工具名白名单 → schema 校验 → 路径复核。
// 返回 { ok: true } 或 { ok: false, reason }；拒绝原因会作为工具结果回填给模型，
// 让它有机会自我纠正，而不是抛异常中断整轮。
export async function guard(toolName, args, registry) {
  if (typeof toolName !== 'string' || !Object.prototype.hasOwnProperty.call(registry, toolName)) {
    return { ok: false, reason: `不在允许列表内的工具：${toolName}` };
  }
  const checked = validate(registry[toolName].schema, args);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return { ok: true, value: checked.value };
}
