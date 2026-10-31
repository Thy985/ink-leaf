'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, parseRelease, checkUpdates } = require('../desktop/update.cjs');

test('compareVersions orders semantic versions with optional v prefix', () => {
  assert.equal(compareVersions('0.9.0', '0.9.0'), 0);
  assert.equal(compareVersions('v0.9.0', '0.9.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.8.0', '0.9.0'), -1);
  assert.equal(compareVersions('0.9', '0.9.0'), 0);
  assert.equal(compareVersions('1.0', '0.99.99'), 1);
});

test('parseRelease validates GitHub release payloads', () => {
  assert.deepEqual(
    parseRelease({ tag_name: ' v9.1.2 ', html_url: 'https://example.com/r' }),
    { version: '9.1.2', url: 'https://example.com/r' }
  );
  assert.throws(() => parseRelease({ tag_name: 'v1.0.0', html_url: 'http://example.com/r' }), /发布数据/);
  assert.throws(() => parseRelease({ tag_name: 'v1.0.0' }), /发布数据/);
  assert.throws(() => parseRelease(null), /发布数据/);
});

function fakeDeps({ body, status = 200, version = '0.9.0', response = 0 }) {
  const calls = { messages: [], opened: [] };
  const deps = {
    net: { fetch: async () => ({ ok: status === 200, status, json: async () => body }) },
    app: { getVersion: () => version },
    dialog: {
      showMessageBox: async (_win, options) => {
        calls.messages.push(options);
        return { response };
      },
    },
    shell: { openExternal: async (url) => { calls.opened.push(url); } },
    win: {},
  };
  return { deps, calls };
}

test('checkUpdates offers a newer release and opens its page', async () => {
  const { deps, calls } = fakeDeps({ body: { tag_name: 'v1.2.3', html_url: 'https://example.com/r123' } });
  assert.equal(await checkUpdates({ ...deps, endpoint: 'http://unit/test' }), 'update-offered');
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].title, '发现新版本');
  assert(calls.messages[0].message.includes('1.2.3'));
  assert.deepEqual(calls.opened, ['https://example.com/r123']);
});

test('checkUpdates skips the browser when the dialog is declined', async () => {
  const { deps, calls } = fakeDeps({ body: { tag_name: 'v1.2.3', html_url: 'https://example.com/r123' }, response: 1 });
  assert.equal(await checkUpdates({ ...deps, endpoint: 'http://unit/test' }), 'update-offered');
  assert.deepEqual(calls.opened, []);
});

test('checkUpdates reports up-to-date and newer local versions', async () => {
  const same = fakeDeps({ body: { tag_name: 'v0.9.0', html_url: 'https://example.com/r' } });
  assert.equal(await checkUpdates({ ...same.deps, endpoint: 'http://unit/test' }), 'up-to-date');
  assert(same.calls.messages[0].message.includes('已是最新'));
  const older = fakeDeps({ body: { tag_name: 'v0.1.0', html_url: 'https://example.com/r' } });
  assert.equal(await checkUpdates({ ...older.deps, endpoint: 'http://unit/test' }), 'up-to-date');
  assert(older.calls.messages[0].message.includes('比最新发布'));
});

test('checkUpdates surfaces network and payload failures as dialogs', async () => {
  const failing = fakeDeps({ status: 500, body: {} });
  assert.equal(await checkUpdates({ ...failing.deps, endpoint: 'http://unit/test' }), 'failed');
  assert.equal(failing.calls.messages[0].title, '检查更新失败');
  assert(failing.calls.messages[0].detail.includes('500'));
  const malformed = fakeDeps({ body: {} });
  assert.equal(await checkUpdates({ ...malformed.deps, endpoint: 'http://unit/test' }), 'failed');
  assert.equal(malformed.calls.messages[0].title, '检查更新失败');
});
