import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocContext, classify, escape, parseBlocks, renderInline, serialize } from './model.js';

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

test('a definition cannot interrupt an open paragraph or list item', () => {
  const paragraph = parseBlocks('A\n[^x]: B\n');
  assert.deepEqual(paragraph.map(({ type }) => type), ['paragraph', 'blank']);
  assert.equal(paragraph[0].raw, 'A\n[^x]: B');

  // Once the paragraph has swallowed one definition line it is still open, so the next joins it.
  const chained = parseBlocks('A\n[^x]: B\n[repo]: https://example.com\n');
  assert.deepEqual(chained.map(({ type }) => type), ['paragraph', 'blank']);
  assert.equal(chained[0].raw, 'A\n[^x]: B\n[repo]: https://example.com');
  assert.equal(buildDocContext(chained).links.size, 0);

  const list = parseBlocks('- item\n[^a]: x\n');
  assert.deepEqual(list.map(({ type }) => type), ['list', 'blank']);
  assert.equal(list[0].raw, '- item\n[^a]: x');

  for (const source of ['A\n[^x]: B\n', '- item\n[^a]: x\n', 'A\n[^x]: B\n[repo]: https://example.com\n']) {
    assert.equal(serialize(parseBlocks(source)), source);
  }
});

test('a definition after a heading, rule, quote, table, fence or HTML starts its own block', () => {
  const cases = [
    ['# 参考文献\n[^1]: 说明\n', ['heading', 'footnoteDef', 'blank']],
    ['---\n[^1]: 说明\n', ['hr', 'footnoteDef', 'blank']],
    ['> 引用\n[^1]: 说明\n', ['quote', 'footnoteDef', 'blank']],
    ['| a | b |\n| --- | --- |\n[^1]: 说明\n', ['table', 'footnoteDef', 'blank']],
    ['```js\ncode\n```\n[^1]: 说明\n', ['code', 'footnoteDef', 'blank']],
    ['<div>x</div>\n[^1]: 说明\n', ['html', 'footnoteDef', 'blank']],
  ];
  for (const [source, types] of cases) {
    const blocks = parseBlocks(source);
    assert.deepEqual(blocks.map(({ type }) => type), types, source);
    assert.equal(serialize(blocks), source);
  }
  assert.equal(buildDocContext(parseBlocks('正文[^1]\n\n# 参考文献\n[^1]: 说明\n')).footnotes.get('1').number, 1);
});

