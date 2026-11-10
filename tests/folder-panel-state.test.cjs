'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('a blocked folder switch leaves the active folder and completed tree unchanged', async () => {
  const { beginFolderScan } = await import('../web/folder-panel-state.js');
  const previousScan = { tree: { name: 'first', dirs: [], docs: [] }, excluded: [] };
  const state = { activeFolder: '/first', lastScan: previousScan };

  assert.equal(beginFolderScan(state, '/second', true), false);
  assert.equal(state.activeFolder, '/first');
  assert.equal(state.lastScan, previousScan);
});

test('an idle folder switch starts a fresh scan for the selected folder', async () => {
  const { beginFolderScan } = await import('../web/folder-panel-state.js');
  const state = { activeFolder: '/first', lastScan: { tree: {} } };

  assert.equal(beginFolderScan(state, '/second', false), true);
  assert.equal(state.activeFolder, '/second');
  assert.equal(state.lastScan, null);
});
