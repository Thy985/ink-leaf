'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const {
  isAllowedAssetUrl,
  compareVersions,
  parseRelease,
  selectAsset,
  normalizeAsset,
  checkForUpdates,
  downloadAsset,
  verifyDigest,
  buildInstallerCommand,
} = require('../desktop/update.cjs');

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-update-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('compareVersions orders semantic versions with optional v prefix', () => {
  assert.equal(compareVersions('0.9.0', '0.9.0'), 0);
  assert.equal(compareVersions('v0.9.0', '0.9.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.8.0', '0.9.0'), -1);
  assert.equal(compareVersions('0.9', '0.9.0'), 0);
  assert.equal(compareVersions('1.0', '0.99.99'), 1);
});

test('parseRelease validates GitHub release payloads and keeps usable assets', () => {
  assert.equal(parseRelease({ tag_name: ' v9.1.2 ', html_url: 'https://example.com/r' }).version, '9.1.2');
  assert.throws(() => parseRelease({ tag_name: 'v1.0.0', html_url: 'http://example.com/r' }), /发布数据/);
  assert.throws(() => parseRelease({ tag_name: 'v1.0.0' }), /发布数据/);
  assert.throws(() => parseRelease(null), /发布数据/);
  const parsed = parseRelease({
    tag_name: 'v1.0.0',
    html_url: 'https://example.com/r',
    assets: [
      { name: 'Inkstone-1.0.0-Windows-x64-Setup.exe', browser_download_url: 'https://example.com/s.exe', size: 123456, digest: 'sha256:abc' },
      { name: 'notes.txt', browser_download_url: 'ftp://example.com/nope' },
      { name: 'broken.exe' },
    ],
  });
  assert.equal(parsed.assets.length, 1);
  assert.equal(parsed.assets[0].name, 'Inkstone-1.0.0-Windows-x64-Setup.exe');

  // 明文 http 只放行回环地址，外网安装包会被丢掉。
  const loopback = parseRelease({
    tag_name: 'v1.0.0',
    html_url: 'https://example.com/r',
    assets: [
      { name: 'a.exe', browser_download_url: 'http://127.0.0.1:8123/a.exe' },
      { name: 'b.exe', browser_download_url: 'http://evil.example.com/b.exe' },
    ],
  });
  assert.deepEqual(loopback.assets.map((asset) => asset.name), ['a.exe']);
});

test('selectAsset prefers the NSIS setup matching version and architecture', () => {
  const release = {
    version: '1.2.3',
    assets: [
      { name: 'Inkstone-1.2.3-Windows-x64-Setup.exe', browser_download_url: 'https://example.com/x64' },
      { name: 'Inkstone-1.2.3-Windows-ia32-Setup.exe', browser_download_url: 'https://example.com/ia32' },
      { name: 'Inkstone-1.2.3-Windows-x64.zip', browser_download_url: 'https://example.com/zip' },
    ],
  };
  assert.equal(selectAsset(release, { platform: 'win32', arch: 'x64' }).name, 'Inkstone-1.2.3-Windows-x64-Setup.exe');
  assert.equal(selectAsset(release, { platform: 'win32', arch: 'ia32' }).name, 'Inkstone-1.2.3-Windows-ia32-Setup.exe');
  assert.equal(selectAsset(release, { platform: 'linux', arch: 'x64' }), null);
  assert.equal(selectAsset({ version: '1.0.0', assets: [{ name: 'a.zip', browser_download_url: 'https://e/x' }] }, { platform: 'win32', arch: 'x64' }), null);
});

test('isAllowedAssetUrl accepts https anywhere and http only on loopback', () => {
  assert.equal(isAllowedAssetUrl('https://github.com/a/b/Setup.exe'), true);
  assert.equal(isAllowedAssetUrl('http://127.0.0.1:8123/setup.exe'), true);
  assert.equal(isAllowedAssetUrl('http://localhost/setup.exe'), true);
  assert.equal(isAllowedAssetUrl('http://[::1]:9000/setup.exe'), true);
  assert.equal(isAllowedAssetUrl('http://example.com/setup.exe'), false);
  // 前缀相似的域名不是回环地址，http 必须被拒。
  assert.equal(isAllowedAssetUrl('http://127.0.0.1.evil.com/setup.exe'), false);
  assert.equal(isAllowedAssetUrl('http://localhost.evil.com/setup.exe'), false);
  assert.equal(isAllowedAssetUrl('ftp://127.0.0.1/setup.exe'), false);
  assert.equal(isAllowedAssetUrl(''), false);
  assert.equal(isAllowedAssetUrl(undefined), false);
});

test('normalizeAsset keeps https download metadata and drops unknown sizes', () => {
  assert.deepEqual(
    normalizeAsset({ name: 'a.exe', browser_download_url: 'https://example.com/a.exe', size: 2048, digest: 'sha256:abc' }),
    { name: 'a.exe', url: 'https://example.com/a.exe', size: 2048, digest: 'sha256:abc' },
  );
  assert.equal(normalizeAsset({ name: 'a.exe', browser_download_url: 'https://example.com/a.exe' }).size, 0);
});

function fakeNet({ body, status = 200, version = '0.9.0', arch = 'x64', platform = 'win32' }) {
  const calls = { urls: [] };
  const net = {
    fetch: async (url) => {
      calls.urls.push(url);
      return { ok: status === 200, status, json: async () => body, headers: { get: () => null } };
    },
  };
  const app = { getVersion: () => version };
  return { net, app, calls };
}

