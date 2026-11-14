// AI 交互层：选区工具栏、AI 面板、Provider 设置
// 渲染层组件，通过 desktop.ai 调用主进程 AI 能力层。

let aiPanelOpen = false;
let aiProviderConfigured = false;
// 最近一次读取到的 Provider 配置（不含 API Key），用于设置面板回填。
let aiProviderStatus = { name: '', baseUrl: '', model: '', configured: false };
let aiBusy = false;
let aiActions = [];
let aiConversation = [];
let aiSelectionToolbar = null;
// 发起 AI 操作时记录的选区信息，用于接受提案时定位原文。
const aiProposalSelections = new Map();

const AI_ACTION_LABELS = {
  rewrite: '改写',
  condense: '精简',
  expand: '扩写',
  explain: '解释',
  logic: '检查逻辑',
};

const AI_HISTORY_LIMIT = 20;
const AI_BUSY_BUTTONS = ['ai-send', 'ai-review-send', 'ai-analyze-btn', 'ai-summarize-btn'];
// 理解型动作只产出回答，不提供"接受"写入，避免用解释文字覆盖原文。
const AI_READONLY_ACTIONS = new Set(['explain', 'logic']);
// 文档切换计数：请求返回时若已换文档，结果直接丢弃，避免串到新文档。
let aiContextVersion = 0;
// 最近一次分析/摘要对应的文档内容，用于提示结果是否过期。
let aiAnalysisSnapshot = null;
let aiAnalysisMode = null;
let aiAnalysisStale = false;
const ANALYSIS_PLACEHOLDER = '<div class="ai-analysis-placeholder">点击上方按钮分析当前文档</div>';

// 切换文档时清空问答、审阅、文档分析与待处理提案，避免旧文档的数据串到新文档。
export function resetAIContext() {
  aiContextVersion += 1;
  aiConversation = [];
  aiProposalSelections.clear();
  aiAnalysisSnapshot = null;
  aiAnalysisMode = null;
  setAnalysisStale(false);
  const chat = document.getElementById('ai-messages');
  const review = document.getElementById('ai-review-messages');
  const analysis = document.getElementById('ai-analysis-content');
  if (chat) chat.innerHTML = '';
  if (review) review.innerHTML = '';
  if (analysis) analysis.innerHTML = ANALYSIS_PLACEHOLDER;
  hideSelectionToolbar();
}

// 文档内容变化时由 app.js 调用：与最近一次分析的内容不一致就标记过期。
export function markAIDocumentChanged(currentText) {
  if (aiAnalysisSnapshot === null) return;
  setAnalysisStale(typeof currentText === 'string' ? currentText !== aiAnalysisSnapshot : true);
}

function setAnalysisStale(stale) {
  if (aiAnalysisStale === stale) return;
  aiAnalysisStale = stale;
  const banner = document.getElementById('ai-analysis-stale');
  if (banner) banner.hidden = !stale;
  const tab = document.querySelector('#ai-panel .ai-tab[data-tab="analysis"]');
  if (tab) tab.classList.toggle('is-stale', stale);
}

function setAIBusy(value) {
  aiBusy = value;
  for (const id of AI_BUSY_BUTTONS) {
    const button = document.getElementById(id);
    if (button) button.disabled = value;
  }
}

// 多轮对话：只保留最近的往返，和历史一起发给主进程。
function rememberAIExchange(question, answer) {
  aiConversation.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
  if (aiConversation.length > AI_HISTORY_LIMIT) aiConversation = aiConversation.slice(-AI_HISTORY_LIMIT);
}

function addAILoading(container, text) {
  if (!container) return null;
  const message = document.createElement('div');
  message.className = 'ai-message ai-message-assistant ai-message-loading';
  message.innerHTML = `<div class="ai-message-content">${escapeHtml(text)}</div>`;
  container.appendChild(message);
  container.scrollTop = container.scrollHeight;
  return message;
}

