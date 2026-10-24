import { isAndroid, nativeFile, installMobileUI, compactViewport } from './mobile.js';
import { parseBlocks, serialize, renderInline } from './model.js';
import { previewMarkdown, needsPreview } from './vendor/renderer.js';

const $ = (id) => document.getElementById(id);
const editor = $('editor');
const source = $('source');
const desktop = window.desktop;
const STORAGE = desktop ? 'inkstone.desktop.draft.v03' : 'inkstone.draft.v03';
let desktopReady = false;
let desktopBusy = false;
let desktopPath = null;
const SAMPLE = "# 让文字，也让公式成形\n\n这里是 **墨页 v0.4**。继续安静地写，也让更复杂的 Markdown 得到妥帖呈现。\n\n## 把信息，整理成表格\n\n| 语法 | 这次的变化 | 状态 |\n| :--- | :--- | :---: |\n| 表格与分割线 | 对齐、行内格式、转义竖线 | 已支持 |\n| 列表与任务 | 多级缩进、续行、退级 | 已支持 |\n| HTML 与公式 | 安全预览、本地数学排版 | 已支持 |\n\n点击表格可编辑原文，移开光标后恢复预览。Tab / Shift+Tab 在表格单元格之间移动。\n\n---\n\n## 从一行公式，到一个想法\n\n行内公式 $E = mc^2$，也可以自然地写在句子中。\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n## 给思路，多一点层次\n\n- 一个大方向\n  - 拆成可以行动的小步\n    - 再留意其中的细节\n- [x] 用 Tab 缩进，Shift+Tab 退级\n- [ ] 空列表项按 Enter，逐级退回正文\n\n## 原样表达，也自由排版\n\n转义字符：\\*这不是斜体\\*，\\# 这不是标题，AT&amp;T。\n\n<details>\n<summary>一小段安全的 HTML</summary>\n<p>支持 <mark>高亮</mark>、<kbd>键帽</kbd>、<sup>上标</sup> 等常用排版。脚本、表单、样式和嵌入内容不会执行。</p>\n</details>\n\n> 复杂的语法，依然可以拥有简单的写作体验。\n\n草稿只保存在当前浏览器、当前网址。Ctrl / ⌘ + S 下载 Markdown；原来的 v0.2 网站与草稿不受影响。\n"
  .replace('这里是 **墨页 v0.4**。', desktop ? '这里是 **墨页 Windows v0.4**。' : isAndroid ? '这里是 **墨页 Android 适配预览**。' : '这里是 **墨页 v0.4**。')
  .replace('草稿只保存在当前浏览器、当前网址。Ctrl / ⌘ + S 下载 Markdown；原来的 v0.2 网站与草稿不受影响。', desktop ? '文字留在你的电脑。Ctrl+O 打开本地文档，Ctrl+S 保存到原文件，Ctrl+Shift+S 另存为。尚未保存的内容会自动保留恢复草稿；关闭窗口时会询问是否保存。' : isAndroid ? '文字留在此设备。点「导入」打开 Markdown，点「导出 .md」通过系统文件选择器保存新文件。草稿在应用内自动保留；请定期导出备份。' : '草稿只保存在当前浏览器、当前网址。Ctrl / ⌘ + S 下载 Markdown；原来的 v0.2 网站与草稿不受影响。');
