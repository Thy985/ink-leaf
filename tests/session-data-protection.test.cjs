'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const Module = require('node:module');

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-json-protection-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function withMain(userData, run) {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => new Promise(() => {});
  app.getPath = (name) => name === 'userData' ? userData : os.tmpdir();
  app.quit = () => {};
  const electron = {
    app,
    BrowserWindow: class BrowserWindow {},
    Menu: {},
    dialog: {},
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
  try { return await run(main); }
  finally {
    delete require.cache[mainPath];
    if (previousUserData === undefined) delete process.env.INKSTONE_USER_DATA;
    else process.env.INKSTONE_USER_DATA = previousUserData;
  }
}

const snapshot = { text: '', filename: '未命名.md', dirty: false, savedText: '' };

test('a malformed session.json is reported and not replaced by an empty session', async (t) => {
  const userData = await temp(t);
  const sessionPath = path.join(userData, 'session.json');
  const original = '{"folders":';
  await fs.writeFile(sessionPath, original);

  await withMain(userData, async ({ perform }) => {
    await assert.rejects(perform('folderAdd', snapshot), /文件夹会话无法读取/);
  });

  assert.equal(await fs.readFile(sessionPath, 'utf8'), original);
  assert.deepEqual((await fs.readdir(userData)).sort(), ['session.json']);
});

test('a malformed recovery.json is reported and remains after a later clear attempt', async (t) => {
  const userData = await temp(t);
  const session = { version: 1, folders: [], activeFolder: null, lastDoc: null };
  await fs.writeFile(path.join(userData, 'session.json'), JSON.stringify(session));
  const recoveryPath = path.join(userData, 'recovery.json');
  const original = '{broken';
  await fs.writeFile(recoveryPath, original);

  await withMain(userData, async ({ perform }) => {
    await assert.rejects(perform('restore', snapshot), /恢复草稿无法读取/);
    await perform('new', snapshot);
  });

  assert.equal(await fs.readFile(recoveryPath, 'utf8'), original);
  assert.deepEqual((await fs.readdir(userData)).sort(), ['recovery.json', 'session.json']);
});

test('missing session and recovery files still mean a first-run empty state', async (t) => {
  const userData = await temp(t);
  await withMain(userData, async ({ perform }) => {
    const result = await perform('restore', snapshot);
    assert.deepEqual(result.session, { folders: [], activeFolder: null, lastDoc: null });
  });
});
