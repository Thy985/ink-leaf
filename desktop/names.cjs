'use strict';
const path = require('node:path');
const { ALLOWED_EXTENSIONS } = require('./files.cjs');

function isReservedWindowsName(value) {
  const trimmed = String(value).replace(/[. ]+$/g, '');
  const stem = trimmed.split('.')[0].toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}
function validBareName(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value) || /[<>:"|?*\u0000-\u001f]/.test(value) || !ALLOWED_EXTENSIONS.has(path.extname(value).toLowerCase()) || isReservedWindowsName(value)) {
    throw new Error('名称必须是安全的 .md、.markdown 或 .txt 文件名');
  }
  return value;
}
function safeDocumentName(name) {
  const raw = typeof name === 'string' ? path.basename(name).trim() : '';
  const cleaned = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim();
  const ext = path.extname(cleaned).toLowerCase();
  const stem = (ALLOWED_EXTENSIONS.has(ext) ? cleaned.slice(0, -ext.length) : cleaned) || '未命名';
  const candidate = ALLOWED_EXTENSIONS.has(ext) ? `${stem}${ext}` : `${stem}.md`;
  return isReservedWindowsName(candidate) ? '未命名.md' : candidate;
}
module.exports = { isReservedWindowsName, validBareName, safeDocumentName };
