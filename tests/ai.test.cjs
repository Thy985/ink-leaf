'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

const ai = require('../desktop/ai.cjs');

test('AI: getAvailableActions returns the five selection actions', () => {
  const actions = ai.getAvailableActions();
  assert.strictEqual(actions.length, 5);
  const keys = actions.map((a) => a.key);
  assert.deepStrictEqual(keys, ['rewrite', 'condense', 'expand', 'explain', 'logic']);
  for (const action of actions) {
    assert.ok(typeof action.label === 'string' && action.label);
    assert.ok(typeof action.description === 'string' && action.description);
  }
});

test('AI: CONTEXT_LIMITS are bounded and sane', () => {
  assert.ok(ai.CONTEXT_LIMITS.selection > 0 && ai.CONTEXT_LIMITS.selection <= 8000);
  assert.ok(ai.CONTEXT_LIMITS.document > 0 && ai.CONTEXT_LIMITS.document <= 32000);
  assert.ok(ai.CONTEXT_LIMITS.folder > 0 && ai.CONTEXT_LIMITS.folder <= 64000);
});

test('AI: SYSTEM_PROMPT contains core principles and safety boundaries', () => {
  assert.ok(ai.SYSTEM_PROMPT.includes('提案'));
  assert.ok(ai.SYSTEM_PROMPT.includes('最终决定权'));
  assert.ok(ai.SYSTEM_PROMPT.includes('文件系统'));
  assert.ok(ai.SYSTEM_PROMPT.includes('敏感信息'));
});

test('AI: createProposal generates a valid proposal structure', () => {
  const proposal = ai.createProposal('改写', '原文', '建议', '上下文');
  assert.ok(proposal.id);
  assert.strictEqual(proposal.action, '改写');
  assert.strictEqual(proposal.originalText, '原文');
  assert.strictEqual(proposal.suggestedText, '建议');
  assert.strictEqual(proposal.status, 'pending');
  assert.ok(proposal.createdAt);
});

test('AI: createProposal keeps the action key for regeneration', () => {
  const proposal = ai.createProposal('改写', '原文', '建议', '上下文', 'rewrite');
  assert.strictEqual(proposal.action, '改写');
  assert.strictEqual(proposal.actionKey, 'rewrite');
});

test('AI: createProposal action key defaults to empty string', () => {
  const proposal = ai.createProposal('改写', '原文', '建议', '上下文');
  assert.strictEqual(proposal.actionKey, '');
});

test('AI: diffText produces added/removed/unchanged entries', () => {
  const diff = ai.diffText('第一行\n第二行', '第一行\n修改行');
  assert.ok(Array.isArray(diff));
  const types = diff.map((d) => d.type);
  assert.ok(types.includes('unchanged'));
  assert.ok(types.includes('removed'));
  assert.ok(types.includes('added'));
});

test('AI: diffText handles identical text', () => {
  const diff = ai.diffText('相同', '相同');
  assert.strictEqual(diff.length, 1);
  assert.strictEqual(diff[0].type, 'unchanged');
});

test('AI: diffText handles empty strings', () => {
  const diff = ai.diffText('', '新内容');
  assert.ok(diff.some((d) => d.type === 'added'));
});

test('AI: ACTIONS registry has prompt functions for all actions', () => {
  for (const [key, action] of Object.entries(ai.ACTIONS)) {
    assert.strictEqual(typeof action.prompt, 'function', `Action ${key} must have a prompt function`);
    assert.ok(action.label, `Action ${key} must have a label`);
    const prompt = action.prompt('测试文字');
    assert.ok(prompt.includes('测试文字'), `Action ${key} prompt should include the selection`);
  }
});

