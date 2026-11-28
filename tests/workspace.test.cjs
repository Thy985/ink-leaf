'use strict';

// H2 验收测试：工作区索引、反向链接、只读工具。
// 全部在临时目录里造文档，不触碰用户真实文件。

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const ai = require('../desktop/ai.cjs');

let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = Promise.all([
      import('../desktop/ai/workspace.mjs'),
      import('../desktop/ai/tools.mjs'),
      import('../desktop/ai/schema.mjs'),
    ]).then(([workspace, tools, schema]) => ({ workspace, tools, schema }));
  }
  return modsPromise;
}

// 造一个含链接关系的工作区：
//   设计文档.md  → [[API 规范]]
//   API 规范.md  → [[设计文档]]
//   笔记.md      → [[设计文档|那篇设计]]、[[不存在的文档]]
async function withWorkspace(files, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  try { return await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

const BASE_FILES = {
  '设计文档.md': '# 设计\n\n本地优先是核心原则。\n\n参见 [[API 规范]]。\n',
  'API 规范.md': '# API\n\n接口说明。\n\n返回 [[设计文档]] 查看背景。\n',
  '笔记.md': '随手记。\n\n引用 [[设计文档|那篇设计]] 与 [[不存在的文档]]。\n',
};

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

test('H2: 索引收录 Markdown 与 txt，跳过其它扩展名', async () => {
  const { workspace } = await mods();
  await withWorkspace({ ...BASE_FILES, 'note.txt': '文本', 'data.json': '{}' }, async (root) => {
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const names = index.files.map((f) => f.name).sort();
    assert.ok(names.includes('note.txt'), 'txt 应被收录');
    assert.ok(!names.includes('data.json'), 'json 不应被收录');
    assert.strictEqual(names.length, 4);
  });
});

test('H2: 索引不跟随符号链接', async (t) => {
  const { workspace } = await mods();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-link-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-out-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.md'), '外部文件', 'utf8');
    await fs.writeFile(path.join(root, 'real.md'), '内部文件', 'utf8');
    try {
      await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'link.md'));
    } catch {
      t.skip('当前系统不允许创建符号链接');
      return;
    }
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const names = index.files.map((f) => f.name);
    assert.ok(names.includes('real.md'));
    assert.ok(!names.includes('link.md'), '软链接不应进入索引');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('H2: 索引只接受绝对路径的文件夹', async () => {
  const { workspace } = await mods();
  const index = await workspace.buildWorkspaceIndex({ roots: ['relative/path', null, 42, {}] });
  assert.strictEqual(index.files.length, 0);
});

// ---------------------------------------------------------------------------
// 反向链接
// ---------------------------------------------------------------------------

test('H2: 反向链接能查出哪些文档指向目标', async () => {
  const { workspace } = await mods();
  await withWorkspace(BASE_FILES, async (root) => {
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const links = workspace.findBacklinks(index, '设计文档');
    const froms = links.backlinks.map((l) => l.from.title).sort();
    assert.deepStrictEqual(froms, ['API 规范', '笔记']);
  });
});

test('H2: 反向链接保留别名，且不把自引用算作反向链接', async () => {
  const { workspace } = await mods();
  await withWorkspace(BASE_FILES, async (root) => {
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const links = workspace.findBacklinks(index, '设计文档');
    const alias = links.backlinks.find((l) => l.from.title === '笔记');
    assert.strictEqual(alias.alias, '那篇设计');

    // API 规范被设计文档指向，且它自己指向设计文档——自引用不会出现在自己的反向链接里。
    const apiLinks = workspace.findBacklinks(index, 'API 规范');
    assert.strictEqual(apiLinks.backlinks.length, 1);
    assert.strictEqual(apiLinks.backlinks[0].from.title, '设计文档');
  });
});

test('H2: 死链检测报告指向不存在文档的链接', async () => {
  const { workspace } = await mods();
  await withWorkspace(BASE_FILES, async (root) => {
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const broken = workspace.findBrokenLinks(index);
    assert.strictEqual(broken.length, 1);
    assert.strictEqual(broken[0].target, '不存在的文档');
    assert.strictEqual(broken[0].title, '笔记');
  });
});

test('H2: 反向链接查询对不存在或空标题不报错', async () => {
  const { workspace } = await mods();
  await withWorkspace(BASE_FILES, async (root) => {
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    assert.deepStrictEqual(workspace.findBacklinks(index, '').backlinks, []);
    assert.deepStrictEqual(workspace.findBacklinks(index, '从未出现').backlinks, []);
    assert.deepStrictEqual(workspace.findBacklinks(null, 'x').backlinks, []);
  });
});

// ---------------------------------------------------------------------------
// 检索（复用倒排表）
// ---------------------------------------------------------------------------

test('H2: 工作区检索命中正确文档且不返回正文之外的字段', async () => {
  const { workspace } = await mods();
  await withWorkspace(BASE_FILES, async (root) => {
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const hit = workspace.searchWorkspace(index, '本地优先');
    assert.strictEqual(hit.results.length, 1);
    assert.strictEqual(hit.results[0].name, '设计文档.md');
    // 命中片段是上下文，不是整篇。
    assert.ok(hit.results[0].hits[0].context.length <= 320);
  });
});

test('H2: 检索无结果时返回空而不是全量', async () => {
  const { workspace } = await mods();
  await withWorkspace(BASE_FILES, async (root) => {
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const miss = workspace.searchWorkspace(index, '这个词完全不存在');
    assert.deepStrictEqual(miss.results, []);
    assert.strictEqual(miss.totalMatches, 0);
  });
});

// ---------------------------------------------------------------------------
// 只读工具
// ---------------------------------------------------------------------------

test('H2: list_workspace 返回文档清单但不含正文', async () => {
  const { tools } = await mods();
  await withWorkspace(BASE_FILES, async (root) => {
    const { registry } = tools.createTools({ folders: [root] });
    const result = await registry.list_workspace.run({});
    assert.strictEqual(result.totalDocs, 3);
    assert.ok(!JSON.stringify(result).includes('本地优先是核心原则'), '清单不应包含正文');
  });
});

test('H2: find_links 查询反向链接与死链', async () => {
  const { tools } = await mods();
  await withWorkspace(BASE_FILES, async (root) => {
    const { registry } = tools.createTools({ folders: [root] });
    const links = await registry.find_links.run({ title: '设计文档' });
    assert.strictEqual(links.backlinks.length, 2);

    const broken = await registry.find_links.run({ broken: true });
    assert.strictEqual(broken.broken.length, 1);

    // 不指定标题时给死链清单，并说明怎么查反向链接。
    const fallback = await registry.find_links.run({});
    assert.ok(Array.isArray(fallback.broken));
    assert.match(fallback.note, /title/);
  });
});

test('H2: 未导入文件夹时新工具明确说明而不是报错', async () => {
  const { tools } = await mods();
  const { registry } = tools.createTools({ folders: [] });
  const ws = await registry.list_workspace.run({});
  assert.strictEqual(ws.totalDocs, 0);
  assert.match(ws.note, /导入/);
  const links = await registry.find_links.run({ title: 'x' });
  assert.deepStrictEqual(links.backlinks, []);
});

test('H2: 新工具经过 guard，多余参数被拒绝', async () => {
  const { tools } = await mods();
  const { registry } = tools.createTools({ folders: [] });
  assert.strictEqual((await tools.guard('list_workspace', {}, registry)).ok, true);
  assert.strictEqual((await tools.guard('list_workspace', { path: 'C:/' }, registry)).ok, false);
  assert.strictEqual((await tools.guard('find_links', { title: 'x' }, registry)).ok, true);
  assert.strictEqual((await tools.guard('find_links', { evil: 1 }, registry)).ok, false);
  // 仍然拒绝未知工具
  assert.strictEqual((await tools.guard('rm_rf', {}, registry)).ok, false);
});

// ---------------------------------------------------------------------------
// ai.cjs 工作区接口（渲染层经 IPC 调用的那一层）
// ---------------------------------------------------------------------------

test('H2: ai.describeWorkspace 汇总文档、链接与死链数', async () => {
  await withWorkspace(BASE_FILES, async (root) => {
    ai.invalidateWorkspace();
    const desc = await ai.describeWorkspace([root]);
    assert.strictEqual(desc.totalDocs, 3);
    assert.strictEqual(desc.linkCount, 3, '设计→API、API→设计、笔记→设计 共 3 条有效链接');
    assert.strictEqual(desc.brokenCount, 1);
    assert.deepStrictEqual(desc.roots, [root]);
  });
});

test('H2: ai.documentLinks 可按文件名推断标题', async () => {
  await withWorkspace(BASE_FILES, async (root) => {
    ai.invalidateWorkspace();
    const links = await ai.documentLinks([root], { filename: '设计文档.md' });
    assert.strictEqual(links.backlinks.length, 2);
  });
});

test('H2: 工作区缓存随文件夹集合变化而失效', async () => {
  await withWorkspace({ 'a.md': '内容\n' }, async (root) => {
    ai.invalidateWorkspace();
    const first = await ai.describeWorkspace([root]);
    assert.strictEqual(first.totalDocs, 1);
    // 同一组文件夹：命中缓存，结果一致。
    const again = await ai.describeWorkspace([root]);
    assert.strictEqual(again.totalDocs, 1);
    // 换一组文件夹（空）：应重新建索引，而不是返回旧缓存。
    const empty = await ai.describeWorkspace([]);
    assert.strictEqual(empty.totalDocs, 0);
  });
});
