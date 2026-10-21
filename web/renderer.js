import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import katex from 'katex';

const md = new MarkdownIt({ html: true, linkify: false, typographer: false, breaks: false });
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

export function previewMarkdown(raw, type = 'paragraph') {
  const formulas = [];
  const seed = `INKMATH${crypto.randomUUID().replaceAll('-', '')}TOKEN`;
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
  else html = md.render(raw);
  // Untrusted HTML never retains CSS, identifiers, interactive controls, media or embeds.
  let clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style','script','iframe','object','embed','form','input','button','textarea','select','option','img','video','audio','source','link','meta','base'],
    FORBID_ATTR: ['style','class','id','name','src','srcset','contenteditable','tabindex','autofocus'],
    ALLOW_DATA_ATTR: false,
    ADD_URI_SAFE_ATTR: ['align', 'colspan', 'rowspan', 'title'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#[^\s]*$)/i,
  });
  formulas.forEach((value, i) => { clean = clean.replaceAll(`${seed}${i}END`, value); });
  return clean || '<span class="safe-empty">此 HTML 的不安全内容已隐藏，点击可编辑原文。</span>';
}

export function needsPreview(block) {
  return ['table','hr','math','html'].includes(block.type) || (block.type !== 'code' && /(?:\$[^$\n]+\$|\\\(|<\/?[a-zA-Z!]|&(?:#\d+|#x[\da-f]+|[a-z]+);|\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/.test(block.raw));
}
