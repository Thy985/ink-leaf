'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const files = require('./files.cjs');
const folders = require('./folders.cjs');
const updates = require('./update.cjs');
const { validBareName, safeDocumentName } = require('./names.cjs');
const { sameDesktopState } = require('./state.cjs');
const { readJsonFile } = require('./json-store.cjs');
const ai = require('./ai.cjs');

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
let closeFallbackTimer = null;
let recoveryWritable = false;
let state = { text: '', filename: '未命名.md', dirty: false, savedText: '', composing: false, filepath: null };
let opened = null; // { filepath, fingerprint, eol, bom }
let sessionState = null; // { version, folders: [{ path, lastDoc, addedAt }], activeFolder, lastDoc }
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
  if (!recoveryWritable || token !== draftVersion || !state.dirty || state.composing || closing) return;
  const body = JSON.stringify({ version: 2, text: state.text, filename: state.filename, filepath: opened?.filepath || null, fingerprint: opened?.fingerprint || null, eol: opened?.eol || 'lf', bom: !!opened?.bom, savedText: state.savedText || '', updatedAt: new Date().toISOString() });
  return enqueueRecovery(async () => { if (!recoveryWritable || token !== draftVersion || !state.dirty || state.composing || closing) return; await ensureDataDir(); const tmp = `${recoveryPath()}.${process.pid}.${Date.now()}.tmp`; try { await fsp.writeFile(tmp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await fsp.rename(tmp, recoveryPath()); } catch (error) { try { await fsp.unlink(tmp); } catch {} throw error; } });
}
async function clearRecovery() { clearTimeout(draftTimer); draftTimer = null; ++draftVersion; return enqueueRecovery(async () => { if (!recoveryWritable) return; try { await fsp.unlink(recoveryPath()); } catch (e) { if (e.code !== 'ENOENT') throw e; } }); }
async function readRecovery() {
  recoveryWritable = false;
  try {
    const result = await readJsonFile(recoveryPath(), fsp);
    if (!result.exists) { recoveryWritable = true; return null; }
    const data = result.value;
    if (!data || typeof data.text !== 'string' || Buffer.byteLength(data.text, 'utf8') > MAX_TEXT) throw new Error('恢复稿格式无效');
    let filepath = null;
    if (data.filepath != null) { files.assertSupportedPath(data.filepath); filepath = data.filepath; }
    recoveryWritable = true;
    return { text: files.normalize(data.text), filename: typeof data.filename === 'string' ? data.filename : '未命名.md', filepath, fingerprint: data.fingerprint || null, eol: data.eol === 'crlf' ? 'crlf' : 'lf', bom: !!data.bom, savedText: typeof data.savedText === 'string' ? files.normalize(data.savedText) : '', dirty: true };
  } catch (error) { throw new Error(`恢复草稿无法读取，原文件已保留且不会覆盖：${error.message}`); }
}
function resultFor(text, filename, filepath, savedText, dirty) { return { text, filename, filepath: filepath || null, savedText: savedText ?? text, ...(dirty === undefined ? {} : { dirty }) }; }

