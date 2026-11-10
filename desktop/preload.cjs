'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = new Set(['restore', 'open', 'new', 'save', 'saveAs', 'close', 'openPending', 'folderAdd', 'folderScan', 'folderOpen', 'folderRename', 'folderCreate', 'folderRemove']);
function validAction(action) { if (typeof action !== 'string' || !ACTIONS.has(action)) throw new Error('未知桌面操作'); return action; }
function validParams(params) {
  if (params === undefined || params === null) return null;
  if (typeof params !== 'object' || Array.isArray(params)) throw new Error('无效的操作参数');
  return params;
}
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
// AI request payload validation: strings only, bounded length, never objects.
function validAiText(value, max = 64000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('无效的 AI 请求内容');
  if (value.length > max) throw new Error('AI 请求内容超过长度限制');
  return value;
}
function validAiAction(value) {
  if (typeof value !== 'string' || !/^(rewrite|condense|expand|explain|logic)$/.test(value)) throw new Error('无效的 AI 操作类型');
  return value;
}
function validAiDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的文档数据');
  if (typeof value.text !== 'string' || typeof value.filename !== 'string') throw new Error('无效的文档数据');
  if (Buffer.byteLength(value.text, 'utf8') > 64000) throw new Error('文档内容超过 AI 处理限制');
  return { text: value.text, filename: value.filename.slice(0, 200) };
}
function validProviderConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的 AI 配置');
  const config = {};
  if (typeof value.name === 'string') config.name = value.name.slice(0, 100);
  if (typeof value.baseUrl === 'string') { config.baseUrl = value.baseUrl.slice(0, 2048); if (!/^https?:\/\//i.test(config.baseUrl)) throw new Error('AI 服务地址必须是 HTTP(S) URL'); }
  if (typeof value.model === 'string') config.model = value.model.slice(0, 100);
  if (typeof value.apiKey === 'string') config.apiKey = value.apiKey.slice(0, 500);
  if (typeof value.maxTokens === 'number') config.maxTokens = Math.min(Math.max(1, Math.floor(value.maxTokens)), 8192);
  return config;
}
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  perform(action, snapshot, params) { return ipcRenderer.invoke('desktop:perform', validAction(action), snapshot, validParams(params)); },
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
  },
  ai: Object.freeze({
    actions() { return ipcRenderer.invoke('ai:actions'); },
    selection(action, selectionText, document) { return ipcRenderer.invoke('ai:selection', validAiAction(action), validAiText(selectionText, 8000), validAiDocument(document)); },
    document(question, document) { return ipcRenderer.invoke('ai:document', validAiText(question, 4000), validAiDocument(document)); },
    review(instruction, document) { return ipcRenderer.invoke('ai:review', validAiText(instruction, 4000), validAiDocument(document)); },
    providerStatus() { return ipcRenderer.invoke('ai:provider:status'); },
    saveProvider(config) { return ipcRenderer.invoke('ai:provider:save', validProviderConfig(config)); },
    clearProvider() { return ipcRenderer.invoke('ai:provider:clear'); },
  })
}));