const RELEASE_BODY = {
  tag_name: 'v1.2.3',
  html_url: 'https://example.com/releases/tag/v1.2.3',
  assets: [{ name: 'Inkstone-1.2.3-Windows-x64-Setup.exe', browser_download_url: 'https://example.com/Inkstone-1.2.3-Windows-x64-Setup.exe', size: 2048, digest: 'sha256:abc' }],
};

test('checkForUpdates offers a newer release with a normalized asset', async () => {
  const { net, app, calls } = fakeNet({ body: RELEASE_BODY });
  const result = await checkForUpdates({ net, app, endpoint: 'http://unit/test', platform: 'win32', arch: 'x64' });
  assert.equal(result.status, 'update-available');
  assert.equal(result.version, '1.2.3');
  assert.equal(result.currentVersion, '0.9.0');
  assert.equal(result.asset.name, 'Inkstone-1.2.3-Windows-x64-Setup.exe');
  assert.equal(result.asset.size, 2048);
  assert.equal(calls.urls[0], 'http://unit/test');
});

test('checkForUpdates reports up-to-date for equal or older releases', async () => {
  const same = fakeNet({ body: { tag_name: 'v0.9.0', html_url: 'https://example.com/r' } });
  assert.equal((await checkForUpdates({ ...same, endpoint: 'http://unit/test' })).status, 'up-to-date');
  const older = fakeNet({ body: { tag_name: 'v0.1.0', html_url: 'https://example.com/r' } });
  assert.equal((await checkForUpdates({ ...older, endpoint: 'http://unit/test' })).status, 'up-to-date');
});

test('checkForUpdates fails loudly on HTTP errors, bad payloads and missing assets', async () => {
  const failing = fakeNet({ status: 500, body: {} });
  const failed = await checkForUpdates({ ...failing, endpoint: 'http://unit/test' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /500/);

  const malformed = fakeNet({ body: {} });
  assert.equal((await checkForUpdates({ ...malformed, endpoint: 'http://unit/test' })).status, 'failed');

  // 有新版本但没有可用安装包时单独报 no-asset，提示与「检查失败」区分开。
  const noAsset = fakeNet({ body: { tag_name: 'v2.0.0', html_url: 'https://example.com/r', assets: [] } });
  const missing = await checkForUpdates({ ...noAsset, endpoint: 'http://unit/test' });
  assert.equal(missing.status, 'no-asset');
  assert.equal(missing.version, '2.0.0');
  assert.match(missing.message, /没有适用于当前平台/);
  assert.equal(missing.releaseUrl, 'https://example.com/r');
});

test('downloadAsset streams the body to disk and reports progress', async (t) => {
  const dir = await temp(t);
  const target = path.join(dir, 'setup.exe');
  const chunks = [Buffer.alloc(1024, 1), Buffer.alloc(1024, 2), Buffer.alloc(512, 3)];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(total) : null) },
    body: Readable.from(chunks),
  });
  const seen = [];
  const result = await downloadAsset({
    fetchImpl,
    asset: { name: 'setup.exe', url: 'https://example.com/setup.exe', size: total },
    targetPath: target,
    onProgress: (progress) => seen.push(progress),
    io: fs,
  });
  assert.equal(result.bytes, total);
  assert.equal(result.total, total);
  assert.equal((await fs.readFile(target)).length, total);
  assert.ok(seen.length >= 2, 'progress reported more than once');
  assert.equal(seen[seen.length - 1].received, total);
});

test('downloadAsset rejects bad responses and removes partial files', async (t) => {
  const dir = await temp(t);
  const target = path.join(dir, 'setup.exe');
  const bad = await downloadAsset({
    fetchImpl: async () => ({ ok: false, status: 404, body: null, headers: { get: () => null } }),
    asset: { name: 'setup.exe', url: 'https://example.com/setup.exe' },
    targetPath: target,
    io: fs,
  }).catch((error) => error);
  assert.match(bad.message, /404/);
  await assert.rejects(fs.access(target));

  // 下载中途断流时，已经写入的半成品必须被删掉，避免被当成完整安装包。
  const failure = new Error('connection reset');
  const body = new Readable({ read() { this.destroy(failure); } });
  const broken = await downloadAsset({
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body }),
    asset: { name: 'setup.exe', url: 'https://example.com/setup.exe' },
    targetPath: target,
    io: fs,
  }).catch((error) => error);
  assert.equal(broken.message, 'connection reset');
  await assert.rejects(fs.access(target));
});

test('verifyDigest accepts a matching sha256 and rejects a tampered file', async (t) => {
  const dir = await temp(t);
  const target = path.join(dir, 'setup.exe');
  const bytes = Buffer.from('inkstone installer payload');
  await fs.writeFile(target, bytes);
  const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  assert.deepEqual(await verifyDigest(target, digest), { verified: true });
  assert.deepEqual(await verifyDigest(target, ''), { verified: false });
  await fs.writeFile(target, 'tampered');
  await assert.rejects(verifyDigest(target, digest), /校验失败/);
});

test('buildInstallerCommand waits for the app process before launching the installer', () => {
  const command = buildInstallerCommand({ installerPath: "C:\\Temp\\Inkstone Setup.exe", pid: 4242 });
  assert.match(command, /\$id = 4242/);
  assert.match(command, /Get-Process -Id \$id/);
  assert.match(command, /Start-Process -FilePath 'C:\\Temp\\Inkstone Setup\.exe'/);
  assert.match(command, /-ArgumentList '\/S'/);
});