let blocks = [];
let activeId = null;
let composing = false;
let compositionTimer;
let mobileBusy = false;
let sourceMode = false;
let filename = '初见.md';
let savedText = SAMPLE;
let history = [];
let future = [];
let lastEdit = 0;
let lastKind = '';
let beforeSelection = null;
let renderTimer;
let persistTimer;
let toastTimer;
let currentText = SAMPLE;
let draftAvailable = true;
let findMatches = [];
let findIndex = -1;
let findSignature = '';
let namingNew = false;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function text() { return serialize(blocks); }
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2500);
}
function readBlock(node) {
  // Generated nodes contain only text/spans. Native BRs are normalized for fallback input paths.
  if (node.childNodes.length === 1 && node.firstChild.nodeName === 'BR') return '';
  const walk = (n) => n.nodeType === Node.ELEMENT_NODE && n.classList.contains('block-preview') ? '' : n.nodeType === Node.TEXT_NODE ? n.data : n.nodeName === 'BR' ? '\n' : [...n.childNodes].map(walk).join('');
  return walk(node);
}
function point(node, offset) {
  if (!node || !editor.contains(node)) return null;
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const block = el.closest('.block');
  if (!block) {
    if (node === editor) return offset === 0 ? 0 : text().length;
    return null;
  }
  if (el.closest('.block-preview')) return null;
  const index = blocks.findIndex((b) => b.id === block.dataset.id);
  if (index < 0) return null;
  const range = document.createRange();
  range.selectNodeContents(block);
  try { range.setEnd(node, offset); } catch { return null; }
  const prior = [...editor.children].slice(0, index).reduce((n, b) => n + readBlock(b).length + 1, 0);
  return prior + range.toString().length;
}
function selection() {
  if (sourceMode) return { a: source.selectionStart, f: source.selectionEnd };
  const s = window.getSelection();
  const a = point(s?.anchorNode, s?.anchorOffset);
  const f = point(s?.focusNode, s?.focusOffset);
  return a === null || f === null ? null : { a, f };
}
function locate(position) {
  let n = Math.max(0, Math.min(position, text().length));
  for (let i = 0; i < blocks.length; i++) {
    if (n <= blocks[i].raw.length || i === blocks.length - 1) return { block: blocks[i], offset: Math.min(n, blocks[i].raw.length), index: i };
    n -= blocks[i].raw.length + 1;
  }
  return { block: blocks[0], offset: 0, index: 0 };
}
function domPoint(pos) {
  const { block, offset } = locate(pos);
  const el = [...editor.children].find((n) => n.dataset.id === block.id);
  let remaining = offset;
  const walker = document.createTreeWalker(el.querySelector('.block-source') || el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (remaining <= node.length) return [node, remaining];
    remaining -= node.length;
  }
  return [el, el.childNodes.length];
}
function restore(sel, focus = true) {
  if (!sel) return;
  if (sourceMode) {
    if (focus) source.focus();
    source.setSelectionRange(sel.a, sel.f);
    return;
  }
  activeId = locate(sel.f).block.id;
  updateActive();
  if (focus) editor.focus({ preventScroll: true });
  const s = window.getSelection();
  const [a, ao] = domPoint(sel.a);
  const [f, fo] = domPoint(sel.f);
  s.setBaseAndExtent(a, ao, f, fo);
}
function headingParts(block) {
  if (block.style === 'setext') {
    const lines = block.raw.split('\n');
    const underline = lines.pop() ?? '';
    return { content: lines.join('\n'), prefix: null, suffix: null, underline };
  }
  const prefix = block.raw.match(/^ {0,3}#{1,6}(?:[ \t]+|$)/)?.[0] || '';
  const rest = block.raw.slice(prefix.length);
  const suffix = rest.match(/[ \t]+#+[ \t]*$/)?.[0] || null;
  return { content: suffix ? rest.slice(0, -suffix.length) : rest, prefix, suffix, underline: null };
}

function headingLabel(block) {
  const { content } = headingParts(block);
  return content.replace(/\n/g, ' ').replace(/[*_`~]/g, '').trim() || '未命名标题';
}

function decorate(block) {
  const raw = block.raw;
  if (needsPreview(block)) {
    let previewRaw = raw, checkbox = '';
    if (block.type === 'list') {
      const task = raw.match(/^(\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]\s/);
      previewRaw = raw.replace(/^\s*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '');
      if (task) checkbox = `<button class="task-box" contenteditable="false" tabindex="0" role="checkbox" aria-checked="${task[2].toLowerCase() === 'x'}" aria-label="切换任务完成状态" data-task="${block.id}"></button>`;
    }
    if (block.type === 'heading') previewRaw = headingParts(block).content;
    if (block.type === 'quote') previewRaw = raw.replace(/^ {0,3}>[ \t]?/gm, '');
    const highlight = !(block.type === 'code' && block.id === activeId);
    return `${checkbox}<span class="block-source">${esc(raw)}</span><div class="block-preview task-body" contenteditable="false">${previewMarkdown(previewRaw, block.type, { highlight })}</div>`;
  }
  if (block.type === 'heading') {
    const { content, prefix, suffix, underline } = headingParts(block);
    return (prefix ? `<span class="syntax">${esc(prefix)}</span>` : '') +
      renderInline(content) +
      (suffix ? `<span class="syntax">${esc(suffix)}</span>` : '') +
      (underline !== null ? `<span class="syntax setext-underline">\n${esc(underline)}</span>` : '');
  }
  let prefix = '';
  if (block.type === 'list') prefix = raw.match(/^\s*(?:[-+*]|\d+[.)])[ \t]+/)?.[0] || '';
  if (block.type === 'quote') prefix = raw.match(/^ {0,3}> ?/)?.[0] || '';
  const task = block.type === 'list' && raw.match(/^(\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]\s/);
  if (task) {
    prefix = task[0];
    const checked = task[2].toLowerCase() === 'x';
    return `<button class="task-box" contenteditable="false" tabindex="0" role="checkbox" aria-checked="${checked}" aria-label="切换任务完成状态" data-task="${block.id}"></button><span class="syntax">${esc(prefix)}</span><span class="task-body">${renderInline(raw.slice(prefix.length))}</span>`;
  }
  return (prefix ? `<span class="syntax">${esc(prefix)}</span>` : '') + renderInline(raw.slice(prefix.length));
}
function render(sel = null) {
  const existing = new Map([...editor.children].map((n) => [n.dataset.id, n]));
  const kept = new Set();
  blocks.forEach((block, index) => {
    let node = existing.get(block.id);
    if (!node) { node = document.createElement('div'); node.dataset.id = block.id; }
    kept.add(node);
    const key = block.type + ':' + block.raw;
    if (node._key !== key) {
      node.innerHTML = block.raw ? decorate(block) : '<br>';
      node._key = key;
      node._stale = block.type === 'code' && block.id === activeId;
    }
    node.className = `block ${block.type}${needsPreview(block) ? ' rich-block' : ''}${block.id === activeId ? ' active' : ''}`;
    const indent = block.raw.match(/^[ \t]*/)[0].replaceAll('\t', '    ').length;
    node.style.setProperty('--indent', `${Math.min(indent / 2, 16) * 22}px`);
    const task = block.type === 'list' && /^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s/.test(block.raw);
    node.classList.toggle('task', Boolean(task));
    node.classList.toggle('done', Boolean(task && /^\s*(?:[-+*]|\d+[.)])\s+\[[xX]\]/.test(block.raw)));
    node.dataset.level = block.level || '';
    const number = block.raw.match(/^\s*(\d+)[.)]\s/);
    node.dataset.ordered = String(Boolean(number));
    node.dataset.number = number?.[1] || '';
    if (editor.children[index] !== node) editor.insertBefore(node, editor.children[index] || null);
  });
  [...editor.children].forEach((n) => { if (!kept.has(n)) n.remove(); });
  updateUI();
  if (sel) restore(sel);
}
let lastActiveId = null;

function refreshCodePreview(id) {
  const node = [...editor.children].find((candidate) => candidate.dataset.id === id);
  const block = blocks.find((candidate) => candidate.id === id);
  if (!node || !block || block.type !== 'code' || !node._stale) return;
  node.innerHTML = decorate(block);
  node._key = block.type + ':' + block.raw;
  node._stale = false;
}

function updateActive() {
  const previous = lastActiveId;
  [...editor.children].forEach((el) => el.classList.toggle('active', el.dataset.id === activeId));
  [...$('outline').children].forEach((el) => el.classList.toggle('active', el.dataset.id === activeId));
  if (previous && previous !== activeId) refreshCodePreview(previous);
  lastActiveId = activeId;
}
function updateUI() {
  const value = text();
  $('filename').textContent = filename;
  $('dirty').textContent = value === savedText ? '' : '•';
  document.title = `${value === savedText ? '' : '● '}${filename} · 墨页`;
  if (desktop && desktopReady) desktop.syncState(desktopSnapshot());
  if (desktop) $('rename').title = desktopPath || '另存为新名称';
  $('undo').disabled = !history.length;
  $('redo').disabled = !future.length;
  $('readtime').textContent = `约 ${Math.max(1, Math.ceil(value.replace(/\s/g, '').length / 400))} 分钟`;
  refreshFind();
  $('wordcount').textContent = `${value.replace(/\s/g, '').length.toLocaleString()} 字符`;
  $('blockcount').textContent = `${blocks.filter((b) => b.type !== 'blank').length} 块`;
  const outline = $('outline');
  outline.replaceChildren();
  blocks.filter((b) => b.type === 'heading').forEach((b) => {
    const button = document.createElement('button');
    button.textContent = headingLabel(b);
    button.dataset.id = b.id;
    button.style.paddingLeft = `${11 + Math.min((b.level || 1) - 1, 3) * 11}px`;
    button.classList.toggle('active', b.id === activeId);
    button.addEventListener('click', () => {
      const position = blocks.slice(0, blocks.indexOf(b)).reduce((n, x) => n + x.raw.length + 1, 0);
      if (sourceMode) { source.focus(); source.setSelectionRange(position, position); }
      else { restore({ a: position, f: position }); [...editor.children].find((n) => n.dataset.id === b.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
    outline.append(button);
  });
  if (!outline.children.length) { const p = document.createElement('span'); p.className = 'empty'; p.textContent = '输入 # 标题，\n为想法建立脉络。'; outline.append(p); }
}
function remember(sel, kind = 'command') {
  const now = Date.now();
  if (kind !== 'typing' || lastKind !== kind || now - lastEdit > 750) {
    history.push({ text: currentText, sel: sel || { a: 0, f: 0 } });
    if (history.length > 150) history.shift();
  }
  lastKind = kind;
  lastEdit = now;
  future = [];
}
function persist() {
  if (desktop) {
    if (desktopReady) desktop.syncState(desktopSnapshot());
    $('status').textContent = text() === savedText ? (desktopPath ? '已保存到本地文件' : '本地草稿 · 尚未选择文件') : '修改未保存 · 请用 Ctrl+S 保存文件';
    return;
  }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ text: text(), filename, savedText }));
      $('status').textContent = isAndroid ? '草稿已保存在此设备' : '草稿已存于此浏览器';
    } catch { draftAvailable = false; $('status').textContent = '浏览器草稿不可用，请保存 .md'; }
  }, 250);
}
function apply(value, sel, kind = 'command', addHistory = true) {
  clearTimeout(renderTimer);
  if (addHistory && value !== currentText) remember(selection() || beforeSelection, kind);
  blocks = parseBlocks(value, blocks);
  currentText = text();
  if (sourceMode) { source.value = currentText; resizeSource(); updateUI(); if (sel) restore(sel); }
  else render(sel);
  persist();
}
function replace(start, end, value, cursor = start + value.length, kind = 'command') {
  const old = text();
  apply(old.slice(0, start) + value + old.slice(end), { a: cursor, f: cursor }, kind);
}
function range() {
  const sel = selection() || beforeSelection || { a: text().length, f: text().length };
  return { ...sel, start: Math.min(sel.a, sel.f), end: Math.max(sel.a, sel.f) };
}
function undo(redo = false) {
  const from = redo ? future : history;
  const to = redo ? history : future;
  const previous = from.pop();
  if (!previous) return;
  to.push({ text: text(), sel: selection() || { a: 0, f: 0 } });
  lastKind = '';
  apply(previous.text, previous.sel, 'history', false);
}
function format(command) {
  if (composing) return;
  if (command === 'indent' || command === 'outdent') return indentSelection(command === 'outdent');
  const s = range();
  const value = text();
  // H1/H2 inside a Setext heading replace only the underline. The caret and
  // selection stay in the heading content so typing cannot strand the markers.
  if (command === 'h1' || command === 'h2') {
    const from = locate(s.start);
    const to = locate(s.end);
    if (from.index === to.index && from.block.style === 'setext' && to.block.style === 'setext') {
      const blockStart = s.start - from.offset;
      const lines = from.block.raw.split('\n');
      const last = lines.length - 1;
      const mark = command === 'h1' ? '=' : '-';
      lines[last] = lines[last].replace(/^(\s*)(=+|-+)(\s*)$/, (_, lead, marks, trail) => lead + mark.repeat(marks.length) + trail);
      const raw = lines.join('\n');
      apply(value.slice(0, blockStart) + raw + value.slice(blockStart + from.block.raw.length), { a: s.start, f: s.end });
      return;
    }
  }
  if (['table','hr','math','html'].includes(command)) {
    const snippets = { table: '| 列一 | 列二 |\n| :--- | ---: |\n| 内容 | 内容 |', hr: '***', math: '$$\nE = mc^2\n$$', html: '<details>\n<summary>展开内容</summary>\n<p>在这里写内容</p>\n</details>' };
    const lead = s.start && value[s.start - 1] !== '\n' ? '\n\n' : '';
    const snippet = lead + snippets[command] + '\n\n';
    const cursor = s.start + lead.length + (command === 'math' ? 3 : 0);
    apply(value.slice(0, s.start) + snippet + value.slice(s.end), { a: cursor, f: cursor });
    toast('已插入' + ({table:'表格',hr:'分割线',math:'公式',html:'HTML'})[command] + '，离开当前块查看预览');
    return;
  }
  if (command === 'link') {
    const label = value.slice(s.start, s.end) || '链接文字';
    const snippet = `[${label}](https://example.com)`;
    apply(value.slice(0, s.start) + snippet + value.slice(s.end), { a: s.start + label.length + 3, f: s.start + snippet.length - 1 });
    toast('已插入链接，请替换选中的网址');
    return;
  }
  if (['bold', 'italic', 'strike'].includes(command)) {
    const marker = command === 'bold' ? '**' : command === 'strike' ? '~~' : '*';
    const selected = value.slice(s.start, s.end);
    if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2) {
      const clean = selected.slice(marker.length, -marker.length);
      apply(value.slice(0, s.start) + clean + value.slice(s.end), { a: s.start, f: s.start + clean.length });
    } else if (value.slice(s.start - marker.length, s.start) === marker && value.slice(s.end, s.end + marker.length) === marker) {
      apply(value.slice(0, s.start - marker.length) + selected + value.slice(s.end + marker.length), { a: s.start - marker.length, f: s.end - marker.length });
    } else {
      const body = selected || (command === 'bold' ? '粗体文字' : command === 'strike' ? '删除文字' : '斜体文字');
      apply(value.slice(0, s.start) + marker + body + marker + value.slice(s.end), { a: s.start + marker.length, f: s.start + marker.length + body.length });
    }
    return;
  }
  if (command === 'code') {
    const body = value.slice(s.start, s.end) || '在这里写代码';
    const prefix = s.start && value[s.start - 1] !== '\n' ? '\n\n' : '';
    const snippet = prefix + '```\n' + body + '\n```\n';
    apply(value.slice(0, s.start) + snippet + value.slice(s.end), { a: s.start + prefix.length + 4, f: s.start + prefix.length + 4 + body.length });
    return;
  }
  const start = value.lastIndexOf('\n', s.start - 1) + 1;
  let end = value.indexOf('\n', s.end);
  if (end < 0) end = value.length;
  const prefixes = { h1: '# ', h2: '## ', list: '- ', ordered: '1. ', quote: '> ', task: '- [ ] ' };
  const prefix = prefixes[command];
  if (!prefix) return;
  const body = value.slice(start, end).split('\n').map((line) => prefix + line.replace(/^ {0,3}(?:#{1,6}\s+|> ?|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')).join('\n');
  apply(value.slice(0, start) + body + value.slice(end), { a: start + body.length, f: start + body.length });
}
function enter(soft = false) {
  const s = range();
  const { block, offset } = locate(s.start);
  if (!soft && s.start === s.end && block.style === 'setext') {
    const underline = block.raw.split('\n').pop() ?? '';
    const contentLength = block.raw.length - underline.length - 1;
    if (offset >= contentLength) {
      const after = s.start - offset + block.raw.length;
      replace(after, after, '\n\n');
      return;
    }
  }
  if (['code','math','html'].includes(block.type) || soft) { replace(s.start, s.end, '\n'); return; }
  const value = text();
  const lineStart = value.lastIndexOf('\n', s.start - 1) + 1;
  const line = value.slice(lineStart, s.start);
  if (block.type === 'table') {
    const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length;
    replace(s.start, s.end, '\n| ' + Array(Math.max(1, cells)).fill(' ').join(' | ') + ' |');
    return;
  }
  const task = line.match(/^(\s*(?:[-+*]|\d+[.)])\s+)\[[ xX]\]\s(.*)$/);
  if (task && block.type === 'list') {
    if (!task[2].trim()) {
      const indent = task[1].match(/^\s*/)[0];
      replace(lineStart, s.end, indent.length ? line.slice(Math.min(2, indent.length)) : '');
    } else {
      const prefix = task[1].replace(/(\d+)([.)])/, (_, n, mark) => `${Number(n) + 1}${mark}`);
      replace(s.start, s.end, `\n${prefix}[ ] `);
    }
    return;
  }
  const match = line.match(/^(\s*)([-+*]|\d+[.)]|>)\s?(.*)$/);
  if (match && ['list', 'quote'].includes(block.type)) {
    if (!match[3].trim()) { replace(lineStart, s.end, match[1].length ? line.slice(Math.min(2, match[1].length)) : ''); return; }
    let prefix = match[2];
    if (/^\d/.test(prefix)) prefix = `${parseInt(prefix, 10) + 1}${prefix.slice(-1)}`;
    replace(s.start, s.end, `\n${match[1]}${prefix} `);
  } else replace(s.start, s.end, '\n\n');
}
function resizeSource() { source.style.height = 'auto'; source.style.height = `${Math.max(source.scrollHeight, 350)}px`; }

editor.addEventListener('beforeinput', (event) => {
  beforeSelection = selection();
  if (composing || event.isComposing) return;
  const s = range();
  if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') { event.preventDefault(); enter(event.inputType === 'insertLineBreak'); }
  else if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') { event.preventDefault(); undo(event.inputType === 'historyRedo'); }
  else if (s.start !== s.end && ['insertText', 'deleteContentBackward', 'deleteContentForward', 'deleteByCut'].includes(event.inputType)) {
    event.preventDefault(); replace(s.start, s.end, event.inputType === 'insertText' ? event.data || '' : '', undefined, 'typing');
  } else if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
    const p = locate(s.start);
    if ((event.inputType === 'deleteContentBackward' && p.offset === 0 && s.start > 0) || (event.inputType === 'deleteContentForward' && p.offset === p.block.raw.length && s.start < text().length)) {
      event.preventDefault();
      const backward = event.inputType === 'deleteContentBackward';
      replace(backward ? s.start - 1 : s.start, backward ? s.start : s.start + 1, '', undefined, 'typing');
    }
  }
});
function storeDOM() {
  const sel = selection();
  const raw = [...editor.children].map(readBlock).join('\n');
  if (raw !== currentText) {
    remember(beforeSelection || sel, 'typing');
    blocks = parseBlocks(raw, blocks);
    currentText = text();
  }
  if (sel) activeId = locate(sel.f).block.id;
  render(sel);
  persist();
}
editor.addEventListener('input', (event) => {
  if (composing || event.isComposing) return;
  // Commit model synchronously; patch only changed keyed blocks and restore logical offsets.
  storeDOM();
});
editor.addEventListener('compositionstart', () => { clearTimeout(compositionTimer); composing = true; beforeSelection = selection(); clearTimeout(renderTimer); });
editor.addEventListener('compositionend', () => {
  // Android IMEs may emit a final input *after* compositionend. Keep their
  // native DOM intact through that event, then commit once in the next task.
  clearTimeout(compositionTimer);
  compositionTimer = setTimeout(() => { composing = false; storeDOM(); }, 0);
});
editor.addEventListener('paste', (event) => {
  if (composing) return;
  event.preventDefault();
  const s = range();
  replace(s.start, s.end, event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
});
editor.addEventListener('cut', (event) => {
  const s = range();
  if (s.start === s.end || composing) return;
  event.preventDefault(); event.clipboardData.setData('text/plain', text().slice(s.start, s.end)); replace(s.start, s.end, '');
});
editor.addEventListener('copy', (event) => {
  const s = range();
  if (s.start !== s.end) { event.preventDefault(); event.clipboardData.setData('text/plain', text().slice(s.start, s.end)); }
});
editor.addEventListener('drop', (event) => { event.preventDefault(); toast('请用「打开」导入 Markdown，或粘贴纯文本。'); });
function indentSelection(outdent = false) {
    const s = range(), value = text(), p = locate(s.start);
    if (p.block.type === 'table') {
      const direction = outdent ? -1 : 1;
      let at = direction > 0 ? value.indexOf('|', s.end + 1) : value.lastIndexOf('|', s.start - 2);
      while (at >= 0 && value[at - 1] === '\\') at = direction > 0 ? value.indexOf('|', at + 1) : value.lastIndexOf('|', at - 1);
      const blockStart = s.start - p.offset;
      if (at >= blockStart && at < blockStart + p.block.raw.length) restore({ a: at + 1, f: at + 1 });
      return;
    }
    const start = value.lastIndexOf('\n', s.start - 1) + 1;
    let end = value.indexOf('\n', Math.max(s.start, s.end - 1)); if (end < 0) end = value.length;
    if (p.block.type === 'list' || s.start !== s.end) {
      const lines = value.slice(start, end).split('\n');
      const deltas = lines.map(line => outdent ? -(line.match(/^(?: {1,2}|\t)/)?.[0].length || 0) : 2);
      const body = lines.map((line, i) => deltas[i] < 0 ? line.slice(-deltas[i]) : ' '.repeat(deltas[i]) + line).join('\n');
      const shiftA = deltas[0], shiftF = deltas.reduce((a,b) => a+b,0);
      apply(value.slice(0, start) + body + value.slice(end), { a: Math.max(start, s.start + shiftA), f: Math.max(start, s.end + shiftF) });
    } else if (!outdent) replace(s.start, s.end, '  ');
}
editor.addEventListener('keydown', (event) => {
  if (composing || event.isComposing || event.keyCode === 229) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    restore({ a: 0, f: text().length });
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    indentSelection(event.shiftKey);
  }
  if (event.key === 'ArrowDown') {
    const s = range(); const p = locate(s.f);
    if (p.block.type === 'code' && p.offset === p.block.raw.length) {
      const next = blocks[p.index + 1];
      if (!next) { event.preventDefault(); replace(text().length, text().length, '\n\n'); }
      else { event.preventDefault(); const pos = s.f + 1; restore({ a: pos, f: pos }); }
    }
  }
});
document.addEventListener('selectionchange', () => {
  if (composing || sourceMode) return;
  const s = selection();
  if (!s) return;
  beforeSelection = s;
  activeId = locate(s.f).block.id;
  updateActive();
});
editor.addEventListener('blur', () => {
  if (!composing) { activeId = null; updateActive(); }
});
document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('pointerdown', (event) => { beforeSelection = selection() || beforeSelection; event.preventDefault(); });
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => format(button.dataset.command));
});
$('sidebar-toggle').onclick = () => {
  if (matchMedia(compactViewport).matches) {
    document.body.classList.remove('no-sidebar');
    const open = document.body.classList.toggle('mobile-outline');
    $('sidebar-toggle').setAttribute('aria-expanded', String(open));
  } else {
    const hidden = document.body.classList.toggle('no-sidebar');
    $('sidebar-toggle').setAttribute('aria-expanded', String(!hidden));
  }
};
$('help-toggle').onclick = () => { $('help').hidden = !$('help').hidden; $('help-toggle').setAttribute('aria-expanded', String(!$('help').hidden)); };
$('source-toggle').onclick = () => {
  if (composing) return;
  const sel = selection() || beforeSelection || { a: 0, f: 0 };
  sourceMode = !sourceMode;
  source.hidden = !sourceMode; editor.hidden = sourceMode;
  $('source-toggle').textContent = sourceMode ? '返回编辑' : '源文';
  $('source-toggle').setAttribute('aria-pressed', String(sourceMode));
  if (sourceMode) { source.value = text(); resizeSource(); restore(sel); }
  else { activeId = null; render(sel); }
};
source.addEventListener('input', () => {
  if (composing) return;
  remember(beforeSelection, 'typing');
  blocks = parseBlocks(source.value, blocks); currentText = text(); resizeSource(); updateUI(); persist();
});
source.addEventListener('beforeinput', () => { beforeSelection = selection(); });
source.addEventListener('compositionstart', () => { clearTimeout(compositionTimer); beforeSelection = selection(); composing = true; });
source.addEventListener('compositionend', () => {
  clearTimeout(compositionTimer);
  compositionTimer = setTimeout(() => { composing = false; source.dispatchEvent(new Event('input')); }, 0);
});
$('open').onclick = () => desktop ? runDesktop('open') : isAndroid ? runMobileFile('open') : openWebFile();
function openWebFile() {
  if (composing) { toast('请先完成输入法选词，再导入。'); return; }
  $('file-input').click();
}
$('file-input').onchange = async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('原型暂只支持 2 MB 以内的文本文件。'); return; }
  if (text() !== savedText && !window.confirm('当前文档有未导出修改。打开文件会替换浏览器草稿，是否继续？')) return;
  try {
    const value = (await file.text()).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    filename = file.name; savedText = value; history = []; future = []; lastKind = '';
    apply(value, { a: 0, f: 0 }, 'open', false);
    toast(`已打开 ${filename}`);
  } catch { toast('读取失败，请尝试 UTF-8 编码的 Markdown 文件。'); }
};
function save() {
  if (desktop) return runDesktop('save');
  if (isAndroid) return runMobileFile('export');
  if (composing) { toast('请先完成输入法选词，再保存。'); return; }
  const value = text();
  const blob = new Blob([value], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = /\.(md|markdown)$/i.test(filename) ? filename : filename.replace(/\.[^.]+$/, '') + '.md';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  savedText = value; updateUI(); persist(); toast('已发起 .md 下载，请在浏览器下载中查看');
}
async function runMobileFile(action) {
  if (mobileBusy) return;
  if (composing) { toast('请先完成输入法选词，再进行文件操作'); return; }
  if (action === 'open' && text() !== savedText && !window.confirm('当前文档有未导出修改。导入会替换本地草稿，是否继续？')) return;
  const snapshot = text();
  if (action === 'export' && new TextEncoder().encode(snapshot).length > 2 * 1024 * 1024) { toast('导出暂只支持 2 MB 以内的 UTF-8 文本。'); return; }
  mobileBusy = true;
  const freeze = action === 'open';
  if (freeze) { editor.contentEditable = 'false'; source.readOnly = true; }
  try {
    const result = await nativeFile(action, { filename: /\.(md|markdown)$/i.test(filename) ? filename : filename.replace(/\.[^.]+$/, '') + '.md', text: snapshot });
    if (result.canceled) return;
    if (action === 'export') {
      savedText = snapshot; updateUI(); persist(); toast('已导出到所选位置');
    } else if (typeof result.text === 'string') {
      const value = result.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      filename = result.filename || '导入文档.md'; savedText = value;
      history = []; future = []; lastKind = ''; activeId = null;
      beforeSelection = { a: 0, f: 0 };
      // Import should not summon the keyboard behind the system file picker.
      apply(value, null, 'open', false);
      if (sourceMode) source.value = value;
      toast(`已导入 ${filename}`);
    }
  } catch (error) { toast(error.message || '文件操作失败，内容仍保留在编辑器中'); }
  finally {
    mobileBusy = false;
    if (freeze) { editor.contentEditable = 'true'; source.readOnly = false; }
  }
}

// Android may stop the WebView without beforeunload. Flush synchronously when
// backgrounded, including the visible IME DOM, without disrupting composition.
function flushDraft() {
  if (desktop) return;
  clearTimeout(persistTimer);
  const value = composing ? (sourceMode ? source.value : [...editor.children].map(readBlock).join('\n')) : text();
  try { localStorage.setItem(STORAGE, JSON.stringify({ text: value, filename, savedText })); }
  catch { $('status').textContent = '草稿保存失败，请导出 .md'; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraft(); });
window.addEventListener('pagehide', flushDraft);
$('save').onclick = save;
document.addEventListener('keydown', (event) => {
  if (composing || event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (desktop) {
    // Menu accelerators normally consume native keys; this fallback also
    // handles accessibility-injected keys that reach the renderer first.
    if (event.target.closest('dialog')) return;
    if (event.target instanceof HTMLInputElement && ['z', 'y', 'b', 'i', 'k'].includes(key)) return;
    const action = {n:'new',o:'open',s:event.shiftKey?'saveAs':'save',z:event.shiftKey?'redo':'undo',y:'redo',b:'bold',i:'italic',k:'link',f:'find',h:'replace','/':'source'}[key];
    if (action) { event.preventDefault(); nativeCommand(action); }
    return;
  }
  const inField = event.target instanceof HTMLInputElement || event.target.closest('dialog');
  if (inField) return;
  if (key === 'f' || key === 'h') { event.preventDefault(); openFind(); if (key === 'h') $('replace-input').focus(); return; }
  if (key === 'k') { event.preventDefault(); format('link'); return; }
  if (['s', 'o', 'b', 'i', 'z', 'y'].includes(key)) {
    event.preventDefault();
    if (key === 's') save();
    else if (key === 'o') $('open').click();
    else if (key === 'b') format('bold');
    else if (key === 'i') format('italic');
    else undo(key === 'y' || event.shiftKey);
  }
});
window.addEventListener('beforeunload', (event) => {
  if (desktop) return; // Main process owns Save / Discard / Cancel.
  if (text() !== savedText) {
    try { localStorage.setItem(STORAGE, JSON.stringify({ text: text(), filename, savedText })); } catch { /* beforeunload warns below */ }
    event.preventDefault(); event.returnValue = '';
  }
});

// Local preferences and document controls.
function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  $('theme-toggle').setAttribute('aria-pressed', String(dark));
  document.querySelector('meta[name="theme-color"]').content = dark ? '#20251f' : '#f6f5f1';
  try { localStorage.setItem('inkstone.theme', dark ? 'dark' : 'light'); } catch {}
}
$('theme-toggle').onclick = () => setTheme(document.documentElement.dataset.theme !== 'dark');
try { const theme = localStorage.getItem('inkstone.theme'); setTheme(theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches); } catch {}
function focusMode(on) {
  document.body.classList.toggle('focus-mode', on);
  $('exit-focus').hidden = !on;
  $('focus-toggle').setAttribute('aria-pressed', String(on));
  if (on) {
    document.body.classList.remove('mobile-outline');
    $('sidebar-toggle').setAttribute('aria-expanded', 'false');
    $('find-panel').hidden = true; $('help').hidden = true;
    $('find-toggle').setAttribute('aria-expanded', 'false'); $('help-toggle').setAttribute('aria-expanded', 'false');
  } else {
    $('sidebar-toggle').setAttribute('aria-expanded', String(!matchMedia(compactViewport).matches && !document.body.classList.contains('no-sidebar')));
  }
  // Keyboard activation must not leave focus on a now-hidden control.
  // Pointer activation retains the live editing selection and IME untouched.
  if (document.activeElement === $(on ? 'focus-toggle' : 'exit-focus')) {
    (sourceMode ? source : editor).focus({ preventScroll: true });
  }
}
$('focus-toggle').onclick = () => focusMode(!document.body.classList.contains('focus-mode'));
$('exit-focus').onclick = () => focusMode(false);
for (const id of ['focus-toggle', 'exit-focus']) {
  $(id).addEventListener('pointerdown', event => event.preventDefault());
}
for (const id of ['undo', 'redo']) {
  $(id).onpointerdown = (e) => { beforeSelection = selection() || beforeSelection; e.preventDefault(); };
  $(id).onmousedown = (e) => e.preventDefault();
  $(id).onclick = () => { if (!composing) undo(id === 'redo'); };
}
function openName(isNew) {
  if (mobileBusy) { toast('请先完成系统文件操作'); return; }
  if (composing) { toast('请先完成输入法选词'); return; }
  if (isNew && text() !== savedText && !confirm('当前修改尚未导出。新建会替换本地草稿，建议先保存 .md。仍要继续吗？')) return;
  namingNew = isNew;
  $('name-title').textContent = isNew ? '新建文档' : '重命名文档';
  $('name-input').value = isNew ? '未命名.md' : filename;
  $('name-dialog').returnValue = '';
  $('name-dialog').showModal();
  $('name-input').select();
}
$('rename').onclick = () => desktop ? runDesktop('saveAs') : openName(false);
$('new').onclick = () => desktop ? runDesktop('new') : openName(true);
$('name-dialog').addEventListener('close', () => {
  if ($('name-dialog').returnValue !== 'confirm') return;
  let name = $('name-input').value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-');
  if (!name) return;
  filename = /\.(md|markdown)$/i.test(name) ? name : name + '.md';
  if (namingNew) {
    savedText = ''; history = []; future = []; lastKind = ''; beforeSelection = { a: 0, f: 0 };
    apply('', { a: 0, f: 0 }, 'new', false);
    toast('新的一页，开始落笔吧');
  } else { updateUI(); persist(); toast('已更新下载文件名'); }
});
editor.addEventListener('mousedown', (event) => {
  if (composing) return;
  if (event.target.closest('.task-box')) event.preventDefault();
  const preview = event.target.closest('.block-preview');
  if (preview && !(event.ctrlKey || event.metaKey) && !event.target.closest('summary')) {
    event.preventDefault();
    const id = preview.parentElement.dataset.id;
    const index = blocks.findIndex(b => b.id === id);
    const start = blocks.slice(0, index).reduce((n,b) => n + b.raw.length + 1, 0);
    restore({ a: start, f: start });
  }
});
editor.addEventListener('click', (event) => {
  const task = event.target.closest('.task-box');
  if (task && !composing) {
    event.preventDefault();
    const block = blocks.find((b) => b.id === task.dataset.task);
    if (!block) return;
    const start = blocks.slice(0, blocks.indexOf(block)).reduce((n, b) => n + b.raw.length + 1, 0);
    const at = start + block.raw.indexOf('[') + 1;
    replace(at, at + 1, /[xX]/.test(text()[at]) ? ' ' : 'x');
    activeId = null; editor.blur(); updateActive();
    return;
  }
  const link = event.target.closest('a');
  if (link) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) window.open(link.href, '_blank', 'noopener,noreferrer');
  }
});
editor.addEventListener('keydown', (event) => {
  if (event.target.closest('.task-box') && [' ', 'Enter'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); event.target.click(); }
});

