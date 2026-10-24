import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, escape, parseBlocks, renderInline, serialize } from './model.js';

test('parses supported block types and round-trips LF text', () => {
  const source = '# Title\nA paragraph\ncontinued\n\n- item\n> quote\n~~~js\nconst x = 1;\n~~~\n';
  const blocks = parseBlocks(source);
  assert.deepEqual(blocks.map(({ type, level }) => level === undefined ? { type } : { type, level }), [
    { type: 'heading', level: 1 }, { type: 'paragraph' }, { type: 'blank' },
    { type: 'list' }, { type: 'quote' }, { type: 'code' }, { type: 'blank' }
  ]);
  assert.equal(blocks[1].raw, 'A paragraph\ncontinued');
  assert.equal(serialize(blocks), source);
  assert.equal(serialize(parseBlocks('a\r\nb\r')), 'a\nb\n');
});

test('keeps each blank line and accepts unterminated fenced code', () => {
  const blocks = parseBlocks('one\n\n\n```js\nalert(1)');
  assert.equal(blocks[1].type, 'blank');
  assert.equal(blocks[2].type, 'blank');
  assert.equal(blocks[3].type, 'code');
  assert.equal(blocks[3].raw, '```js\nalert(1)');
  assert.equal(serialize(blocks), 'one\n\n\n```js\nalert(1)');
});

test('matches IDs at the same position first and then by raw text', () => {
  const old = parseBlocks('# alpha\n# beta\n# alpha');
  const ids = old.map((block) => block.id);
  const next = parseBlocks('# alpha\n# alpha\n# beta', old);
  assert.equal(next[0].id, ids[0]);
  assert.equal(next[1].id, ids[2]);
  assert.equal(next[2].id, ids[1]);
  assert.equal(new Set(next.map((block) => block.id)).size, next.length);
});

test('keeps later unchanged IDs after an insertion or edit at the beginning', () => {
  const old = parseBlocks('# first\n# second\n# third');
  const ids = old.map((block) => block.id);
  const inserted = parseBlocks('# new\n# first\n# second\n# third', old);
  assert.deepEqual(inserted.slice(1).map((block) => block.id), ids);

  const edited = parseBlocks('# changed\n# second\n# third', old);
  assert.equal(edited[1].id, ids[1]);
  assert.equal(edited[2].id, ids[2]);
});

test('keeps a trailing newline as an independent blank block', () => {
  const blocks = parseBlocks('```js\ncode\n```\n');
  assert.equal(blocks.at(-2).type, 'code');
  assert.equal(blocks.at(-2).raw, '```js\ncode\n```');
  assert.equal(blocks.at(-1).type, 'blank');
  assert.equal(serialize(blocks), '```js\ncode\n```\n');
});

test('represents an empty document as one blank block', () => {
  const blocks = parseBlocks('');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'blank');
  assert.equal(serialize(blocks), '');
});

test('classify exposes useful block metadata', () => {
  assert.deepEqual(classify('### hi'), { type: 'heading', level: 3, prefix: '###' });
  assert.equal(classify('12. thing').type, 'list');
  assert.equal(classify('> quote').type, 'quote');
  assert.equal(classify('~~~ js').fence, '~');
});

