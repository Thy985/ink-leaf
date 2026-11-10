'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

const { searchFolder, extractMatches, MAX_SEARCH_FILES, MAX_SEARCH_MATCHES } = require('../desktop/folders.cjs');

test('search: extractMatches finds literal text (case-insensitive)', () => {
  const text = 'Hello World\nhello world\nHELLO WORLD';
  const matches = extractMatches(text, 'hello', { caseSensitive: false });
  assert.strictEqual(matches.length, 3);
  assert.strictEqual(matches[0].lineNumber, 1);
  assert.strictEqual(matches[1].lineNumber, 2);
  assert.strictEqual(matches[2].lineNumber, 3);
});

test('search: extractMatches respects case sensitivity', () => {
  const text = 'Hello World\nhello world\nHELLO WORLD';
  const matches = extractMatches(text, 'Hello', { caseSensitive: true });
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].lineNumber, 1);
});

test('search: extractMatches supports regex', () => {
  const text = 'abc123\ndef456\nghi789';
  const matches = extractMatches(text, '[a-z]+[0-9]+', { regex: true });
  assert.strictEqual(matches.length, 3);
});

test('search: extractMatches returns empty for invalid regex', () => {
  const text = 'test';
  const matches = extractMatches(text, '[invalid', { regex: true });
  assert.strictEqual(matches.length, 0);
});

test('search: extractMatches returns empty for empty query', () => {
  const text = 'test';
  const matches = extractMatches(text, '');
  assert.strictEqual(matches.length, 0);
});

test('search: extractMatches caps at MAX_SEARCH_MATCHES', () => {
  const text = 'a'.repeat(MAX_SEARCH_MATCHES + 50);
  const matches = extractMatches(text, 'a', { caseSensitive: true });
  assert.strictEqual(matches.length, MAX_SEARCH_MATCHES);
});

test('search: extractMatches includes context around match', () => {
  const text = 'x'.repeat(200) + 'needle' + 'y'.repeat(200);
  const matches = extractMatches(text, 'needle');
  assert.strictEqual(matches.length, 1);
  assert.ok(matches[0].context.length > 6);
  assert.ok(matches[0].context.includes('needle'));
});

test('search: searchFolder finds matches in a folder', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-test-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'doc1.md'), '# First\n\nThis contains the keyword.\n');
    await fs.writeFile(path.join(tmpDir, 'doc2.md'), '# Second\n\nNo match here.\n');
    await fs.mkdir(path.join(tmpDir, 'subdir'));
    await fs.writeFile(path.join(tmpDir, 'subdir', 'doc3.md'), '# Third\n\nKeyword again!\n');

    const result = await searchFolder(tmpDir, 'keyword');
    assert.strictEqual(result.results.length, 2);
    assert.strictEqual(result.totalMatches, 2);
    assert.ok(result.results.some((r) => r.path === 'doc1.md'));
    assert.ok(result.results.some((r) => r.path === 'subdir/doc3.md'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('search: searchFolder returns empty for no matches', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-test-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'doc.md'), '# Title\n\nSome text.\n');
    const result = await searchFolder(tmpDir, 'nonexistent');
    assert.strictEqual(result.results.length, 0);
    assert.strictEqual(result.totalMatches, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('search: searchFolder skips non-matching extensions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-test-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'doc.txt'), 'keyword in txt');
    await fs.writeFile(path.join(tmpDir, 'doc.md'), 'keyword in md');
    const result = await searchFolder(tmpDir, 'keyword');
    assert.strictEqual(result.results.length, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('search: searchFolder skips oversized files', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-test-'));
  try {
    const big = 'keyword' + 'x'.repeat(11 * 1024 * 1024);
    await fs.writeFile(path.join(tmpDir, 'big.md'), big);
    await fs.writeFile(path.join(tmpDir, 'small.md'), 'keyword');
    const result = await searchFolder(tmpDir, 'keyword');
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].path, 'small.md');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('search: searchFolder handles empty query', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-test-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'doc.md'), 'text');
    const result = await searchFolder(tmpDir, '');
    assert.strictEqual(result.results.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('search: searchFolder respects caseSensitive option', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-test-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'doc.md'), 'Hello World\nhello world');
    const insensitive = await searchFolder(tmpDir, 'hello', { caseSensitive: false });
    assert.strictEqual(insensitive.totalMatches, 2);
    const sensitive = await searchFolder(tmpDir, 'Hello', { caseSensitive: true });
    assert.strictEqual(sensitive.totalMatches, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('search: searchFolder respects regex option', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-test-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'doc.md'), 'abc123\ndef456');
    const literal = await searchFolder(tmpDir, '[a-z]+[0-9]+', { regex: false });
    assert.strictEqual(literal.totalMatches, 0);
    const regex = await searchFolder(tmpDir, '[a-z]+[0-9]+', { regex: true });
    assert.strictEqual(regex.totalMatches, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('search: searchFolder skips symlinks', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-test-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'real.md'), 'keyword');
    await fs.symlink(path.join(tmpDir, 'real.md'), path.join(tmpDir, 'link.md'));
    const result = await searchFolder(tmpDir, 'keyword');
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].path, 'real.md');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('search: searchFolder skips .git and node_modules', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-search-test-'));
  try {
    await fs.mkdir(path.join(tmpDir, '.git'));
    await fs.writeFile(path.join(tmpDir, '.git', 'config.md'), 'keyword');
    await fs.mkdir(path.join(tmpDir, 'node_modules'));
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'index.md'), 'keyword');
    await fs.writeFile(path.join(tmpDir, 'doc.md'), 'keyword');
    const result = await searchFolder(tmpDir, 'keyword');
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].path, 'doc.md');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('search: MAX_SEARCH_FILES is bounded', () => {
  assert.ok(MAX_SEARCH_FILES > 0 && MAX_SEARCH_FILES <= 2000);
});

test('search: MAX_SEARCH_MATCHES is bounded', () => {
  assert.ok(MAX_SEARCH_MATCHES > 0 && MAX_SEARCH_MATCHES <= 200);
});
