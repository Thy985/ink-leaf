import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';

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
    open.attrs = [['href', entry.url], ['target', '_blank'], ['rel', 'noopener noreferrer']];
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

export function previewMarkdown(raw, type = 'paragraph', options = {}) {
  const formulas = [];
  const codeFragments = [];
  const seed = `INKMATH${crypto.randomUUID().replaceAll('-', '')}TOKEN`;
  const codeSeed = `INKCODE${crypto.randomUUID().replaceAll('-', '')}TOKEN`;
  const env = {
    inkHighlight: options.highlight !== false,
    inkCodeFragments: codeFragments,
    inkCodeSeed: codeSeed,
    inkDoc: options.doc || null,
  };
  const formula = (src, display) => {
    const key = `${seed}${formulas.length}END`;
    try {
      formulas.push(katex.renderToString(src, { displayMode: display, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 500, maxSize: 20, output: 'htmlAndMathml' }));
    } catch {
      formulas.push(`<span class="math-error" title="公式未完成或包含不支持的 LaTeX 命令">${md.utils.escapeHtml(src)}</span>`);
    }
    return key;
  };
  md.renderer.rules.ink_math = (tokens, i) => formula(tokens[i].content, false);
  let html;
  if (type === 'math') {
    const trimmed = raw.trim();
    const body = trimmed.startsWith('$$') ? trimmed.slice(2).replace(/\$\$\s*$/, '') : trimmed.slice(2).replace(/\\\]\s*$/, '');
    html = formula(body.trim(), true);
  } else if (type === 'hr') html = '<hr>';
  else html = md.render(raw, env);
  // Untrusted HTML never retains CSS, identifiers, interactive controls, media or embeds.
  let clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style','script','iframe','object','embed','form','input','button','textarea','select','option','img','video','audio','source','link','meta','base'],
    FORBID_ATTR: ['style','class','id','name','src','srcset','contenteditable','tabindex','autofocus'],
    ALLOW_DATA_ATTR: false,
    ADD_URI_SAFE_ATTR: ['align', 'colspan', 'rowspan', 'title'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#[^\s]*$)/i,
  });
  formulas.forEach((value, index) => { clean = clean.replaceAll(`${seed}${index}END`, value); });
  codeFragments.forEach((value, index) => { clean = clean.replaceAll(`${codeSeed}${index}END`, value); });
  return clean || '<span class="safe-empty">此 HTML 的不安全内容已隐藏，点击可编辑原文。</span>';
}

export function needsPreview(block) {
  return block.type === 'code' || ['table','hr','math','html'].includes(block.type) || (block.type !== 'code' && /(?:\$[^$\n]+\$|\\\(|<\/?[a-zA-Z!]|&(?:#\d+|#x[\da-f]+|[a-z]+);|\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/.test(block.raw));
}
