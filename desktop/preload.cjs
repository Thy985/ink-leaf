'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = new Set(['restore', 'open', 'new', 'save', 'saveAs', 'close', 'openPending', 'folderAdd', 'folderScan', 'folderOpen', 'folderRename', 'folderCreate', 'folderRemove', 'search']);
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
// 上限与桌面文档上限（MAX_TEXT，10 MB）对齐；更大的文档由后端按 CONTEXT_LIMITS 截断，而不是直接拒绝。
const AI_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

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
  if (Buffer.byteLength(value.text, 'utf8') > AI_DOCUMENT_MAX_BYTES) throw new Error('文档内容超过 AI 处理限制');
  return { text: value.text, filename: value.filename.slice(0, 200) };
}
function validSearchQuery(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入搜索关键词');
  if (value.length > 200) throw new Error('搜索关键词过长');
  return value;
}
function validSearchOptions(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的搜索选项');
  const options = {};
  if (typeof value.caseSensitive === 'boolean') options.caseSensitive = value.caseSensitive;
  if (typeof value.regex === 'boolean') options.regex = value.regex;
  return options;
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
// 更新安装包信息只接受 https 地址（回环 http 仅用于本地测试源）；落地路径由主进程决定，渲染层不能指定。
function validUpdateAsset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的安装包信息');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) throw new Error('无效的安装包名称');
  // 与主进程保持一致：https 任意地址；http 仅限回环（本地测试 / 自建源）。
  if (typeof value.url !== 'string' || value.url.length > 2048 || (!/^https:\/\//i.test(value.url) && !/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d{1,5})?(?:\/|$)/i.test(value.url))) throw new Error('无效的安装包地址');
  if (value.size !== undefined && typeof value.size !== 'number') throw new Error('无效的安装包大小');
  if (value.digest !== undefined && (typeof value.digest !== 'string' || value.digest.length > 200)) throw new Error('无效的安装包校验值');
  return { name: value.name, url: value.url, size: value.size, digest: value.digest };
}
function validUpdateFilePath(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\0]/.test(value)) throw new Error('无效的文件路径');
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)) throw new Error('无效的文件路径');
  return value;
}
contextBridge.exposeInMainWorld('desktop', Object.freeze({
  perform(action, snapshot, params) { return ipcRenderer.invoke('desktop:perform', validAction(action), snapshot, validParams(params)); },
  search(query, options) { return ipcRenderer.invoke('desktop:search', validSearchQuery(query), validSearchOptions(options)); },
  readImage(relativePath) { return ipcRenderer.invoke('desktop:image', validImagePath(relativePath)); },
  exportHtml(html) { return ipcRenderer.invoke('desktop:exportHtml', validExportHtml(html)); },
  writeImage(mime, bytes) { return ipcRenderer.invoke('desktop:writeImage', validImageMime(mime), validImageBytes(bytes)); },
  exportPdf(html) { return ipcRenderer.invoke('desktop:exportPdf', validExportHtml(html)); },
  syncState(state) { ipcRenderer.send('desktop:state', state); },
  onCommand(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback 必须是函数');
    const listener = (_event, message) => {
      const action = typeof message === 'string' ? message : message?.action;
      const payload = typeof message === 'string' ? undefined : message?.payload;
      callback(action, payload);
    };
    ipcRenderer.on('desktop:command', listener);
    return () => ipcRenderer.removeListener('desktop:command', listener);
  },
  ai: Object.freeze({
    actions() { return ipcRenderer.invoke('ai:actions'); },
    selection(action, selectionText, document) { return ipcRenderer.invoke('ai:selection', validAiAction(action), validAiText(selectionText, 8000), validAiDocument(document)); },
    document(question, document) { return ipcRenderer.invoke('ai:document', validAiText(question, 4000), validAiDocument(document)); },
    review(instruction, document) { return ipcRenderer.invoke('ai:review', validAiText(instruction, 4000), validAiDocument(document)); },
    analyze(document) { return ipcRenderer.invoke('ai:analyze', validAiDocument(document)); },
    summarize(document) { return ipcRenderer.invoke('ai:summarize', validAiDocument(document)); },
    providerStatus() { return ipcRenderer.invoke('ai:provider:status'); },
    saveProvider(config) { return ipcRenderer.invoke('ai:provider:save', validProviderConfig(config)); },
    clearProvider() { return ipcRenderer.invoke('ai:provider:clear'); },
  }),
  update: Object.freeze({
    check() { return ipcRenderer.invoke('update:check'); },
    download(asset) { return ipcRenderer.invoke('update:download', validUpdateAsset(asset)); },
    install(filePath) { return ipcRenderer.invoke('update:install', validUpdateFilePath(filePath)); },
    reveal(filePath) { return ipcRenderer.invoke('update:reveal', validUpdateFilePath(filePath)); },
    onProgress(callback) {
      if (typeof callback !== 'function') throw new TypeError('callback 必须是函数');
      const listener = (_event, progress) => {
        if (!progress || typeof progress !== 'object') return;
        callback({ received: typeof progress.received === 'number' ? progress.received : 0, total: typeof progress.total === 'number' ? progress.total : 0 });
      };
      ipcRenderer.on('update:progress', listener);
      return () => ipcRenderer.removeListener('update:progress', listener);
    },
  })
}));
