// Full-text search panel: cross-folder search with grouped results.
// Renderer-side component; uses desktop.search for the backend scan.

let searchPanelOpen = false;
let searchResults = [];
let searchQuery = '';
let searchOptions = { caseSensitive: false, regex: false };

export function initSearch() {
  if (!window.desktop?.search) return;
  // 搜索面板创建失败不能影响编辑器主流程。
  try { createSearchPanel(); } catch (error) { console.error('搜索面板初始化失败', error); }
}

export function isSearchAvailable() {
  return !!window.desktop?.search;
}

function createSearchPanel() {
  const panel = document.createElement('aside');
  panel.id = 'search-panel';
  panel.className = 'search-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', '文件夹搜索');
  panel.innerHTML = `
    <div class="search-panel-header">
      <span class="search-panel-title">搜索文件夹</span>
      <button type="button" class="search-panel-close" aria-label="关闭搜索">×</button>
    </div>
    <div class="search-panel-controls">
      <input type="text" id="search-input" placeholder="搜索已导入文件夹中的文档…" aria-label="搜索关键词">
      <div class="search-options">
        <label><input type="checkbox" id="search-case"> 区分大小写</label>
        <label><input type="checkbox" id="search-regex"> 正则表达式</label>
      </div>
    </div>
    <div class="search-panel-results" id="search-results"></div>
    <div class="search-panel-status" id="search-status"></div>`;
  document.body.appendChild(panel);

  panel.querySelector('.search-panel-close').onclick = () => toggleSearchPanel(false);
  const input = panel.querySelector('#search-input');
  input.addEventListener('input', () => { searchQuery = input.value; debouncedSearch(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  panel.querySelector('#search-case').onchange = (e) => { searchOptions.caseSensitive = e.target.checked; runSearch(); };
  panel.querySelector('#search-regex').onchange = (e) => { searchOptions.regex = e.target.checked; runSearch(); };
}

let searchDebounceTimer = null;
function debouncedSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => runSearch(), 300);
}

export function toggleSearchPanel(force) {
  const panel = document.getElementById('search-panel');
  if (!panel) return;
  searchPanelOpen = force !== undefined ? force : !searchPanelOpen;
  panel.hidden = !searchPanelOpen;
  if (searchPanelOpen) {
    const input = panel.querySelector('#search-input');
    if (input) { input.focus(); input.select(); }
  }
}

async function runSearch() {
  const status = document.getElementById('search-status');
  const resultsContainer = document.getElementById('search-results');
  if (!searchQuery.trim()) {
    resultsContainer.innerHTML = '';
    status.textContent = '';
    return;
  }
  status.textContent = '搜索中…';
  resultsContainer.innerHTML = '';
  try {
    const result = await window.desktop.search(searchQuery, searchOptions);
    if (!result.ok) throw new Error(result.message || '搜索失败');
    searchResults = result.results;
    renderSearchResults(result);
  } catch (error) {
    status.textContent = error.message || '搜索失败';
  }
}

function renderSearchResults(result) {
  const container = document.getElementById('search-results');
  const status = document.getElementById('search-status');
  if (result.results.length === 0) {
    status.textContent = `未找到包含「${searchQuery}」的文档`;
    container.innerHTML = '';
    return;
  }
  status.textContent = `找到 ${result.totalMatches} 处匹配，分布在 ${result.results.length} 个文件夹中`;
  container.innerHTML = result.results.map((folderResult) => {
    const folderLabel = folderResult.folder.split(/[\\/]/).pop() || folderResult.folder;
    const files = folderResult.results.map((file) => {
      const matches = file.matches.slice(0, 10).map((m) =>
        `<div class="search-match" data-folder="${escapeHtml(folderResult.folder)}" data-path="${escapeHtml(file.path)}" data-index="${m.index}" data-length="${m.length}">
          <span class="search-match-line">第 ${m.lineNumber} 行</span>
          <span class="search-match-context">${escapeHtml(m.context)}</span>
        </div>`
      ).join('');
      return `<div class="search-file">
        <div class="search-file-name">${escapeHtml(file.name)}</div>
        ${matches}
      </div>`;
    }).join('');
    return `<div class="search-folder">
      <div class="search-folder-name">${escapeHtml(folderLabel)}</div>
      ${files}
    </div>`;
  }).join('');

  container.querySelectorAll('.search-match').forEach((el) => {
    el.onclick = () => openSearchResult(el.dataset.folder, el.dataset.path, parseInt(el.dataset.index, 10), parseInt(el.dataset.length, 10));
  });
}

async function openSearchResult(folder, path, index, length) {
  try {
    const result = await window.desktop.perform('folderOpen', window.inkstoneSnapshot?.() || {}, { folder, path });
    if (result && !result.canceled) {
      window.inkstoneInstallNativeDocument?.(result, 'folderOpen');
      // TODO: position cursor at the match index
      toast(`已打开 ${path.split('/').pop()}`);
    }
  } catch (error) {
    toast(`打开文档失败：${error.message}`);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function toast(message) { window.inkstoneToast?.(message); }
