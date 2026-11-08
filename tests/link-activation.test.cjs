'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let shouldOpenExternalLink;
test('keyboard activation and modified mouse clicks open preview links', async () => {
  ({ shouldOpenExternalLink } = await import('../web/link-activation.js'));
  assert.equal(shouldOpenExternalLink({ detail: 0, ctrlKey: false, metaKey: false }), true);
  assert.equal(shouldOpenExternalLink({ detail: 1, ctrlKey: true, metaKey: false }), true);
  assert.equal(shouldOpenExternalLink({ detail: 1, ctrlKey: false, metaKey: true }), true);
  assert.equal(shouldOpenExternalLink({ detail: 1, ctrlKey: false, metaKey: false }), false);
});
