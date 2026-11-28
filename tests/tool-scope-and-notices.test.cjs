'use strict';

// 工具范围声明（H1 复审 I3）与第三方许可证告知的回归测试。
// 这两项都是「容易在后续重构里悄悄退化」的红线，所以单独成文件。

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs/promises');

let toolsPromise = null;
function tools() {
  if (!toolsPromise) {
    toolsPromise = Promise.all([
      import('../desktop/ai/tools.mjs'),
      import('../desktop/ai/harness.mjs'),
    ]).then(([toolsMod, harnessMod]) => ({ tools: toolsMod, harness: harnessMod }));
  }
  return toolsPromise;
}

// ---------------------------------------------------------------------------
// 工具范围声明
// ---------------------------------------------------------------------------

test('I3: 每个工具都声明了 scope', async () => {
  const { tools: t } = await tools();
  const { registry } = t.createTools({ folders: [], document: { text: 'abc', filename: 'a.md' } });
  for (const [name, spec] of Object.entries(registry)) {
    assert.ok(typeof spec.scope === 'string' && spec.scope.length, `${name} 必须声明 scope`);
    assert.ok(['folders', 'document', 'none'].includes(spec.scope), `${name} 的 scope 取值不合法：${spec.scope}`);
  }
});

test('I3: search_document 在无当前文档时被 guard 拒绝', async () => {
  // 原先范围只在 run() 内部靠闭包保证，guard 不关心有没有文档；
  // 现在 guard 会按 scope 声明复核，读不到文档就不放行。
  const { tools: t } = await tools();
  const { registry } = t.createTools({ document: null });
  const verdict = await t.guard('search_document', { query: 'x' }, registry);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /当前文档/);
});

test('I3: search_document 在有当前文档时放行', async () => {
  const { tools: t } = await tools();
  const { registry } = t.createTools({ document: { text: '内容', filename: 'a.md' } });
  const verdict = await t.guard('search_document', { query: 'x' }, registry);
  assert.strictEqual(verdict.ok, true);
});

test('I3: document 范围的工具一旦接受路径类参数，guard 拒绝', async () => {
  // 这是复审担心的接缝：将来有人给 search_document 加 docId/path，
  // 范围复核逻辑却没跟上，模型就能越出「当前文档」。
  const { tools: t } = await tools();
  const { registry } = t.createTools({ document: { text: '内容', filename: 'a.md' } });
  const spec = registry.search_document;
  const original = spec.schema;
  for (const leaked of ['docId', 'path', 'folder']) {
    spec.schema = {
      type: 'object',
      properties: { ...original.properties, [leaked]: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    };
    const verdict = await t.guard('search_document', { query: 'x', [leaked]: 'other' }, registry);
    assert.strictEqual(verdict.ok, false, `出现 ${leaked} 参数时必须拒绝`);
    assert.match(verdict.reason, /范围声明与实现不符/);
  }
  spec.schema = original;
});

test('I3: 声明 folders 却没有 roots 的工具被拒绝', async () => {
  const { tools: t } = await tools();
  const { registry } = t.createTools({ folders: [] });
  const spec = registry.search_folder;
  const saved = spec.roots;
  delete spec.roots;
  try {
    const verdict = await t.guard('search_folder', { query: 'x' }, registry);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.reason, /范围声明与实现不符/);
  } finally {
    spec.roots = saved;
  }
});

test('I3: 未知 scope 被拒绝', async () => {
  const { tools: t } = await tools();
  const { registry } = t.createTools({ folders: [] });
  const spec = registry.list_workspace;
  const saved = spec.scope;
  spec.scope = 'everything';
  try {
    const verdict = await t.guard('list_workspace', {}, registry);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.reason, /未知的工具范围声明/);
  } finally {
    spec.scope = saved;
  }
});

test('I3: 越界 folder 仍被拒绝（回归）', async () => {
  const { tools: t } = await tools();
  const { registry } = t.createTools({ folders: ['C:\\Docs'] });
  const verdict = await t.guard('search_folder', { query: 'x', folder: 'C:\\Windows' }, registry);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /只能检索已在墨页中导入的文件夹/);
});

test('I3: 未知工具仍被拒绝（回归）', async () => {
  const { tools: t } = await tools();
  const { registry } = t.createTools({ folders: [] });
  const verdict = await t.guard('rm_rf', {}, registry);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /不在允许列表/);
});

// ---------------------------------------------------------------------------
// 第三方许可证告知
// ---------------------------------------------------------------------------

test('NOTICE: AI 运行时依赖的许可证进入 THIRD-PARTY-NOTICES', async () => {
  // 桌面安装包会把 node_modules 里的 AI 依赖一并分发，
  // 其 Apache-2.0 许可要求随分发保留许可证文本。
  const file = path.resolve(__dirname, '../web/vendor/licenses.txt');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    // 未先构建过 vendor 时不误报失败：CI 与打包流程都会先跑 build:web，
    // 而纯单元测试环境下 licenses.txt 是 gitignore 的生成物，可能并不存在。
    return;
  }
  for (const name of ['ai', '@ai-sdk/openai-compatible', '@ai-sdk/provider', '@ai-sdk/provider-utils']) {
    assert.ok(text.includes(`===== ${name} `), `${name} 的许可证应出现在 THIRD-PARTY-NOTICES`);
  }
  // provider-utils 上游不带 LICENSE 文件，必须有兜底的完整条款。
  assert.ok(
    text.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'),
    '应包含完整的 Apache-2.0 条款，而不只是一句引用声明',
  );
});

test('NOTICE: 仓库内保存了 Apache-2.0 全文以备兜底', async () => {
  const file = path.resolve(__dirname, '../licenses/apache-2.0.txt');
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.includes('Apache License'), '应包含 Apache License 标题');
  assert.ok(text.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'), '应包含完整条款');
  assert.ok(text.length > 8000, `全文长度合理，实际 ${text.length}`);
});
