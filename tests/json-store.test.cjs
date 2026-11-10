'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readJsonFile } = require('../desktop/json-store.cjs');

test('readJsonFile treats only ENOENT as missing and preserves other failures', async () => {
  const missing = await readJsonFile('/unused/missing.json', {
    readFile: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  assert.deepEqual(missing, { exists: false, value: undefined });

  for (const code of ['EACCES', 'EBUSY', 'EIO']) {
    await assert.rejects(readJsonFile('/unused/blocked.json', {
      readFile: async () => { const error = new Error(code); error.code = code; throw error; },
    }), new RegExp(code));
  }

  await assert.rejects(readJsonFile('/unused/corrupt.json', {
    readFile: async () => '{broken json',
  }), SyntaxError);
  assert.deepEqual(await readJsonFile('/unused/valid.json', {
    readFile: async () => '{"folders":[]}',
  }), { exists: true, value: { folders: [] } });
});