// Literal, Unicode-aware search in Markdown source. Replacements form one undo step.
function refreshFind(reset = false) {
  if (!$('find-input')) return;
  const query = $('find-input').value;
  const signature = text() + '\u0000' + query + $('find-case').checked;
  if (!reset && signature === findSignature) return;
  findSignature = signature;
  findMatches = [];
  if (query) {
    const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(pattern, $('find-case').checked ? 'gu' : 'giu');
    findMatches = [...text().matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  }
  findIndex = findMatches.length ? Math.min(Math.max(reset ? 0 : findIndex, 0), findMatches.length - 1) : -1;
  updateFindCount();
}
function updateFindCount() {
  $('find-count').textContent = `${findIndex + 1} / ${findMatches.length}`;
  for (const id of ['find-prev', 'find-next', 'replace-one', 'replace-all']) $(id).disabled = !findMatches.length;
}
function showMatch() {
  const match = findMatches[findIndex];
  if (!match) return;
  restore({ a: match.start, f: match.end });
  if (!sourceMode) {
    const el = [...editor.children].find((e) => e.dataset.id === locate(match.start).block.id);
    el?.scrollIntoView({ block: 'center', behavior: 'instant' });
  } else {
    const line = text().slice(0, match.start).split('\n').length;
    $('paper-scroll').scrollTop = Math.max(0, line * 26 - 100);
  }
  updateFindCount();
}
function openFind() {
  if (composing) return;
  const s = selection();
  if (s && s.a !== s.f) {
    const selected = text().slice(Math.min(s.a, s.f), Math.max(s.a, s.f));
    if (selected.length <= 200 && !selected.includes('\n')) $('find-input').value = selected;
  }
  $('find-panel').hidden = false;
  $('find-toggle').setAttribute('aria-expanded', 'true');
  refreshFind(true);
  $('find-input').focus(); $('find-input').select();
}
function closeFind() {
  $('find-panel').hidden = true;
  $('find-toggle').setAttribute('aria-expanded', 'false');
}
$('find-toggle').onclick = () => $('find-panel').hidden ? openFind() : closeFind();
$('find-close').onclick = closeFind;
$('find-input').oninput = () => refreshFind(true);
$('find-case').onchange = () => refreshFind(true);
function moveFind(delta) {
  refreshFind();
  if (!findMatches.length) return;
  findIndex = (findIndex + delta + findMatches.length) % findMatches.length;
  showMatch();
}
$('find-next').onclick = () => moveFind(1);
$('find-prev').onclick = () => moveFind(-1);
$('find-panel').addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Enter') { event.preventDefault(); moveFind(event.shiftKey ? -1 : 1); }
});
$('replace-one').onclick = () => {
  if (composing) return;
  refreshFind();
  const match = findMatches[findIndex];
  if (!match) return;
  replace(match.start, match.end, $('replace-input').value);
  findIndex = findMatches.findIndex((m) => m.start >= match.start + $('replace-input').value.length);
  if (findIndex < 0 && findMatches.length) findIndex = 0;
  updateFindCount(); if (findMatches.length) showMatch();
};
$('replace-all').onclick = () => {
  if (composing) return;
  refreshFind();
  if (!findMatches.length) return;
  const count = findMatches.length; let value = text();
  const replacement = $('replace-input').value;
  for (const m of [...findMatches].reverse()) value = value.slice(0, m.start) + replacement + value.slice(m.end);
  apply(value, null, 'replace');
  toast(`已替换 ${count} 处，可撤销`);
};
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.isComposing) return;
  if (!$('find-panel').hidden) { closeFind(); event.preventDefault(); }
  focusMode(false);
  document.body.classList.remove('mobile-outline');
});

