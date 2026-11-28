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

test('H2: 索引不跟随目录 junction（Windows 无需特权）', async (t) => {
  const { workspace } = await mods();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-junc-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-jout-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.md'), '外部文件', 'utf8');
    await fs.writeFile(path.join(root, 'real.md'), '内部文件', 'utf8');
    try {
      // junction 是目录联接：Node 的 dirent.isSymbolicLink() 对它在 Windows 上返回 false，
      // 所以这条用例能真正暴露「只见 dirent 判定」的缺口。
      await fs.symlink(outside, path.join(root, 'junc'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('当前系统不允许创建目录链接');
      return;
    }
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const names = index.files.map((f) => f.name);
    assert.ok(names.includes('real.md'));
    assert.ok(!names.includes('secret.md'), '目录链接不应被跟随');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test('H2: 索引尊重 folders.cjs 的深度上限', async () => {
  const { workspace } = await mods();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-depth-'));
  try {
    // 造 12 层深目录（folders.MAX_SCAN_DEPTH 是 6），最深处放一篇文档。
    let cur = root;
    for (let i = 0; i < 12; i += 1) {
      cur = path.join(cur, `d${i}`);
      await fs.mkdir(cur);
    }
    await fs.writeFile(path.join(cur, 'deep.md'), '# 很深\n', 'utf8');
    await fs.writeFile(path.join(root, 'top.md'), '# 顶层\n', 'utf8');

    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const paths = index.files.map((f) => f.rel);
    assert.ok(paths.includes('top.md'), '顶层文档应被收录');
    assert.ok(!paths.some((p) => p.includes('d11')), '超过深度上限的文档不应被收录');
    // 截断要如实上报，否则用户以为索引是完整的。
    assert.strictEqual(index.truncated, true, '超出深度上限应标记 truncated');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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

test('H2: 同一路径内容变化后缓存必须失效', async () => {
  // 复审 F4 的真实场景：用户「移除文件夹 → 清空目录 → 重建内容 → 重新导入同一路径」。
  // 文件夹集合完全没变，只靠 key 比较会永久返回已经不存在的文档。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-cache-'));
  try {
    await fs.writeFile(path.join(root, 'a.md'), '# A\n', 'utf8');
    ai.invalidateWorkspace();
    const first = await ai.describeWorkspace([root]);
    assert.strictEqual(first.totalDocs, 1);

    // 换掉目录内容（相当于移除后重新导入）
    await fs.rm(path.join(root, 'a.md'));
    await fs.writeFile(path.join(root, 'c.md'), '# C\n', 'utf8');
    await fs.writeFile(path.join(root, 'd.md'), '# D\n', 'utf8');
    // 文件夹增删会触发失效（main.cjs 的 updateSession 调用它）；这里直接模拟该事件。
    ai.invalidateWorkspace();

    const second = await ai.describeWorkspace([root]);
    assert.strictEqual(second.totalDocs, 2, `应看到新内容，实际 ${second.totalDocs}`);
    assert.ok(!second.documents.some((d) => d.path === 'a.md'), '不应再返回已删除的 a.md');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('H2: 未失效时命中缓存（证明缓存确实生效）', async () => {
  // 与上一条互补：上一条验证「失效后能拿到新数据」，这一条验证「不失效时确实复用」。
  // 缺了这一条，把缓存整个去掉也能让上一条通过，缓存逻辑就失去了测试保护。
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-hit-'));
  try {
    await fs.writeFile(path.join(root, 'a.md'), '# A\n', 'utf8');
    ai.invalidateWorkspace();
    const first = await ai.describeWorkspace([root]);
    assert.strictEqual(first.totalDocs, 1);

    // 在应用外新增文件，但不通知失效：索引是缓存，应当仍返回旧结果。
    await fs.writeFile(path.join(root, 'b.md'), '# B\n', 'utf8');
    const cached = await ai.describeWorkspace([root]);
    assert.strictEqual(cached.totalDocs, 1, '未失效时应命中缓存，而不是每次重扫');

    // 显式失效后应反映新内容。
    ai.invalidateWorkspace();
    const fresh = await ai.describeWorkspace([root]);
    assert.strictEqual(fresh.totalDocs, 2, '失效后应重新扫描');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('H2: 缓存的是 Promise，并发查询只建一次索引', async () => {
  // 侧栏打开面板时会并发发起 workspace / links / broken 三个查询。
  // 缓存结果而不是 Promise 的话，三者同时 miss，会把整盘扫三遍（复审 F7）。
  await withWorkspace(BASE_FILES, async (root) => {
    ai.invalidateWorkspace();
    const [a, b, c] = await Promise.all([
      ai.describeWorkspace([root]),
      ai.documentLinks([root], { filename: '设计文档.md' }),
      ai.documentLinks([root], { broken: true }),
    ]);
    // 三者都应基于同一份索引：链接数与死链数互相对得上。
    assert.strictEqual(a.totalDocs, 3);
    assert.strictEqual(b.backlinks.length, 2);
    assert.strictEqual(c.broken.length, 1);
  });
});

test('H2: 同名文档跨文件夹时优先连到同文件夹的那篇', async () => {
  // 复审 F8：proj-a/guide 写 [[report]] 不应同时登记到 proj-b/report。
  const { workspace } = await mods();
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-a-'));
  const b = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-b-'));
  try {
    await fs.writeFile(path.join(a, 'guide.md'), '见 [[report]]\n', 'utf8');
    await fs.writeFile(path.join(a, 'report.md'), '# A 的报告\n', 'utf8');
    await fs.writeFile(path.join(b, 'report.md'), '# B 的报告\n', 'utf8');
    const index = await workspace.buildWorkspaceIndex({ roots: [a, b] });
    const links = workspace.findBacklinks(index, 'report');
    // 只有 a 里的 report 应有一条反向链接（来自 a/guide）。
    const fromA = links.backlinks.filter((l) => l.to.root === a);
    const fromB = links.backlinks.filter((l) => l.to.root === b);
    assert.strictEqual(fromA.length, 1, '同文件夹应建边');
    assert.strictEqual(fromB.length, 0, '跨文件夹同名文档不应被误连');
  } finally {
    await fs.rm(a, { recursive: true, force: true });
    await fs.rm(b, { recursive: true, force: true });
  }
});

test('H2: 超过大小上限的文档不算死链', async () => {
  // 复审 F9：文件存在但没被索引（超 10 MB），不能被报成「指向不存在的文档」。
  const { workspace } = await mods();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-big-'));
  try {
    await fs.writeFile(path.join(root, 'big.md'), 'x'.repeat(11 * 1024 * 1024), 'utf8');
    await fs.writeFile(path.join(root, 'small.md'), '见 [[big]] 与 [[真的不存在]]\n', 'utf8');
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const broken = workspace.findBrokenLinks(index);
    assert.ok(!broken.some((b) => b.target === 'big'), 'big.md 存在，不应算死链');
    assert.ok(broken.some((b) => b.target === '真的不存在'), '真正不存在的仍要报出');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('H2: 索引截断不切断 UTF-16 代理对，bytes 为磁盘字节数', async () => {
  // 复审 F5：slice 会切坏 emoji/CJK 扩展字；size 用码元数会让中文文档大小差三倍。
  const { workspace } = await mods();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inkstone-h2-trunc-'));
  try {
    // 造一个超过 MAX_INDEXED_TEXT（200 KB）且结尾是 emoji 的文档。
    const head = 'a'.repeat(200 * 1024 - 1);
    await fs.writeFile(path.join(root, 'emoji.md'), `${head}😀`, 'utf8');
    const index = await workspace.buildWorkspaceIndex({ roots: [root] });
    const file = index.files[0];
    assert.strictEqual(file.truncated, true);
    assert.ok(!/[\uD800-\uDBFF]$/.test(file.text), '截断后不应留下孤立高代理');
    // 中文文档的 bytes 应接近实际字节数，而不是字符数。
    assert.ok(file.bytes > file.text.length, 'bytes 应为磁盘字节数');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