test('inline rendering preserves syntax markers and escapes HTML', () => {
  const html = renderInline('**bold** and _em_ `a < b` <script>alert(1)</script>');
  assert.match(html, /<strong>/);
  assert.match(html, /<em>/);
  assert.match(html, /<code>a &lt; b<\/code>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /class="syntax"/);
  assert.equal(escape('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
});


test('renders strike-through and safe links while preserving source text', () => {
  const source = '~~gone~~ [docs](https://example.com) [mail](mailto:team@example.com) [section](#intro)';
  const html = renderInline(source);
  assert.match(html, /<del>/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /<a href="mailto:team@example\.com" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /<a href="#intro" target="_blank" rel="noopener noreferrer">/);
  assert.match(html, /class="syntax">~~<\/span>/);
  assert.match(html, /class="syntax">\]\(https:\/\/example\.com\)<\/span>/);
  // The rendered DOM's textContent is the original Markdown source because
  // every syntax marker remains in a syntax span.
  assert.equal(html.replace(/<[^>]+>/g, ''), source);
});

test('does not create clickable anchors for dangerous URLs', () => {
  const source = '[bad](javascript:alert(1)) [also-bad](data:text/html,x)';
  const html = renderInline(source);
  assert.doesNotMatch(html, /<a\b/);
  assert.match(html, /javascript:alert\(1\)/);
  assert.match(html, /data:text\/html,x/);
  assert.equal(html.replace(/<[^>]+>/g, ''), source);
});

test('does not parse emphasis inside inline code', () => {
  const html = renderInline('`**not bold** ~~not deleted~~`');
  assert.match(html, /<code>\*\*not bold\*\* ~~not deleted~~<\/code>/);
  assert.doesNotMatch(html, /<strong>|<del>/);
});

test('parses GFM tables, alignment, escaped pipes, and preserves source', () => {
  const source = '| Name | Note |\n| :--- | ---: |\n| a\\|b | **ok** |\n\n---';
  const blocks = parseBlocks(source);
  assert.equal(blocks[0].type, 'table');
  assert.equal(blocks[0].raw, source.split('\n\n')[0]);
  assert.match(blocks[0].separator, /:---/);
  assert.equal(blocks[1].type, 'blank');
  assert.equal(blocks[2].type, 'hr');
  assert.equal(serialize(blocks), source);
});

test('parses math blocks, nested list metadata, and does not let hr become a list', () => {
  const source = '$$\nx < y\n$$\n- outer\n  - inner\n    1. deep\n***';
  const blocks = parseBlocks(source);
  assert.equal(blocks[0].type, 'math');
  assert.deepEqual(blocks.slice(1).map(b => [b.type, b.depth, b.indent]), [
    ['list', 0, 0], ['list', 1, 2], ['list', 2, 4], ['hr', undefined, undefined]
  ]);
  assert.equal(serialize(blocks), source);
});

test('classifies HTML blocks, including script, without executing or rendering them', () => {
  const source = '<details>\n<summary>x</summary>\n<script>alert(1)</script>\n</details>';
  const block = parseBlocks(source)[0];
  assert.equal(block.type, 'html');
  assert.equal(block.tag, 'details');
  assert.equal(block.safe, false);
  assert.equal(serialize([block]), source);
});

test('supports backslash escapes and multi-backtick code spans', () => {
  const source = '\\*literal\\* `` `code` **raw** ``';
  const html = renderInline(source);
  assert.doesNotMatch(html, /<em>/);
  assert.match(html, /<code>`code` \*\*raw\*\*<\/code>/);
  assert.equal(html.replace(/<[^>]+>/g, ''), source);
});

test('keeps single-line math and HTML boundaries', () => {
  const source = '$$x$$\nafter\n\\[y\\]\nafter2\n<hr>\nafter3\n<div/>\nafter4';
  const blocks = parseBlocks(source);
  assert.deepEqual(blocks.map(({ type }) => type), ['math','paragraph','math','paragraph','html','paragraph','html','paragraph']);
  assert.equal(serialize(blocks), source);
});

test('bounds unclosed HTML at blank lines but lets script and style reach closing tags', () => {
  const source = '<div>\ninside\n\nafter\n<script>\n\nalert(1)\n</script>\n<style>\n.x{}\n</style>';
  const blocks = parseBlocks(source);
  assert.equal(blocks[0].raw, '<div>\ninside');
  assert.equal(blocks[3].tag, 'script');
  assert.equal(blocks[4].tag, 'style');
  assert.equal(serialize(blocks), source);
});

test('recognizes a table immediately after a paragraph and normalizes tab list indentation', () => {
  const source = 'paragraph\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\t- nested';
  const blocks = parseBlocks(source);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[1].type, 'table');
  assert.equal(blocks[2].type, 'list');
  assert.equal(blocks[2].indent, 4);
  assert.equal(blocks[2].depth, 2);
  assert.equal(serialize(blocks), source);
});

test('parses setext headings and preserves source', () => {
  const source = 'Title\n=====\n\nSub *title*\n---\n\n---';
  const blocks = parseBlocks(source);
  assert.deepEqual(blocks.map(({ type, level, style }) => ({ type, level, style })), [
    { type: 'heading', level: 1, style: 'setext' },
    { type: 'blank', level: undefined, style: undefined },
    { type: 'heading', level: 2, style: 'setext' },
    { type: 'blank', level: undefined, style: undefined },
    { type: 'hr', level: undefined, style: undefined },
  ]);
  assert.equal(blocks[0].raw, 'Title\n=====');
  assert.equal(blocks[2].raw, 'Sub *title*\n---');
  assert.equal(serialize(blocks), source);
});

test('parses multi-line setext headings', () => {
  const source = 'First line\nsecond line\n===';
  const block = parseBlocks(source)[0];
  assert.equal(block.type, 'heading');
  assert.equal(block.level, 1);
  assert.equal(block.style, 'setext');
  assert.equal(block.raw, source);
});

test('treats --- after a paragraph as setext but blank-preceded --- as hr', () => {
  const blocks = parseBlocks('alpha\n---\n\nbeta\n\n---');
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[2].type, 'paragraph');
  assert.equal(blocks[4].type, 'hr');
  assert.equal(serialize(blocks), 'alpha\n---\n\nbeta\n\n---');
});

test('parses top-level indented code blocks and preserves trailing blanks', () => {
  const source = '    first\n    second\n\nafter';
  const blocks = parseBlocks(source);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].style, 'indented');
  assert.equal(blocks[0].raw, '    first\n    second');
  assert.equal(blocks[1].type, 'blank');
  assert.equal(blocks[2].type, 'paragraph');
  assert.equal(serialize(blocks), source);
});

