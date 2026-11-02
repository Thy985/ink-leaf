'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const folders = require('../desktop/folders.cjs');

async function temp(t) { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-folders-')); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; }
const EXT = new Set(['.md', '.markdown', '.txt']);
const MAX = 10 * 1024 * 1024;

test('scanFolder 分类：正常文档、子目录、不支持的类型、超大、非法编码', async t => {
  const d = await temp(t);
  await fs.writeFile(path.join(d, '主文档.md'), '# 好\n');
  await fs.mkdir(path.join(d, '子目录'));
  await fs.writeFile(path.join(d, '子目录', 'nested.markdown'), '正文\n');
  await fs.writeFile(path.join(d, 'image.png'), 'x');
  await fs.writeFile(path.join(d, 'huge.md'), 'x');
  // Make the oversize file exceed MAX without allocating 10 MB: inflate the stat size.
  const small = await folders.scanFolder(d, { ...fs, stat: async (p) => { const s = await fs.stat(p); if (path.basename(p) === 'huge.md') s.size = MAX + 1; return s; } }, EXT, MAX);
  assert(small.tree.docs.some(x => x.name === '主文档.md'));
  assert.equal(small.tree.dirs.length, 1);
  assert.deepEqual(small.tree.dirs[0].docs.map(x => x.name), ['nested.markdown']);
  const reasons = Object.fromEntries(small.excluded.map(x => [path.basename(x.path), x.reason]));
  assert.match(reasons['image.png'], /不支持的文件类型/);
  assert.match(reasons['huge.md'], /10 MB/);
});

test('scanFolder 将非法 UTF-8 文档列入未纳名单而不是树', async t => {
  const d = await temp(t);
  await fs.writeFile(path.join(d, 'bad.md'), Buffer.from([0xc0, 0xff]));
  await fs.writeFile(path.join(d, 'good.md'), 'ok');
  const result = await folders.scanFolder(d, fs, EXT, MAX);
  assert.deepEqual(result.tree.docs.map(x => x.name), ['good.md']);
  assert.equal(result.excluded.length, 1);
  assert.match(result.excluded[0].reason, /UTF-8/);
});

test('scanFolder 跳过 .git 与 node_modules，深度超限截断', async t => {
  const d = await temp(t);
  await fs.mkdir(path.join(d, '.git'));
  await fs.writeFile(path.join(d, '.git', 'config.md'), 'x');
  await fs.mkdir(path.join(d, 'node_modules'));
  await fs.writeFile(path.join(d, 'node_modules', 'lib.md'), 'x');
  let deep = d;
  for (let i = 0; i < folders.MAX_SCAN_DEPTH + 2; i++) deep = path.join(deep, `层级${i}`);
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(deep, '深层.md'), 'x');
  const result = await folders.scanFolder(d, fs, EXT, MAX);
  const names = JSON.stringify(result.tree);
  assert(!names.includes('config.md') && !names.includes('lib.md'));
  assert(!names.includes('深层.md'));
  assert.equal(result.truncated, true);
  assert.equal(result.tree.docs.length, 0);
});

test('resolveInFolder 拒绝越界、绝对路径、反斜杠与空路径', () => {
  const root = path.resolve(os.tmpdir(), 'root-dir');
  assert.equal(folders.resolveInFolder(root, 'a/b.md'), path.resolve(root, 'a', 'b.md'));
  assert.equal(folders.resolveInFolder(root, '../outside.md'), null);
  assert.equal(folders.resolveInFolder(root, 'a/../../outside.md'), null);
  assert.equal(folders.resolveInFolder(root, path.join(os.tmpdir(), 'elsewhere.md')), null);
  assert.equal(folders.resolveInFolder(root, 'a\\b.md'), null);
  assert.equal(folders.resolveInFolder(root, ''), null);
  assert.equal(folders.resolveInFolder(root, '/abs.md'), null);
  assert.equal(folders.resolveInFolder(root, 'a/./b.md'), null);
});
