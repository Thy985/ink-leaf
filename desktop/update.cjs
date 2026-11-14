'use strict';

// GitHub Releases 更新服务：检查新版本、下载安装包、校验完整性、生成安装命令。
// 网络、文件与进程都通过参数注入，纯逻辑部分可以直接单元测试。
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const DEFAULT_ENDPOINT = 'https://api.github.com/repos/Thy985/ink-leaf/releases/latest';
const CHECK_TIMEOUT_MS = 15000;
// 保险丝：安装包再大也不该超过 2 GB，避免异常发布把磁盘写满。
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

function compareVersions(a, b) {
  const segments = (value) => String(value).trim().replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = segments(a);
  const right = segments(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function parseRelease(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('发布数据格式无效');
  const version = typeof payload.tag_name === 'string' ? payload.tag_name.trim().replace(/^v/i, '') : '';
  const url = typeof payload.html_url === 'string' ? payload.html_url : '';
  if (!version || !/^https:\/\//i.test(url)) throw new Error('发布数据格式无效');
  const assets = (Array.isArray(payload.assets) ? payload.assets : []).filter((asset) => (
    asset && typeof asset.name === 'string' && asset.name.trim()
    && isAllowedAssetUrl(asset.browser_download_url)
  ));
  return { version, url, assets };
}

const SETUP_ASSET = /-setup\.exe$/i;
const ARCH_TOKEN = { x64: 'x64', ia32: 'ia32', arm64: 'arm64' };

// 安装包地址只接受 https；回环地址放行 http，仅用于本地测试与自建更新源，
// 因为 127.0.0.1 / localhost 不经过外部网络，不存在中间人风险。
const HTTPS_URL = /^https:\/\//i;
const LOOPBACK_HTTP_URL = /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d{1,5})?(?:\/|$)/i;

function isAllowedAssetUrl(url) {
  return typeof url === 'string' && (HTTPS_URL.test(url) || LOOPBACK_HTTP_URL.test(url));
}

// 发布里可能有多个平台的产物，优先挑版本号与架构都匹配的那个 NSIS 安装包。
function selectAsset(release, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'win32') return null;
  const setups = (release && Array.isArray(release.assets) ? release.assets : []).filter((asset) => SETUP_ASSET.test(asset.name));
  if (!setups.length) return null;
  const versionToken = String(release.version || '').toLowerCase();
  const archToken = String(ARCH_TOKEN[arch] || arch).toLowerCase();
  let best = null;
  let bestScore = -1;
  for (const asset of setups) {
    const name = asset.name.toLowerCase();
    let score = 0;
    if (versionToken && name.includes(versionToken)) score += 4;
    if (name.includes(archToken)) score += 2;
    if (score > bestScore) { bestScore = score; best = asset; }
  }
  return best;
}

function normalizeAsset(asset) {
  return {
    name: asset.name,
    url: asset.browser_download_url,
    size: typeof asset.size === 'number' && asset.size > 0 ? asset.size : 0,
    digest: typeof asset.digest === 'string' ? asset.digest.slice(0, 200) : '',
  };
}

async function checkForUpdates({ net, app, endpoint, timeoutMs = CHECK_TIMEOUT_MS, platform = process.platform, arch = process.arch }) {
  const target = endpoint || process.env.INKSTONE_UPDATE_API || DEFAULT_ENDPOINT;
  const currentVersion = typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0';
  try {
    const response = await net.fetch(target, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'inkstone-update-check' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
    const release = parseRelease(await response.json());
    if (compareVersions(release.version, currentVersion) <= 0) {
      return { status: 'up-to-date', version: release.version, currentVersion, releaseUrl: release.url };
    }
    const asset = normalizeAsset(selectAsset(release, { platform, arch }) || {});
    if (!asset.url) {
      return { status: 'no-asset', version: release.version, currentVersion, releaseUrl: release.url, message: '发布中没有适用于当前平台的安装包。' };
    }
    return { status: 'update-available', version: release.version, currentVersion, releaseUrl: release.url, asset };
  } catch (error) {
    return { status: 'failed', currentVersion, message: String(error?.message || error) };
  }
}

// 把 Release 资产流式写入目标路径，同时回报进度。失败时删掉半成品，避免留下被误用的安装包。
async function downloadAsset({ fetchImpl, asset, targetPath, onProgress, io = fs.promises }) {
  if (typeof fetchImpl !== 'function') throw new Error('缺少下载实现');
  if (!asset || typeof asset.url !== 'string' || !asset.url) throw new Error('无效的安装包地址');
  const response = await fetchImpl(asset.url, { redirect: 'follow' });
  if (!response || !response.ok) throw new Error(`下载失败：服务器返回 ${response ? response.status : '无响应'}`);
  const body = response.body;
  if (!body) throw new Error('下载失败：服务器没有返回内容');
  const total = Number(response.headers?.get?.('content-length')) || asset.size || 0;
  await io.mkdir(path.dirname(targetPath), { recursive: true });
  const reader = typeof body.getReader === 'function' ? Readable.fromWeb(body) : body;
  const writer = fs.createWriteStream(targetPath);
  let received = 0;
  try {
    await new Promise((resolve, reject) => {
      const onData = (chunk) => {
        received += chunk.length;
        if (received > MAX_ASSET_BYTES) { reject(new Error('安装包超过大小上限')); return; }
        if (onProgress) { try { onProgress({ received, total }); } catch { /* 进度回调不影响下载 */ } }
      };
      const fail = (error) => reject(error);
      reader.on('data', onData);
      reader.on('error', fail);
      writer.on('error', fail);
      writer.on('finish', resolve);
      reader.pipe(writer);
    });
  } catch (error) {
    try { reader.destroy(); } catch { /* 已经结束 */ }
    try { writer.destroy(); } catch { /* 已经结束 */ }
    await io.unlink(targetPath).catch(() => {});
    throw error;
  }
  return { filePath: targetPath, bytes: received, total };
}

// GitHub 在资产上给出 sha256 digest 时按比例校验；没有 digest 的发布跳过校验。
async function verifyDigest(filePath, expected) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(expected || ''));
  if (!match) return { verified: false };
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  try {
    for await (const chunk of stream) hash.update(chunk);
  } catch (error) {
    stream.destroy();
    throw new Error(`安装包校验失败：${error.message}`);
  }
  if (hash.digest('hex').toLowerCase() !== match[1].toLowerCase()) throw new Error('安装包校验失败，文件已被丢弃');
  return { verified: true };
}

// 让安装器等主进程退出后再静默运行：NSIS 检测到应用仍在运行会中止安装。
function buildInstallerCommand({ installerPath, pid }) {
  const escaped = String(installerPath).replace(/'/g, "''");
  return [
    `$id = ${pid}`,
    '$deadline = (Get-Date).AddSeconds(60)',
    'while ((Get-Process -Id $id -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }',
    `Start-Process -FilePath '${escaped}' -ArgumentList '/S'`,
  ].join('; ');
}

module.exports = {
  DEFAULT_ENDPOINT,
  CHECK_TIMEOUT_MS,
  MAX_ASSET_BYTES,
  isAllowedAssetUrl,
  compareVersions,
  parseRelease,
  selectAsset,
  normalizeAsset,
  checkForUpdates,
  downloadAsset,
  verifyDigest,
  buildInstallerCommand,
};
