'use strict';

// H1 验收测试：问答迁移到工具检索、审阅改结构化输出。
// 全部走本地 mock 网关，不发真实网络请求。

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const ai = require('../desktop/ai.cjs');

// ai/ 目录是 ESM，测试用 CommonJS 运行，惰性加载并缓存。
let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = Promise.all([
      import('../desktop/ai/schema.mjs'),
      import('../desktop/ai/harness.mjs'),
      import('../desktop/ai/tools.mjs'),
      import('../desktop/ai/provider.mjs'),
    ]).then(([schema, harness, tools, provider]) => ({ schema, harness, tools, provider }));
  }
  return modsPromise;
}

// 起一个脚本化网关：每轮按脚本返回，并记录收到的请求体。
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
      const payload = script(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
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

// 临时用户数据目录：让 provider 配置指向 mock 网关。
async function withProviderConfig(baseUrl, run) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h1-'));
  const previous = process.env.INKSTONE_USER_DATA;
  process.env.INKSTONE_USER_DATA = tmpDir;
  try {
    await ai.saveProviderConfig({ baseUrl, apiKey: 'sk-test', model: 'mock' });
    return await run();
  } finally {
    if (previous === undefined) delete process.env.INKSTONE_USER_DATA;
    else process.env.INKSTONE_USER_DATA = previous;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. 短文档：整篇发送，不触发工具
// ---------------------------------------------------------------------------

test('H1: 短文档问答整篇发送且不调用工具', async () => {
  await withScriptedServer([
    () => completion({ role: 'assistant', content: '整篇回答' }, 'stop'),
  ], async (baseUrl, requests) => {
    await withProviderConfig(baseUrl, async () => {
      const result = await ai.askDocument('核心观点？', { text: '这是一篇短文档。', filename: 'short.md' }, []);
      assert.strictEqual(result.answer, '整篇回答');
      assert.deepStrictEqual(result.trace, [], '短文档不应有工具调用');
      // 只发一次请求，且请求体里带上了整篇正文。
      assert.strictEqual(requests.length, 1);
      const body = JSON.stringify(requests[0]);
      assert.ok(body.includes('这是一篇短文档'), '短文档应整篇发送');
      // 不该把工具暴露给模型——短文档没有可检索的东西。
      assert.strictEqual(requests[0].tools, undefined, '短文档不应暴露工具');
    });
  });
});

// ---------------------------------------------------------------------------
// 2. 长文档：走检索工具，不再整篇塞入
// ---------------------------------------------------------------------------

test('H1: 长文档问答改用 search_document 检索而非整篇塞入', async () => {
  // 构造超过 CONTEXT_LIMITS.document（32000）的文档。
  const filler = '这是一段用来撑长文档的填充文字。'.repeat(2000);
  const longText = `${filler}\n\n关键的结论只有一个：本地优先。\n`;
  assert.ok(longText.length > 32000, `测试文档必须超过内联阈值，实际 ${longText.length}`);

  await withScriptedServer([
    // 第一轮：模型请求检索
    () => completion({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_document', arguments: JSON.stringify({ query: '结论' }) } }],
    }, 'tool_calls'),
    // 第二轮：给出最终回答
    (body) => {
      const toolMessage = body.messages.find((m) => m.role === 'tool');
      return completion({ role: 'assistant', content: `检索到：${String(toolMessage?.content || '').slice(0, 60)}` }, 'stop');
    },
  ], async (baseUrl, requests) => {
    await withProviderConfig(baseUrl, async () => {
      const result = await ai.askDocument('结论是什么？', { text: longText, filename: 'long.md' }, []);
      assert.strictEqual(result.trace.length, 1, '应当记录一次工具调用');
      assert.strictEqual(result.trace[0].toolName, 'search_document');
      assert.strictEqual(result.trace[0].outcome, 'ok');
      // 关键：请求体**不应**包含整篇文档，否则等于没迁移。
      const firstBody = JSON.stringify(requests[0]);
      assert.ok(!firstBody.includes(filler.slice(0, 200)), '长文档不应整篇进入上下文');
      // 但工具确实检索到了文档内容（命中片段出现在工具结果里）。
      assert.ok(JSON.stringify(requests[1]).includes('本地优先'), '工具应检索到关键段落');
    });
  });
});

// ---------------------------------------------------------------------------
// 3. search_document 只读当前文档，不碰文件夹
// ---------------------------------------------------------------------------

test('H1: search_document 只检索当前文档', async () => {
  const { tools } = await mods();
  const { registry } = tools.createTools({ folders: [], document: { text: '第一行\n关于检索的内容\n第三行', filename: 'cur.md' } });
  const result = await registry.search_document.run({ query: '检索' });
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.results[0].name, 'cur.md');
  assert.ok(result.results[0].hits[0].context.includes('检索'));
});

test('H1: 没有文档时 search_document 明确说明而不是报错', async () => {
  const { tools } = await mods();
  const { registry } = tools.createTools({ folders: [], document: null });
  const result = await registry.search_document.run({ query: '任何' });
  assert.deepStrictEqual(result.results, []);
  assert.match(result.note, /没有可检索的文档/);
});

test('H1: search_document 命中为空时提示换关键词', async () => {
  const { tools } = await mods();
  const { registry } = tools.createTools({ document: { text: '只有这些内容', filename: 'a.md' } });
  const result = await registry.search_document.run({ query: '完全不存在' });
  assert.deepStrictEqual(result.results, []);
  assert.match(result.note, /换一个关键词/);
});

// ---------------------------------------------------------------------------
// 4. 结构化审阅与宽容解析
// ---------------------------------------------------------------------------

test('H1: reviewDocument 返回结构化条目', async () => {
  const items = [
    { position: '第 1 段', original: '原句子。', suggested: '改写后的句子。', reason: '更简洁' },
    { position: '第 2 段', original: '另一个句子。', suggested: '另一个更好的句子。', reason: '表达更清楚' },
  ];
  await withScriptedServer([
    () => completion({ role: 'assistant', content: JSON.stringify(items) }, 'stop'),
  ], async (baseUrl) => {
    await withProviderConfig(baseUrl, async () => {
      const review = await ai.reviewDocument('更简洁一点', { text: '原句子。\n另一个句子。', filename: 'a.md' });
      assert.ok(Array.isArray(review.items), '应当返回结构化条目');
      assert.strictEqual(review.items.length, 2);
      assert.strictEqual(review.items[0].suggested, '改写后的句子。');
      assert.strictEqual(review.items[1].reason, '表达更清楚');
    });
  });
});

test('H1: 审阅回复夹带代码围栏与说明文字时仍能解析', async () => {
  const fenced = '好的，以下是建议：\n```json\n[{"position":"第 1 段","original":"a","suggested":"b","reason":"c"}]\n```\n希望有帮助。';
  await withScriptedServer([
    () => completion({ role: 'assistant', content: fenced }, 'stop'),
  ], async (baseUrl) => {
    await withProviderConfig(baseUrl, async () => {
      const review = await ai.reviewDocument('改', { text: 'a', filename: 'a.md' });
      assert.ok(Array.isArray(review.items));
      assert.strictEqual(review.items[0].suggested, 'b');
    });
  });
});

test('H1: 审阅回复完全不是 JSON 时退化为纯文本而不是报错', async () => {
  await withScriptedServer([
    () => completion({ role: 'assistant', content: '这段文字本身写得不错，不需要修改。' }, 'stop'),
  ], async (baseUrl) => {
    await withProviderConfig(baseUrl, async () => {
      const review = await ai.reviewDocument('看看', { text: 'a', filename: 'a.md' });
      assert.strictEqual(review.items, undefined, '解析失败时不应伪造条目');
      assert.match(review.text, /写得不错/);
    });
  });
});

test('H1: parseReviewItems 处理各种包装形态', async () => {
  const { schema } = await mods();
  // 纯数组
  assert.strictEqual(schema.parseReviewItems('[{"original":"a","suggested":"b"}]').length, 1);
  // 对象包装
  assert.strictEqual(schema.parseReviewItems('{"items":[{"original":"a","suggested":"b"}]}').length, 1);
  assert.strictEqual(schema.parseReviewItems('{"suggestions":[{"original":"a","suggested":"b"}]}').length, 1);
  // 前后有说明文字
  assert.strictEqual(schema.parseReviewItems('建议如下：[{"original":"a","suggested":"b"}] 以上。').length, 1);
  // 空数组表示无需修改
  assert.deepStrictEqual(schema.parseReviewItems('[]'), null, '空数组应视为没有条目');
  // 完全无法解析
  assert.strictEqual(schema.parseReviewItems('随便一段话'), null);
  assert.strictEqual(schema.parseReviewItems(''), null);
  assert.strictEqual(schema.parseReviewItems(null), null);
  // 条目里没有任何可用字段时应被丢弃
  assert.strictEqual(schema.parseReviewItems('[{"position":"第1段"}]'), null);
});

// ---------------------------------------------------------------------------
// 5. 既有行为不回退
// ---------------------------------------------------------------------------

test('H1: 选区操作仍返回提案结构', async () => {
  await withScriptedServer([
    () => completion({ role: 'assistant', content: '精简后的文字' }, 'stop'),
  ], async (baseUrl) => {
    await withProviderConfig(baseUrl, async () => {
      const proposal = await ai.runSelectionAction('condense', '原文内容', { text: '原文内容', filename: 'a.md' });
      assert.strictEqual(proposal.suggestedText, '精简后的文字');
      assert.strictEqual(proposal.actionKey, 'condense');
    });
  });
});