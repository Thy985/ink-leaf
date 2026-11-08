'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sameDesktopState } = require('../desktop/state.cjs');

test('desktop state fast path only skips fully equal normalized snapshots', () => {
  const base = { text: 'a\n', savedText: 'a\n', filename: 'a.md', dirty: false, composing: false };
  assert.equal(sameDesktopState({ ...base }, base), true);
  for (const change of [
    { text: 'a\r\n' }, { savedText: 'other' }, { filename: 'b.md' },
    { dirty: true }, { composing: true },
  ]) assert.equal(sameDesktopState({ ...base, ...change }, base), false);
  assert.equal(sameDesktopState({ ...base, extra: 'ignored' }, base), true);
});
