import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import { imagePlaceholder } from './model.js';

const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
const AUTO_LINK_SCHEME_RE = /^(?:https?:\/\/|mailto:)/i;
md.core.ruler.after('linkify', 'ink_restrict_linkify', (state) => {
  for (const block of state.tokens) {
    const children = block.children;
    if (!children) continue;
    for (let i = children.length - 1; i >= 0; i--) {
      const token = children[i];
      if (token.type !== 'link_open' || token.markup !== 'linkify') continue;
      if (AUTO_LINK_SCHEME_RE.test(token.attrGet('href') || '')) continue;
      children.splice(i, 1);
      for (let j = i; j < children.length; j++) {
        if (children[j].type === 'link_close' && children[j].markup === 'linkify') {
          children.splice(j, 1);
          break;
        }
      }
    }
  }
});
md.inline.ruler.before('escape', 'ink_math', (state, silent) => {
  const start = state.pos;
  let open, close;
  if (state.src.startsWith('\\(', start)) { open = '\\('; close = '\\)'; }
  else if (state.src[start] === '$' && state.src[start + 1] !== '$' && !/\s/.test(state.src[start + 1] || ' ')) { open = '$'; close = '$'; }
  else return false;
  let end = start + open.length;
  while ((end = state.src.indexOf(close, end)) >= 0) {
    let slashes = 0; for (let j = end - 1; j >= 0 && state.src[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) break;
    end += close.length;
  }
  if (end < 0 || end === start + open.length || state.src.slice(start, end).includes('\n')) return false;
  if (open === '$' && (/\s/.test(state.src[end - 1]) || /\d/.test(state.src[end + 1] || ''))) return false;
  if (!silent) { const token = state.push('ink_math', 'math', 0); token.content = state.src.slice(start + open.length, end); }
  state.pos = end + close.length;
  return true;
});
// Full-document rendering (HTML export) must see the same $$ / \[…\] math blocks the
// per-block editor model recognizes. As a block rule it only fires at top level, so
// math-looking lines inside list items keep their previous inline treatment.
md.block.ruler.before('paragraph', 'ink_math_block', (state, startLine, endLine, silent) => {
  const lineText = (line) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  const open = /^ {0,3}(\$\$|\\\[)(.*)$/.exec(lineText(startLine));
  if (!open) return false;
  const delim = open[1];
  if (silent) return true;
  const closeRe = delim === '$$' ? /\$\$$/ : /\\\]$/;
  const rest = open[2];
  const inlineClose = closeRe.exec(rest);
  let body, nextLine;
  if (inlineClose) {
    body = rest.slice(0, inlineClose.index);
    nextLine = startLine + 1;
  } else {
    const standalone = delim === '$$' ? /^ {0,3}\$\$\s*$/ : /^ {0,3}\\\]\s*$/;
    let line = startLine + 1;
    while (line < endLine && !standalone.test(lineText(line))) line++;
    // Unclosed math runs to the end of the document, matching the editor model.
    body = state.getLines(startLine + 1, line, state.blkIndent, false);
    nextLine = line < endLine ? line + 1 : endLine;
  }
  const token = state.push('ink_math_block', 'math', 0);
  token.markup = delim;
  token.content = body;
  token.map = [startLine, nextLine];
  state.line = nextLine;
  return true;
});
const INK_SAFE_TARGET_RE = /^(?:https?:|mailto:|#[^\s]*$)/i;
// Rich blocks (tables, HTML, formulas) render through markdown-it, which knows nothing about
// the document-wide definition tables; this rule resolves [^label] and [text][label] against env.inkDoc.
md.inline.ruler.before('link', 'ink_ref', (state, silent) => {
  const doc = state.env?.inkDoc;
  if (!doc || state.src[state.pos] !== '[') return false;
  const rest = state.src.slice(state.pos);
  const foot = /^\[\^([^\]\s]{1,64})\]/.exec(rest);
  if (foot) {
    const entry = doc.footnotes.get(foot[1].trim().toLowerCase());
    if (!entry?.number) return false;
    if (!silent) {
      const token = state.push('html_inline', '', 0);
      token.content = `<sup><a href="#ink-fn-${entry.number}">${entry.number}</a></sup>`;
      token.markup = 'ink_footnote';
    }
    state.pos += foot[0].length;
    return true;
  }
  const ref = /^\[([^\]\n]+)\]\[([^\]\s]{1,64})\]/.exec(rest);
  if (!ref) return false;
  const entry = doc.links.get(ref[2].trim().toLowerCase());
  if (!entry || !INK_SAFE_TARGET_RE.test(entry.url)) return false;
  if (!silent) {
    const open = state.push('link_open', 'a', 1);
    open.attrs = [['href', entry.url], ...(entry.title ? [['title', entry.title]] : []), ['target', '_blank'], ['rel', 'noopener noreferrer']];
    open.markup = 'ink_linkref';
    const label = [];
    state.md.inline.parse(ref[1], state.md, state.env, label);
    state.tokens.push(...label);
    state.push('link_close', 'a', -1).markup = 'ink_linkref';
  }
  state.pos += ref[0].length;
  return true;
});
for (const name of ['th_open', 'td_open']) md.renderer.rules[name] = (tokens, index, options, env, self) => {
  const t = tokens[index]; const style = t.attrGet('style');
  if (style) { t.attrs = t.attrs.filter(([k]) => k !== 'style'); t.attrSet('align', style.split(':')[1]); }
  return self.renderToken(tokens, index, options);
};