try {
  const draft = desktop ? null : JSON.parse(localStorage.getItem(STORAGE) || 'null');
  if (draft && typeof draft.text === 'string') {
    currentText = draft.text; filename = draft.filename || '未命名.md'; savedText = draft.savedText ?? '';
    $('status').textContent = '已恢复此浏览器的草稿';
  }
} catch { draftAvailable = false; }
blocks = parseBlocks(currentText);
render();
if (!draftAvailable) $('status').textContent = '浏览器草稿不可用，请保存 .md';
// Public, read-only diagnostics for regression tests; no document content leaves this origin.
window.inkstone = { getMarkdown: text, getBlocks: () => blocks.map((b) => ({ ...b })), get isComposing() { return composing; } };


// Minimal, allowlisted native bridge. No filesystem API is exposed to document HTML.
function desktopSnapshot() {
  return { text: text(), filename, dirty: text() !== savedText, savedText, composing };
}
function installNativeDocument(result, action) {
  if (!result || result.canceled) return;
  if (result.filename) filename = result.filename;
  if ('filepath' in result) desktopPath = result.filepath;
  if (['save', 'saveAs'].includes(action)) {
    // User may continue typing while the OS dialog is open. Only mark the
    // exact snapshot actually written as saved, never edits typed afterward.
    savedText = result.savedText;
    updateUI(); persist(); toast('已保存到本地文件');
    return;
  }
  if (typeof result.text === 'string') {
    savedText = typeof result.savedText === 'string' ? result.savedText : result.text;
    history = []; future = []; lastKind = ''; activeId = null;
    beforeSelection = { a: 0, f: 0 };
    apply(result.text, { a: 0, f: 0 }, 'native', false);
    toast(action === 'restore' ? '本地文档已就绪' : action === 'new' ? '新的一页，开始落笔吧' : '已打开 ' + filename);
  }
}
async function runDesktop(action) {
  if (!desktop || desktopBusy) return;
  if (composing) { toast('请先完成输入法选词，再进行文件操作'); return; }
  desktopBusy = true;
  // Freeze edits during a file replacement to avoid losing text typed behind
  // native dialogs; save / saveAs may safely preserve edits made meanwhile.
  const freeze = ['new', 'open', 'openPending', 'close', 'restore'].includes(action);
  if (freeze) { editor.contentEditable = 'false'; source.readOnly = true; }
  try {
    const result = await desktop.perform(action, desktopSnapshot());
    installNativeDocument(result, action);
  } catch (error) {
    toast(error?.message || '文件操作失败，请重试');
    $('status').textContent = '文件操作失败 · 你的内容仍保留在编辑器中';
  } finally {
    desktopBusy = false;
    if (freeze) { editor.contentEditable = 'true'; source.readOnly = false; }
  }
}
function nativeCommand(action) {
  if (desktopBusy || composing) { if (composing) toast('请先完成输入法选词'); return; }
  if (['open', 'new', 'save', 'saveAs', 'close', 'openPending'].includes(action)) return runDesktop(action);
  const field = document.activeElement;
  const inField = field instanceof HTMLInputElement || field?.closest('dialog');
  if (inField && ['undo', 'redo', 'bold', 'italic', 'link'].includes(action)) {
    if (action === 'undo' || action === 'redo') document.execCommand(action);
    return;
  }
  if (action === 'undo' || action === 'redo') return undo(action === 'redo');
  if (['bold', 'italic', 'link'].includes(action)) return format(action);
  if (action === 'find' || action === 'replace') { openFind(); if (action === 'replace') $('replace-input').focus(); return; }
  const ids = {source:'source-toggle',focus:'focus-toggle',theme:'theme-toggle',outline:'sidebar-toggle',help:'help-toggle'};
  if (ids[action]) $(ids[action]).click();
}
if (desktop) {
  $('open').innerHTML = '打开 <kbd>Ctrl O</kbd>';
  $('save').innerHTML = '保存 <kbd>Ctrl S</kbd>';
  $('save').title = '保存到原文件 Ctrl+S；另存为 Ctrl+Shift+S';
  $('rename').title = '另存为新名称';
  $('dirty').setAttribute('aria-label', '尚未保存的修改');
  document.querySelector('.edition').innerHTML = 'WINDOWS DESKTOP <span>04</span>';
  document.querySelector('.mvp').textContent = 'Windows v0.4';
  $('help').innerHTML = '<strong>墨页 Windows · 文字留在你的电脑。</strong> Ctrl+N 新建，Ctrl+O 打开，Ctrl+S 保存到原文件，Ctrl+Shift+S 另存为；Ctrl+F 查找，Ctrl+H 替换，Ctrl+B / I 格式，Ctrl+K 链接，Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做；Ctrl+/ 源码视图，F8 专注，F11 全屏，Esc 退出专注。<br><small>支持表格与对齐、分割线、多级列表、任务、安全 HTML、转义字符与本地 KaTeX 数学排版。代码块支持离线语法高亮；Setext 标题、缩进代码块与裸 URL 也可用。点击复杂块编辑原文，离开后预览；Tab / Shift+Tab 缩进列表或移动表格单元格。Ctrl+点击链接在系统浏览器打开。纯离线，无云端上传；恢复草稿不代替保存文件。打开 UTF-8 / UTF-8 BOM 的 .md / .markdown / .txt（不超过 10 MB）；保留原换行方式。GBK 等编码请先转为 UTF-8。支持 Windows 10/11 64 位；真实中文输入法仍需设备验证。不含图片与完整 CommonMark。<span>开源组件许可见安装目录 THIRD-PARTY-NOTICES.txt。</span></small>';
  desktop.onCommand(nativeCommand);
  await runDesktop('restore');
  desktopReady = true;
  updateUI(); persist();
}

installMobileUI();
if (isAndroid) {
  document.querySelector('#name-dialog p').textContent = '名称用于导出新文件，不会覆盖导入的原文件。';
  $('help').innerHTML = '<strong>墨页 Android · 文字留在此设备。</strong> 点按段落编辑，横向滑动工具栏使用格式；点左上角「墨」打开大纲。导入 UTF-8 的 .md / .markdown / .txt（不超过 2 MB），导出通过系统文件选择器保存新文件，不覆盖导入原件。<br><small>草稿自动保存在应用内，切到后台时立即保留；清除应用数据或卸载会删除草稿，请定期导出。中文输入法选词期间不重排编辑区，完成选词后可格式化、导入导出。真实设备的不同输入法仍需验证。内容不上传云端。<a href="vendor/licenses.txt" target="_blank" rel="noopener">开源组件许可</a></small>';
}
