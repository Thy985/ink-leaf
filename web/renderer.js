import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';

const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
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
  return clean.replace(/class="([^"]*)"/g, (_, classes) => {
    const kept = classes.split(/\s+/).filter((name) => name === 'hljs' || name.startsWith('hljs-'));
    return kept.length ? ` class="${kept.join(' ')}"` : '';
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