test('consecutive definitions each start their own block without a blank line', () => {
  const blocks = parseBlocks('[^a]: one\n[repo]: https://x.dev\n[^b]: two\n');
  assert.deepEqual(blocks.map(({ type }) => type), ['footnoteDef', 'linkDef', 'footnoteDef', 'blank']);
  assert.equal(serialize(blocks), '[^a]: one\n[repo]: https://x.dev\n[^b]: two\n');
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

test('numbers footnotes by first reference order and leaves unreferenced definitions unnumbered', () => {
  const blocks = parseBlocks('A[^b] B[^a]\n\n[^a]: one\n[^b]: two\n[^c]: three\n');
  const ctx = buildDocContext(blocks);
  const defA = blocks.find((b) => b.type === 'footnoteDef' && b.label === 'a');
  const para = blocks.find((b) => b.type === 'paragraph');
  assert.equal(ctx.footnotes.get('b').number, 1);
  assert.equal(ctx.footnotes.get('a').number, 2);
  assert.equal(ctx.footnotes.get('c').number, 0);
  assert.equal(ctx.footnotes.get('a').blockId, defA.id);
  assert.equal(ctx.footnotes.get('a').refBlockId, para.id);
  assert.equal(ctx.footnotes.get('c').refBlockId, null);
  assert.deepEqual([...ctx.order], ['b', 'a']);
});

test('matches footnote labels case-insensitively and skips references inside inline code', () => {
  const ctx = buildDocContext(parseBlocks('Use `[^a]` here and [^ABC] there\n\n[^abc]: note\n'));
  assert.equal(ctx.footnotes.get('abc').number, 1);
  assert.equal(ctx.footnotes.get('abc').label, 'abc');
});

test('does not number an escaped footnote reference', () => {
  const ctx = buildDocContext(parseBlocks('Literal \\[^a] here and [^b] there\n\n[^a]: one\n[^b]: two\n'));
  assert.equal(ctx.footnotes.get('a').number, 0);
  assert.equal(ctx.footnotes.get('a').refBlockId, null);
  assert.equal(ctx.footnotes.get('b').number, 1);
});

test('skips references inside fenced code and other container blocks', () => {
  const blocks = parseBlocks('Real [^a] ref\n\n```md\nfenced [^b]\n```\n\n[^a]: one\n[^b]: two\n');
  const ctx = buildDocContext(blocks);
  assert.equal(ctx.footnotes.get('a').number, 1);
  assert.equal(ctx.footnotes.get('b').number, 0);
  assert.equal(ctx.footnotes.get('b').refBlockId, null);
});

test('first definition wins and later duplicates are reported instead of hidden', () => {
  const blocks = parseBlocks('Text[^a]\n\n[^a]: first\n[^a]: second\n\n[repo]: https://a.example\n[repo]: https://b.example\n');
  const ctx = buildDocContext(blocks);
  assert.equal(ctx.footnotes.get('a').blockId, blocks.filter((b) => b.type === 'footnoteDef')[0].id);
  assert.equal(ctx.footnotes.get('a').body, 'first');
  assert.deepEqual([...ctx.duplicateFootnotes], ['a']);
  assert.deepEqual([...ctx.duplicateLinks], ['repo']);
  assert.equal(ctx.links.get('repo').url, 'https://a.example');
  assert.equal(ctx.links.get('repo').blockId, blocks.filter((b) => b.type === 'linkDef')[0].id);
});

test('collects link reference definitions with their optional title', () => {
  const ctx = buildDocContext(parseBlocks('[repo]: https://example.com "Repo title"\n[docs]: https://d.example\n'));
  assert.equal(ctx.links.get('repo').url, 'https://example.com');
  assert.equal(ctx.links.get('repo').title, 'Repo title');
  assert.equal(ctx.links.get('docs').title, undefined);
});

test('exposes definition and reference block ids by footnote number', () => {
  const blocks = parseBlocks('甲[^a] 乙[^b]\n\n[^a]: 一\n[^b]: 二\n[^c]: 三\n');
  const ctx = buildDocContext(blocks);
  const defA = blocks.find((b) => b.type === 'footnoteDef' && b.label === 'a');
  const defC = blocks.find((b) => b.type === 'footnoteDef' && b.label === 'c');
  const para = blocks.find((b) => b.type === 'paragraph');
  assert.equal(ctx.defNumbers.get(defA.id), 1);
  assert.equal(ctx.defNumbers.get(defC.id), undefined);
  assert.deepEqual(ctx.byNumber.get(1), { defBlockId: defA.id, refBlockId: para.id });
  assert.deepEqual([...ctx.byNumber.keys()], [1, 2]);
});

test('renders a footnote reference as an anchor whose number is generated, keeping DOM text equal to source', () => {
  const blocks = parseBlocks('See [^note] here\n\n[^note]: Body\n');
  const html = renderInline(blocks[0].raw, buildDocContext(blocks));
  assert.match(html, /<sup class="fn-ref"><a href="#ink-fn-1" data-fn="1"[^>]*><\/a><\/sup>/);
  assert.ok(html.includes('<span class="syntax">[^note]<\/span>'));
  assert.equal(html.replace(/<[^>]+>/g, ''), 'See [^note] here');
});

test('repeated references to one footnote reuse its number', () => {
  const blocks = parseBlocks('[^a] again [^a]\n\n[^a]: Body\n');
  const html = renderInline(blocks[0].raw, buildDocContext(blocks));
  assert.equal((html.match(/href="#ink-fn-1"/g) || []).length, 2);
  assert.ok(!html.includes('#ink-fn-2'));
});

test('leaves unpaired, escaped and empty footnote references as plain text', () => {
  const blocks = parseBlocks('Undef [^nope], escaped \\[^a], and [^a] real\n\n[^a]: Body\n');
  const html = renderInline(blocks[0].raw, buildDocContext(blocks));
  assert.equal((html.match(/<sup\b/g) || []).length, 1);
  assert.ok(html.includes('[^nope]'));
  assert.ok(!html.includes('<a href="#ink-fn-2'));
});

test('resolves link references through the document context', () => {
  const blocks = parseBlocks('Read [the repo][repo] now\n\n[repo]: https://example.com "Repo title"\n');
  const html = renderInline(blocks[0].raw, buildDocContext(blocks));
  assert.match(html, /<a href="https:\/\/example\.com" title="Repo title" target="_blank" rel="noopener noreferrer">the repo<\/a>/);
  assert.ok(html.includes('<span class="syntax">][repo]<\/span>'));
  assert.equal(html.replace(/<\/?(?:span|a|sup)\b[^>]*>/g, ''), 'Read [the repo][repo] now');
});

test('does not turn a link reference into an anchor when the target is unsafe or undefined', () => {
  const blocks = parseBlocks('Bad [x][evil] and missing [y][gone]\n\n[evil]: javascript:alert(1)\n');
  const html = renderInline(blocks[0].raw, buildDocContext(blocks));
  assert.ok(!html.includes('<a href="javascript:'));
  assert.equal((html.match(/<a /g) || []).length, 0);
  assert.equal(html.replace(/<\/?span\b[^>]*>/g, ''), 'Bad [x][evil] and missing [y][gone]');
});

test('renders nothing new when no document context is supplied', () => {
  assert.equal(renderInline('See [^a] and [x][repo]'), renderInline('See [^a] and [x][repo]', null));
  assert.ok(!renderInline('[^a]').includes('<sup>'));
});

test('does not number references inside multi-backtick spans or inline math', () => {
  const source = 'A ``[^a]`` B $[^b]$ C \\(x [^c] y\\) D [^d]\n\n[^a]: one\n[^b]: two\n[^c]: three\n[^d]: four\n';
  const ctx = buildDocContext(parseBlocks(source));
  assert.equal(ctx.footnotes.get('a').number, 0);
  assert.equal(ctx.footnotes.get('b').number, 0);
  assert.equal(ctx.footnotes.get('c').number, 0);
  assert.equal(ctx.footnotes.get('d').number, 1);
  assert.deepEqual([...ctx.order], ['d']);
});

test('never nests an anchor when a footnote reference appears inside link brackets', () => {
  const blocks = parseBlocks('See [a [^b] c](https://x.dev)\n\n[^b]: note\n');
  const html = renderInline(blocks[0].raw, buildDocContext(blocks));
  assert.match(html, /<sup class="fn-ref"><a href="#ink-fn-1"/);
  assert.ok(!/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/.test(html), html);
});

test('numbers a reference made inside another footnote definition body', () => {
  const blocks = parseBlocks('A[^a]\n\n[^a]: 见 [^b]\n[^b]: 另一条\n');
  const ctx = buildDocContext(blocks);
  assert.equal(ctx.footnotes.get('a').number, 1);
  assert.equal(ctx.footnotes.get('b').number, 2);
  assert.match(renderInline('见 [^b]', ctx), /href="#ink-fn-2"/);
});

test('numbers a reference only where a render path can turn it into an anchor', () => {
  const number = (line) => buildDocContext(parseBlocks(`${line}\n\n[^a]: 说明\n`)).footnotes.get('a').number;
  // Neither path anchors these: an HTML comment, a tag attribute, an autolink target, a bare URL, a tight destination.
  assert.equal(number(String.raw`A <!-- [^a] --> B`), 0);
  assert.equal(number(String.raw`x <a href="p[^a]q">y</a>`), 0);
  assert.equal(number(String.raw`<https://e.com/x[^a]y> z`), 0);
  assert.equal(number(String.raw`见 https://e.com/q[^a]r 说明`), 0);
  assert.equal(number(String.raw`y [x](https://e.com/q[^a]r) z`), 0);
  // These do anchor, so they must keep a number: comparison text, inline HTML around the ref,
  // a destination with spaces (not a link at all), escaped brackets with spaces (not display math).
  assert.equal(number(String.raw`a < b [^a] > d`), 1);
  assert.equal(number(String.raw`<b>[^a]</b> 说明`), 1);
  assert.equal(number(String.raw`y [x](foo [^a] bar) z`), 1);
  assert.equal(number(String.raw`pre \[ [^a] \] x`), 1);
});

test('a definition does not number a reference to itself', () => {
  const ctx = buildDocContext(parseBlocks('[^a]: see [^a]\n'));
  assert.equal(ctx.footnotes.get('a').number, 0);
  assert.deepEqual([...ctx.order], []);
});

test('does not number references inside a link destination, angle target or display math', () => {
  const source = 'See [x](https://e.com/[^a]) and $$y [^b] z$$ and <https://e.com/[^c]> plus [^d]\n\n[^a]: 1\n[^b]: 2\n[^c]: 3\n[^d]: 4\n';
  const ctx = buildDocContext(parseBlocks(source));
  assert.equal(ctx.footnotes.get('a').number, 0);
  assert.equal(ctx.footnotes.get('b').number, 0);
  assert.equal(ctx.footnotes.get('c').number, 0);
  assert.equal(ctx.footnotes.get('d').number, 1);
  // Angle brackets with spaces inside are comparison text, not a target, so the ref still counts.
  const spaced = buildDocContext(parseBlocks('a < b [^d] > c\n\n[^d]: 1\n'));
  assert.equal(spaced.footnotes.get('d').number, 1);
});

test('carries a link definition title onto the resolved anchor', () => {
  const blocks = parseBlocks('读 [文档][docs]\n\n[docs]: https://example.com/docs "官方文档"\n');
  const html = renderInline(blocks[0].raw, buildDocContext(blocks));
  assert.match(html, /<a href="https:\/\/example\.com\/docs" title="官方文档" target="_blank" rel="noopener noreferrer">文档<\/a>/);
});

test('leaves the anchor without a title when the definition has none', () => {
  const blocks = parseBlocks('读 [文档][docs]\n\n[docs]: https://example.com/docs\n');
  const html = renderInline(blocks[0].raw, buildDocContext(blocks));
  assert.ok(!html.includes('title='), html);
});