test('treats a top-level four-space list marker as code', () => {
  const blocks = parseBlocks('    - item');
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].style, 'indented');
});

test('does not treat list continuation indentation as indented code', () => {
  const blocks = parseBlocks('- parent\n    - child');
  assert.deepEqual(blocks.map(({ type }) => type), ['list', 'list']);
});

test('linkifies bare URLs without changing source text', () => {
  const source = 'see https://example.com/a. and mailto:team@example.com';
  const html = renderInline(source);
  assert.match(html, /<a href="https:\/\/example\.com\/a"/);
  assert.match(html, /<a href="mailto:team@example\.com"/);
  assert.equal(html.replace(/<[^>]+>/g, ''), source);
});

test('does not linkify inside code spans, link labels, or mid-word', () => {
  assert.doesNotMatch(renderInline('`https://example.com`'), /<a\b/);
  const linked = renderInline('[https://example.com](https://example.com)');
  assert.equal((linked.match(/<a\b/g) || []).length, 1);
  assert.doesNotMatch(renderInline('xhttps://example.com'), /<a\b/);
});

test('trims trailing URL punctuation and unmatched parentheses', () => {
  const html = renderInline('https://example.com/a).');
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.doesNotMatch(html, /href="https:\/\/example\.com\/a\)/);
});

test('stops bare URLs before fullwidth brackets', () => {
  for (const [source, before, after] of [['（https://example.com）', '（', '）'], ['「https://example.com」', '「', '」']]) {
    const html = renderInline(source);
    const anchor = /(<a\b[^>]*>)(.*?)<\/a>/.exec(html);
    assert.equal(/<a href="([^"]*)"/.exec(html)?.[1], 'https://example.com');
    assert.equal(anchor?.[2], 'https://example.com');
    assert.equal(html.slice(0, anchor.index), before);
    assert.equal(html.slice(anchor.index + anchor[0].length), after);
    assert.equal(html.replace(/<[^>]+>/g, ''), source);
  }
});

test('stops a bare URL at interior fullwidth punctuation', () => {
  const source = '见https://example.com/a，参考';
  const html = renderInline(source);
  const anchor = /(<a\b[^>]*>)(.*?)<\/a>/.exec(html);
  assert.equal(/<a href="([^"]*)"/.exec(html)?.[1], 'https://example.com/a');
  assert.equal(anchor?.[2], 'https://example.com/a');
  assert.equal(html.slice(anchor.index + anchor[0].length), '，参考');
  assert.equal(html.replace(/<[^>]+>/g, ''), source);
});

// --- v0.5 cross-block definitions ---

test('parses top-level footnote and link definitions as single-line blocks', () => {
  const source = 'para\n\n[^note]: Body text\n\n[repo]: https://example.com "Repo"\n';
  const blocks = parseBlocks(source);
  assert.deepEqual(blocks.map(({ type }) => ({ type })), [
    { type: 'paragraph' }, { type: 'blank' }, { type: 'footnoteDef' }, { type: 'blank' },
    { type: 'linkDef' }, { type: 'blank' }
  ]);
  assert.equal(blocks[2].raw, '[^note]: Body text');
  assert.equal(blocks[2].label, 'note');
  assert.equal(blocks[2].body, 'Body text');
  assert.equal(blocks[4].raw, '[repo]: https://example.com "Repo"');
  assert.equal(blocks[4].label, 'repo');
  assert.equal(blocks[4].url, 'https://example.com');
  assert.equal(blocks[4].title, 'Repo');
  assert.equal(serialize(blocks), source);
});

test('does not let a paragraph absorb a following definition line', () => {
  const blocks = parseBlocks('A\n[^x]: B\n[repo]: https://example.com\n');
  assert.deepEqual(blocks.map(({ type }) => type), ['paragraph', 'footnoteDef', 'linkDef', 'blank']);
  assert.equal(blocks[0].raw, 'A');
  assert.equal(blocks[1].body, 'B');
});

test('accepts an empty footnote body but needs a label and a link destination', () => {
  assert.equal(parseBlocks('[^a]:\n')[0].type, 'footnoteDef');
  assert.equal(parseBlocks('[^a]:\n')[0].body, '');
  assert.equal(parseBlocks('[^]: x\n')[0].type, 'paragraph');
  assert.equal(parseBlocks('[repo]:\n')[0].type, 'paragraph');
  assert.equal(parseBlocks('[repo]: https://example.com\nmore\ntext\n')[0].type, 'linkDef');
  assert.equal(parseBlocks('[repo]: https://example.com\nmore\ntext\n')[1].type, 'paragraph');
});

test('does not parse definitions nested in a list, quote or indented code', () => {
  assert.equal(parseBlocks('- [^a]: x\n')[0].type, 'list');
  assert.equal(parseBlocks('> [^a]: x\n')[0].type, 'quote');
  const indented = parseBlocks('\n    [^a]: x\n');
  assert.deepEqual(indented.map(({ type }) => type), ['blank', 'code', 'blank']);
});
