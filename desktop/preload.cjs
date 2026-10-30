'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = new Set(['restore', 'open', 'new', 'save', 'saveAs', 'close', 'openPending']);
function validAction(action) { if (typeof action !== 'string' || !ACTIONS.has(action)) throw new Error('未知桌面操作'); return action; }
// Image and export requests travel on their own channels with their own validation, so the
// document pipeline's snapshot contract stays untouched.
function validImagePath(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\0\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('无效的图片路径');
  return value;
}
function validExportHtml(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 10 * 1024 * 1024) throw new Error('导出内容超过 10 MB 限制');
  return value;
}
const PASTE_IMAGE_MIME = /^image\/(png|jpeg|gif|webp|bmp|avif)$/;
// Clipboard bytes arrive as ArrayBuffer/TypedArray; anything else or oversized data is
// rejected before it ever reaches the main process.
function validImageBytes(value) {
  const view = value instanceof ArrayBuffer ? new Uint8Array(value) : (ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null);
  if (!view || !view.byteLength) throw new Error('无效的图片数据');
  if (view.byteLength > 5 * 1024 * 1024) throw new Error('图片超过 5 MB 限制');
  return view;
}
function validImageMime(value) {
  if (typeof value !== 'string' || !PASTE_IMAGE_MIME.test(value)) throw new Error('不支持的图片类型');
  return value;
}
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  perform(action, snapshot) { return ipcRenderer.invoke('desktop:perform', validAction(action), snapshot); },
  readImage(relativePath) { return ipcRenderer.invoke('desktop:image', validImagePath(relativePath)); },
  exportHtml(html) { return ipcRenderer.invoke('desktop:exportHtml', validExportHtml(html)); },
  writeImage(mime, bytes) { return ipcRenderer.invoke('desktop:writeImage', validImageMime(mime), validImageBytes(bytes)); },
  exportPdf(html) { return ipcRenderer.invoke('desktop:exportPdf', validExportHtml(html)); },
  syncState(state) { ipcRenderer.send('desktop:state', state); },
  onCommand(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback 必须是函数');
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('desktop:command', listener);
    return () => ipcRenderer.removeListener('desktop:command', listener);
  }
}));
