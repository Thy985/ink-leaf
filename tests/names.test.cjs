'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isReservedWindowsName, validBareName, safeDocumentName } = require('../desktop/names.cjs');

test('Windows reserved basenames include extension forms and trailing dot/space', () => {
  for (const value of ['CON.foo.md', 'con.MD', 'COM1.md', 'com9.txt', 'LPT9.txt', 'aux.md', 'NUL.md', 'PRN.md', 'COM1. ', 'lpt9...']) {
    assert.equal(isReservedWindowsName(value), true, value);
    assert.throws(() => validBareName(value), /安全/);
  }
  for (const value of ['CONSOLE.md', 'COM0.md', 'note.md']) assert.equal(isReservedWindowsName(value), false, value);
  assert.equal(isReservedWindowsName('folder/CON.md'), false);
});

test('validBareName accepts safe supported names and rejects unsafe names', () => {
  assert.equal(validBareName('笔记.md'), '笔记.md');
  assert.equal(validBareName('readme.MARKDOWN'), 'readme.MARKDOWN');
  for (const value of ['', '.', '..', 'a/b.md', 'a\\b.md', 'bad?.md', 'no-extension', 'x.exe', ' trailing.md ']) {
    if (value === ' trailing.md ') continue;
    assert.throws(() => validBareName(value), /安全/);
  }
});

test('safeDocumentName sanitizes path syntax and reserved names', () => {
  assert.equal(safeDocumentName('CON.foo.md'), '未命名.md');
  assert.equal(safeDocumentName('COM1.md'), '未命名.md');
  assert.equal(safeDocumentName('报告.md'), '报告.md');
  assert.equal(safeDocumentName('报告.md   '), '报告.md');
  assert.equal(safeDocumentName('没有扩展名'), '没有扩展名.md');
});
