'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const files = require('./files.cjs');

const MAX_TEXT = files.MAX_BYTES;
const ENTRY = path.resolve(__dirname, '../web/index.html');
const allowedUrl = pathToFileURL(ENTRY).href;
let win;
let pendingPath = null;
let pendingAfterRestore = false;
let draftTimer;
let draftVersion = 0;
let recoveryQueue = Promise.resolve();
let closing = false;
let state = { text: '', filename: '未命名.md', dirty: false, savedText: '', composing: false, filepath: null };
let opened = null; // { filepath, fingerprint, eol, bom }
const gotSingleInstanceLock = app.requestSingleInstanceLock();

function commandLinePath(commandLine) {
  return commandLine.find((x) => path.isAbsolute(x) && files.ALLOWED_EXTENSIONS.has(path.extname(x).toLowerCase())) || null;
}
if (gotSingleInstanceLock) pendingPath = commandLinePath(process.argv.slice(1));

function userDataDir() { return process.env.INKSTONE_USER_DATA || app.getPath('userData'); }
function recoveryPath() { return path.join(userDataDir(), 'recovery.json'); }
function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.text !== 'string' || typeof snapshot.filename !== 'string' || typeof snapshot.dirty !== 'boolean' || typeof snapshot.savedText !== 'string') throw new Error('桌面请求数据格式无效');
  if (Buffer.byteLength(snapshot.text, 'utf8') > MAX_TEXT || Buffer.byteLength(snapshot.savedText, 'utf8') > MAX_TEXT) throw new Error('文档超过 10 MB 限制');
  return { text: files.normalize(snapshot.text), filename: snapshot.filename.slice(0, 120), dirty: snapshot.dirty, savedText: files.normalize(snapshot.savedText), composing: !!snapshot.composing };
}
function isTrusted(event) {
  try { return event.senderFrame && event.senderFrame.url === allowedUrl; } catch { return false; }
}
async function ensureDataDir() { await fsp.mkdir(userDataDir(), { recursive: true }); }
function enqueueRecovery(task) { const run = recoveryQueue.then(task, task); recoveryQueue = run.catch(() => {}); return run; }
function scheduleRecovery() { clearTimeout(draftTimer); const token = ++draftVersion; draftTimer = setTimeout(() => { draftTimer = null; if (token === draftVersion) saveRecovery(token).catch(() => {}); }, 350); }
async function saveRecovery(token = draftVersion) {
  if (token !== draftVersion || !state.dirty || state.composing || closing) return;
  const body = JSON.stringify({ version: 2, text: state.text, filename: state.filename, filepath: opened?.filepath || null, fingerprint: opened?.fingerprint || null, eol: opened?.eol || 'lf', bom: !!opened?.bom, savedText: state.savedText || '', updatedAt: new Date().toISOString() });
  return enqueueRecovery(async () => { if (token !== draftVersion || !state.dirty || state.composing || closing) return; await ensureDataDir(); const tmp = `${recoveryPath()}.${process.pid}.${Date.now()}.tmp`; try { await fsp.writeFile(tmp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await fsp.rename(tmp, recoveryPath()); } catch (error) { try { await fsp.unlink(tmp); } catch {} throw error; } });
}
async function clearRecovery() { clearTimeout(draftTimer); draftTimer = null; ++draftVersion; return enqueueRecovery(async () => { try { await fsp.unlink(recoveryPath()); } catch (e) { if (e.code !== 'ENOENT') throw e; } }); }
async function readRecovery() {
  try {
    const raw = await fsp.readFile(recoveryPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data.text !== 'string' || Buffer.byteLength(data.text, 'utf8') > MAX_TEXT) return null;
    let filepath = null;
    if (data.filepath != null) { files.assertSupportedPath(data.filepath); filepath = data.filepath; }
    return { text: files.normalize(data.text), filename: typeof data.filename === 'string' ? data.filename : '未命名.md', filepath, fingerprint: data.fingerprint || null, eol: data.eol === 'crlf' ? 'crlf' : 'lf', bom: !!data.bom, savedText: typeof data.savedText === 'string' ? files.normalize(data.savedText) : '', dirty: true };
  } catch { return null; }
}
function resultFor(text, filename, filepath, savedText, dirty) { return { text, filename, filepath: filepath || null, savedText: savedText ?? text, ...(dirty === undefined ? {} : { dirty }) }; }
async function chooseDirty(snapshot, operation) {
  if (!snapshot.dirty) return 'discard';
  const answer = await dialog.showMessageBox(win, { type: 'warning', buttons: ['保存', '不保存', '取消'], defaultId: 0, cancelId: 2, noLink: true, title: '未保存的修改', message: operation === 'close' ? '文档有未保存的修改。' : '切换文档前要如何处理未保存的修改？' });
  if (answer.response === 0) { const saved = await perform('save', snapshot); return saved.canceled ? 'cancel' : 'save'; }
  if (answer.response === 1) return 'discard';
  return 'cancel';
}
async function chooseConflict() {
  const answer = await dialog.showMessageBox(win, { type: 'warning', buttons: ['覆盖', '另存为', '取消'], defaultId: 2, cancelId: 2, noLink: true, title: '文件已被修改', message: '磁盘上的文件在打开后发生了变化。' });
  return ['overwrite', 'saveAs', 'cancel'][answer.response] || 'cancel';
}
async function openPath(filePath) {
  const doc = await files.readDocument(filePath);
  opened = { filepath: filePath, fingerprint: doc.fingerprint, eol: doc.eol, bom: doc.bom };
  return resultFor(doc.text, doc.filename, filePath, doc.text, false);
}
function adopt(r) { if (r && !r.canceled) state = { ...state, text: r.text, filename: r.filename, savedText: r.savedText ?? r.text, dirty: !!r.dirty, filepath: r.filepath || null }; return r; }
async function savePath(snapshot, filePath, saveAs = false) {
  if (!saveAs && opened?.filepath === filePath && opened.fingerprint) {
    const current = await files.currentFingerprint(filePath);
    if (!files.sameFingerprint(current, opened.fingerprint)) {
      const choice = await chooseConflict();
      if (choice === 'cancel') return { canceled: true };
      if (choice === 'saveAs') return saveAsPath(snapshot);
    }
  }
  const written = await files.writeDocumentAtomic(filePath, snapshot.text, { eol: opened?.eol || 'lf', bom: opened?.bom || false });
  opened = { filepath: filePath, fingerprint: written.fingerprint, eol: opened?.eol || 'lf', bom: opened?.bom || false };
  await clearRecovery();
  state = { ...state, ...snapshot, savedText: snapshot.text, dirty: false, filepath: filePath };
  return resultFor(snapshot.text, path.basename(filePath), filePath, snapshot.text, false);
}
async function saveAsPath(snapshot) {
  const defaultPath = path.join(app.getPath('documents'), snapshot.filename.toLowerCase().endsWith('.md') || snapshot.filename.includes('.') ? snapshot.filename : `${snapshot.filename}.md`);
  const picked = await dialog.showSaveDialog(win, { title: '另存为', defaultPath, filters: [{ name: 'Markdown/文本', extensions: ['md', 'markdown', 'txt'] }] });
  if (picked.canceled || !picked.filePath) return { canceled: true };
  files.assertSupportedPath(picked.filePath);
  return savePath(snapshot, picked.filePath, true);
}
async function perform(action, rawSnapshot = state) {
  const snapshot = assertSnapshot(rawSnapshot);
  state = { ...state, ...snapshot };
  const actions = new Set(['restore','openPending','open','new','save','saveAs','close']);
  if (!actions.has(action)) throw new Error('未知桌面操作');
  if (snapshot.composing && action !== 'restore') throw new Error('正在输入，暂不能执行文件操作');
  if (action === 'restore') {
    const recovery = await readRecovery();
    if (recovery) { pendingAfterRestore = !!pendingPath; opened = recovery.filepath ? { filepath: recovery.filepath, fingerprint: recovery.fingerprint, eol: recovery.eol, bom: recovery.bom } : null; return adopt(resultFor(recovery.text, recovery.filename, recovery.filepath, recovery.savedText, true)); }
    if (pendingPath) { const candidate = pendingPath; pendingPath = null; return adopt(await openPath(candidate)); }
    return null;
  }
  if (action === 'openPending') { if (!pendingPath) return { canceled: true }; const p = pendingPath; const candidate = await files.readDocument(p); const decision = await chooseDirty(snapshot, 'open'); if (decision === 'cancel') { pendingPath = p; return { canceled: true }; } pendingPath = null; await clearRecovery(); opened = { filepath: p, fingerprint: candidate.fingerprint, eol: candidate.eol, bom: candidate.bom }; return adopt(resultFor(candidate.text, candidate.filename, p, candidate.text, false)); }
  if (action === 'open') {
    const picked = await dialog.showOpenDialog(win, { title: '打开 Markdown', properties: ['openFile'], filters: [{ name: 'Markdown/文本', extensions: ['md', 'markdown', 'txt'] }] });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const candidate = await files.readDocument(picked.filePaths[0]); // 先读，失败不会丢弃草稿
    const decision = await chooseDirty(snapshot, 'open');
    if (decision === 'cancel') return { canceled: true };
    opened = { filepath: candidate.filepath, fingerprint: candidate.fingerprint, eol: candidate.eol, bom: candidate.bom };
    await clearRecovery(); return adopt(resultFor(candidate.text, candidate.filename, candidate.filepath, candidate.text, false));
  }
  if (action === 'new') {
    const decision = await chooseDirty(snapshot, 'new'); if (decision === 'cancel') return { canceled: true };
    opened = null; await clearRecovery(); return adopt(resultFor('', '未命名.md', null, '', false));
  }
  if (action === 'save') {
    if (!opened?.filepath) return saveAsPath(snapshot);
    return savePath(snapshot, opened.filepath);
  }
  if (action === 'saveAs') return saveAsPath(snapshot);
  if (action === 'close') {
    const decision = await chooseDirty(snapshot, 'close'); if (decision === 'cancel') return { canceled: true };
    if (decision === 'discard' || decision === 'save') await clearRecovery();
    clearTimeout(draftTimer); draftTimer = null; ++draftVersion; state = { ...state, dirty: false }; closing = true; if (win && !win.isDestroyed()) win.destroy();
    return { closed: true };
  }
  throw new Error('未知桌面操作');
}
function sendCommand(action) { if (win && !win.isDestroyed() && win.webContents) win.webContents.send('desktop:command', action); }
function menuTemplate() {
  const item = (label, action, accelerator) => ({ label, ...(accelerator ? { accelerator } : {}), click: () => action === 'fullscreen' ? win.setFullScreen(!win.isFullScreen()) : sendCommand(action) });
  return [
    { label: '文件', submenu: [item('新建', 'new', 'CommandOrControl+N'), item('打开', 'open', 'CommandOrControl+O'), item('保存', 'save', 'CommandOrControl+S'), item('另存为', 'saveAs', 'CommandOrControl+Shift+S'), { type: 'separator' }, item('导出 HTML', 'exportHtml'), item('导出 PDF', 'exportPdf'), { type: 'separator' }, item('关闭', 'close')] },
    { label: '编辑', submenu: [item('撤销', 'undo', 'CommandOrControl+Z'), item('重做', 'redo', 'CommandOrControl+Y'), item('重做（备用）', 'redo', 'CommandOrControl+Shift+Z'), { type: 'separator' }, {role:'cut',label:'剪切'}, {role:'copy',label:'复制'}, {role:'paste',label:'粘贴'}, {role:'selectAll',label:'全选'}, { type: 'separator' }, item('粗体', 'bold', 'CommandOrControl+B'), item('斜体', 'italic', 'CommandOrControl+I'), item('链接', 'link', 'CommandOrControl+K'), item('查找', 'find', 'CommandOrControl+F'), item('替换', 'replace', 'CommandOrControl+H')] },
    { label: '视图', submenu: [item('源文', 'source', 'CommandOrControl+/'), item('专注', 'focus', 'F8'), item('主题', 'theme'), item('大纲', 'outline'), item('全屏', 'fullscreen', 'F11')] },
    { label: '帮助', submenu: [item('使用说明', 'help')] }
  ];
}
function createWindow() {
  win = new BrowserWindow({ width: 1200, height: 820, minWidth: 760, minHeight: 520, show: false, backgroundColor: '#f6f5f1', title: '墨页', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.session.on('will-download', (_event, item) => item.cancel());
  win.on('close', (event) => { if (!closing) { event.preventDefault(); sendCommand('close'); } });
  win.loadFile(ENTRY);
}
app.on('second-instance', (_event, commandLine) => { const candidate = commandLinePath(commandLine); if (candidate) pendingPath = candidate; if (win) { if (win.isMinimized()) win.restore(); win.focus(); sendCommand('openPending'); } });
app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return app.quit();
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
  let ipcLock = Promise.resolve();
  ipcMain.handle('desktop:perform', (event, action, snapshot) => {
    if (!isTrusted(event)) throw new Error('不受信任的桌面请求');
    const result = ipcLock.then(() => perform(action, snapshot));
    ipcLock = result.catch(() => {});
    return result.catch(error => { throw new Error(error.message || '桌面操作失败'); });
  });
  // Local images never travel as file paths — only a validated data URL comes back, and
  // only when the path resolves inside the open document's own directory.
  ipcMain.handle('desktop:image', async (event, relativePath) => {
    if (!isTrusted(event)) return { ok: false, message: '不受信任的桌面请求' };
    try {
      const image = await files.readImage(opened?.filepath ? path.dirname(opened.filepath) : null, relativePath);
      return { ok: true, dataUrl: image.dataUrl };
    } catch (error) {
      return { ok: false, message: error.message || '图片读取失败' };
    }
  });
  ipcMain.handle('desktop:exportHtml', async (event, html) => {
    if (!isTrusted(event)) return { canceled: true };
    try {
      if (typeof html !== 'string' || !html || Buffer.byteLength(html, 'utf8') > files.MAX_BYTES) throw new Error('导出内容超过 10 MB 限制');
      const defaultPath = path.join(app.getPath('documents'), (state.filename || '未命名').replace(/\.(md|markdown|txt)$/i, '') + '.html');
      const picked = await dialog.showSaveDialog(win, { title: '导出 HTML', defaultPath, filters: [{ name: 'HTML 文档', extensions: ['html', 'htm'] }] });
      if (picked.canceled || !picked.filePath) return { canceled: true };
      const written = await files.writeHtmlFile(picked.filePath, html);
      return { exported: true, filename: written.filename, filepath: written.filepath };
    } catch (error) {
      return { error: error.message || '导出失败' };
    }
  });
  // Clipboard images land next to the open document; the directory is derived from the
  // main process's own state, never from renderer input.
  ipcMain.handle('desktop:writeImage', async (event, mime, bytes) => {
    if (!isTrusted(event)) return { ok: false, message: '不受信任的桌面请求' };
    try {
      if (!opened?.filepath) throw new Error('请先保存文档（Ctrl+S），再插入图片');
      const filename = await files.writeImageFile(path.dirname(opened.filepath), mime, Buffer.from(bytes));
      return { ok: true, filename };
    } catch (error) {
      return { ok: false, message: error.message || '图片写入失败' };
    }
  });
  // PDF export reuses the same offline HTML pipeline as "导出 HTML"; a hidden sandboxed
  // window prints it so formulas stay as MathML and images stay as embedded data URLs.
  ipcMain.handle('desktop:exportPdf', async (event, html) => {
    if (!isTrusted(event)) return { canceled: true };
    let printer = null;
    let tempHtml = null;
    try {
      if (typeof html !== 'string' || !html || Buffer.byteLength(html, 'utf8') > files.MAX_BYTES) throw new Error('导出内容超过 10 MB 限制');
      const defaultPath = path.join(app.getPath('documents'), (state.filename || '未命名').replace(/\.(md|markdown|txt)$/i, '') + '.pdf');
      const picked = await dialog.showSaveDialog(win, { title: '导出 PDF', defaultPath, filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] });
      if (picked.canceled || !picked.filePath) return { canceled: true };
      if (path.extname(picked.filePath).toLowerCase() !== '.pdf') throw new Error('仅支持导出为 .pdf 文件');
      // A temp file (not a data URL) keeps the pipeline free of navigation size limits.
      tempHtml = path.join(app.getPath('temp'), `inkstone-export-${process.pid}-${Date.now()}.html`);
      await fs.promises.writeFile(tempHtml, html, 'utf8');
      printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, images: true } });
      await printer.loadFile(tempHtml);
      const pdf = await printer.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
      const written = await files.writeBinaryFile(picked.filePath, pdf);
      return { exported: true, filename: written.filename, filepath: written.filepath };
    } catch (error) {
      return { error: error.message || '导出失败' };
    } finally {
      if (printer && !printer.isDestroyed()) printer.destroy();
      if (tempHtml) fs.unlink(tempHtml, () => {});
    }
  });
  ipcMain.on('desktop:state', (event, next) => { if (!isTrusted(event) || closing) return; try { const checked = assertSnapshot(next); state = { ...state, ...checked }; if (state.dirty) scheduleRecovery(); else clearRecovery().catch(() => {}); if (pendingAfterRestore) { pendingAfterRestore = false; setImmediate(() => sendCommand('openPending')); } } catch {} });
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (!closing) { clearTimeout(draftTimer); saveRecovery().catch(() => {}); } });
module.exports = { assertSnapshot, normalize: files.normalize, perform, menuTemplate };