export async function initAI() {
  if (!window.desktop?.ai) return;
  try {
    aiActions = await window.desktop.ai.actions();
    const status = await window.desktop.ai.providerStatus();
    aiProviderStatus = { ...aiProviderStatus, ...status };
    aiProviderConfigured = !!status.configured;
  } catch {
    aiActions = Object.entries(AI_ACTION_LABELS).map(([key, label]) => ({ key, label }));
  }
  // 面板创建失败不能影响编辑器主流程：AI 只是可选能力。
  try {
    createAIPanel();
    createSelectionToolbar();
    createProviderSettingsDialog();
    updateAIUI();
  } catch (error) {
    console.error('AI 面板初始化失败', error);
  }
}

export function isAIAvailable() {
  return !!window.desktop?.ai;
}

function createAIPanel() {
  const panel = document.createElement('aside');
  panel.id = 'ai-panel';
  panel.className = 'ai-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'AI 助手面板');
  panel.innerHTML = `
    <div class="ai-panel-header">
      <span class="ai-panel-title">AI 助手</span>
      <button type="button" class="ai-panel-close" aria-label="关闭 AI 面板">×</button>
    </div>
    <div class="ai-panel-tabs">
      <button type="button" class="ai-tab active" data-tab="chat">问答</button>
      <button type="button" class="ai-tab" data-tab="review">修改审阅</button>
      <button type="button" class="ai-tab" data-tab="analysis">分析</button>
    </div>
    <div class="ai-panel-body">
      <div class="ai-tab-page active" data-page="chat">
        <div class="ai-messages" id="ai-messages"></div>
        <div class="ai-input-row">
          <input type="text" id="ai-question" placeholder="就当前文档提问…" aria-label="AI 问题">
          <button type="button" id="ai-send" aria-label="发送问题">发送</button>
        </div>
        <div class="ai-context-notice" id="ai-context-notice">上下文：当前文档</div>
      </div>
      <div class="ai-tab-page" data-page="review">
        <div class="ai-messages" id="ai-review-messages"></div>
        <div class="ai-input-row">
          <input type="text" id="ai-instruction" placeholder="描述你希望如何修改文档…" aria-label="修改要求">
          <button type="button" id="ai-review-send" aria-label="发送修改要求">审阅</button>
        </div>
        <div class="ai-context-notice">AI 将提出修改建议，不会直接修改文档</div>
      </div>
      <div class="ai-tab-page" data-page="analysis">
        <div class="ai-analysis-stale" id="ai-analysis-stale" hidden>
          <span>文档已修改，以下结果可能已过期</span>
          <button type="button" id="ai-analysis-refresh">重新分析</button>
        </div>
        <div class="ai-analysis-controls">
          <button type="button" id="ai-analyze-btn" class="ai-analysis-btn">分析文档结构</button>
          <button type="button" id="ai-summarize-btn" class="ai-analysis-btn">生成摘要</button>
        </div>
        <div class="ai-analysis-content" id="ai-analysis-content">
          ${ANALYSIS_PLACEHOLDER}
        </div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  panel.querySelector('.ai-panel-close').onclick = () => toggleAIPanel(false);
  panel.querySelector('[data-tab="chat"]').onclick = () => switchAITab('chat');
  panel.querySelector('[data-tab="review"]').onclick = () => switchAITab('review');
  panel.querySelector('[data-tab="analysis"]').onclick = () => switchAITab('analysis');
  panel.querySelector('#ai-send').onclick = () => sendAIQuestion();
  panel.querySelector('#ai-question').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAIQuestion(); });
  panel.querySelector('#ai-review-send').onclick = () => sendAIReview();
  panel.querySelector('#ai-instruction').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAIReview(); });
  panel.querySelector('#ai-analyze-btn').onclick = () => analyzeDocument();
  panel.querySelector('#ai-summarize-btn').onclick = () => summarizeDocument();
  panel.querySelector('#ai-analysis-refresh').onclick = () => {
    if (aiAnalysisMode === 'summary') summarizeDocument();
    else analyzeDocument();
  };
}

function createSelectionToolbar() {
  const toolbar = document.createElement('div');
  toolbar.id = 'ai-selection-toolbar';
  toolbar.className = 'ai-selection-toolbar';
  toolbar.hidden = true;
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'AI 选区操作');
  document.body.appendChild(toolbar);
  aiSelectionToolbar = toolbar;
}

function createProviderSettingsDialog() {
  const dialog = document.createElement('dialog');
  dialog.id = 'ai-settings-dialog';
  dialog.className = 'ai-settings-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="ai-settings-form">
      <h2>AI 服务设置</h2>
      <p class="ai-settings-hint">配置 OpenAI 兼容的 AI 服务。API Key 存储在本机安全存储中，不会写入文档或同步文件。</p>
      <label>服务名称
        <input type="text" id="ai-provider-name" placeholder="例如：OpenAI / DeepSeek / 通义千问">
      </label>
      <label>服务地址
        <input type="url" id="ai-provider-url" placeholder="https://api.openai.com/v1">
      </label>
      <label>模型
        <input type="text" id="ai-provider-model" placeholder="gpt-4o-mini">
      </label>
      <label>API Key
        <input type="password" id="ai-provider-key" placeholder="sk-...">
      </label>
      <div class="ai-settings-actions">
        <button type="button" id="ai-provider-save">保存</button>
        <button type="button" id="ai-provider-clear">清除配置</button>
        <button type="submit" value="cancel">关闭</button>
      </div>
      <div class="ai-provider-status" id="ai-provider-status"></div>
    </form>`;
  document.body.appendChild(dialog);

  dialog.querySelector('#ai-provider-save').onclick = async (e) => {
    e.preventDefault();
    await saveAIProvider();
  };
  dialog.querySelector('#ai-provider-clear').onclick = async (e) => {
    e.preventDefault();
    await clearAIProvider();
  };
  // 「关闭」是表单里唯一的 submit 按钮，输入框内回车会触发隐式提交直接关掉对话框，
  // 填了一半的配置就丢了。这里把输入框内的回车改为保存（输入法组合态除外）。
  dialog.querySelectorAll('input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      saveAIProvider();
    });
  });
}