// KaTeX output contains class attributes and MathML that the HTML profile strips, so like the
// image and code seeds the formula renders to a text seed and is swapped back after sanitizing.
function renderFormula(src, display, env) {
  const output = env?.inkMathMode === 'mathml' ? 'mathml' : 'htmlAndMathml';
  let html;
  try {
    html = katex.renderToString(src, { displayMode: display, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20, output });
  } catch {
    html = `<span class="math-error" title="公式未完成或包含不支持的 LaTeX 命令">${md.utils.escapeHtml(src)}</span>`;
  }
  const key = `INKMATH${crypto.randomUUID().replaceAll('-', '')}${env.inkMathSeeds.length}END`;
  env.inkMathSeeds.push([key, html]);
  return key;
}
md.renderer.rules.ink_math = (tokens, index, options, env) => renderFormula(tokens[index].content, false, env);
md.renderer.rules.ink_math_block = (tokens, index, options, env) => renderFormula(tokens[index].content, true, env);
// `![alt](src)` and `![alt][ref]` render to an inert placeholder token. Like the formula and
// code seeds, the seed text survives sanitization untouched and is swapped for the controlled
// placeholder markup afterwards — an <img> never reaches the sanitizer or the document.
md.renderer.rules.image = (tokens, index, options, env, self) => {
  if (!env.inkImages) env.inkImages = [];
  const token = tokens[index];
  const alt = self.renderInlineAsText(token.children || [], options, env);
  const id = env.inkImages.length;
  env.inkImages.push({ src: token.attrGet('src') || '', title: token.attrGet('title') || '', alt });
  return `${env.inkImageSeed}${id}END`;
};

const MAX_HIGHLIGHT_CHARS = 100_000;

function plainFence(content) {
  return `<pre><code>${md.utils.escapeHtml(content)}</code></pre>\n`;
}

function sanitizeHighlight(value) {
  const clean = DOMPurify.sanitize(value, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
  // `<` is always escaped in text nodes, so a literal `<span class="` can only come from a
  // real tag; anchoring here keeps code text like class="foo" byte-for-byte intact.
  return clean.replace(/<span class="([^"]*)">/g, (_, classes) => {
    const kept = classes.split(/\s+/).filter((name) => name === 'hljs' || name.startsWith('hljs-'));
    return kept.length ? `<span class="${kept.join(' ')}">` : '<span>';
  });
}

md.renderer.rules.fence = (tokens, index, options, env) => {
  const token = tokens[index];
  const info = token.info.trim().split(/\s+/)[0] || '';
  if (!env?.inkHighlight || !info || token.content.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(info)) {
    return plainFence(token.content);
  }
  let fragment;
  try {
    fragment = sanitizeHighlight(hljs.highlight(token.content, { language: info, ignoreIllegals: true }).value);
  } catch {
    return plainFence(token.content);
  }
  const id = env.inkCodeFragments.length;
  env.inkCodeFragments.push(fragment);
  return `<pre><code>${env.inkCodeSeed}${id}END</code></pre>\n`;
};

// Untrusted HTML never retains CSS, identifiers, interactive controls, media or embeds.
// Image markdown never produces a live <img>: the image rule only leaves a text seed, and
// the controlled placeholder markup is injected after sanitization.
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style','script','iframe','object','embed','form','input','button','textarea','select','option','img','video','audio','source','link','meta','base'],
  FORBID_ATTR: ['style','class','id','name','src','srcset','contenteditable','tabindex','autofocus'],
  ALLOW_DATA_ATTR: false,
  ADD_URI_SAFE_ATTR: ['align', 'colspan', 'rowspan', 'title'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#[^\s]*$)/i,
};

