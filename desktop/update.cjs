'use strict';

// Manual update check against GitHub Releases. Pure helpers are unit-tested;
// the dialog flow takes its Electron surfaces as injected dependencies.
const DEFAULT_ENDPOINT = 'https://api.github.com/repos/Thy985/ink-leaf/releases/latest';

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
  return { version, url };
}

async function checkUpdates({ net, app, dialog, shell, win, endpoint, timeoutMs = 8000 }) {
  const target = endpoint || process.env.INKSTONE_UPDATE_API || DEFAULT_ENDPOINT;
  const current = app.getVersion();
  try {
    const response = await net.fetch(target, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ink-leaf-update-check' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
    const release = parseRelease(await response.json());
    const comparison = compareVersions(release.version, current);
    if (comparison > 0) {
      const answer = await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['前往下载页', '关闭'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: '发现新版本',
        message: `墨页 ${release.version} 已发布，当前版本 v${current}。`,
        detail: '确认后将打开浏览器访问发布页。',
      });
      if (answer.response === 0) await shell.openExternal(release.url);
      return 'update-offered';
    }
    await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['好'],
      noLink: true,
      title: '检查更新',
      message: comparison === 0 ? `当前已是最新版本（v${current}）。` : `当前版本 v${current} 已比最新发布 v${release.version} 更新。`,
    });
    return 'up-to-date';
  } catch (error) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['好'],
      noLink: true,
      title: '检查更新失败',
      message: '无法获取最新版本信息。',
      detail: String(error.message || error),
    });
    return 'failed';
  }
}

module.exports = { compareVersions, parseRelease, checkUpdates, DEFAULT_ENDPOINT };
