// 工具注册表：Agent 能「动手」的全部范围都在这里，且首期一律只读。
// 每个工具在真正执行前都要过 guard()——这是从 Pi Agent SDK 的 beforeToolCall
// 借鉴来的挂载点：校验发生在执行之前，而不是执行完之后再事后检查。
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  SEARCH_FOLDER_SCHEMA, SEARCH_DOCUMENT_SCHEMA, LIST_WORKSPACE_SCHEMA, FIND_LINKS_SCHEMA, validate,
} from './schema.mjs';
import {
  buildWorkspaceIndex, describeWorkspace, findBacklinks, findBrokenLinks,
} from './workspace.mjs';

const require = createRequire(import.meta.url);
const folders = require('../folders.cjs');

// 单次检索回传给模型的结果上限。工具结果会直接进上下文，
// 不设上限等于把整个文件夹塞给模型。
const MAX_RESULTS = 12;
const MAX_RESULTS_PER_FILE = 2;
const MAX_CONTEXT_CHARS = 300;

// 已导入文件夹解析：只接受 session 里登记过的绝对路径。
// 模型给的名字不可信，绝不能让它在任意磁盘位置检索。
// Windows 路径大小写不敏感，且盘符可能有 \\?\ 前缀，所以比较前统一规范化：
// \?\C:\X 与 c:/x 必须判为同一个目录，否则合法请求会被误拒。
function normalizeForCompare(p) {
  let value = String(p || '');
  // 去掉 Windows 扩展长度前缀，它只是路径写法而不是不同位置。
  if (/^\\\\\?\\/.test(value)) value = value.slice(4);
  value = path.normalize(value);
  // Windows 上大小写不敏感；其他平台保留大小写（大小写敏感的卷上 C:/A 与 c:/a 确为不同目录）。
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function resolveRoot(requested, roots) {
  if (!Array.isArray(roots) || !roots.length) return { ok: false, reason: '当前没有已导入的文件夹' };
  if (requested === undefined) return { ok: true, roots };
  const target = normalizeForCompare(path.resolve(requested));
  const matched = roots.find((root) => normalizeForCompare(path.resolve(root)) === target);
  if (!matched) return { ok: false, reason: '只能检索已在墨页中导入的文件夹' };
  return { ok: true, roots: [matched] };
}

function trimContext(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_CONTEXT_CHARS ? `${flat.slice(0, MAX_CONTEXT_CHARS)}…` : flat;
}

// 把工具层与文件系统、会话状态解耦：调用方注入已导入文件夹的绝对路径。
// 注意：session.json 里 folders 的元素是 { path, lastDoc, addedAt } 对象，
// 调用方需先映射成路径字符串（ai.cjs 的 runAgent 已代为处理）。
// 这里再过滤一遍：不是绝对路径的条目直接丢弃，避免一个坏数据让整轮工具调用
// 在深层抛出 TypeError，再被包装成「无法连接 AI 服务」这种误导性提示。
export function createTools({ folders: roots = [], io, document: currentDocument = null } = {}) {
  const usableRoots = (Array.isArray(roots) ? roots : [])
    .map((entry) => (entry && typeof entry === 'object' ? entry.path : entry))
    .filter((entry) => typeof entry === 'string' && path.isAbsolute(entry));
  roots = usableRoots;
  // 索引按需构建且只建一次：一轮 Agent 里模型常连续追问，
  // 每次都重扫整个文件夹既慢又毫无意义。索引只在本次工具会话内有效，
  // 不跨轮缓存——用户随时可能在应用外改动文件，长期缓存会读到过期内容。
  let indexPromise = null;
  const getIndex = () => {
    if (!indexPromise) indexPromise = buildWorkspaceIndex({ roots, io: io || undefined });
    return indexPromise;
  };
  // 当前文档作为「问答上下文」存在时，它自己就是一个检索范围。
  // 与 search_folder 分开是为了让权限边界在工具清单里一眼可辨：
  // 读已导入文件夹是另一类能力，读当前文档是又一类能力。
  const hasDocument = currentDocument && typeof currentDocument.text === 'string' && currentDocument.text.length > 0;
  const registry = {
    search_document: {
      label: '检索当前文档',
      description: '在当前正在编辑的这篇文档内检索关键词，返回行号与上下文片段。只能读当前这一篇文档，不能访问其他文件。',
      schema: SEARCH_DOCUMENT_SCHEMA,
      // 范围声明：只读当前文档。guard 会复核 hasDocument 与 schema 不含路径类参数。
      scope: 'document',
      hasDocument,
      // 只读工具：不做任何写操作，因此无需额外确认。
      mutates: false,
      async run(args) {
        if (!hasDocument) {
          return { results: [], totalMatches: 0, truncated: false, note: '当前没有可检索的文档内容。' };
        }
        const text = currentDocument.text;
        let matches;
        try {
          matches = folders.extractMatches(text, args.query, {});
        } catch {
          return { results: [], totalMatches: 0, truncated: false, note: '检索关键词无效，请换一个。' };
        }
        if (!matches.length) {
          return { results: [], totalMatches: 0, truncated: false, note: '文档中没有找到匹配内容；可以换一个关键词再试。' };
        }
        const hits = matches.slice(0, MAX_RESULTS).map((match) => ({
          line: match.lineNumber,
          context: trimContext(match.context),
        }));
        return {
          results: [{ name: currentDocument.filename || '当前文档', hits }],
          totalMatches: matches.length,
          truncated: matches.length > MAX_RESULTS,
          note: '以下为当前文档中的命中片段。',
        };
      },
    },
    search_folder: {
      label: '检索文件夹',
      description: '在用户已导入的文件夹中全文检索关键词，返回命中的文档路径、行号与上下文片段。只能访问已导入文件夹。',
      schema: SEARCH_FOLDER_SCHEMA,
      // 范围声明：只读已导入文件夹。
      scope: 'folders',
      roots,
      // 只读工具：不做任何写操作，因此无需额外确认。
      mutates: false,
      async run(args) {
        // 模型可以用 folder 限定范围；不在已导入列表里的路径一律拒绝，
        // 而不是静默退化成「搜全部」——那样会让用户以为只搜了一个文件夹。
        const scope = resolveRoot(args.folder, roots);
        if (!scope.ok) return { results: [], totalMatches: 0, truncated: false, note: scope.reason };
        const options = {};
        if (args.regex) options.regex = true;
        const collected = [];
        let totalMatches = 0;
        let truncated = false;
        for (const root of scope.roots) {
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
    list_workspace: {
      label: '列出工作区',
      description: '列出用户已导入的工作区：包含哪些文件夹、每篇文档的标题与相对路径。只描述结构，不返回正文。',
      schema: LIST_WORKSPACE_SCHEMA,
      // 范围声明：只读已导入文件夹。
      scope: 'folders',
      roots,
      mutates: false,
      async run() {
        if (!roots.length) {
          return { roots: [], totalDocs: 0, documents: [], note: '用户还没有导入任何文件夹。' };
        }
        const desc = describeWorkspace(await getIndex());
        return { ...desc, note: desc.truncated ? '文档数量超过索引上限，列表可能不完整。' : '以下为已导入文件夹中的文档清单。' };
      },
    },
    find_links: {
      label: '查询链接关系',
      description: '查询某篇文档的反向链接（哪些文档用 [[标题]] 指向它），或列出指向不存在文档的死链。用于理解文档之间的关系。',
      schema: FIND_LINKS_SCHEMA,
      // 范围声明：只读已导入文件夹。
      scope: 'folders',
      roots,
      mutates: false,
      async run(args) {
        if (!roots.length) {
          return { title: args.title || '', targets: [], backlinks: [], note: '用户还没有导入任何文件夹。' };
        }
        const index = await getIndex();
        if (args.broken) {
          const broken = findBrokenLinks(index);
          return {
            broken,
            note: broken.length ? '以下链接指向不存在的文档。' : '没有发现指向不存在文档的链接。',
          };
        }
        if (!args.title) {
          // 两者都不指定时给死链清单——这是用户最常见的「链接检查」需求。
          const broken = findBrokenLinks(index);
          return {
            broken,
            note: '未指定标题，返回死链清单。可以用 title 参数查询某篇文档的反向链接。',
          };
        }
        const result = findBacklinks(index, args.title);
        return {
          ...result,
          note: result.backlinks.length
            ? `找到 ${result.backlinks.length} 条指向「${args.title}」的链接。`
            : `没有文档指向「${args.title}」。`,
        };
      },
    },
  };
  return { registry, roots };
}

// 执行前的守卫：工具名白名单 → schema 校验 → 读取范围复核。
// 返回 { ok: true } 或 { ok: false, reason }；拒绝原因会作为工具结果回填给模型，
// 让它有机会自我纠正，而不是抛异常中断整轮。
//
// 实测确认 SDK 不会在调用 execute 前替我们校验工具名与参数（探针：非法参数会原样传到 execute），
// 所以这里是唯一一道拦得住不可信模型输入的关口，不能只靠 run() 内部自觉。
//
// 范围复核（H1 复审 I3）：每个工具必须显式声明 scope，guard 按声明复核。
// 早先只有「带 folder 参数 + 有 roots」的工具会被复核，search_document 这类
// 靠闭包自保的工具不在复核范围内——当前安全，但任何人给它加个路径参数，
// guard 都不会拦，而注释却写着它是安全钩子。
//
// 要点：
// 1. **没有 scope 声明就拒绝**，不设默认值。「漏写声明」必须是显式错误，
//    而不是悄悄落到最宽松的分支——那等于把安全默认值调反（复审 finding 4）。
// 2. scope='document' 用**白名单**复核参数：只有该 scope 允许的字段能出现，
//    其余一律拒绝。黑名单（列举 path/folder/docId…）挡不住 source/uri/name
//    这类同义字段，等于给未来留了绕过口（复审 finding 3）。
const SCOPE_RULES = Object.freeze({
  folders: { allowedParams: ['query', 'folder', 'regex', 'title', 'broken'] },
  document: { allowedParams: ['query'] },
});

export async function guard(toolName, args, registry) {
  if (typeof toolName !== 'string' || !Object.prototype.hasOwnProperty.call(registry, toolName)) {
    return { ok: false, reason: `不在允许列表内的工具：${toolName}` };
  }
  const spec = registry[toolName];
  const checked = validate(spec.schema, args);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const rule = SCOPE_RULES[spec.scope];
  if (!rule) {
    return { ok: false, reason: `工具范围未声明或不可识别：${spec.scope || '(缺失)'}` };
  }

  // 白名单复核：schema 里出现的每个参数都必须是该 scope 允许的。
  const declaredProps = Object.keys(spec.schema?.properties || {});
  const unexpected = declaredProps.filter((key) => !rule.allowedParams.includes(key));
  if (unexpected.length) {
    return { ok: false, reason: `工具范围声明与实现不符：${spec.scope} 范围不应接受参数 ${unexpected.join('、')}` };
  }

  if (spec.scope === 'folders' && !Array.isArray(spec.roots)) {
    return { ok: false, reason: '工具范围声明与实现不符：缺少已导入文件夹' };
  }
  if (spec.scope === 'document' && !spec.hasDocument) {
    // 这属于接线错误，不是用户的操作问题；措辞要能让维护者看懂，
    // 但也不能让最终用户以为是自己做错了什么（复审 finding 5）。
    return { ok: false, reason: '本次没有可供检索的文档' };
  }
  if (checked.value.folder !== undefined) {
    const resolved = resolveRoot(checked.value.folder, spec.roots);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
  }
  return { ok: true, value: checked.value };
}