function createEnv(options, extras = {}) {
  return {
    inkHighlight: options.highlight !== false,
    inkCodeFragments: [],
    inkCodeSeed: `INKCODE${crypto.randomUUID().replaceAll('-', '')}TOKEN`,
    inkDoc: options.doc || null,
    ...extras,
  };
}

function reinsertSeeds(clean, env) {
  env.inkMathSeeds.forEach(([key, value]) => { clean = clean.replaceAll(key, value); });
  env.inkCodeFragments.forEach((value, index) => { clean = clean.replaceAll(`${env.inkCodeSeed}${index}END`, value); });
  env.inkImages.forEach((image, index) => {
    clean = clean.replaceAll(`${env.inkImageSeed}${index}END`, imagePlaceholder(image.src, image.alt, image.title));
  });
  return clean;
}

export function previewMarkdown(raw, type = 'paragraph', options = {}) {
  const env = createEnv(options, {
    inkMathSeeds: [],
    inkMathMode: 'preview',
    inkImages: [],
    inkImageSeed: `INKIMG${crypto.randomUUID().replaceAll('-', '')}TOKEN`,
  });
  let html;
  if (type === 'math') {
    const trimmed = raw.trim();
    const body = trimmed.startsWith('$$') ? trimmed.slice(2).replace(/\$\$\s*$/, '') : trimmed.slice(2).replace(/\\\]\s*$/, '');
    html = renderFormula(body.trim(), true, env);
  } else if (type === 'hr') html = '<hr>';
  else html = md.render(raw, env);
  const clean = reinsertSeeds(DOMPurify.sanitize(html, SANITIZE_CONFIG), env);
  return clean || '<span class="safe-empty">此 HTML 的不安全内容已隐藏，点击可编辑原文。</span>';
}

// Full-document render for HTML export. Same sanitizer and seeds; math uses MathML-only
// output so the exported file needs no KaTeX fonts or CSS. A numbered footnote definition
// that owns its line becomes an anchored entry at its original position, so in-document
// references keep working; definitions that would stay literal in the editor (right after
// a paragraph or inside a list) are left untouched here as well.
export function renderDocumentHTML(raw, options = {}) {
  const env = createEnv(options, {
    inkMathSeeds: [],
    inkMathMode: 'mathml',
    inkImages: [],
    inkImageSeed: `INKIMG${crypto.randomUUID().replaceAll('-', '')}TOKEN`,
  });
  let source = String(raw ?? '');
  const footnoteDefs = [];
  if (options.doc?.footnotes?.size) {
    const ownLine = /^( {0,3}(?:#{1,6}(?:[ \t]|$)|>|\||`{3,}|~{3,}|\[\^[^\]\s]{1,64}\]:|\[[^\]]+\]:|(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}))|$)/;
    const lines = source.split('\n');
    source = lines.map((line, index) => {
      const m = /^ {0,3}\[\^([^\]\s]{1,64})\]:[ \t]*(.*)$/.exec(line);
      if (!m) return line;
      const previous = index > 0 ? lines[index - 1] : '';
      if (index > 0 && !/^\s*$/.test(previous) && !ownLine.test(previous)) return line;
      const entry = options.doc.footnotes.get(m[1].trim().toLowerCase());
      if (!entry?.number) return line;
      footnoteDefs.push({ key: `INKFN${crypto.randomUUID().replaceAll('-', '')}${entry.number}SEED`, number: entry.number, body: m[2] });
      return footnoteDefs[footnoteDefs.length - 1].key;
    }).join('\n');
  }
  // Render footnote bodies first so any seeds they emit join the shared env and get
  // replaced together with the document's own seeds.
  footnoteDefs.forEach((def) => {
    def.inner = DOMPurify.sanitize(md.renderInline(def.body, env), SANITIZE_CONFIG);
  });
  let out = reinsertSeeds(DOMPurify.sanitize(md.render(source, env), SANITIZE_CONFIG), env);
  footnoteDefs.forEach(({ key, number, body, inner }) => {
    out = out.replaceAll(key, `<p class="ink-fn" id="ink-fn-${number}"><span class="ink-fn-num">${number}.</span> ${inner || md.utils.escapeHtml(body)}</p>`);
  });
  return out;
}

export function needsPreview(block) {
  return block.type === 'code' || ['table','hr','math','html'].includes(block.type) || (block.type !== 'code' && /(?:\$[^$\n]+\$|\\\(|!\[|<\/?[a-zA-Z!]|&(?:#\d+|#x[\da-f]+|[a-z]+);|\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/.test(block.raw));
}