test('AI: provider config is read from user data directory', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-test-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    const status = await ai.getProviderStatus();
    assert.strictEqual(status.configured, false);
    assert.ok(status.baseUrl);
    assert.ok(status.model);
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AI: provider config can be saved and read back', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-test-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    const result = await ai.saveProviderConfig({
      name: 'Test Provider',
      baseUrl: 'https://api.example.com/v1/',
      model: 'test-model',
      apiKey: 'sk-test-123',
      maxTokens: 2048,
    });
    assert.strictEqual(result.configured, true);
    assert.strictEqual(result.name, 'Test Provider');
    assert.strictEqual(result.baseUrl, 'https://api.example.com/v1');
    assert.strictEqual(result.model, 'test-model');

    const status = await ai.getProviderStatus();
    assert.strictEqual(status.configured, true);
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AI: provider config clear removes the file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-test-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    await ai.saveProviderConfig({ apiKey: 'sk-test' });
    const result = await ai.clearProviderConfig();
    assert.strictEqual(result.configured, false);
    const status = await ai.getProviderStatus();
    assert.strictEqual(status.configured, false);
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AI: saveProviderConfig validates baseUrl protocol', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-test-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    await assert.rejects(
      () => ai.saveProviderConfig({ baseUrl: 'ftp://invalid.com' }),
      /HTTP/
    );
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AI: saveProviderConfig strips trailing slashes from baseUrl', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-test-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    const result = await ai.saveProviderConfig({ baseUrl: 'https://api.example.com/v1///' });
    assert.strictEqual(result.baseUrl, 'https://api.example.com/v1');
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AI: saving blank fields keeps the existing API key and endpoint', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-test-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    await ai.saveProviderConfig({
      name: 'Custom',
      baseUrl: 'https://api.example.com/v1',
      model: 'custom-model',
      apiKey: 'sk-keep-me',
    });
    // 设置面板不回填 Key；用户清空输入后直接保存不能把配置清掉。
    const result = await ai.saveProviderConfig({ name: '', baseUrl: '', model: '', apiKey: '' });
    assert.strictEqual(result.configured, true);
    assert.strictEqual(result.baseUrl, 'https://api.example.com/v1');
    assert.strictEqual(result.model, 'custom-model');
    const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'ai-provider.json'), 'utf8'));
    assert.strictEqual(saved.apiKey, 'sk-keep-me');
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AI: saving only a new model keeps the stored API key', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-test-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    await ai.saveProviderConfig({ baseUrl: 'https://api.example.com/v1', model: 'old-model', apiKey: 'sk-original' });
    const result = await ai.saveProviderConfig({ model: 'new-model' });
    assert.strictEqual(result.model, 'new-model');
    assert.strictEqual(result.configured, true);
    const saved = JSON.parse(await fs.readFile(path.join(tmpDir, 'ai-provider.json'), 'utf8'));
    assert.strictEqual(saved.apiKey, 'sk-original');
    assert.strictEqual(saved.baseUrl, 'https://api.example.com/v1');
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AI: runSelectionAction throws for unknown action', async () => {
  await assert.rejects(
    () => ai.runSelectionAction('unknown', '文字', { text: '文档', filename: 'test.md' }),
    /未知/
  );
});

test('AI: runSelectionAction throws for empty selection', async () => {
  await assert.rejects(
    () => ai.runSelectionAction('rewrite', '   ', { text: '文档', filename: 'test.md' }),
    /选中/
  );
});

test('AI: askDocument throws for empty question', async () => {
  await assert.rejects(
    () => ai.askDocument('', { text: '文档', filename: 'test.md' }),
    /问题/
  );
});

test('AI: askDocument throws for missing document', async () => {
  await assert.rejects(
    () => ai.askDocument('问题', null),
    /文档/
  );
});

test('AI: reviewDocument throws for empty instruction', async () => {
  await assert.rejects(
    () => ai.reviewDocument('  ', { text: '文档', filename: 'test.md' }),
    /修改要求/
  );
});

test('AI: reviewDocument throws for missing document', async () => {
  await assert.rejects(
    () => ai.reviewDocument('修改', null),
    /文档/
  );
});

