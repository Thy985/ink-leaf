'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const Module = require('node:module');

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-folder-open-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function withMain(userData, root, run) {
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
    await main.perform('folderAdd', { text: '', filename: '未命名.md', dirty: false, savedText: '' });
    return await run(main.perform);
  } finally {
    delete require.cache[mainPath];
    if (previousUserData === undefined) delete process.env.INKSTONE_USER_DATA;
    else process.env.INKSTONE_USER_DATA = previousUserData;
  }
}

const clean = { text: '', filename: '未命名.md', dirty: false, savedText: '' };

test('folderOpen still opens a regular document inside the imported folder', async (t) => {
  const userData = await temp(t);
  const root = await temp(t);
  await fs.writeFile(path.join(root, 'inside.md'), '# 内部文档\n');
  // folderAdd 注册的是 realpath 规范形式，渲染层回传的也是这个形式。
  const realRoot = await fs.realpath(root);

  await withMain(userData, root, async (perform) => {
    const result = await perform('folderOpen', clean, { folder: realRoot, path: 'inside.md' });
    assert.equal(result.text, '# 内部文档\n');
    assert.equal(path.basename(result.filepath), 'inside.md');
  });
});

test('folderOpen rejects a file symlink added after the folder was scanned', async (t) => {
  const userData = await temp(t);
  const root = await temp(t);
  const outside = await temp(t);
  const secret = path.join(outside, 'secret.md');
  await fs.writeFile(secret, '# 外部秘密\n');
  const realRoot = await fs.realpath(root);

  await withMain(userData, root, async (perform) => {
    const link = path.join(root, 'external.md');
    try { await fs.symlink(secret, link, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.skip('当前 Windows 环境不允许创建文件 symlink');
        return;
      }
      throw error;
    }
    await assert.rejects(perform('folderOpen', clean, { folder: realRoot, path: 'external.md' }), /软链接或 junction/);
  });
});

test('folderOpen rejects a directory symlink or junction added after the folder was scanned', async (t) => {
  const userData = await temp(t);
  const root = await temp(t);
  const outside = await temp(t);
  await fs.writeFile(path.join(outside, 'secret.md'), '# 外部秘密\n');
  const realRoot = await fs.realpath(root);

  await withMain(userData, root, async (perform) => {
    const link = path.join(root, 'escape');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(perform('folderOpen', clean, { folder: realRoot, path: 'escape/secret.md' }), /软链接或 junction/);
  });
});
