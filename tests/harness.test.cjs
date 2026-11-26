'use strict';

// H0 Agent Harness 验收测试。
// 全部走本地 mock 网关，不发真实网络请求；每个用例结束后关闭服务并清理临时目录。

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const ai = require('../desktop/ai.cjs');

// ai/ 目录是 ESM，测试用 CommonJS 运行，所以在用例里惰性加载并缓存。
let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = Promise.all([
      import('../desktop/ai/provider.mjs'),
      import('../desktop/ai/harness.mjs'),
      import('../desktop/ai/tools.mjs'),
      import('../desktop/ai/schema.mjs'),
    ]).then(([provider, harness, tools, schema]) => ({ provider, harness, tools, schema }));
  }
  return modsPromise;
}

// ---------------------------------------------------------------------------
// 辅助：临时文件夹与脚本化 mock 网关
// ---------------------------------------------------------------------------

async function withTempFolder(files, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h0-folder-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), content, 'utf8');
  }
  try { return await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

// 按轮次返回脚本化响应的网关。每一轮可以返回工具调用或最终回答。
async function withScriptedServer(rounds, run) {
  let round = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const script = rounds[Math.min(round, rounds.length - 1)];
      round += 1;
      const { status = 200, payload } = script(parsed, round);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { return await run(`http://127.0.0.1:${port}/v1`, requests); }
  finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
}

function completion(message, finishReason) {
  return {
    id: 'x', object: 'chat.completion', created: 1, model: 'mock',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function toolCallRound(name, args) {
  return () => ({
    payload: completion({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    }, 'tool_calls'),
  });
}

function finalRound(textFor = () => '完成') {
  return (body) => {
    const toolMessage = body.messages.find((m) => m.role === 'tool');
    return { payload: completion({ role: 'assistant', content: textFor(toolMessage) }, 'stop') };
  };
}

// ---------------------------------------------------------------------------
// 1. 端到端：提问 → 自动调用 search_folder → 引用文档段落
// ---------------------------------------------------------------------------

test('H0: 提问触发 search_folder 并带回命中结果', async () => {
  await withTempFolder({ 'note.md': '# 笔记\n\n这是一段关于检索的内容。\n', 'other.md': '无关。\n' }, async (root) => {
    await withScriptedServer([
      toolCallRound('search_folder', { query: '检索' }),
      finalRound((toolMessage) => `检索到了：${toolMessage ? String(toolMessage.content).slice(0, 80) : '无'}`),
    ], async (baseUrl) => {
      const { tools, harness, provider } = await mods();
      const { registry } = tools.createTools({ folders: [root] });
      const result = await harness.runAgent({
        model: provider.createProvider({ baseUrl, apiKey: 'k' })('mock'),
        system: '测试',
        messages: [{ role: 'user', content: '找一下检索相关内容' }],
        registry,
      });
      assert.strictEqual(result.toolCalls, 1, '应当调用一次工具');
      assert.ok(result.text.includes('note.md'), `回答应提到命中文档，实际：${result.text}`);
      assert.strictEqual(result.steps, 2, '应当有两轮：工具调用 + 最终回答');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. trace：每步记录工具名、耗时、结果，且不含文档正文
// ---------------------------------------------------------------------------

test('H0: trace 记录步骤信息且不泄露文档正文', async () => {
  await withTempFolder({ 'secret.md': '# 内部\n\n机密正文不应出现在 trace 中。\n' }, async (root) => {
    await withScriptedServer([
      toolCallRound('search_folder', { query: '机密' }),
      finalRound(),
    ], async (baseUrl) => {
      const { tools, harness, provider } = await mods();
      const { registry } = tools.createTools({ folders: [root] });
      const result = await harness.runAgent({
        model: provider.createProvider({ baseUrl, apiKey: 'k' })('mock'),
        system: '测试',
        messages: [{ role: 'user', content: '查机密' }],
        registry,
      });
      assert.strictEqual(result.trace.length, 1);
      const step = result.trace[0];
      assert.strictEqual(step.toolName, 'search_folder');
      assert.strictEqual(step.outcome, 'ok');
      assert.strictEqual(typeof step.durationMs, 'number');
      assert.strictEqual(typeof step.stepIndex, 'number');
      // trace 会进日志与 UI，绝不能带上正文。
      assert.ok(!JSON.stringify(step).includes('机密正文不应出现在 trace 中'), 'trace 泄露了文档正文');
    });
  });
});

// ---------------------------------------------------------------------------
// 3. 安全钩子：非白名单工具、schema 不符、越界文件夹
// ---------------------------------------------------------------------------

test('H0: guard 拒绝非白名单工具', async () => {
  const { tools, provider } = await mods();
      const { registry } = tools.createTools({ folders: [] });
  const verdict = await tools.guard('delete_file', { path: 'x.md' }, registry);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /不在允许列表/);
});

test('H0: guard 拒绝不符合 schema 的参数', async () => {
  const { tools, provider } = await mods();
      const { registry } = tools.createTools({ folders: [] });
  assert.strictEqual((await tools.guard('search_folder', {}, registry)).ok, false, '缺 query 应拒绝');
  assert.strictEqual((await tools.guard('search_folder', { query: '' }, registry)).ok, false, '空 query 应拒绝');
  assert.strictEqual((await tools.guard('search_folder', { query: 'x', evil: 1 }, registry)).ok, false, '多余参数应拒绝');
  assert.strictEqual((await tools.guard('search_folder', { query: 42 }, registry)).ok, false, '非字符串应拒绝');
});

test('H0: search_folder 拒绝未导入的文件夹而不是静默搜全部', async () => {
  await withTempFolder({ 'inside.md': '命中关键词 alpha\n' }, async (root) => {
    const { tools } = await mods();
    const { registry } = tools.createTools({ folders: [root] });
    // 指向父目录：不在已导入列表内。必须明确拒绝，而**不能**退化成搜全部——
    // 否则用户以为只搜了一个文件夹，实际范围更大。
    const outside = path.join(root, '..');
    const result = await registry.search_folder.run({ query: 'alpha', folder: outside });
    assert.deepStrictEqual(result.results, [], '越界文件夹不应返回任何结果');
    assert.match(result.note, /只能检索已在墨页中导入的文件夹/);
  });
});

test('H0: search_folder 的 folder 参数确实生效（限定范围）', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h0-scope-'));
  const a = path.join(parent, 'a');
  const b = path.join(parent, 'b');
  await fs.mkdir(a);
  await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'a.md'), '共同关键词 alpha\n', 'utf8');
  await fs.writeFile(path.join(b, 'b.md'), '共同关键词 alpha\n', 'utf8');
  try {
    const { tools } = await mods();
    const { registry } = tools.createTools({ folders: [a, b] });
    // 不限定时应命中两个文件夹。
    const all = await registry.search_folder.run({ query: 'alpha' });
    assert.strictEqual(all.results.length, 2, `不限范围应命中 2 个，实际 ${all.results.length}`);
    // 限定其中一个时只应命中它。
    const only = await registry.search_folder.run({ query: 'alpha', folder: a });
    assert.strictEqual(only.results.length, 1, `限定范围应命中 1 个，实际 ${only.results.length}`);
    assert.strictEqual(only.results[0].name, 'a.md');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('H0: 已导入文件夹的路径比较不因大小写不同而误拒（Windows）', async (t) => {
  if (process.platform !== 'win32') { t.skip('仅 Windows 需要大小写不敏感比较'); return; }
  await withTempFolder({ 'x.md': '关键词 alpha\n' }, async (root) => {
    const { tools } = await mods();
    const { registry } = tools.createTools({ folders: [root] });
    // 同一目录换一种大小写/斜杠写法，应当仍然被认作已导入。
    const variant = root.toUpperCase().replace(/\\/g, '/');
    const result = await registry.search_folder.run({ query: 'alpha', folder: variant });
    assert.strictEqual(result.results.length, 1, '大小写不同的同一目录不应被拒绝');
  });
});

test('H0: 未导入任何文件夹时工具明确告知而不是报错', async () => {
  const { tools } = await mods();
  const { registry } = tools.createTools({ folders: [] });
  const result = await registry.search_folder.run({ query: 'anything' });
  assert.deepStrictEqual(result.results, []);
  // 这里的提示要说清「还没导入文件夹」，而不是让模型误以为「关键词没搜到」。
  assert.match(result.note, /没有已导入的文件夹/);
});

// ---------------------------------------------------------------------------
// 4. 网关纠偏：非标准 SSE 与尾部垃圾不应让请求失败
// ---------------------------------------------------------------------------

test('H0: 网关返回 SSE 时纠偏为 JSON', async () => {
  const { provider } = await mods();
  const sse = 'data: {"choices":[{"message":{"role":"assistant","content":"流式回答"}}]}\n\ndata: [DONE]\n\n';
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await provider.normalizingFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false }),
    });
    assert.match(response.headers.get('content-type'), /application\/json/);
    const payload = await response.json();
    assert.strictEqual(payload.choices[0].message.content, '流式回答');
  } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});

test('H0: 网关在 JSON 后追加 data: [DONE] 时仍能解析', async () => {
  const { provider } = await mods();
  const body = `${JSON.stringify(completion({ role: 'assistant', content: '宽容解析' }, 'stop'))}\ndata: [DONE]`;
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await provider.normalizingFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: false }),
    });
    const payload = await response.json();
    assert.strictEqual(payload.choices[0].message.content, '宽容解析');
  } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
});