// Session memory (打开状态记忆) remembers the last document and imported folders so the
// next launch restores the previous view. It never stores document text — that stays in
// recovery.json — and both files live in the same user-data directory.
function sessionPath() { return path.join(userDataDir(), 'session.json'); }
const MAX_RECENT_DOCS = 10;
function sanitizeSession(data) {
  const empty = { version: 1, folders: [], activeFolder: null, lastDoc: null, recentDocs: [] };
  if (!data || typeof data !== 'object') return empty;
  const seen = new Set();
  const folderList = [];
  for (const entry of Array.isArray(data.folders) ? data.folders : []) {
    const p = entry && typeof entry.path === 'string' ? entry.path : null;
    if (!p || !path.isAbsolute(p) || seen.has(p)) continue;
    seen.add(p);
    folderList.push({
      path: p,
      lastDoc: typeof entry.lastDoc === 'string' && files.ALLOWED_EXTENSIONS.has(path.extname(entry.lastDoc).toLowerCase()) ? entry.lastDoc : null,
      addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : new Date().toISOString(),
    });
  }
  const recentDocs = [];
  const recentSeen = new Set();
  for (const entry of Array.isArray(data.recentDocs) ? data.recentDocs : []) {
    const p = entry && typeof entry.path === 'string' ? entry.path : null;
    if (!p || !path.isAbsolute(p) || recentSeen.has(p)) continue;
    recentSeen.add(p);
    recentDocs.push({
      path: p,
      openedAt: typeof entry.openedAt === 'string' ? entry.openedAt : new Date().toISOString(),
    });
    if (recentDocs.length >= MAX_RECENT_DOCS) break;
  }
  // Sort by openedAt descending (newest first)
  recentDocs.sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());
  return {
    version: 1,
    folders: folderList,
    activeFolder: typeof data.activeFolder === 'string' && seen.has(data.activeFolder) ? data.activeFolder : folderList[0]?.path || null,
    lastDoc: typeof data.lastDoc === 'string' && files.ALLOWED_EXTENSIONS.has(path.extname(data.lastDoc).toLowerCase()) ? data.lastDoc : null,
    recentDocs,
  };
}
async function readSession() {
  try {
    const result = await readJsonFile(sessionPath(), fsp);
    if (!result.exists) return sanitizeSession(null);
    const data = result.value;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.folders) || data.folders.some((entry) => !entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path))) throw new Error('会话文件格式无效');
    return sanitizeSession(data);
  } catch (error) { throw new Error(`文件夹会话无法读取，原文件已保留且不会覆盖：${error.message}`); }
}
// Writes are serialized through the recovery queue; every caller awaits the result, so
// read-modify-write cycles never interleave.
function updateSession(patch) {
  return enqueueRecovery(async () => {
    const next = sanitizeSession({ ...(await readSession()), ...patch });
    await ensureDataDir();
    const tmp = `${sessionPath()}.${process.pid}.${Date.now()}.tmp`;
    try { await fsp.writeFile(tmp, JSON.stringify(next), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await fsp.rename(tmp, sessionPath()); }
    catch (error) { try { await fsp.unlink(tmp); } catch {} throw error; }
    return next;
  });
}
function withinFolder(folderPath, filePath) {
  const rel = path.relative(folderPath, filePath);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function publicFolders() { return sessionState.folders.map(({ path: p, lastDoc }) => ({ path: p, lastDoc })); }
function publicRecentDocs() { return sessionState.recentDocs.map(({ path: p, openedAt }) => ({ path: p, openedAt })); }
async function recordSessionDoc(filePath) {
  if (!sessionState) sessionState = await readSession();
  const patch = { lastDoc: filePath };
  const folder = sessionState.folders.find((f) => withinFolder(f.path, filePath));
  if (folder) { patch.activeFolder = folder.path; if (folder.lastDoc !== filePath) patch.folders = sessionState.folders.map((f) => f.path === folder.path ? { ...f, lastDoc: filePath } : f); }
  // Update recent docs: move to front, dedupe, cap at 10
  const now = new Date().toISOString();
  const recentDocs = [{ path: filePath, openedAt: now }, ...sessionState.recentDocs.filter((d) => d.path !== filePath)].slice(0, MAX_RECENT_DOCS);
  patch.recentDocs = recentDocs;
  if (patch.lastDoc === sessionState.lastDoc && patch.activeFolder === sessionState.activeFolder && !patch.folders && JSON.stringify(recentDocs) === JSON.stringify(sessionState.recentDocs)) return;
  sessionState = await updateSession(patch);
}
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
  await recordSessionDoc(filePath).catch(() => {});
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
  return { ...resultFor(doc.text, doc.filename, filePath, doc.text, false), session: { folders: publicFolders(), activeFolder: sessionState.activeFolder, lastDoc: sessionState.lastDoc, recentDocs: publicRecentDocs() } };
}
// Shared by Ctrl+O and folder-panel opens: read first so a bad file never discards the
// draft, then ask about unsaved changes, then commit.
async function openCandidate(filePath, snapshot, readOptions = {}) {
  const candidate = await files.readDocument(filePath, fsp, readOptions);
  const decision = await chooseDirty(snapshot, 'open');
  if (decision === 'cancel') return { canceled: true };
  opened = { filepath: candidate.filepath, fingerprint: candidate.fingerprint, eol: candidate.eol, bom: candidate.bom };
  await clearRecovery();
  await recordSessionDoc(candidate.filepath).catch(() => {});
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
  return adopt({ ...resultFor(candidate.text, candidate.filename, candidate.filepath, candidate.text, false), session: { folders: publicFolders(), activeFolder: sessionState.activeFolder, lastDoc: sessionState.lastDoc, recentDocs: publicRecentDocs() } });
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
  await recordSessionDoc(filePath).catch(() => {});
  state = { ...state, ...snapshot, savedText: snapshot.text, dirty: false, filepath: filePath };
  return resultFor(snapshot.text, path.basename(filePath), filePath, snapshot.text, false);
}
async function saveAsPath(snapshot) {
  const defaultPath = path.join(app.getPath('documents'), safeDocumentName(snapshot.filename));
  const picked = await dialog.showSaveDialog(win, { title: '另存为', defaultPath, filters: [{ name: 'Markdown/文本', extensions: ['md', 'markdown', 'txt'] }] });
  if (picked.canceled || !picked.filePath) return { canceled: true };
  files.assertSupportedPath(picked.filePath);
  return savePath(snapshot, picked.filePath, true);
}
async function perform(action, rawSnapshot = state, params = null) {
  const snapshot = assertSnapshot(rawSnapshot);
  state = { ...state, ...snapshot };
  const actions = new Set(['restore','openPending','open','new','save','saveAs','close','folderAdd','folderScan','folderOpen','folderRename','folderCreate','folderRemove']);
  if (!actions.has(action)) throw new Error('未知桌面操作');
  if (snapshot.composing && action !== 'restore') throw new Error('正在输入，暂不能执行文件操作');
  if (action === 'restore') {
    if (!sessionState) sessionState = await readSession();
    const sessionInfo = () => ({ folders: publicFolders(), activeFolder: sessionState.activeFolder, lastDoc: sessionState.lastDoc, recentDocs: publicRecentDocs() });
    const recovery = await readRecovery();
    if (recovery) { pendingAfterRestore = !!pendingPath; opened = recovery.filepath ? { filepath: recovery.filepath, fingerprint: recovery.fingerprint, eol: recovery.eol, bom: recovery.bom } : null; return adopt({ ...resultFor(recovery.text, recovery.filename, recovery.filepath, recovery.savedText, true), session: sessionInfo() }); }
    if (pendingPath) { const candidate = pendingPath; pendingPath = null; return adopt({ ...(await openPath(candidate)), session: sessionInfo() }); }
    if (sessionState.lastDoc) {
      try { return { ...(await openPath(sessionState.lastDoc)), session: sessionInfo() }; }
      catch { sessionState = await updateSession({ lastDoc: null }).catch(() => sessionState); }
    }
    return { session: sessionInfo() };
  }
  if (action === 'openPending') { if (!pendingPath) return { canceled: true }; const p = pendingPath; const candidate = await files.readDocument(p); const decision = await chooseDirty(snapshot, 'open'); if (decision === 'cancel') { pendingPath = p; return { canceled: true }; } pendingPath = null; await clearRecovery(); opened = { filepath: p, fingerprint: candidate.fingerprint, eol: candidate.eol, bom: candidate.bom }; await recordSessionDoc(p).catch(() => {}); return adopt(resultFor(candidate.text, candidate.filename, p, candidate.text, false)); }
  if (action === 'open') {
    const directPath = params?.path;
    if (directPath) {
      files.assertSupportedPath(directPath);
      return openCandidate(directPath, snapshot);
    }
    const picked = await dialog.showOpenDialog(win, { title: '打开 Markdown', properties: ['openFile'], filters: [{ name: 'Markdown/文本', extensions: ['md', 'markdown', 'txt'] }] });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    return openCandidate(picked.filePaths[0], snapshot);
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
    clearTimeout(draftTimer); draftTimer = null; ++draftVersion; state = { ...state, dirty: false }; closing = true;
    if (closeFallbackTimer) { clearTimeout(closeFallbackTimer); closeFallbackTimer = null; }
    if (win && !win.isDestroyed()) win.destroy();
    return { closed: true };
  }
  if (action === 'folderAdd') {
    if (!sessionState) sessionState = await readSession();
    const directPath = params?.path;
    let folderPath;
    if (directPath) {
      folderPath = directPath;
    } else {
      const picked = await dialog.showOpenDialog(win, { title: '导入文件夹', properties: ['openDirectory'] });
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
      folderPath = picked.filePaths[0];
    }
    const scan = await scanRegistered(folderPath);
    if (!sessionState.folders.some((f) => f.path === folderPath)) sessionState = await updateSession({ folders: [...sessionState.folders, { path: folderPath, lastDoc: null, addedAt: new Date().toISOString() }], activeFolder: folderPath });
    else sessionState = await updateSession({ activeFolder: folderPath });
    return { folders: publicFolders(), activeFolder: sessionState.activeFolder, ...scan };
  }
  if (action === 'folderScan') return scanRegistered(requireFolder(params?.folder));
  if (action === 'folderOpen') {
    const folderPath = requireFolder(params?.folder);
    const safeTarget = await folders.resolveSafeInFolder(folderPath, params?.path, fsp);
    if (!safeTarget) throw new Error('文件必须位于已导入文件夹内');
    return openCandidate(safeTarget, snapshot, { noFollow: true });
  }
  if (action === 'folderRename') {
    if (!sessionState) sessionState = await readSession();
    const folderPath = requireFolder(params?.folder);
    const target = await folders.resolveSafeInFolder(folderPath, params?.path, fsp);
    if (!target) throw new Error('文件必须位于已导入文件夹内');
    const updated = path.join(path.dirname(target), validBareName(params?.name));
    if (updated === target) return scanRegistered(folderPath);
    let exists = null;
    try { exists = await fsp.stat(updated); } catch (error) { if (error.code !== 'ENOENT') throw new Error(`重命名失败：${error.message}`); }
    if (exists && (process.platform !== 'win32' || target.toLowerCase() !== updated.toLowerCase())) throw new Error('同名文件已存在');
    try { await fsp.rename(target, updated); } catch (error) { throw new Error(`重命名失败：${error.message}`); }
    const renamedOpenDocument = opened?.filepath === target;
    if (renamedOpenDocument) {
      opened = { ...opened, filepath: updated };
      state = { ...state, filepath: updated, filename: path.basename(updated) };
    }
    const patch = { folders: sessionState.folders.map((f) => f.lastDoc === target ? { ...f, lastDoc: updated } : f) };
    if (sessionState.lastDoc === target) patch.lastDoc = updated;
    sessionState = await updateSession(patch);
    const scan = await scanRegistered(folderPath);
    return { ...scan, ...(renamedOpenDocument ? { filepath: updated, filename: path.basename(updated) } : {}) };
  }
  if (action === 'folderCreate') {
    const folderPath = requireFolder(params?.folder);
    const target = path.join(folderPath, validBareName(params?.name));
    let exists = null;
    try { exists = await fsp.stat(target); } catch (error) { if (error.code !== 'ENOENT') throw new Error(`创建失败：${error.message}`); }
    if (exists) throw new Error('同名文件已存在');
    await files.writeDocumentAtomic(target, '', { eol: 'lf', bom: false });
    return openCandidate(target, snapshot);
  }
  if (action === 'folderRemove') {
    if (!sessionState) sessionState = await readSession();
    const folderPath = requireFolder(params?.folder);
    const remaining = sessionState.folders.filter((f) => f.path !== folderPath);
    sessionState = await updateSession({ folders: remaining, activeFolder: sessionState.activeFolder === folderPath ? remaining[0]?.path || null : sessionState.activeFolder });
    return { folders: publicFolders(), activeFolder: sessionState.activeFolder };
  }
  throw new Error('未知桌面操作');
}
// Folder-panel helpers. params come from the renderer, so every path is re-resolved
// against a registered folder root before it ever touches the filesystem.
function requireFolder(folderPath) {
  if (!sessionState || !sessionState.folders.some((f) => f.path === folderPath)) throw new Error('文件夹未导入或已被移除');
  return folderPath;
}
function folderRelTarget(folderPath, rel) {
  if (typeof rel !== 'string') throw new Error('无效的文件路径');
  const target = folders.resolveInFolder(folderPath, rel);
  if (!target) throw new Error('文件必须位于已导入文件夹内');
  return target;
}


async function scanRegistered(folderPath) {
  const scan = await folders.scanFolder(folderPath, fsp, files.ALLOWED_EXTENSIONS, files.MAX_BYTES);
  return { folder: folderPath, ...scan };
}
function sendCommand(action, payload) { if (win && !win.isDestroyed() && win.webContents) win.webContents.send('desktop:command', { action, payload }); }
function menuTemplate() {
  const item = (label, action, accelerator) => ({ label, ...(accelerator ? { accelerator } : {}), click: () => action === 'fullscreen' ? win.setFullScreen(!win.isFullScreen()) : sendCommand(action) });
  const recentSubmenu = (sessionState?.recentDocs || []).map((doc) => ({
    label: doc.path,
    click: () => sendCommand('openRecent', doc.path),
  }));
  const recentItem = { label: '打开最近', submenu: recentSubmenu.length > 0 ? recentSubmenu : [{ label: '（暂无最近文档）', enabled: false }] };
  return [
    { label: '文件', submenu: [item('新建', 'new', 'CommandOrControl+N'), item('打开', 'open', 'CommandOrControl+O'), recentItem, item('打开文件夹…', 'folderAdd'), item('保存', 'save', 'CommandOrControl+S'), item('另存为', 'saveAs', 'CommandOrControl+Shift+S'), { type: 'separator' }, item('搜索文件夹…', 'search', 'CommandOrControl+Shift+F'), { type: 'separator' }, item('导出 HTML', 'exportHtml'), item('导出 PDF', 'exportPdf'), { type: 'separator' }, item('关闭', 'close')] },
    { label: '编辑', submenu: [item('撤销', 'undo', 'CommandOrControl+Z'), item('重做', 'redo', 'CommandOrControl+Y'), item('重做（备用）', 'redo', 'CommandOrControl+Shift+Z'), { type: 'separator' }, {role:'cut',label:'剪切'}, {role:'copy',label:'复制'}, {role:'paste',label:'粘贴'}, {role:'selectAll',label:'全选'}, { type: 'separator' }, item('粗体', 'bold', 'CommandOrControl+B'), item('斜体', 'italic', 'CommandOrControl+I'), item('链接', 'link', 'CommandOrControl+K'), item('查找', 'find', 'CommandOrControl+F'), item('替换', 'replace', 'CommandOrControl+H')] },
    { label: '视图', submenu: [item('源文', 'source', 'CommandOrControl+/'), item('专注', 'focus', 'F8'), item('主题', 'theme'), item('大纲', 'outline'), item('全屏', 'fullscreen', 'F11')] },
    { label: 'AI', submenu: [item('AI 助手面板', 'aiPanel', 'CommandOrControl+Space'), { type: 'separator' }, item('改写选中', 'aiRewrite'), item('精简选中', 'aiCondense'), item('扩写选中', 'aiExpand'), item('解释选中', 'aiExplain'), item('检查逻辑', 'aiLogic'), { type: 'separator' }, item('AI 服务设置…', 'aiSettings')] },
    { label: '帮助', submenu: [item('使用说明', 'help'), { type: 'separator' }, { label: '检查更新', id: 'check-updates', click: () => { updates.checkUpdates({ net, app, dialog, shell, win }).catch(() => {}); } }] }
  ];
}
function createWindow() {
  win = new BrowserWindow({ width: 1200, height: 820, minWidth: 760, minHeight: 520, show: false, backgroundColor: '#f6f5f1', title: '墨页', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.once('ready-to-show', () => win.show());
  // Allow HTTP connections for local AI services
  win.webContents.session.setCertificateVerifyProc((request, callback) => {
    callback(0); // Continue
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  // Allow network requests for AI service (main process net.request is not affected by this)
  win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    // Allow clipboard-read for paste operations, deny others
    if (permission === 'clipboard-read') callback(true);
    else callback(false);
  });
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.session.on('will-download', (_event, item) => item.cancel());
  win.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    sendCommand('close');
    // Fallback: if the renderer never responds (crashed, hung, or busy too long),
    // force-close after a timeout so the user is never trapped.
    if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
    closeFallbackTimer = setTimeout(() => {
      if (!closing && win && !win.isDestroyed()) {
        closing = true;
        win.destroy();
      }
    }, 10000);
  });
  win.webContents.on('render-process-gone', () => {
    if (!closing) { closing = true; }
    if (win && !win.isDestroyed()) win.destroy();
  });
  win.loadFile(ENTRY);
}
app.on('second-instance', (_event, commandLine) => { const candidate = commandLinePath(commandLine); if (candidate) pendingPath = candidate; if (win) { if (win.isMinimized()) win.restore(); win.focus(); sendCommand('openPending'); } });
app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return app.quit();
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
  let ipcLock = Promise.resolve();
  ipcMain.handle('desktop:perform', (event, action, snapshot, params) => {
    if (!isTrusted(event)) throw new Error('不受信任的桌面请求');
    const result = ipcLock.then(() => perform(action, snapshot, params));
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
      const defaultPath = path.join(app.getPath('documents'), safeDocumentName(state.filename).replace(/\.(md|markdown|txt)$/i, '') + '.html');
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
      const defaultPath = path.join(app.getPath('documents'), safeDocumentName(state.filename).replace(/\.(md|markdown|txt)$/i, '') + '.pdf');
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
  ipcMain.on('desktop:state', (event, next) => { if (!isTrusted(event) || closing) return; try { if (sameDesktopState(next, state)) return; const checked = assertSnapshot(next); state = { ...state, ...checked }; if (state.dirty) scheduleRecovery(); else clearRecovery().catch(() => {}); if (pendingAfterRestore) { pendingAfterRestore = false; setImmediate(() => sendCommand('openPending')); } } catch {} });
  // AI 能力层：选区操作、文档问答、修改审阅、Provider 配置
  ipcMain.handle('ai:actions', async (event) => { if (!isTrusted(event)) throw new Error('不受信任的 AI 请求'); return ai.getAvailableActions(); });
  ipcMain.handle('ai:selection', async (event, action, selection, document) => {
    if (!isTrusted(event)) return { ok: false, message: '不受信任的 AI 请求' };
    try {
      if (typeof action !== 'string' || typeof selection !== 'string') throw new Error('无效的 AI 请求参数');
      const proposal = await ai.runSelectionAction(action, selection, document);
      return { ok: true, proposal };
    } catch (error) {
      return { ok: false, message: error.message || 'AI 操作失败' };
    }
  });
  ipcMain.handle('ai:document', async (event, question, document) => {
    if (!isTrusted(event)) return { ok: false, message: '不受信任的 AI 请求' };
    try {
      if (typeof question !== 'string') throw new Error('无效的问题');
      const answer = await ai.askDocument(question, document);
      return { ok: true, answer };
    } catch (error) {
      return { ok: false, message: error.message || 'AI 问答失败' };
    }
  });
  ipcMain.handle('ai:review', async (event, instruction, document) => {
    if (!isTrusted(event)) return { ok: false, message: '不受信任的 AI 请求' };
    try {
      if (typeof instruction !== 'string') throw new Error('无效的修改要求');
      const result = await ai.reviewDocument(instruction, document);
      return { ok: true, review: result };
    } catch (error) {
      return { ok: false, message: error.message || 'AI 审阅失败' };
    }
  });
  ipcMain.handle('ai:provider:status', async (event) => { if (!isTrusted(event)) return { ok: false }; return ai.getProviderStatus(); });
  ipcMain.handle('ai:provider:save', async (event, config) => {
    if (!isTrusted(event)) return { ok: false, message: '不受信任的 AI 请求' };
    try { return { ok: true, status: await ai.saveProviderConfig(config || {}) }; }
    catch (error) { return { ok: false, message: error.message || '配置保存失败' }; }
  });
  ipcMain.handle('ai:provider:clear', async (event) => { if (!isTrusted(event)) return { ok: false }; try { return { ok: true, status: await ai.clearProviderConfig() }; } catch (error) { return { ok: false, message: error.message || '配置清除失败' }; } });
  // 全文搜索：跨已导入文件夹的纯内存扫描
  ipcMain.handle('desktop:search', async (event, query, options) => {
    if (!isTrusted(event)) return { ok: false, message: '不受信任的搜索请求' };
    try {
      if (typeof query !== 'string' || !query.trim()) throw new Error('请输入搜索关键词');
      if (!sessionState) sessionState = await readSession();
      const results = [];
      for (const folder of sessionState.folders) {
        const search = await folders.searchFolder(folder.path, query, options || {});
        if (search.results.length > 0) results.push({ folder: folder.path, ...search });
      }
      return { ok: true, results, totalMatches: results.reduce((sum, r) => sum + r.totalMatches, 0) };
    } catch (error) {
      return { ok: false, message: error.message || '搜索失败' };
    }
  });
  // 文档分析：结构大纲与统计（纯本地，不调用远程模型）
  ipcMain.handle('ai:analyze', async (event, document) => {
    if (!isTrusted(event)) return { ok: false, message: '不受信任的 AI 请求' };
    try {
      if (!document || typeof document.text !== 'string') throw new Error('无效的文档数据');
      return { ok: true, analysis: ai.analyzeDocument(document) };
    } catch (error) {
      return { ok: false, message: error.message || '文档分析失败' };
    }
  });
  // 文档摘要：调用远程模型生成
  ipcMain.handle('ai:summarize', async (event, document) => {
    if (!isTrusted(event)) return { ok: false, message: '不受信任的 AI 请求' };
    try {
      if (!document || typeof document.text !== 'string') throw new Error('无效的文档数据');
      const summary = await ai.summarizeDocument(document);
      return { ok: true, summary };
    } catch (error) {
      return { ok: false, message: error.message || '文档摘要失败' };
    }
  });
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (!closing) { clearTimeout(draftTimer); saveRecovery().catch(() => {}); } });
module.exports = { assertSnapshot, normalize: files.normalize, perform, menuTemplate };
