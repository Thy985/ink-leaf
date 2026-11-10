'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const Module = require('node:module');

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-recent-docs-'));
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
    Menu: { buildFromTemplate: (template) => template, setApplicationMenu: () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
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

test('recentDocs are recorded when opening documents', async (t) => {
  const userData = await temp(t);
  const folder = await temp(t);
  const docA = path.join(folder, 'a.md');
  const docB = path.join(folder, 'b.md');
  await fs.writeFile(docA, '# A');
  await fs.writeFile(docB, '# B');

  await withMain(userData, async ({ perform }) => {
    await perform('folderAdd', snapshot, { path: folder });
    const resultA = await perform('open', snapshot, { path: docA });
    assert.ok(resultA.session.recentDocs.length === 1);
    assert.equal(resultA.session.recentDocs[0].path, docA);

    const resultB = await perform('open', snapshot, { path: docB });
    assert.equal(resultB.session.recentDocs.length, 2);
    assert.equal(resultB.session.recentDocs[0].path, docB);
    assert.equal(resultB.session.recentDocs[1].path, docA);

    // Reopening A moves it to the front
    const resultA2 = await perform('open', snapshot, { path: docA });
    assert.equal(resultA2.session.recentDocs.length, 2);
    assert.equal(resultA2.session.recentDocs[0].path, docA);
    assert.equal(resultA2.session.recentDocs[1].path, docB);
  });
});

test('recentDocs are capped at 10 entries', async (t) => {
  const userData = await temp(t);
  const folder = await temp(t);
  const docs = [];
  for (let i = 0; i < 12; i++) {
    const doc = path.join(folder, `doc${i}.md`);
    await fs.writeFile(doc, `# Doc ${i}`);
    docs.push(doc);
  }

  await withMain(userData, async ({ perform }) => {
    await perform('folderAdd', snapshot, { path: folder });
    for (const doc of docs) {
      await perform('open', snapshot, { path: doc });
    }
    const result = await perform('open', snapshot, { path: docs[0] });
    assert.equal(result.session.recentDocs.length, 10);
    assert.equal(result.session.recentDocs[0].path, docs[0]);
  });
});

test('recentDocs persist in session.json', async (t) => {
  const userData = await temp(t);
  const folder = await temp(t);
  const doc = path.join(folder, 'test.md');
  await fs.writeFile(doc, '# Test');

  await withMain(userData, async ({ perform }) => {
    await perform('folderAdd', snapshot, { path: folder });
    await perform('open', snapshot, { path: doc });
  });

  const sessionPath = path.join(userData, 'session.json');
  const session = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
  assert.ok(Array.isArray(session.recentDocs));
  assert.equal(session.recentDocs.length, 1);
  assert.equal(session.recentDocs[0].path, doc);
  assert.ok(session.recentDocs[0].openedAt);
});

test('recentDocs are deduplicated and moved to front', async (t) => {
  const userData = await temp(t);
  const folder = await temp(t);
  const docA = path.join(folder, 'a.md');
  const docB = path.join(folder, 'b.md');
  const docC = path.join(folder, 'c.md');
  await fs.writeFile(docA, '# A');
  await fs.writeFile(docB, '# B');
  await fs.writeFile(docC, '# C');

  await withMain(userData, async ({ perform }) => {
    await perform('folderAdd', snapshot, { path: folder });
    await perform('open', snapshot, { path: docA });
    await perform('open', snapshot, { path: docB });
    await perform('open', snapshot, { path: docC });
    const result = await perform('open', snapshot, { path: docA });
    assert.equal(result.session.recentDocs.length, 3);
    assert.equal(result.session.recentDocs[0].path, docA);
    assert.equal(result.session.recentDocs[1].path, docC);
    assert.equal(result.session.recentDocs[2].path, docB);
  });
});

test('recentDocs ignore non-absolute paths in session file', async (t) => {
  const userData = await temp(t);
  const session = {
    version: 1,
    folders: [],
    activeFolder: null,
    lastDoc: null,
    recentDocs: [
      { path: '/absolute/path.md', openedAt: '2024-01-01T00:00:00.000Z' },
      { path: 'relative/path.md', openedAt: '2024-01-01T00:00:00.000Z' },
      { path: '/another/absolute.md', openedAt: '2024-01-02T00:00:00.000Z' },
    ],
  };
  await fs.writeFile(path.join(userData, 'session.json'), JSON.stringify(session));

  await withMain(userData, async ({ perform }) => {
    const result = await perform('restore', snapshot);
    assert.equal(result.session.recentDocs.length, 2);
    assert.equal(result.session.recentDocs[0].path, '/another/absolute.md');
    assert.equal(result.session.recentDocs[1].path, '/absolute/path.md');
  });
});

test('recentDocs with invalid openedAt are normalized', async (t) => {
  const userData = await temp(t);
  const session = {
    version: 1,
    folders: [],
    activeFolder: null,
    lastDoc: null,
    recentDocs: [
      { path: '/test.md', openedAt: 'invalid-date' },
    ],
  };
  await fs.writeFile(path.join(userData, 'session.json'), JSON.stringify(session));

  await withMain(userData, async ({ perform }) => {
    const result = await perform('restore', snapshot);
    assert.equal(result.session.recentDocs.length, 1);
    assert.equal(result.session.recentDocs[0].path, '/test.md');
    assert.ok(result.session.recentDocs[0].openedAt);
  });
});