// ---------------------------------------------------------------------------
// 5. 错误映射与步数上限
// ---------------------------------------------------------------------------

test('H0: mapSdkError 把 SDK 错误转成中文提示', async () => {
  const { provider } = await mods();
  assert.match(provider.mapSdkError({ statusCode: 401, message: 'invalid api key' }).message, /API Key 无效或已过期/);
  assert.match(provider.mapSdkError({ statusCode: 429, message: 'rate limit' }).message, /请求过于频繁/);
  assert.match(provider.mapSdkError({ statusCode: 502, message: 'Bad Gateway' }).message, /暂时不可用/);
  // 重试包装后的错误也要能还原。
  assert.match(provider.mapSdkError({ message: 'Failed after 3 attempts. Last error: AI_APICallError: [429] too many requests' }).message, /请求过于频繁/);
});

test('H0: 步数上限是有限值', async () => {
  const { harness, provider } = await mods();
  assert.strictEqual(typeof harness.DEFAULT_MAX_STEPS, 'number');
  assert.ok(harness.DEFAULT_MAX_STEPS > 0 && harness.DEFAULT_MAX_STEPS <= 10, '步数上限应当是小的有限值');
});

test('H0: 达到步数上限时明确标记而不是静默结束', async () => {
  await withTempFolder({ 'a.md': 'alpha\n' }, async (root) => {
    // 网关始终请求工具，让循环永远不结束。
    await withScriptedServer([toolCallRound('search_folder', { query: 'alpha' })], async (baseUrl) => {
      const { tools, harness, provider } = await mods();
      const { registry } = tools.createTools({ folders: [root] });
      const result = await harness.runAgent({
        model: provider.createProvider({ baseUrl, apiKey: 'k' })('mock'),
        system: '测试',
        messages: [{ role: 'user', content: '循环' }],
        registry,
        maxSteps: 2,
      });
      assert.strictEqual(result.truncatedByStepLimit, true, '应当标记为因步数上限截断');
    });
  });
});

