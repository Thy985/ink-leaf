// 工作区索引：给已导入文件夹建一份**内存**倒排索引与链接图。
//
// 为什么需要它：search_folder 每次调用都重扫整个文件夹并逐次读盘，模型连续追问时会反复
// 做同样的工作（复审 I5 指出过这点）。办公场景下文件夹可能有上百篇文档，这里把「扫描一次、
// 多次查询」的收益拿回来。
//
// 边界（不可退让）：
// 1. 索引只覆盖调用方传入的文件夹路径，不自行发现任何目录；
// 2. 索引只在内存里，不落盘、不同步——文档内容永远不离开用户机器；
// 3. 索引只是缓存。磁盘上的文件可能被外部改动，所以任何「读取正文」的路径仍走
//    folders.cjs 的边界校验，索引不充当安全边界。
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const folders = require('../folders.cjs');
const fsp = fs.promises;

// 单次建索引的规模上限，与 folders.cjs 的扫描上限保持一致，避免出现「索引里有、搜索里没有」。
const MAX_INDEX_FILES = 2000;
const MAX_INDEX_BYTES = 10 * 1024 * 1024;
// 索引里保留每篇文档的截断副本，用于反向链接与快速摘要。
// 完整正文仍由调用方按需从磁盘读取，避免索引长期占用大量内存。
const MAX_INDEXED_TEXT = 200 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

// 简易分词：中文按字，西文按词（与 ai.cjs 的 countWords 同一思路）。
// 倒排表只用于「关键词 → 候选文档」的粗筛，精确匹配仍由 extractMatches 完成，
// 所以这里不需要中文分词器，单字入表即可。
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

function tokenize(text) {
  const tokens = new Set();
  const source = String(text || '');
  for (const char of source.match(CJK_CHAR_RE) || []) tokens.add(char.toLowerCase());
  for (const word of source.replace(CJK_CHAR_RE, ' ').toLowerCase().split(/[^a-z0-9_\u00c0-\u024f]+/)) {
    if (word.length >= 2) tokens.add(word);
  }
  return tokens;
}

// 把相对路径变成展示用标题：去掉扩展名，只保留文件名。
function titleOf(name) {
  return String(name || '').replace(/\.(md|markdown|txt)$/i, '');
}

/**
 * 建一份工作区索引。
 *
 * @param {object} options
 * @param {string[]} options.roots       已导入文件夹的绝对路径
 * @param {object}  [options.io]         注入的 fs（测试用）
 * @param {function} [options.parse]     文档解析函数，返回 wikilink 列表；默认从 web/model.js 取
 * @returns {Promise<{files: Array, byToken: Map, byTitle: Map, backlinks: Map, scannedAt: string, truncated: boolean}>}
 */
export async function buildWorkspaceIndex({ roots = [], io = fsp, parse } = {}) {
  const usableRoots = (Array.isArray(roots) ? roots : [])
    .map((entry) => (entry && typeof entry === 'object' ? entry.path : entry))
    .filter((entry) => typeof entry === 'string' && path.isAbsolute(entry));

  let extract = parse;
  if (!extract) {
    // 默认解析器来自 web/model.js —— 与渲染共用同一份实现（单一事实来源）。
    const model = await import('../../web/model.js');
    extract = (text) => model.documentWikilinks(model.parseBlocks(text));
  }

  const files = [];
  let truncated = false;
  let scanned = 0;

  for (const root of usableRoots) {
    const list = await listMarkdown(root, io);
    for (const rel of list) {
      if (scanned >= MAX_INDEX_FILES) { truncated = true; break; }
      const target = path.resolve(root, ...rel.split('/'));
      let text;
      try {
        const stat = await io.stat(target);
        if (stat && stat.size > MAX_INDEX_BYTES) continue;
        text = await io.readFile(target, 'utf8');
      } catch {
        continue;
      }
      scanned += 1;
      const stored = text.length > MAX_INDEXED_TEXT ? text.slice(0, MAX_INDEXED_TEXT) : text;
      const name = path.basename(rel);
      files.push({
        root,
        rel,
        name,
        title: titleOf(name),
        size: text.length,
        truncated: text.length > MAX_INDEXED_TEXT,
        // 只留摘要供快速预览；完整正文不进索引。
        text: stored,
      });
    }
    if (truncated) break;
  }

  // 倒排表：token → 文档下标集合。
  const byToken = new Map();
  files.forEach((file, index) => {
    for (const token of tokenize(file.text)) {
      let set = byToken.get(token);
      if (!set) { set = new Set(); byToken.set(token, set); }
      set.add(index);
    }
  });

  // 标题表：归一化标题 → 文档下标列表（同名文档可能存在于不同文件夹）。
  const byTitle = new Map();
  files.forEach((file, index) => {
    const key = file.title.toLowerCase();
    let list = byTitle.get(key);
    if (!list) { list = []; byTitle.set(key, list); }
    list.push(index);
  });

  // 链接图：从每篇文档里取 [[标题]]，反向登记到被指向的文档上。
  const backlinks = buildBacklinks(files, byTitle, extract);

  return {
    roots: usableRoots,
    files,
    byToken,
    byTitle,
    backlinks,
    // 保留解析器引用：死链检测要复用同一份实现，不能在别处再写一个。
    extract,
    scannedAt: new Date().toISOString(),
    truncated,
  };
}

