/** Dependency-free Markdown block model used by Inkstone. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

function setextLevel(line) {
  const match = SETEXT_RE.exec(line);
  return match ? (match[1][0] === '=' ? 1 : 2) : 0;
}
const INDENTED_CODE_RE = /^(?: {4}|\t)/;

function isIndentedCodeStart(lines, index) {
  return INDENTED_CODE_RE.test(lines[index]) && (index === 0 || /^\s*$/.test(lines[index - 1]));
}
const HEADING_RE = /^( {0,3})(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
// Up to 3 spaces is CommonMark's top-level allowance; nested items may use any indentation.
const LIST_RE = /^([ \t]*)(?:(\d+)([.)])|([-+*]))[ \t]+(.*)$/;
const QUOTE_RE = /^( {0,3})(>[ \t]?)(.*)$/;
const HR_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const HTML_OPEN_RE = /^ {0,3}<([A-Za-z][\w:-]*)(?:\s[^>]*)?>/;
const HTML_BLOCK_TAGS = new Set(['address','article','aside','blockquote','details','dialog','dd','div','dl','dt','fieldset','figcaption','figure','footer','form','h1','h2','h3','h4','h5','h6','header','hr','li','main','nav','ol','p','pre','section','summary','table','tbody','td','tfoot','th','thead','tr','ul','script','style','template']);
const HTML_VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

export function escape(text) { return String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }

function tableLine(line) { return line.includes('|') && line.trim().length > 0; }
function classifyList(first) {
  const m = LIST_RE.exec(first); if (!m) return null;
  const indent = m[1].replaceAll('\t', '    ').length;
  return { type:'list', ordered:Boolean(m[2]), prefix:m[2] || m[4], marker:m[2] ? `${m[2]}${m[3]}` : m[4], indent, depth:Math.floor(indent / 2) };
}
function classifyHtml(first) {
  const m = /^ {0,3}<([A-Za-z][\w:-]*)(?:\s[^>]*)?\/?>/.exec(first); if (!m || !HTML_BLOCK_TAGS.has(m[1].toLowerCase())) return null;
  return { type:'html', tag:m[1].toLowerCase(), safe:false };
}
export function classify(raw) {
  const value=String(raw ?? ''), first=value.split('\n',1)[0];
  if (value==='' || /^\s*$/.test(value)) return {type:'blank'};
  if (value.split('\n').length >= 2 && tableLine(first) && TABLE_SEPARATOR_RE.test(value.split('\n')[1])) {
    return {type:'table',header:first,separator:value.split('\n')[1]};
  }
  const fence=FENCE_RE.exec(first); if (fence) return {type:'code',prefix:fence[1],fence:fence[1][0],fenceLength:fence[1].length,info:fence[2].trim()||undefined};
  if (/^ {0,3}(?:\$\$|\\\[)/.test(first)) return {type:'math',delimiter:first.match(/^ {0,3}(\$\$|\\\[)/)[1]};
  if (HR_RE.test(first)) return {type:'hr'};
  const heading=HEADING_RE.exec(first); if (heading) return {type:'heading',level:heading[2].length,prefix:heading[2]};
  const list=classifyList(first); if (list) return list;
  const quote=QUOTE_RE.exec(first); if (quote) return {type:'quote',prefix:quote[2].trimEnd()};
  const html=classifyHtml(first); if (html) return html;
  return {type:'paragraph'};
}
function isFenceClose(line, open) { const m=/^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line); return Boolean(m && m[1][0]===open[0] && m[1].length>=open.length); }
function isMathClose(line, opening) { return opening==='$$' ? /^ {0,3}\$\$\s*$/.test(line) : /^ {0,3}\\\]\s*$/.test(line); }
function hasInlineMathClose(line, opening) { const start=line.search(opening==='$$' ? /\$\$/ : /\\\[/); const close=opening==='$$' ? line.indexOf('$$',start+2) : line.indexOf('\\]',start+2); return start>=0 && close>=0 && /^\s*$/.test(line.slice(close+2)); }
function isSpecialLine(line, lines, index) { return Boolean(FENCE_RE.test(line)||/^ {0,3}(?:\$\$|\\\[)/.test(line)||HR_RE.test(line)||HEADING_RE.test(line)||LIST_RE.test(line)||QUOTE_RE.test(line)||classifyHtml(line)||(lines && index+1<lines.length && tableLine(line) && TABLE_SEPARATOR_RE.test(lines[index+1]))); }
function nextId(used,serial) { let id; do id=`block-${serial.value++}`; while(used.has(id)); used.add(id); return id; }

export function parseBlocks(text, previous=[]) {
  const source=String(text??'').replaceAll('\r\n','\n').replaceAll('\r','\n'), lines=source.split('\n'), parsed=[]; let i=0;
  while(i<lines.length) {
    const line=lines[i]; if (/^\s*$/.test(line)) { parsed.push({type:'blank',raw:line}); i++; continue; }
    if (isIndentedCodeStart(lines, i)) {
      const start = i;
      let end = i;
      while (end < lines.length && (/^\s*$/.test(lines[end]) || INDENTED_CODE_RE.test(lines[end]))) end++;
      let rawEnd = end;
      while (rawEnd > start && /^\s*$/.test(lines[rawEnd - 1])) rawEnd--;
      parsed.push({ type: 'code', style: 'indented', raw: lines.slice(start, rawEnd).join('\n') });
      i = rawEnd;
      continue;
    }
    const opening=FENCE_RE.exec(line); if(opening){const start=i++; while(i<lines.length&&!isFenceClose(lines[i],opening[1]))i++; if(i<lines.length)i++; parsed.push({...classify(lines[start]),raw:lines.slice(start,i).join('\n')}); continue;}
    const mathOpen=/^ {0,3}(\$\$|\\\[)/.exec(line); if(mathOpen){const start=i++, delim=mathOpen[1]; if(!hasInlineMathClose(line,delim)){ while(i<lines.length&&!isMathClose(lines[i],delim))i++; if(i<lines.length)i++; } parsed.push({...classify(lines[start]),raw:lines.slice(start,i).join('\n')}); continue;}
    if(classifyHtml(line)){ const start=i++, htmlInfo=classifyHtml(line), tag=htmlInfo.tag; const close=new RegExp(`</${tag}\\s*>`,'i'); const selfClosing=/\/\s*>\s*$/.test(line)||HTML_VOID_TAGS.has(tag); if(!selfClosing&&!close.test(line)){ while(i<lines.length&&!close.test(lines[i])&&(tag==='script'||tag==='style'||!/^\s*$/.test(lines[i])))i++; if(i<lines.length&&close.test(lines[i]))i++; } parsed.push({...htmlInfo,raw:lines.slice(start,i).join('\n')}); continue; }
    if (tableLine(line) && i+1<lines.length && TABLE_SEPARATOR_RE.test(lines[i+1])) { const start=i; i+=2; while(i<lines.length&&tableLine(lines[i]))i++; const raw=lines.slice(start,i).join('\n'); parsed.push({...classify(raw),raw}); continue; }
    if (isSpecialLine(line,lines,i)) { const list=classifyList(line); if(list){ const start=i++; while(i<lines.length&&!/^\s*$/.test(lines[i])&&!isSpecialLine(lines[i],lines,i))i++; parsed.push({...list,raw:lines.slice(start,i).join('\n')}); } else { parsed.push({...classify(line),raw:line}); i++; } continue; }
    const start = i;
    let end = i;
    while (end < lines.length && !/^\s*$/.test(lines[end]) && !isSpecialLine(lines[end], lines, end)) {
      if (end > start && setextLevel(lines[end])) break;
      end++;
    }
    if (end < lines.length && end > start && setextLevel(lines[end])) {
      parsed.push({ type: 'heading', level: setextLevel(lines[end]), style: 'setext', raw: lines.slice(start, end + 1).join('\n') });
      i = end + 1;
      continue;
    }
    parsed.push({ type: 'paragraph', raw: lines.slice(start, end).join('\n') });
    i = end;
  }
  const old=Array.isArray(previous)?previous:[], used=new Set(), serial={value:1}, previousIds=new Set(old.map(x=>x?.id).filter(Boolean)), matches=Array(parsed.length);
  parsed.forEach((b,n)=>{const x=old[n];if(x?.id&&x.raw===b.raw&&!used.has(x.id)){matches[n]=x.id;used.add(x.id);}});
  parsed.forEach((b,n)=>{if(matches[n])return;const x=old.find(y=>y?.id&&y.raw===b.raw&&!used.has(y.id));if(x){matches[n]=x.id;used.add(x.id);}});
  const reserved=new Set([...previousIds,...used]);
  return parsed.map((b,n)=>{let id=matches[n], x=old[n];if(!id&&x?.id&&!used.has(x.id)){id=x.id;used.add(id);reserved.add(id);}if(!id)id=nextId(reserved,serial);return {id,...b};});
}
export function serialize(blocks){return (Array.isArray(blocks)?blocks:[]).map(b=>String(b?.raw??'')).join('\n');}
function syntax(marker){return `<span class="syntax">${escape(marker)}</span>`;}
function isSafeLinkTarget(url){return /^(?:https?:|mailto:)/i.test(url)||/^#[^\s]*$/.test(url);}

function trimUrlTail(url) {
  let value = url;
  while (/[.,;:!?。，；：！？]$/u.test(value)) value = value.slice(0, -1);
  while (value.endsWith(')')) {
    const opens = (value.match(/\(/g) || []).length;
    const closes = (value.match(/\)/g) || []).length;
    if (closes <= opens) break;
    value = value.slice(0, -1);
  }
  return value;
}

function startsUrl(text, pos) {
  const first = text[pos];
  if (first !== 'h' && first !== 'H' && first !== 'm' && first !== 'M') return false;
  if (pos > 0 && /[A-Za-z0-9_@]/.test(text[pos - 1])) return false;
  return /^(?:https?:\/\/|mailto:)/i.test(text.slice(pos));
}

export function renderInline(raw){
  const input=String(raw??'');
  const render=(text,allowCode=true,allowLinks=true)=>{let out='',pos=0;
    while(pos<text.length){
      if (allowLinks && startsUrl(text, pos)) {
        const match = text.slice(pos).match(/^(?:https?:\/\/|mailto:)[^\s<>"'`]+/i);
        if (match) {
          const href = trimUrlTail(match[0]);
          if (href) {
            out += `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(href)}</a>`;
            pos += href.length;
            continue;
          }
        }
      }
      if(text[pos]==='\\' && pos+1<text.length && /[\\`*_[\]~<>()[\]{}#+.!|_-]/.test(text[pos+1])) { out+=syntax('\\')+escape(text[pos+1]); pos+=2; continue; }
      if(allowCode&&text[pos]==='`'){let n=1;while(text[pos+n]==='`')n++;const marker='`'.repeat(n), end=text.indexOf(marker,pos+n);if(end!==-1){let content=text.slice(pos+n,end), padded=content.startsWith(' ')&&content.endsWith(' ')&&content.trim();if(padded)content=content.slice(1,-1);out+=syntax(marker)+(padded?' ':'')+`<code>${escape(content)}</code>`+(padded?' ':'')+syntax(marker);pos=end+n;continue;}}
      const link=text.slice(pos).match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/);if(link){const[,label,url]=link, labelHtml=render(label,allowCode,false), suffix=`](${url})`;out+=syntax('[')+(isSafeLinkTarget(url)?`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`:labelHtml)+syntax(suffix);pos+=link[0].length;continue;}
      const strong=text.slice(pos).match(/^(\*\*|__)(?=\S)([\s\S]+?)\1/);if(strong){out+=syntax(strong[1])+`<strong>${render(strong[2],false,allowLinks)}</strong>`+syntax(strong[1]);pos+=strong[0].length;continue;}
      const emphasis=text.slice(pos).match(/^(\*|_)(?=\S)([\s\S]+?)\1/);if(emphasis){out+=syntax(emphasis[1])+`<em>${render(emphasis[2],false,allowLinks)}</em>`+syntax(emphasis[1]);pos+=emphasis[0].length;continue;}
      const strike=text.slice(pos).match(/^~~(?=\S)([\s\S]+?)~~/);if(strike){out+=syntax('~~')+`<del>${render(strike[1],false,allowLinks)}</del>`+syntax('~~');pos+=strike[0].length;continue;}
      let end=pos+1;while(end<text.length&&! '`*_~[\\'.includes(text[end])&&!(allowLinks&&startsUrl(text,end)))end++;out+=escape(text.slice(pos,end));pos=end;
    } return out;}; return render(input);
}
