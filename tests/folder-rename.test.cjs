'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const Module = require('node:module');

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-folder-rename-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Loads desktop/main.cjs in isolation with a stubbed Electron, mirroring the
// folder-open-security harness so each test starts from fresh module state.
async function withMain(t, root, run) {
  const userData = await temp(t);
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => new Promise(() => {});
  app.getPath = (name) => name === 'userData' ? userData : os.tmpdir();
  app.quit = () => {};
  const electron = {
    app,
    BrowserWindow: class BrowserWindow {},
    Menu: { buildFromTemplate: (template) => template, setApplicationMenu: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) },
    ipcMain: { handle() {}, on() {} },
    shell: {},
    session: {},
    net: {},
  };
  const mainPath = require.resolve('../desktop/main.cjs');
  delete require.cache[mainPath];
  const originalLoad = Module._load;
  const previousUserData = process.env.INKSTONE_USER_DATA;
  process.env.INKSTONE_USER_DATA = userData;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  let main;
  try { main = require(mainPath); }
  finally { Module._load = originalLoad; }
  try {
    const clean = { text: '', filename: '未命名.md', dirty: false, savedText: '' };
    await main.perform('folderAdd', clean);
    return await run(main.perform, clean);
  } finally {
    delete require.cache[mainPath];
    if (previousUserData === undefined) delete process.env.INKSTONE_USER_DATA;
    else process.env.INKSTONE_USER_DATA = previousUserData;
  }
}

test('renaming the open folder document returns its new path and keeps subsequent saves there', async (t) => {
  const folder = await temp(t);
  const originalText = '# before\n';
  await fs.writeFile(path.join(folder, 'old.md'), originalText);
  const realFolder = await fs.realpath(folder);
  const renamedPath = path.join(realFolder, 'new.md');

  await withMain(t, folder, async (perform, clean) => {
    await perform('folderOpen', clean, { folder: realFolder, path: 'old.md' });
    const snapshot = { ...clean, text: originalText, filename: 'old.md', savedText: originalText };

    const result = await perform('folderRename', snapshot, { folder: realFolder, path: 'old.md', name: 'new.md' });
    assert.equal(result.filepath, renamedPath);
    assert.equal(result.filename, 'new.md');
    await assert.rejects(fs.access(path.join(folder, 'old.md')));
    assert.equal(await fs.readFile(renamedPath, 'utf8'), originalText);

    await perform('save', { ...snapshot, text: '# after\n', filename: 'new.md', dirty: true });
    assert.equal(await fs.readFile(renamedPath, 'utf8'), '# after\n');
  });
});

// Regression: on Windows os.tmpdir() is D:\Temp while realpath yields D:\temp,
// and CI runners may hand back an 8.3 short name (RUNNER~1) instead of the long
// one. folderAdd registers the realpath form and the renderer passes that form
// back, so every folder action must be exercised with the canonical path.
test('a document created inside the folder follows the rename and saves to the new path', async (t) => {
  const folder = await temp(t);
  const realFolder = await fs.realpath(folder);
  const createdPath = path.join(realFolder, '新建文档.md');
  const renamedPath = path.join(realFolder, '改名文档.md');

  await withMain(t, folder, async (perform, clean) => {
    const created = await perform('folderCreate', clean, { folder: realFolder, name: '新建文档.md' });
    assert.equal(created.text, '');
    assert.equal(created.filepath, createdPath);
    assert.equal(await fs.readFile(createdPath, 'utf8'), '');

    const snapshot = { ...clean, text: '', filename: '新建文档.md', savedText: '' };
    const result = await perform('folderRename', snapshot, { folder: realFolder, path: '新建文档.md', name: '改名文档.md' });
    assert.equal(result.filepath, renamedPath);
    await assert.rejects(fs.access(createdPath));

    await perform('save', { ...snapshot, text: '# 改名后内容', filename: '改名文档.md', dirty: true });
    assert.equal(await fs.readFile(renamedPath, 'utf8'), '# 改名后内容');
  });
});