function updateAIUI() {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;
  const notice = panel.querySelector('#ai-context-notice');
  if (notice && !aiProviderConfigured) {
    notice.innerHTML = '⚠ 尚未配置 AI 服务，请先在「AI → AI 服务设置」中配置。';
    notice.classList.add('ai-notice-warning');
  } else if (notice) {
    notice.textContent = '上下文：当前文档';
    notice.classList.remove('ai-notice-warning');
  }
}

export function toggleAIPanel(force) {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;
  aiPanelOpen = force !== undefined ? force : !aiPanelOpen;
  panel.hidden = !aiPanelOpen;
  // 面板打开时给内容区让出宽度，避免遮住顶栏与工具栏右侧按钮。
  document.body.classList.toggle('ai-open', aiPanelOpen);
  if (aiPanelOpen) {
    const input = panel.querySelector('#ai-question');
    if (input) input.focus();
  }
}

function switchAITab(tab) {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;
  panel.querySelectorAll('.ai-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  panel.querySelectorAll('.ai-tab-page').forEach((p) => p.classList.toggle('active', p.dataset.page === tab));
}

function getSelectionText() {
  const selection = window.getSelection();
  return selection ? selection.toString().trim() : '';
}

function showSelectionToolbar(x, y) {
  if (!aiSelectionToolbar || !isAIAvailable()) return;
  const selection = getSelectionText();
  if (!selection) { hideSelectionToolbar(); return; }
  if (!aiProviderConfigured) {
    aiSelectionToolbar.innerHTML = '<span class="ai-toolbar-hint">配置 AI 服务后可用</span>';
  } else {
    aiSelectionToolbar.innerHTML = aiActions.map((a) =>
      `<button type="button" data-action="${a.key}" title="${a.description || ''}">${a.label}</button>`
    ).join('');
    aiSelectionToolbar.querySelectorAll('button[data-action]').forEach((btn) => {
      btn.onclick = () => runAISelection(btn.dataset.action, selection);
    });
  }
  aiSelectionToolbar.style.left = `${Math.min(x, window.innerWidth - 280)}px`;
  aiSelectionToolbar.style.top = `${y + 8}px`;
  aiSelectionToolbar.hidden = false;
}

function hideSelectionToolbar() {
  if (aiSelectionToolbar) aiSelectionToolbar.hidden = true;
}

async function runAISelection(action, selection, existingOffsets) {
  if (aiBusy) return;
  if (!aiProviderConfigured) {
    toast('请先在「AI → AI 服务设置」中配置 AI 服务');
    return;
  }
  // 记录发起操作时的选区偏移；接受提案时用它定位原文，不再依赖已被面板清空的实时选区。
  const offsets = normalizeOffsets(existingOffsets || window.inkstoneGetSelection?.());
  setAIBusy(true);
  hideSelectionToolbar();
  const version = aiContextVersion;
  try {
    const document = { text: getText(), filename: getFilename() };
    const result = await window.desktop.ai.selection(action, selection, document);
    if (version !== aiContextVersion) return;
    if (!result.ok) throw new Error(result.message || 'AI 操作失败');
    aiProposalSelections.set(result.proposal.id, offsets);
    showAIProposal(result.proposal);
  } catch (error) {
    toast(friendlyError(error, 'AI 操作失败'));
  } finally {
    setAIBusy(false);
  }
}

function normalizeOffsets(offsets) {
  if (!offsets) return null;
  const start = typeof offsets.start === 'number' ? offsets.start : offsets.a;
  const end = typeof offsets.end === 'number' ? offsets.end : offsets.f;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

// 接受时重新定位原文：优先用保存的偏移（容忍选中前后的空白），文档变化后按原文回查，
// 仍然找不到就明确报错，而不是把建议写进错误的位置。
function resolveProposalRange(proposal) {
  const value = getText();
  const saved = aiProposalSelections.get(proposal.id);
  if (saved) {
    const raw = value.slice(saved.start, saved.end);
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed === proposal.originalText) return { start: saved.start + leading, end: saved.start + leading + trimmed.length };
  }
  const at = value.indexOf(proposal.originalText);
  return at >= 0 ? { start: at, end: at + proposal.originalText.length } : null;
}

function showAIProposal(proposal) {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;
  toggleAIPanel(true);
  switchAITab('review');
  const container = panel.querySelector('#ai-review-messages');
  // 解释/检查逻辑产出的是回答而非改写方案，不能"接受"覆盖原文。
  const readOnly = AI_READONLY_ACTIONS.has(proposal.actionKey);
  const card = document.createElement('div');
  card.className = 'ai-proposal-card';
  card.innerHTML = `
    <div class="ai-proposal-header">
      <span class="ai-proposal-action">${proposal.action}</span>
      <span class="ai-proposal-time">${new Date(proposal.createdAt).toLocaleTimeString()}</span>
    </div>
    <div class="ai-proposal-original${readOnly ? ' ai-proposal-context' : ''}">${escapeHtml(proposal.originalText)}</div>
    <div class="ai-proposal-suggested">${escapeHtml(proposal.suggestedText)}</div>
    <div class="ai-proposal-actions">
      ${readOnly ? '' : `<button type="button" class="ai-accept" data-id="${proposal.id}">接受</button>
      <button type="button" class="ai-reject" data-id="${proposal.id}">拒绝</button>`}
      <button type="button" class="ai-regenerate" data-action="${proposal.actionKey || ''}">重新生成</button>
      ${readOnly ? `<button type="button" class="ai-dismiss" data-id="${proposal.id}">关闭</button>` : ''}
    </div>`;
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;

  if (!readOnly) {
    card.querySelector('.ai-accept').onclick = () => acceptAIProposal(proposal);
    card.querySelector('.ai-reject').onclick = () => rejectAIProposal(proposal.id);
  } else {
    card.querySelector('.ai-dismiss').onclick = () => {
      aiProposalSelections.delete(proposal.id);
      card.remove();
    };
  }
  card.querySelector('.ai-regenerate').onclick = () => runAISelection(proposal.actionKey || 'rewrite', proposal.originalText, aiProposalSelections.get(proposal.id));
}

function acceptAIProposal(proposal) {
  if (!window.inkstoneReplaceRange) {
    toast('当前环境不支持写入文档');
    return;
  }
  const range = resolveProposalRange(proposal);
  if (!range) {
    toast('文档已变化，无法定位原选区，请重新选中后再试');
    return;
  }
  try {
    // 走模型层替换：同步更新大纲、字数、撤销栈与预览，而不是直接改 DOM。
    window.inkstoneReplaceRange(range.start, range.end, proposal.suggestedText);
    aiProposalSelections.delete(proposal.id);
    window.inkstoneToast?.('已接受 AI 修改');
  } catch (error) {
    toast(friendlyError(error, '应用 AI 修改失败'));
  }
}

function rejectAIProposal(id) {
  aiProposalSelections.delete(id);
  const card = document.querySelector(`.ai-proposal-card .ai-reject[data-id="${id}"]`)?.closest('.ai-proposal-card');
  if (card) card.remove();
  toast('已拒绝 AI 修改');
}

async function sendAIQuestion() {
  const input = document.getElementById('ai-question');
  const question = input?.value.trim();
  if (!question || aiBusy) return;
  if (!aiProviderConfigured) {
    toast('请先配置 AI 服务');
    return;
  }
  setAIBusy(true);
  const container = document.getElementById('ai-messages');
  addAIMessage(container, 'user', question);
  input.value = '';
  const pending = addAILoading(container, '正在结合文档思考…');
  const version = aiContextVersion;
  try {
    const document = { text: getText(), filename: getFilename() };
    const result = await window.desktop.ai.document(question, document, aiConversation);
    if (version !== aiContextVersion) return;
    if (!result.ok) throw new Error(result.message || 'AI 问答失败');
    addAIMessage(container, 'assistant', result.answer);
    rememberAIExchange(question, result.answer);
  } catch (error) {
    addAIMessage(container, 'error', friendlyError(error, 'AI 问答失败'));
  } finally {
    pending?.remove();
    setAIBusy(false);
  }
}

async function sendAIReview() {
  const input = document.getElementById('ai-instruction');
  const instruction = input?.value.trim();
  if (!instruction || aiBusy) return;
  if (!aiProviderConfigured) {
    toast('请先配置 AI 服务');
    return;
  }
  setAIBusy(true);
  const container = document.getElementById('ai-review-messages');
  addAIMessage(container, 'user', instruction);
  input.value = '';
  const pending = addAILoading(container, '正在审阅文档…');
  const version = aiContextVersion;
  try {
    const document = { text: getText(), filename: getFilename() };
    const result = await window.desktop.ai.review(instruction, document);
    if (version !== aiContextVersion) return;
    if (!result.ok) throw new Error(result.message || 'AI 审阅失败');
    addAIMessage(container, 'assistant', result.review);
  } catch (error) {
    addAIMessage(container, 'error', friendlyError(error, 'AI 审阅失败'));
  } finally {
    pending?.remove();
    setAIBusy(false);
  }
}

async function analyzeDocument() {
  const content = document.getElementById('ai-analysis-content');
  if (!content || aiBusy) return;
  setAIBusy(true);
  content.innerHTML = '<div class="ai-analysis-loading">正在分析文档结构…</div>';
  const version = aiContextVersion;
  try {
    const document = { text: getText(), filename: getFilename() };
    const result = await window.desktop.ai.analyze(document);
    if (version !== aiContextVersion) return;
    if (!result.ok) throw new Error(result.message || '文档分析失败');
    renderAnalysis(content, result.analysis);
    aiAnalysisSnapshot = document.text;
    aiAnalysisMode = 'structure';
    markAIDocumentChanged(getText());
  } catch (error) {
    if (version === aiContextVersion) {
      content.innerHTML = `<div class="ai-analysis-error">${escapeHtml(friendlyError(error, '文档分析失败'))}</div>`;
    }
  } finally {
    setAIBusy(false);
  }
}

async function summarizeDocument() {
  const content = document.getElementById('ai-analysis-content');
  if (!content || aiBusy) return;
  if (!aiProviderConfigured) {
    toast('请先配置 AI 服务');
    return;
  }
  setAIBusy(true);
  content.innerHTML = '<div class="ai-analysis-loading">正在生成摘要…</div>';
  const version = aiContextVersion;
  try {
    const document = { text: getText(), filename: getFilename() };
    const result = await window.desktop.ai.summarize(document);
    if (version !== aiContextVersion) return;
    if (!result.ok) throw new Error(result.message || '文档摘要失败');
    renderSummary(content, result.summary);
    aiAnalysisSnapshot = document.text;
    aiAnalysisMode = 'summary';
    markAIDocumentChanged(getText());
  } catch (error) {
    if (version === aiContextVersion) {
      content.innerHTML = `<div class="ai-analysis-error">${escapeHtml(friendlyError(error, '文档摘要失败'))}</div>`;
    }
  } finally {
    setAIBusy(false);
  }
}

function renderAnalysis(container, analysis) {
  const { outline, stats } = analysis;
  const outlineHtml = outline.length > 0
    ? `<div class="ai-analysis-section"><h3>文档大纲</h3><ul class="ai-outline">${outline.map((h) =>
        `<li class="ai-outline-item ai-outline-level-${h.level}"><span class="ai-outline-marker">${'#'.repeat(h.level)}</span>${escapeHtml(h.title)}</li>`
      ).join('')}</ul></div>`
    : '<div class="ai-analysis-section"><p class="ai-analysis-empty">未检测到标题结构</p></div>';
  const statsHtml = `<div class="ai-analysis-section"><h3>统计信息</h3><div class="ai-stats-grid">
    <div class="ai-stat"><span class="ai-stat-value">${stats.wordCount}</span><span class="ai-stat-label">字数</span></div>
    <div class="ai-stat"><span class="ai-stat-value">${stats.charCount}</span><span class="ai-stat-label">字符</span></div>
    <div class="ai-stat"><span class="ai-stat-value">${stats.paragraphCount}</span><span class="ai-stat-label">段落</span></div>
    <div class="ai-stat"><span class="ai-stat-value">${stats.codeBlockCount}</span><span class="ai-stat-label">代码块</span></div>
    <div class="ai-stat"><span class="ai-stat-value">${stats.lineCount}</span><span class="ai-stat-label">行数</span></div>
    <div class="ai-stat"><span class="ai-stat-value">${stats.headingCount}</span><span class="ai-stat-label">标题</span></div>
  </div></div>`;
  container.innerHTML = outlineHtml + statsHtml;
}

function renderSummary(container, summary) {
  container.innerHTML = `<div class="ai-analysis-section"><h3>文档摘要</h3><div class="ai-summary">${escapeHtml(summary)}</div></div>`;
}

function addAIMessage(container, role, text) {
  if (!container) return;
  const msg = document.createElement('div');
  msg.className = `ai-message ai-message-${role}`;
  msg.innerHTML = `<div class="ai-message-content">${escapeHtml(text)}</div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

// 用最近一次读到的配置回填表单；API Key 不回填，留空即视为不修改。
function fillProviderForm() {
  const nameInput = document.getElementById('ai-provider-name');
  if (!nameInput) return;
  const status = aiProviderStatus || {};
  nameInput.value = status.name || '';
  document.getElementById('ai-provider-url').value = status.baseUrl || '';
  document.getElementById('ai-provider-model').value = status.model || '';
  const keyInput = document.getElementById('ai-provider-key');
  keyInput.value = '';
  keyInput.placeholder = status.configured ? '已配置，留空则不修改' : 'sk-...';
  const statusEl = document.getElementById('ai-provider-status');
  if (statusEl) {
    statusEl.textContent = status.configured
      ? `当前服务：${status.name || '自定义'} · ${status.model || '默认模型'}`
      : '尚未配置 AI 服务';
  }
}

async function saveAIProvider() {
  const config = {};
  const name = document.getElementById('ai-provider-name')?.value.trim() || '';
  const baseUrl = document.getElementById('ai-provider-url')?.value.trim() || '';
  const model = document.getElementById('ai-provider-model')?.value.trim() || '';
  const apiKey = document.getElementById('ai-provider-key')?.value.trim() || '';
  // 留空的字段不提交：空字符串表示"未修改"，避免只改模型时把已保存的 Key 清掉。
  if (name) config.name = name;
  if (baseUrl) config.baseUrl = baseUrl;
  if (model) config.model = model;
  if (apiKey) config.apiKey = apiKey;
  try {
    const result = await window.desktop.ai.saveProvider(config);
    if (result.ok) {
      aiProviderStatus = { ...aiProviderStatus, ...result.status };
      aiProviderConfigured = !!result.status.configured;
      fillProviderForm();
      document.getElementById('ai-provider-status').textContent = result.status.configured ? '✓ 配置已保存' : '配置已保存，但缺少 API Key';
      updateAIUI();
      toast('AI 服务配置已保存');
    } else {
      throw new Error(result.message || '保存失败');
    }
  } catch (error) {
    toast(friendlyError(error, '保存失败'));
  }
}

async function clearAIProvider() {
  try {
    const result = await window.desktop.ai.clearProvider();
    if (result.ok) {
      aiProviderConfigured = false;
      aiProviderStatus = { name: '', baseUrl: '', model: '', configured: false };
      fillProviderForm();
      document.getElementById('ai-provider-status').textContent = '配置已清除';
      updateAIUI();
      toast('AI 服务配置已清除');
    }
  } catch (error) {
    toast(friendlyError(error, '清除失败'));
  }
}

export function openAISettings() {
  const dialog = document.getElementById('ai-settings-dialog');
  if (!dialog) return;
  if (dialog.open) dialog.close();
  else {
    fillProviderForm();
    dialog.showModal();
  }
}

export function handleAICommand(action) {
  if (action === 'aiPanel') return toggleAIPanel();
  if (action === 'aiSettings') return openAISettings();
  const actionMap = { aiRewrite: 'rewrite', aiCondense: 'condense', aiExpand: 'expand', aiExplain: 'explain', aiLogic: 'logic' };
  const key = actionMap[action];
  if (key) {
    const selection = getSelectionText();
    if (!selection) { toast('请先选中一段文字'); return; }
    runAISelection(key, selection);
  }
}

// --- Selection toolbar events ---
export function setupSelectionToolbar() {
  document.addEventListener('selectionchange', () => {
    if (!isAIAvailable()) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) { hideSelectionToolbar(); return; }
    const text = selection.toString().trim();
    if (!text) { hideSelectionToolbar(); return; }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    showSelectionToolbar(rect.left + rect.width / 2, rect.bottom + window.scrollY);
  });
  document.addEventListener('scroll', hideSelectionToolbar);
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ai-selection-toolbar')) hideSelectionToolbar();
  });
}

// --- Helpers ---
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// These are provided by app.js via global scope.
function getText() { return window.inkstoneGetText?.() || ''; }
function getFilename() { return window.inkstoneGetFilename?.() || '未命名.md'; }
function toast(message) { window.inkstoneToast?.(message); }
function friendlyError(error, fallback) {
  const message = String(error?.message || error || '');
  return message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, '').replace(/^Error:\s*/i, '') || fallback;
}