// 列出文件夹内的 Markdown（相对路径）。复用 folders.cjs 的跳过规则，
// 避免索引与搜索对「哪些文件算文档」产生两套判断。
async function listMarkdown(root, io) {
  const out = [];
  async function walk(dirRel) {
    if (out.length >= MAX_INDEX_FILES) return;
    let dirents;
    try {
      dirents = await io.readdir(path.resolve(root, ...dirRel.split('/').filter(Boolean)), { withFileTypes: true });
    } catch { return; }
    for (const dirent of dirents) {
      if (out.length >= MAX_INDEX_FILES) return;
      // 软链接不跟随：与 folders.cjs 的扫描保持一致。
      if (dirent.isSymbolicLink()) continue;
      const childRel = dirRel ? `${dirRel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (folders.SKIP_DIRS.has(dirent.name)) continue;
        await walk(childRel);
        continue;
      }
      if (!dirent.isFile()) continue;
      const ext = path.extname(dirent.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      out.push(childRel);
    }
  }
  await walk('');
  return out;
}

// 反向链接：对每篇文档解析出它指向的标题，登记到目标文档上。
// 返回 Map<目标文档下标, Array<{ fromIndex, fromTitle, fromRoot, fromPath, alias }>>。
function buildBacklinks(files, byTitle, extract) {
  const backlinks = new Map();
  files.forEach((file, fromIndex) => {
    let links = [];
    try { links = extract(file.text) || []; } catch { links = []; }
    for (const link of links) {
      const target = String(link?.target || '').toLowerCase();
      if (!target) continue;
      const targets = byTitle.get(target);
      if (!targets) continue; // 指向不存在的文档：不建边，但仍可被 find_links 报告为「未解析」
      for (const toIndex of targets) {
        if (toIndex === fromIndex) continue; // 自引用不算反向链接
        let list = backlinks.get(toIndex);
        if (!list) { list = []; backlinks.set(toIndex, list); }
        list.push({
          fromIndex,
          fromTitle: file.title,
          fromRoot: file.root,
          fromPath: file.rel,
          alias: link.alias || '',
        });
      }
    }
  });
  return backlinks;
}

/**
 * 在工作区索引上做关键词检索，返回候选文档及其命中片段。
 * 先走倒排表粗筛，再用 folders.extractMatches 精确定位，保证与全文搜索语义一致。
 */
export function searchWorkspace(index, query, { limit = 12, perFile = 2 } = {}) {
  if (!index || !query || !String(query).trim()) {
    return { results: [], totalMatches: 0, candidates: 0 };
  }
  const text = String(query).trim();
  const tokens = [...tokenize(text)];
  let candidateIndexes = null;
  for (const token of tokens) {
    const set = index.byToken.get(token);
    if (!set) continue;
    candidateIndexes = candidateIndexes
      ? new Set([...candidateIndexes].filter((i) => set.has(i)))
      : new Set(set);
  }
  // 关键词全是倒排表里没有的字（例如纯标点）时，退化为全量精筛，
  // 否则会出现「明明有匹配却报没找到」。
  const pool = candidateIndexes && candidateIndexes.size
    ? [...candidateIndexes]
    : index.files.map((_, i) => i);

  const results = [];
  let totalMatches = 0;
  for (const index0 of pool) {
    const file = index.files[index0];
    const matches = folders.extractMatches(file.text, text, {});
    if (!matches.length) continue;
    totalMatches += matches.length;
    results.push({
      root: file.root,
      path: file.rel,
      name: file.name,
      title: file.title,
      hits: matches.slice(0, perFile).map((match) => ({
        line: match.lineNumber,
        context: String(match.context || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      })),
    });
    if (results.length >= limit) break;
  }
  return { results, totalMatches, candidates: pool.length };
}

/**
 * 查询反向链接。
 * @param {object} index
 * @param {string} title 目标文档标题（不带扩展名）
 */
export function findBacklinks(index, title) {
  if (!index || !title) return { title: String(title || ''), targets: [], backlinks: [], brokenLinks: [] };
  const key = String(title).replace(/\.(md|markdown|txt)$/i, '').trim().toLowerCase();
  const targets = index.byTitle.get(key) || [];
  const backlinks = [];
  for (const toIndex of targets) {
    const file = index.files[toIndex];
    for (const link of index.backlinks.get(toIndex) || []) {
      backlinks.push({
        to: { root: file.root, path: file.rel, title: file.title },
        from: { root: link.fromRoot, path: link.fromPath, title: link.fromTitle },
        alias: link.alias,
      });
    }
  }
  return {
    title: key,
    targets: targets.map((i) => ({ root: index.files[i].root, path: index.files[i].rel, title: index.files[i].title })),
    backlinks,
  };
}

/**
 * 列出工作区里所有指向不存在文档的 [[链接]]。
 * 拼错的目标不会产生反向链接边，如果不单独报告，用户就永远发现不了这类死链。
 */
export function findBrokenLinks(index) {
  if (!index || typeof index.extract !== 'function') return [];
  const broken = [];
  for (const file of index.files) {
    let links = [];
    try {
      links = index.extract(file.text) || [];
    } catch { links = []; }
    for (const link of links) {
      const target = String(link?.target || '').trim().toLowerCase();
      if (!target || index.byTitle.has(target)) continue;
      broken.push({ root: file.root, path: file.rel, title: file.title, target: link.target });
    }
  }
  return broken;
}

// 工作区概览：给 list_workspace 工具用。只描述结构，不返回正文。
export function describeWorkspace(index) {
  if (!index) return { roots: [], totalDocs: 0, documents: [], truncated: false };
  return {
    roots: index.roots,
    totalDocs: index.files.length,
    truncated: !!index.truncated,
    documents: index.files.map((file) => ({
      root: file.root,
      path: file.rel,
      title: file.title,
      bytes: file.size,
      truncated: file.truncated,
    })),
  };
}
