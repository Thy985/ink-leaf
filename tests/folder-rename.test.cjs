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

test('renaming the open folder document returns its new path and keeps subsequent saves there', async (t) => {
  const folder = await temp(t);
  const userData = await temp(t);
  const originalPath = path.join(folder, 'old.md');
  const realFolder = await fs.realpath(folder);
  const renamedPath = path.join(realFolder, 'new.md');
  const originalText = '# before\n';
  await fs.writeFile(originalPath, originalText);

  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => new Promise(() => {});
  app.getPath = (name) => name === 'userData' ? userData : os.tmpdir();
  app.quit = () => {};
  const electron = {
    app,
    BrowserWindow: class BrowserWindow {},
    Menu: {},
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [folder] }) },
    ipcMain: { handle() {}, on() {} },
    shell: {},
    session: {},
    net: {},
  };
  const originalLoad = Module._load;
  const previousUserData = process.env.INKSTONE_USER_DATA;
  process.env.INKSTONE_USER_DATA = userData;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { perform } = require('../desktop/main.cjs');
    const snapshot = { text: originalText, filename: 'old.md', dirty: false, savedText: originalText };
    await perform('folderAdd', snapshot);
    await perform('folderOpen', snapshot, { folder, path: 'old.md' });

    const result = await perform('folderRename', snapshot, { folder, path: 'old.md', name: 'new.md' });
    assert.equal(result.filepath, renamedPath);
    assert.equal(result.filename, 'new.md');
    await assert.rejects(fs.access(originalPath));
    assert.equal(await fs.readFile(renamedPath, 'utf8'), originalText);

    await perform('save', { ...snapshot, text: '# after\n', filename: 'new.md', dirty: true });
    assert.equal(await fs.readFile(renamedPath, 'utf8'), '# after\n');
  } finally {
    Module._load = originalLoad;
    if (previousUserData === undefined) delete process.env.INKSTONE_USER_DATA;
    else process.env.INKSTONE_USER_DATA = previousUserData;
  }
});
