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
  // 措辞面向用户：不能说成「范围声明与实现不符」那种内部错误（复审 finding 5）。
  assert.match(verdict.reason, /没有可供检索的文档/);
  assert.doesNotMatch(verdict.reason, /声明与实现不符/);
});

test('I3: search_document 在有当前文档时放行', async () => {
  const { tools: t } = await tools();
  const { registry } = t.createTools({ document: { text: '内容', filename: 'a.md' } });
  const verdict = await t.guard('search_document', { query: 'x' }, registry);
  assert.strictEqual(verdict.ok, true);
});

test('I3: document 范围工具接受任何新增参数都被拒（白名单语义）', async () => {
  // 黑名单只能挡住列举过的名字；source/uri/name/target 这类同义字段会漏过去。
  // 改为白名单后，任何不在允许清单里的字段都应被拒绝（复审 finding 3、7）。
  const { tools: t } = await tools();
  const { registry } = t.createTools({ document: { text: '内容', filename: 'a.md' } });
  const spec = registry.search_document;
  const original = spec.schema;
  const suspicious = ['docId', 'path', 'folder', 'source', 'name', 'target', 'uri', 'href', 'filename', 'from', 'to', 'src'];
  try {
    for (const leaked of suspicious) {
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
  } finally {
    spec.schema = original;
  }
});

test('I3: 缺少 scope 声明的工具被拒绝（不设默认值）', async () => {
  // 默认值必须是最严格的，而不是最宽松的：漏写声明要报错，不能悄悄放行。
  const { tools: t } = await tools();
  const { registry } = t.createTools({ folders: [] });
  const spec = registry.list_workspace;
  const saved = spec.scope;
  delete spec.scope;
  try {
    const verdict = await t.guard('list_workspace', {}, registry);
    assert.strictEqual(verdict.ok, false, '没有 scope 声明必须拒绝');
    assert.match(verdict.reason, /未声明或不可识别/);
  } finally {
    spec.scope = saved;
  }
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
    assert.match(verdict.reason, /未声明或不可识别/);
  } finally {
    spec.scope = saved;
  }
});

test('I3: 不允许任何工具落到「跳过复核」的分支', async () => {
  // 之前有个 scope='none' 分支直接放行，且没有任何工具使用它。
  // 现在 SCOPE_RULES 里只有 folders / document，其余取值一律拒绝。
  const { tools: t } = await tools();
  const { registry } = t.createTools({ folders: [], document: { text: 'x', filename: 'a.md' } });
  for (const name of Object.keys(registry)) {
    const spec = registry[name];
    const saved = spec.scope;
    spec.scope = 'none';
    try {
      const verdict = await t.guard(name, {}, registry);
      assert.strictEqual(verdict.ok, false, `${name} 不应接受 scope='none'`);
    } finally {
      spec.scope = saved;
    }
  }
});

test('I3: 越界 folder 仍被拒绝（回归）', async () => {
  const { tools: t } = await tools();
  // 用当前平台的绝对路径，不能在测试里写死 C:\ ——Linux 上 path.isAbsolute 会把它
  // 判成相对路径，roots 被过滤成空，拒绝原因变成「缺少已导入文件夹」而不是范围检查，
  // 断言就会假失败（CI Ubuntu 上已踩到一次）。
  const root = path.join(path.sep, 'inkstone-imported');
  const outside = path.join(path.sep, 'somewhere-else');
  const { registry } = t.createTools({ folders: [root] });
  const verdict = await t.guard('search_folder', { query: 'x', folder: outside }, registry);
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

test('NOTICE: AI 运行时依赖的许可证进入 THIRD-PARTY-NOTICES', async (t) => {
  // 桌面安装包会把 node_modules 里的 AI 依赖一并分发，
  // 其 Apache-2.0 许可要求随分发保留许可证文本。
  const file = path.resolve(__dirname, '../web/vendor/licenses.txt');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    // web/vendor 是 gitignore 的生成物，npm test 不先跑 build:web。
    // 用 skip 而不是静默 return——静默返回会让这条合规断言在 CI 主路径上
    // 看起来「通过」实则从未执行（复审 finding 6）。
    t.skip('web/vendor/licenses.txt 尚未生成；npm run build:web 后此用例才会真正执行');
    return;
  }

  // 每个随安装包分发的 Apache-2.0 包都必须拿到**完整条款**，
  // 而不只是上游那几百字节的引用式声明。
  const sections = {};
  const parts = text.split(/^===== /m).slice(1);
  for (const part of parts) {
    const header = part.split('\n')[0].trim();
    sections[header.split(' ')[0]] = part;
  }
  for (const name of ['ai', '@ai-sdk/openai-compatible', '@ai-sdk/provider', '@ai-sdk/provider-utils', '@ai-sdk/gateway']) {
    const section = sections[name];
    assert.ok(section, `${name} 的许可证应出现在 THIRD-PARTY-NOTICES`);
    assert.match(
      section,
      /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/,
      `${name} 必须带完整 Apache-2.0 条款，不能只有引用声明`,
    );
  }

  // 非 Apache 的包不应被扣上 Apache 全文。
  for (const name of ['@standard-schema/spec', 'eventsource-parser']) {
    const section = sections[name];
    if (!section) continue;
    assert.doesNotMatch(section, /full text supplied by ink-leaf/, `${name} 不应被 Apache 全文兜底`);
  }
});

test('NOTICE: 许可证聚合结果可通过重新构建复现', async () => {
  // 直接跑构建脚本的聚合逻辑会污染仓库，所以这里只校验兜底文件本身可用：
  // 构建流程（CI 与打包）都会在 npm test 之后跑 build:web，缺文件会直接让构建失败。
  const file = path.resolve(__dirname, '../licenses/apache-2.0.txt');
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'));
});

test('NOTICE: 仓库内保存了 Apache-2.0 全文以备兜底', async () => {
  const file = path.resolve(__dirname, '../licenses/apache-2.0.txt');
  const text = await fs.readFile(file, 'utf8');
  assert.ok(text.includes('Apache License'), '应包含 Apache License 标题');
  assert.ok(text.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'), '应包含完整条款');
  assert.ok(text.length > 8000, `全文长度合理，实际 ${text.length}`);
});
