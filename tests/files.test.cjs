'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const f = require('../desktop/files.cjs');
async function temp(t) { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-files-')); t.after(() => fs.rm(d, {recursive:true,force:true})); return d; }
test('UTF-8 BOM and CRLF normalize losslessly', () => {
  assert.deepEqual(f.decode(Buffer.from('\ufeff# 墨页\r\n正文\r\n')), {text:'# 墨页\n正文\n',bom:true,eol:'crlf'});
});
test('invalid UTF-8 rejected without replacement characters', () => assert.throws(() => f.decode(Buffer.from([0xc0,0xff])), /UTF-8/));
test('oversized input rejected', () => assert.throws(() => f.decode(Buffer.alloc(f.MAX_BYTES+1)), /10 MB/));
test('only absolute Markdown and text paths accepted', () => {
  assert.throws(() => f.assertSupportedPath('test.md'));
  assert.throws(() => f.assertSupportedPath(path.join(os.tmpdir(), 'script.exe')));
  f.assertSupportedPath(path.join(os.tmpdir(), '文档.MD'));
});
test('atomic save preserves BOM, CRLF and Chinese text', async t => {
  const p=path.join(await temp(t),'测试.md');
  await f.writeDocumentAtomic(p,'# 标题\n正文\n',{bom:true,eol:'crlf'});
  assert.equal(await fs.readFile(p,'utf8'),'\ufeff# 标题\r\n正文\r\n');
  const d=await f.readDocument(p); assert.equal(d.text,'# 标题\n正文\n'); assert.equal(d.bom,true); assert.equal(d.eol,'crlf');
  assert.equal((await fs.readdir(path.dirname(p))).length,1);
});
test('external changes and deletion detected', async t => {
  const p=path.join(await temp(t),'doc.md'); await fs.writeFile(p,'old');
  const a=await f.currentFingerprint(p); assert(f.sameFingerprint(a,await f.currentFingerprint(p)));
  await fs.writeFile(p,'new'); assert(!f.sameFingerprint(a,await f.currentFingerprint(p)));
  await fs.unlink(p); assert.equal(await f.currentFingerprint(p),null);
});
test('failed rename preserves original and cleans temporary file for all failure types', async t => {
  for (const code of ['EEXIST', 'EPERM', 'ENOTEMPTY', undefined]) {
    const d = await temp(t);
    const p = path.join(d, 'doc.md');
    await fs.writeFile(p, 'original');
    let unlinkCalls = 0;
    const io = {
      ...fs,
      rename: async () => {
        const error = new Error(code ? `simulated ${code}` : 'simulated ordinary failure');
        if (code) error.code = code;
        throw error;
      },
      unlink: async target => { unlinkCalls += 1; return fs.unlink(target); },
    };
    await assert.rejects(f.writeDocumentAtomic(p, 'new', {}, io), /保存失败/);
    assert.equal(await fs.readFile(p, 'utf8'), 'original', `original content for ${code || 'ordinary error'}`);
    assert.deepEqual(await fs.readdir(d), ['doc.md'], `temporary file cleanup for ${code || 'ordinary error'}`);
    assert.equal(unlinkCalls, 1, `only temporary file is unlinked for ${code || 'ordinary error'}`);
  }
});
test('directories and missing files rejected', async t => {
  const d=await temp(t); const p=path.join(d,'folder.md'); await fs.mkdir(p);
  await assert.rejects(f.readDocument(p),/不是文件/);
  await assert.rejects(f.readDocument(path.join(d,'missing.md')));
});
