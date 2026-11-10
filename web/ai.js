// AI 交互层：选区工具栏、AI 面板、Provider 设置
// 渲染层组件，通过 desktop.ai 调用主进程 AI 能力层。

let aiPanelOpen = false;
let aiProviderConfigured = false;
let aiBusy = false;
let aiActions = [];
let aiConversation = [];
let aiSelectionToolbar = null;

const AI_ACTION_LABELS = {
  rewrite: '改写',
  condense: '精简',
  expand: '扩写',
  explain: '解释',
  logic: '检查逻辑',
};

export async function initAI() {
  if (!window.desktop?.ai) return;
  try {
    aiActions = await window.desktop.ai.actions();
    const status = await window.desktop.ai.providerStatus();
    aiProviderConfigured = status.configured;
  } catch {
    aiActions = Object.entries(AI_ACTION_LABELS).map(([key, label]) => ({ key, label }));
  }
  createAIPanel();
  createSelectionToolbar();
  createProviderSettingsDialog();
  updateAIUI();
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
    </div>`;
  document.querySelector('.app').appendChild(panel);

  panel.querySelector('.ai-panel-close').onclick = () => toggleAIPanel(false);
  panel.querySelector('[data-tab="chat"]').onclick = () => switchAITab('chat');
  panel.querySelector('[data-tab="review"]').onclick = () => switchAITab('review');
  panel.querySelector('#ai-send').onclick = () => sendAIQuestion();
  panel.querySelector('#ai-question').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAIQuestion(); });
  panel.querySelector('#ai-review-send').onclick = () => sendAIReview();
  panel.querySelector('#ai-instruction').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAIReview(); });
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

async function runAISelection(action, selection) {
  if (aiBusy) return;
  if (!aiProviderConfigured) {
    toast('请先在「AI → AI 服务设置」中配置 AI 服务');
    return;
  }
  aiBusy = true;
  hideSelectionToolbar();
  try {
    const document = { text: getText(), filename: getFilename() };
    const result = await window.desktop.ai.selection(action, selection, document);
    if (!result.ok) throw new Error(result.message || 'AI 操作失败');
    showAIProposal(result.proposal);
  } catch (error) {
    toast(friendlyError(error, 'AI 操作失败'));
  } finally {
    aiBusy = false;
  }
}

function showAIProposal(proposal) {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;
  toggleAIPanel(true);
  switchAITab('review');
  const container = panel.querySelector('#ai-review-messages');
  const card = document.createElement('div');
  card.className = 'ai-proposal-card';
  card.innerHTML = `
    <div class="ai-proposal-header">
      <span class="ai-proposal-action">${proposal.action}</span>
      <span class="ai-proposal-time">${new Date(proposal.createdAt).toLocaleTimeString()}</span>
    </div>
    <div class="ai-proposal-original">${escapeHtml(proposal.originalText)}</div>
    <div class="ai-proposal-suggested">${escapeHtml(proposal.suggestedText)}</div>
    <div class="ai-proposal-actions">
      <button type="button" class="ai-accept" data-id="${proposal.id}">接受</button>
      <button type="button" class="ai-reject" data-id="${proposal.id}">拒绝</button>
      <button type="button" class="ai-regenerate" data-action="${proposal.action}">重新生成</button>
    </div>`;
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;

  card.querySelector('.ai-accept').onclick = () => acceptAIProposal(proposal);
  card.querySelector('.ai-reject').onclick = () => rejectAIProposal(proposal.id);
  card.querySelector('.ai-regenerate').onclick = () => runAISelection(proposal.actionKey || 'rewrite', proposal.originalText);
}

async function acceptAIProposal(proposal) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    toast('未找到可替换的选区');
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(document.createTextNode(proposal.suggestedText));
  selection.removeAllRanges();
  window.inkstoneUpdateUI?.();
  window.inkstoneToast?.('已接受 AI 修改');
}

function rejectAIProposal(id) {
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
  aiBusy = true;
  const container = document.getElementById('ai-messages');
  addAIMessage(container, 'user', question);
  input.value = '';
  try {
    const document = { text: getText(), filename: getFilename() };
    const result = await window.desktop.ai.document(question, document);
    if (!result.ok) throw new Error(result.message || 'AI 问答失败');
    addAIMessage(container, 'assistant', result.answer);
  } catch (error) {
    addAIMessage(container, 'error', friendlyError(error, 'AI 问答失败'));
  } finally {
    aiBusy = false;
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
  aiBusy = true;
  const container = document.getElementById('ai-review-messages');
  addAIMessage(container, 'user', instruction);
  input.value = '';
  try {
    const document = { text: getText(), filename: getFilename() };
    const result = await window.desktop.ai.review(instruction, document);
    if (!result.ok) throw new Error(result.message || 'AI 审阅失败');
    addAIMessage(container, 'assistant', result.review);
  } catch (error) {
    addAIMessage(container, 'error', friendlyError(error, 'AI 审阅失败'));
  } finally {
    aiBusy = false;
  }
}

function addAIMessage(container, role, text) {
  if (!container) return;
  const msg = document.createElement('div');
  msg.className = `ai-message ai-message-${role}`;
  msg.innerHTML = `<div class="ai-message-content">${escapeHtml(text)}</div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

async function saveAIProvider() {
  const config = {
    name: document.getElementById('ai-provider-name')?.value.trim() || '',
    baseUrl: document.getElementById('ai-provider-url')?.value.trim() || '',
    model: document.getElementById('ai-provider-model')?.value.trim() || '',
    apiKey: document.getElementById('ai-provider-key')?.value || '',
  };
  try {
    const result = await window.desktop.ai.saveProvider(config);
    if (result.ok) {
      aiProviderConfigured = result.status.configured;
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
      document.getElementById('ai-provider-name').value = '';
      document.getElementById('ai-provider-url').value = '';
      document.getElementById('ai-provider-model').value = '';
      document.getElementById('ai-provider-key').value = '';
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
  else dialog.showModal();
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
