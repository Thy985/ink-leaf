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

// --- v0.6: local image bridge and HTML export ---
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
test('readImage rejects absolute paths, URL schemes and traversal', async t => {
  const d = await temp(t);
  await assert.rejects(f.readImage(d, path.join(os.tmpdir(), 'elsewhere.png')), /文档目录/);
  await assert.rejects(f.readImage(d, 'https://example.com/a.png'), /文档目录/);
  await assert.rejects(f.readImage(d, '../outside.png'), /文档目录内/);
  await assert.rejects(f.readImage(d, 'a/../../outside.png'), /文档目录内/);
  await assert.rejects(f.readImage(null, 'cat.png'), /先保存文档/);
  await assert.rejects(f.readImage(d, ''), /无效的图片路径/);
});
test('readImage enforces extension and magic-number agreement', async t => {
  const d = await temp(t);
  await fs.writeFile(path.join(d, 'notes.txt'), 'text');
  await fs.writeFile(path.join(d, 'fake.png'), 'not a png at all');
  await assert.rejects(f.readImage(d, 'notes.txt'), /不支持的图片格式/);
  await assert.rejects(f.readImage(d, 'fake.png'), /内容与扩展名不符/);
  await assert.rejects(f.readImage(d, 'missing.png'), /找不到图片文件/);
});
test('oversized image rejected', async t => {
  const d = await temp(t);
  await fs.writeFile(path.join(d, 'big.png'), Buffer.alloc(f.MAX_IMAGE_BYTES + 1));
  await assert.rejects(f.readImage(d, 'big.png'), /5 MB/);
});
test('readImage resolves encoded names, strips query strings and returns a data URL', async t => {
  const d = await temp(t);
  await fs.writeFile(path.join(d, '我的 猫.png'), PNG);
  const result = await f.readImage(d, encodeURIComponent('我的 猫.png') + '?v=2');
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
  assert.equal(path.basename(result.filepath), '我的 猫.png');
  const direct = await f.readImage(d, '我的 猫.png');
  assert.equal(direct.dataUrl, result.dataUrl);
});
test('writeHtmlFile writes atomically and refuses other extensions', async t => {
  const d = await temp(t);
  const p = path.join(d, '导出.html');
  const out = await f.writeHtmlFile(p, '<!doctype html><title>墨页</title>');
  assert.equal(out.filename, '导出.html');
  assert.equal(await fs.readFile(p, 'utf8'), '<!doctype html><title>墨页</title>');
  assert.deepEqual(await fs.readdir(d), ['导出.html']);
  await assert.rejects(f.writeHtmlFile(path.join(d, 'doc.md'), '<p>x</p>'), /仅支持导出/);
  await assert.rejects(f.writeHtmlFile(path.join(d, 'big.html'), 'x'.repeat(f.MAX_BYTES + 1)), /10 MB/);
});

// --- v0.7: clipboard image writes and PDF export ---
test('writeImageFile saves beside the document with generated names and conflict counters', async t => {
  const d = await temp(t);
  const name = await f.writeImageFile(d, 'image/png', PNG);
  assert.match(name, /^粘贴图片-\d{8}-\d{6}\.png$/);
  assert.deepEqual(await fs.readFile(path.join(d, name)), PNG);
  const second = await f.writeImageFile(d, 'image/png', PNG);
  assert.notEqual(second, name);
  assert.match(second, /-1\.png$/);
  assert.equal((await fs.readdir(d)).length, 2);
});
test('writeImageFile validates MIME mapping, magic numbers, size and directory', async t => {
  const d = await temp(t);
  await assert.rejects(f.writeImageFile(d, 'image/svg+xml', Buffer.from('<svg/>')), /不支持的图片类型/);
  await assert.rejects(f.writeImageFile(d, 'image/png', Buffer.from('not a png at all')), /内容与类型不一致/);
  await assert.rejects(f.writeImageFile(d, 'image/png', Buffer.alloc(0)), /内容为空/);
  await assert.rejects(f.writeImageFile(d, 'image/png', Buffer.alloc(f.MAX_IMAGE_BYTES + 1)), /5 MB/);
  await assert.rejects(f.writeImageFile(null, 'image/png', PNG), /先保存文档/);
  await assert.rejects(f.writeImageFile(path.join(d, '无此目录'), 'image/png', PNG), /文档目录不可用/);
});
test('writeImageFile cleans temporary files when rename fails', async t => {
  const d = await temp(t);
  const failing = {
    stat: fs.stat.bind(fs),
    access: fs.access.bind(fs),
    writeFile: async (p, data, opts) => fs.writeFile(p, data, opts),
    rename: async () => { throw new Error('boom'); },
    unlink: (p) => fs.unlink(p),
  };
  await assert.rejects(f.writeImageFile(d, 'image/png', PNG, failing), /写入图片失败：boom/);
  const entries = await fs.readdir(d);
  assert.equal(entries.filter((n) => n.endsWith('.tmp')).length, 0);
});
test('writeBinaryFile stores PDF bytes atomically with a 10 MB ceiling', async t => {
  const d = await temp(t);
  const pdf = Buffer.from('%PDF-1.7 test bytes');
  const out = await f.writeBinaryFile(path.join(d, '导出.pdf'), pdf);
  assert.equal(out.filename, '导出.pdf');
  assert.deepEqual(await fs.readFile(path.join(d, '导出.pdf')), pdf);
  assert.deepEqual(await fs.readdir(d), ['导出.pdf']);
  await assert.rejects(f.writeBinaryFile('相对.pdf', pdf), /绝对路径/);
  await assert.rejects(f.writeBinaryFile(path.join(d, 'big.pdf'), Buffer.alloc(f.MAX_BYTES + 1)), /10 MB/);
  await assert.rejects(f.writeBinaryFile(path.join(d, '空.pdf'), Buffer.alloc(0)), /内容为空/);
});