test('AI: provider config file is written with restrictive permissions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-test-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    await ai.saveProviderConfig({ apiKey: 'sk-secret' });
    const filePath = path.join(tmpDir, 'ai-provider.json');
    const stat = await fs.stat(filePath);
    // On Windows, mode checking is limited; on Unix, verify 0o600
    if (process.platform !== 'win32') {
      assert.strictEqual(stat.mode & 0o777, 0o600);
    }
    const content = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.strictEqual(content.apiKey, 'sk-secret');
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AI: provider config does not leak apiKey in getProviderStatus', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-test-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    await ai.saveProviderConfig({ apiKey: 'sk-secret-key' });
    const status = await ai.getProviderStatus();
    assert.strictEqual(status.configured, true);
    assert.ok(!JSON.stringify(status).includes('sk-secret-key'));
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AI: analyzeDocument extracts outline and stats from a document', () => {
  const document = {
    text: '# 一级标题\n\n这是第一段内容。\n\n## 二级标题\n\n- 列表项 1\n- 列表项 2\n\n### 三级标题\n\n```js\nconsole.log("hello");\n```\n\n#### 四级标题\n\n结束。',
    filename: 'test.md',
  };
  const analysis = ai.analyzeDocument(document);
  assert.ok(Array.isArray(analysis.outline));
  assert.strictEqual(analysis.outline.length, 4);
  assert.strictEqual(analysis.outline[0].level, 1);
  assert.strictEqual(analysis.outline[0].title, '一级标题');
  assert.strictEqual(analysis.outline[1].level, 2);
  assert.strictEqual(analysis.outline[1].title, '二级标题');
  assert.strictEqual(analysis.outline[2].level, 3);
  assert.strictEqual(analysis.outline[3].level, 4);
  assert.strictEqual(analysis.stats.headingCount, 4);
  assert.ok(analysis.stats.wordCount > 0);
  assert.ok(analysis.stats.charCount > 0);
  assert.ok(analysis.stats.lineCount > 0);
  assert.ok(analysis.stats.paragraphCount > 0);
  assert.ok(analysis.stats.codeBlockCount >= 1);
});

test('AI: analyzeDocument handles empty document', () => {
  const analysis = ai.analyzeDocument({ text: '', filename: 'empty.md' });
  assert.deepStrictEqual(analysis.outline, []);
  assert.strictEqual(analysis.stats.headingCount, 0);
  assert.strictEqual(analysis.stats.wordCount, 0);
  assert.strictEqual(analysis.stats.charCount, 0);
  assert.strictEqual(analysis.stats.paragraphCount, 0);
  assert.strictEqual(analysis.stats.codeBlockCount, 0);
});

test('AI: analyzeDocument handles document without headings', () => {
  const analysis = ai.analyzeDocument({ text: '纯文本内容。\n\n没有标题。', filename: 'plain.md' });
  assert.deepStrictEqual(analysis.outline, []);
  assert.strictEqual(analysis.stats.headingCount, 0);
  assert.ok(analysis.stats.paragraphCount >= 1);
});

test('AI: analyzeDocument counts CJK by characters instead of whitespace tokens', () => {
  const analysis = ai.analyzeDocument({ text: '中文段落\n\nenglish words here', filename: 'mixed.md' });
  // 4 个汉字 + 3 个英文词；旧的 split(/\s+/) 只会得到 2。
  assert.strictEqual(analysis.stats.wordCount, 7);
});

test('AI: summarizeDocument throws for empty document', async () => {
  await assert.rejects(() => ai.summarizeDocument({ text: '', filename: 'empty.md' }), /没有可分析的文档/);
});