test('H0: 工具被拒绝时记录 rejected 且不中断整轮', async () => {
  await withTempFolder({ 'a.md': 'alpha\n' }, async (root) => {
    await withScriptedServer([
      toolCallRound('search_folder', {}), // 缺 query，会被 guard 拒绝
      finalRound(() => '已收到拒绝提示'),
    ], async (baseUrl) => {
      const { tools, harness, provider } = await mods();
      const { registry } = tools.createTools({ folders: [root] });
      const result = await harness.runAgent({
        model: provider.createProvider({ baseUrl, apiKey: 'k' })('mock'),
        system: '测试',
        messages: [{ role: 'user', content: '坏参数' }],
        registry,
      });
      assert.strictEqual(result.trace[0].outcome, 'rejected');
      assert.ok(result.trace[0].reason, '拒绝应带原因');
      assert.strictEqual(result.text, '已收到拒绝提示', '模型应继续完成这一轮');
    });
  });
});

// ---------------------------------------------------------------------------
// 6. schema 工具函数
// ---------------------------------------------------------------------------

test('H0: validate 收紧模型参数', async () => {
  const { schema } = await mods();
  assert.deepStrictEqual(schema.validate(schema.SEARCH_FOLDER_SCHEMA, { query: '  abc  ' }), { ok: true, value: { query: 'abc' } });
  assert.strictEqual(schema.validate(schema.SEARCH_FOLDER_SCHEMA, { query: 'abc', regex: 'yes' }).ok, false);
  assert.strictEqual(schema.validate(schema.SEARCH_FOLDER_SCHEMA, null).ok, false);
});

test('H0: digestArgs 截断长参数且只保留摘要', async () => {
  const { schema } = await mods();
  const digest = schema.digestArgs({ query: 'x'.repeat(500) });
  assert.ok(digest.length <= 200, '摘要应有长度上限');
  assert.ok(digest.includes('…'), '长值应被截断');
  assert.strictEqual(schema.digestArgs(null), '');
});

// ---------------------------------------------------------------------------
// 7. 既有行为不回退：ai.cjs 的公开面仍然可用
// ---------------------------------------------------------------------------

test('H0: ai.cjs 仍导出既有能力且可被 CommonJS 直接 require', () => {
  for (const name of [
    'runSelectionAction', 'askDocument', 'askMultiDocument', 'reviewDocument',
    'analyzeDocument', 'summarizeDocument', 'getAvailableActions', 'getProviderStatus',
    'saveProviderConfig', 'clearProviderConfig', 'createProposal', 'diffText',
  ]) {
    assert.strictEqual(typeof ai[name], 'function', `${name} 应当是函数`);
  }
  assert.strictEqual(ai.getAvailableActions().length, 5, '选区动作仍应是五个');
});
