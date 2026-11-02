'use strict';

// Folder import stays read-only on disk: scanning classifies entries and never writes,
// moves or deletes anything. All paths handed to the renderer are root-relative with
// forward slashes; resolveInFolder is the single place that turns them back into
// absolute paths and rejects anything escaping the registered folder root.

const path = require('node:path');
const { decode } = require('./files.cjs');

const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_ENTRIES = 2000;
const MAX_SCAN_DOCS = 300;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
// Reason strings are user-facing; the renderer displays them verbatim in the
// "未纳入" summary so users can trace why an entry was left out.
const REASONS = {
  type: '不支持的文件类型',
  size: '文件超过 10 MB 限制',
  symlink: '软链接，不跟随',
  encoding: '不是有效的 UTF-8 文本',
  read: '读取失败',
  limit: '超出单次扫描上限，未读取',
  special: '不是常规文件',
};

function toRel(...segments) { return segments.join('/'); }
function relSegments(rel) {
  if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0') || rel.includes('\\') || /^\//.test(rel) || /(^|\/)\.\.?(\/|$)/.test(rel)) return null;
  return rel.split('/').filter(Boolean);
}
function resolveInFolder(root, rel) {
  const segments = relSegments(rel);
  if (!segments) return null;
  const target = path.resolve(root, ...segments);
  const contained = path.relative(path.resolve(root), target);
  if (!contained || contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) return null;
  return target;
}

// Reads every candidate document once so encoding problems surface at import time
// instead of as a surprise on first open; oversize files are excluded by stat alone.
async function scanFolder(root, io, extensions, maxBytes) {
  const tree = { name: path.basename(path.resolve(root)) || path.resolve(root), path: '', dirs: [], docs: [] };
  const excluded = [];
  let entries = 0;
  let docs = 0;
  let truncated = false;

  async function walk(dirRel, dirNode, depth) {
    if (depth > MAX_SCAN_DEPTH) { truncated = true; return; }
    let dirents;
    try { dirents = await io.readdir(path.resolve(root, ...dirRel.split('/').filter(Boolean)), { withFileTypes: true }); }
    catch (error) { excluded.push({ path: dirRel || '.', reason: `${REASONS.read}：${error.message}` }); return; }
    for (const dirent of dirents) {
      if (++entries > MAX_SCAN_ENTRIES) { truncated = true; return; }
      const childRel = dirRel ? toRel(dirRel, dirent.name) : dirent.name;
      if (dirent.isSymbolicLink()) { excluded.push({ path: childRel, reason: REASONS.symlink }); continue; }
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        const node = { name: dirent.name, path: childRel, dirs: [], docs: [] };
        dirNode.dirs.push(node);
        await walk(childRel, node, depth + 1);
        continue;
      }
      if (!dirent.isFile()) { excluded.push({ path: childRel, reason: REASONS.special }); continue; }
      if (!extensions.has(path.extname(dirent.name).toLowerCase())) { excluded.push({ path: childRel, reason: REASONS.type }); continue; }
      if (docs >= MAX_SCAN_DOCS) { excluded.push({ path: childRel, reason: REASONS.limit }); continue; }
      const absolute = path.resolve(root, ...childRel.split('/'));
      try {
        const stat = await io.stat(absolute);
        if (!stat.isFile()) { excluded.push({ path: childRel, reason: REASONS.special }); continue; }
        if (stat.size > maxBytes) { excluded.push({ path: childRel, reason: REASONS.size }); continue; }
        decode(await io.readFile(absolute));
        docs += 1;
        dirNode.docs.push({ name: dirent.name, path: childRel });
      } catch (error) {
        const reason = error.code === 'ENOENT' ? `${REASONS.read}：文件已不存在` : /UTF-8/.test(error.message) ? REASONS.encoding : `${REASONS.read}：${error.message}`;
        excluded.push({ path: childRel, reason });
      }
    }
  }

  await walk('', tree, 1);
  return { tree, excluded, truncated, entryCount: entries };
}

module.exports = { MAX_SCAN_DEPTH, MAX_SCAN_ENTRIES, MAX_SCAN_DOCS, SKIP_DIRS, REASONS, toRel, relSegments, resolveInFolder, scanFolder };