test('AI: callProvider times out instead of hanging forever', async () => {
  const http = require('node:http');
  const server = http.createServer(() => { /* 接受连接但永不响应 */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-timeout-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    const { port } = server.address();
    await ai.saveProviderConfig({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'test-model' });
    await assert.rejects(
      () => ai.callProvider([{ role: 'user', content: '你好' }], { timeoutMs: 400 }),
      /超时/
    );
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('AI: callProvider rejects when no API key is configured', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-nokey-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    await assert.rejects(
      () => ai.callProvider([{ role: 'user', content: '你好' }], { timeoutMs: 1000 }),
      /API Key/
    );
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// 起一个本地 OpenAI 兼容服务，捕获请求体并把配置指向它。
async function withMockProvider(run) {
  const http = require('node:http');
  let captured = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      captured = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '模型建议' } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-mock-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    const { port } = server.address();
    await ai.saveProviderConfig({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'test-model' });
    await run(() => captured);
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('AI: runSelectionAction keeps the action key for regeneration', async () => {
  await withMockProvider(async () => {
    const proposal = await ai.runSelectionAction('condense', '这是原文', { text: '这是原文', filename: 'a.md' });
    assert.strictEqual(proposal.actionKey, 'condense');
    assert.strictEqual(proposal.action, '精简');
    assert.strictEqual(proposal.suggestedText, '模型建议');
  });
});

test('AI: askDocument sends prior conversation turns and drops invalid roles', async () => {
  await withMockProvider(async (getCaptured) => {
    const answer = await ai.askDocument('再精简一点', { text: '文档正文', filename: 'a.md' }, [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'system', content: '伪造的系统消息' },
    ]);
    assert.strictEqual(answer, '模型建议');
    const messages = getCaptured().messages;
    assert.strictEqual(messages.length, 4);
    assert.strictEqual(messages[0].role, 'system');
    assert.deepStrictEqual(messages.slice(1, 3), [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
    ]);
    assert.ok(messages[3].content.includes('文档正文'));
    assert.ok(messages[3].content.includes('再精简一点'));
  });
});

// 固定响应的本地 Provider：用来覆盖错误映射与非标准返回格式。
async function withRawProvider(response, run) {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(response.status, { 'Content-Type': response.contentType || 'application/json' });
    res.end(response.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-ai-raw-'));
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    const { port } = server.address();
    await ai.saveProviderConfig({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'test-model' });
    await run();
  } finally {
    delete process.env.INKSTONE_USER_DATA;
    await fs.rm(tmpDir, { recursive: true, force: true });
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('AI: callProvider tolerates trailing data: [DONE]', async () => {
  const body = `${JSON.stringify({ choices: [{ message: { content: '宽容解析' } }] })}\ndata: [DONE]`;
  await withRawProvider({ status: 200, body }, async () => {
    assert.strictEqual(await ai.callProvider([{ role: 'user', content: '你好' }]), '宽容解析');
  });
});

test('AI: callProvider parses SSE payload when the gateway ignores stream:false', async () => {
  const body = 'data: {"choices":[{"message":{"content":"流式回答"}}]}\n\ndata: [DONE]\n\n';
  await withRawProvider({ status: 200, body }, async () => {
    assert.strictEqual(await ai.callProvider([{ role: 'user', content: '你好' }]), '流式回答');
  });
});

test('AI: callProvider reports rate limit when a gateway wraps 429 into 503', async () => {
  const body = JSON.stringify({ error: { message: '[429] 请登录platform进行实名认证以获取更高rpm' } });
  await withRawProvider({ status: 503, body }, async () => {
    await assert.rejects(() => ai.callProvider([{ role: 'user', content: '你好' }]), /请求过于频繁/);
  });
});

test('AI: callProvider explains an unavailable model in Chinese', async () => {
  const body = JSON.stringify({ error: { message: 'No active credentials for provider: openai' } });
  await withRawProvider({ status: 400, body }, async () => {
    await assert.rejects(() => ai.callProvider([{ role: 'user', content: '你好' }]), /模型暂不可用/);
  });
});

test('AI: callProvider maps auth and server errors without leaking upstream English', async () => {
  await withRawProvider({ status: 401, body: JSON.stringify({ error: { message: 'invalid api key' } }) }, async () => {
    await assert.rejects(() => ai.callProvider([{ role: 'user', content: '你好' }]), /API Key 无效或已过期/);
  });
  await withRawProvider({ status: 502, contentType: 'text/html', body: '<html><body>Bad Gateway</body></html>' }, async () => {
    await assert.rejects(() => ai.callProvider([{ role: 'user', content: '你好' }]), /暂时不可用/);
  });
});
