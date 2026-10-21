'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

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
module.exports = { MAX_BYTES, ALLOWED_EXTENSIONS, assertSupportedPath, normalize, decode, readDocument, currentFingerprint, fingerprint, sameFingerprint, writeDocumentAtomic };
