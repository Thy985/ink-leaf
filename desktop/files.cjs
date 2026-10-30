'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const EXPORT_EXTENSIONS = new Set(['.html', '.htm']);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);
// Magic numbers must match the claimed extension; a renamed file is never served.
const IMAGE_SIGNATURES = [
  ['.png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['.jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['.jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['.gif', (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38],
  ['.webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['.bmp', (b) => b[0] === 0x42 && b[1] === 0x4d],
  ['.avif', (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && ['avif', 'avis'].some((brand) => b.subarray(8, 12).toString('latin1').startsWith(brand.slice(0, 4)))],
];
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif' };
const IMAGE_MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif' };

function assertSupportedPath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('只允许打开本地绝对路径');
  if (!ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('仅支持 .md、.markdown 或 .txt 文件');
}
function normalize(text) { return text.replace(/\r\n?/g, '\n'); }
function decode(buffer) {
  if (buffer.length > MAX_BYTES) throw new Error('文件超过 10 MB 限制');
  let bom = false;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) { bom = true; buffer = buffer.subarray(3); }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('文件不是有效的 UTF-8 文本，未打开'); }
  return { text: normalize(text), bom, eol: /\r\n/.test(text) ? 'crlf' : 'lf' };
}
async function readDocument(filePath, io = fsp) {
  assertSupportedPath(filePath);
  const stat = await io.stat(filePath);
  if (!stat.isFile()) throw new Error('所选路径不是文件');
  if (stat.size > MAX_BYTES) throw new Error('文件超过 10 MB 限制');
  const data = await io.readFile(filePath);
  const decoded = decode(data);
  return { ...decoded, filepath: filePath, filename: path.basename(filePath), fingerprint: fingerprint(stat, data) };
}
function fingerprint(stat, data) {
  return { size: stat.size, mtimeMs: stat.mtimeMs, hash: crypto.createHash('sha256').update(data).digest('hex') };
}
async function currentFingerprint(filePath, io = fsp) {
  try { const stat = await io.stat(filePath); const data = await io.readFile(filePath); return fingerprint(stat, data); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function sameFingerprint(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.hash === b.hash;
}
async function writeDocumentAtomic(filePath, text, options = {}, io = fsp) {
  assertSupportedPath(filePath);
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('文档超过 10 MB 限制');
  const eol = options.eol === 'crlf' ? '\r\n' : '\n';
  const bom = options.bom ? '\ufeff' : '';
  const data = Buffer.from(bom + normalize(text).replace(/\n/g, eol), 'utf8');
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await io.writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
    await io.rename(tmp, filePath);
  } catch (error) {
    try { await io.unlink(tmp); } catch {}
    throw new Error(`保存失败：${error.message}`);
  }
  const stat = await io.stat(filePath);
  return { filepath: filePath, filename: path.basename(filePath), savedText: normalize(text), fingerprint: fingerprint(stat, data) };
}

function sniffImageType(extension, data) {
  const entry = IMAGE_SIGNATURES.find(([ext]) => ext === extension);
  if (!entry || data.length < 12) return null;
  return entry[1](data) ? IMAGE_MIME[extension] : null;
}

// Local images resolve only against the open document's directory. Traversal outside it,
// absolute paths, URL schemes, oversized files and content that contradicts the extension
// are all rejected; the renderer layer only ever receives a data URL on success.
async function readImage(baseDir, relativePath, io = fsp) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.includes('\0')) throw new Error('无效的图片路径');
  const withoutQuery = relativePath.split(/[?#]/)[0];
  let decoded = withoutQuery;
  try { decoded = decodeURIComponent(withoutQuery); } catch { /* keep the raw path */ }
  if (path.isAbsolute(decoded) || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) throw new Error('仅支持相对于文档目录的图片路径');
  if (!baseDir) throw new Error('先保存文档，才能加载本地图片');
  const target = path.resolve(baseDir, decoded);
  const contained = path.relative(baseDir, target);
  if (!contained || contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) throw new Error('图片必须位于文档目录内');
  const extension = path.extname(target).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('不支持的图片格式');
  let stat;
  try { stat = await io.stat(target); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('找不到图片文件'); throw error; }
  if (!stat.isFile()) throw new Error('图片路径不是文件');
  if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片超过 5 MB 限制');
  const data = await io.readFile(target);
  const mime = sniffImageType(extension, data);
  if (!mime) throw new Error('图片内容与扩展名不符');
  return { dataUrl: `data:${mime};base64,${data.toString('base64')}`, filepath: target };
}

// Exported HTML files share the document pipeline's atomic-write discipline but use their
// own extension whitelist, so save-as-document validation never blocks or admits them.
async function writeHtmlFile(filePath, html, io = fsp) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('只允许写入本地绝对路径');
  if (!EXPORT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw new Error('仅支持导出 .html 或 .htm 文件');
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_BYTES) throw new Error('导出内容超过 10 MB 限制');
  const data = Buffer.from(html, 'utf8');
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await io.writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
    await io.rename(tmp, filePath);
  } catch (error) {
    try { await io.unlink(tmp); } catch {}
    throw new Error(`导出失败：${error.message}`);
  }
  return { filepath: filePath, filename: path.basename(filePath) };
}
// Clipboard and drag-dropped images are written only beside the open document. The
// extension comes from the declared MIME type and is verified against the file header,
// and the file name is generated here so user-controlled text never becomes a path.
async function writeImageFile(baseDir, mime, data, io = fsp) {
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) throw new Error('请先保存文档，再插入图片');
  const extension = IMAGE_MIME_TO_EXT[mime];
  if (!extension) throw new Error('不支持的图片类型');
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('图片内容为空');
  if (data.length > MAX_IMAGE_BYTES) throw new Error('图片超过 5 MB 限制');
  if (!sniffImageType(extension, data)) throw new Error('图片内容与类型不一致');
  let stat;
  try { stat = await io.stat(baseDir); } catch (error) { throw new Error(`文档目录不可用：${error.message}`); }
  if (!stat.isDirectory()) throw new Error('文档目录不可用');
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stem = `粘贴图片-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  let target = null;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    const candidate = path.join(baseDir, attempt ? `${stem}-${attempt}${extension}` : `${stem}${extension}`);
    try { await io.access(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`写入图片失败：${error.message}`); target = candidate; }
  }
  if (!target) throw new Error('同一秒内插入的图片过多，请稍后再试');
  const tmp = path.join(baseDir, `.${path.basename(target)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await io.writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
    await io.rename(tmp, target);
  } catch (error) {
    try { await io.unlink(tmp); } catch {}
    throw new Error(`写入图片失败：${error.message}`);
  }
  return path.basename(target);
}

// Exported PDF bytes share the HTML export's atomic-write discipline, with their own
// size ceiling; the extension check stays in the caller because PDFs have no document
// pipeline validation of their own.
async function writeBinaryFile(filePath, data, io = fsp) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('只允许写入本地绝对路径');
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('导出内容为空');
  if (data.length > MAX_BYTES) throw new Error('导出内容超过 10 MB 限制');
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await io.writeFile(tmp, data, { flag: 'wx', mode: 0o600 });
    await io.rename(tmp, filePath);
  } catch (error) {
    try { await io.unlink(tmp); } catch {}
    throw new Error(`导出失败：${error.message}`);
  }
  return { filepath: filePath, filename: path.basename(filePath) };
}
module.exports = { MAX_BYTES, MAX_IMAGE_BYTES, ALLOWED_EXTENSIONS, EXPORT_EXTENSIONS, IMAGE_EXTENSIONS, assertSupportedPath, normalize, decode, readDocument, currentFingerprint, fingerprint, sameFingerprint, writeDocumentAtomic, readImage, writeHtmlFile, writeImageFile, writeBinaryFile };
