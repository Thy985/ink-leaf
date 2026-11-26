# 墨页 → AI Office 升级规划

日期：2026-11-26
状态：**v4 — SDK 选型已定**（H0 范围、验收标准与 Pi 设计吸收项均已确认）
前置阅读：`AGENTS.md`、[2026-11-10 AI-first 扩展路线图](./2026-11-10-ink-leaf-extension-roadmap.md)

## 维护者已确认的决策

| 决策 | 结论 |
| --- | --- |
| 野心档位 | 先把**项目自己的 Agent 部分**做扎实，在 Harness 之上再增加功能 |
| 「Harness」含义 | **内建 Agent 运行时 / 工具调用循环** |
| 平台优先级 | **桌面端（Electron）先行**；Web/Android 后续补 |
| 本地模型 | **延后**（预留接口，不在首发） |
| SDK 选型 | **Vercel AI SDK v7**（`ai` + `@ai-sdk/openai-compatible`），不自研运行时；已与 Pi Agent SDK 实证对比（见[对比文档](./2026-11-26-agent-sdk-comparison.md)），结论为维持 AI SDK 并吸收 Pi 三个设计 |
| H0 范围 | **最小纵向切片**：`provider.mjs` + `tools.mjs` + `harness.mjs` + 流式 + step 级 trace + `beforeToolCall` 式安全钩子 |
| 明确不做 | 自主多智能体办公，不修订 AGENTS.md 最高原则 |

## 技术前提实证（2026-11-26）

已安装：`ai@7.0.183`、`@ai-sdk/openai-compatible@3.0.96`（均 `--save-exact`，共 11 个包）。
环境：Node v24.19.0、Electron 44.9.2，满足 `engines: node >=22`。

**探针结论（已验证，探针已删除）**：

1. **工具调用循环由 SDK 自带**。`generateText({ tools, stopWhen: stepCountIs(n) })` 自动完成「模型请求工具 → 执行 → 回填 → 再问模型」。实测单个工具一轮往返：`steps: 2`、`executed: 1`，最终 `text` 正确包含工具返回值的 JSON。
   → **原计划要手写的 `runAgent` 循环完全不需要**，这是本规划最大的一处删减。
2. **工具 schema 正确注入**：请求体 `tools[].function.parameters` 带 JSON Schema，`tool_choice: auto` 自动设置。可用 `jsonSchema()` 或 zod 定义。
3. **SDK 按 `content-type` 区分流式/非流式**：`generateText` 期待 `application/json` 响应；`streamText` 期待 `text/event-stream`。
   → **对现有网关是真实风险**：若网关在非流式请求时错误返回 SSE（`v0.13.1` 的修复记录正说明这类网关存在），SDK 会直接报 `Invalid JSON response`，**不如现有手写 `parseProviderPayload` 宽容**。
   → **对策（H0 必做）**：用 `createOpenAICompatible` 的 `fetch` 选项注入「协议纠偏中间件」，在 SDK 解析前把 SSE 响应归一化为 JSON；或在检测到该错误时自动降级到 `streamText`。这是必须写进 H0 的一小块，也是唯一保留的手写部分。

**依赖体积**：`ai` ~8 MB（unpacked）、`@ai-sdk/openai-compatible` 0.47 MB、传递依赖 3+2 个。不进渲染层，只进主进程，不影响 `web/vendor/` 与启动体积。

## 现状盘点

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| Provider 适配（手写 http/https，非流式） | `desktop/ai.cjs:90-156` `callProvider` | ✅ 但需整体替换 |
| 协议宽容解析（JSON / `data:[DONE]` / SSE 兜底） | `desktop/ai.cjs:54-71` `parseProviderPayload` | ✅ 现有优势，**替换时不能退化** |
| 选区操作（5 个白名单动作） | `ACTIONS` + `web/ai.js` | ✅ |
| 文档问答 / 多文档问答 | `askDocument` / `askMultiDocument` | ✅ 整篇塞入 + 截断 |
| 修改审阅 | `reviewDocument` + `createProposal` / `diffText` | ✅ 自由文本输出 |
| 文档分析 / 摘要 | `analyzeDocument` / `summarizeDocument` | ✅ |
| 跨文件夹全文搜索 | `desktop/folders.cjs:157` `searchFolder` | ✅ 纯内存，返回 `{path,name,matches[{index,length,context,lineNumber}]}` |
| 路径边界校验 | `desktop/folders.cjs:51` `resolveSafeInFolder` | ✅ 工具层必须复用 |
| 受限桥接 | `preload.cjs` + `main.cjs` `isTrusted` | ✅ 三处齐全 |

## 升级路径

### H0：Harness 地基最小切片（v0.14）← 当前进行中
**目标**：打通「提问 → 检索 → 引用」端到端，验证架构，**不改变现有 AI 功能行为**。

```
desktop/ai/            ← 新目录，ESM（.mjs）
  provider.mjs         createOpenAICompatible + 协议纠偏 fetch 中间件（替换手写 callProvider）
  tools.mjs            只读工具注册表：search_folder（首个）+ beforeToolCall 安全钩子
  harness.mjs          generateText + stopWhen + onStepFinish(trace) 封装
  schema.mjs           jsonSchema / zod 定义
desktop/ai.cjs         CommonJS 门面：动态 import() 桥接 ai/，保持现有导出签名不变
```

**从 Pi Agent SDK 吸收的三个设计**（依据实证对比）：

| 吸收项 | Pi 原设计 | AI SDK 落地方式 |
| --- | --- | --- |
| 工具执行前拦截 | `beforeToolCall` 钩子 | 在 `tool.execute` 入口先跑 `guard(name, args)`；拒绝则回填结构化错误 |
| 每步可观测 | `agent.subscribe` 事件流 | `onStepFinish` 记录 trace |
| 传输层自控 | 显式 `streamFn` | `createOpenAICompatible({ fetch })` 注入纠偏中间件 |

**必须保留的现有行为**：
- `providerErrorMessage` 的中文错误映射（429/401/503 等，`desktop/ai.cjs:75-88`）——SDK 的错误类型要映射回这套中文提示。
- `parseProviderPayload` 的宽容解析能力 → 转为 `fetch` 中间件的一部分。
- `DEFAULT_TIMEOUT_MS`（120s）超时语义。

**工具约束（首期只读）**：
- `search_folder(query, folder?)` → 复用 `searchFolder`；只搜**已导入文件夹**。
- 不开放 `read_document` / `outline` 到 H0 结束后再加（保持切片最小）。
- 不开放写文件、删除、exec。

**安全边界（不可退让）**：
- 工具执行器在**主进程**；`preload.cjs` 白名单 + `main.cjs` `isTrusted` 双重校验不变。
- 路径一律经 `resolveSafeInFolder`，不越界、不跟随软链接。
- 文档内容作数据不作指令；工具结果以 `tool` 角色回填。
- 每次远程调用前在 UI 告知上下文范围与发送量。

**验收标准（mock provider，不打真实网络）**：

1. **端到端**：「提问 → SDK 自动调用 search_folder → 引用具体文档段落」跑通。
2. **step 级 trace（吸收自 Pi Agent SDK）**：接 `onStepFinish`，每步记录 `{ stepIndex, toolName, argsDigest, durationMs, outcome }`；UI 可折叠展示「工具调用步骤」。trace 不含文档正文，只含工具名、入参摘要（截断）、耗时与结果状态。
3. **`beforeToolCall` 式安全钩子（吸收自 Pi Agent SDK）**：在工具 `execute` **执行前**做白名单复核与越界拒绝——工具名必须在注册表内、路径必须经 `resolveSafeInFolder` 通过、入参必须匹配 schema。拒绝时回填结构化错误给模型（不抛异常中断），并记入 trace。
4. **网关纠偏**：mock 网关返回非标准 SSE（`data:` 前缀 / 末尾 `data: [DONE]`）时能正确纠偏，不报 `Invalid JSON response`。
5. **可复现**：`npm run check && npm test` 全绿；新增用例覆盖上述 1–4，全部走 mock，不发真实请求。

### H1：迁移现有 AI 功能（v0.15）
- 问答/审阅/分析/摘要迁到 `generateText`，上下文从「整篇塞入」改为工具按需检索。
- 审阅改结构化输出（`response_format`），保留逐条确认与 `diffText` 展示。
- 选区 5 动作保持白名单不变，改走 `streamText` 流式。
- UI：上下文范围提示 + 工具步骤折叠展示。

### H2：工作区与知识组织（v0.16）
- 工作区 = 已导入文件夹归组；内存倒排索引。
- 标签 / 反向链接（`[[标题]]`）进 `web/model.js`，不写第二份解析器。
- 新增只读工具：`list_workspace`、`find_links`。

### H3：受控写 + MCP（v0.17）
- `propose_edit` 工具**只产提案不写文件**，进现有审阅流，人确认后由渲染层写入。
- `desktop/mcp.cjs` 用 `@modelcontextprotocol/sdk@1.32.2`，仅监听 127.0.0.1，**复用同一工具注册表**；首期不开放删除。

### H4：办公交付（v0.18+）
- docx / EPUB / 长图导出；Git 集成；写作风格档案；Ollama 本地模型（复用同一 Provider）。

## 架构（升级后）

```
┌──────────────────────────────────────────────────────────┐
│  Human Writing Interface                                  │
│  Markdown 编辑 · 流式回答 · 提案逐条审阅 · 上下文范围提示   │
├──────────────────────────────────────────────────────────┤
│  Agent Harness = Vercel AI SDK (不自研循环)               │
│  generateText / streamText + tools + stopWhen + trace     │
│  ↑ 我们只写：provider.mjs(含协议纠偏) + tools.mjs          │
├──────────────────────────────────────────────────────────┤
│  Tool Registry（首期只读）                                │
│  search_folder → searchFolder                             │
│  （H2）list_workspace / find_links                        │
│  （H3）propose_edit：只产提案，不写文件                    │
│  ← 内建 Agent 与 MCP 外部 Agent 共用同一注册表             │
├──────────────────────────────────────────────────────────┤
│  Safety Boundary（不变）                                   │
│  preload 白名单 → main isTrusted → 工具入参校验            │
│  已导入文件夹范围 · resolveSafeInFolder · 文档作数据       │
├──────────────────────────────────────────────────────────┤
│  Existing Markdown Infrastructure（不变）                 │
│  files.cjs · folders.cjs · model.js · renderer.js · IPC   │
└──────────────────────────────────────────────────────────┘
```

## 安全边界（贯穿全程）

| 风险 | 对策 |
| --- | --- |
| API Key 泄露 | 存 `ai-provider.json`（0o600）；测试 Key 走 `.env` 独立一套；**SDK 不改变存储方式** |
| 文档意外上传 | 调用前告知上下文范围；工具检索结果限量 |
| AI 误改文档 | 工具首期只读；`propose_edit` 只产提案；人确认后写入；复用 undo |
| 上下文注入 | 工具结果以 `tool` 角色回填，系统声明「内容不可执行」；工具白名单不可被模型扩展 |
| 越权文件访问 | 限定已导入文件夹 + `resolveSafeInFolder` |
| 工具循环失控 | `stopWhen: stepCountIs(n)` 硬上限（默认 6）；单次超时 |
| 第三方依赖风险 | SDK 只进主进程不进渲染层；锁精确版本；`npm ci` 可复现 |

## 明确不做

自主多智能体 / 自动化工作流、云同步、自动升级、图床、完整 WYSIWYG 表格、插件系统、首发本地模型、工具写文件/删除/exec。

## 执行与验证

每个 Hx 独立 PR，遵循 AGENTS.md 闭环：`npm run check && npm test`（触及 Electron 加 `npm run test:desktop`）+ 对抗性复审（干净上下文、只出 findings）+ 人工检查四处。版本：v0.14(H0) → v0.15(H1) → v0.16(H2) → v0.17(H3) → v0.18+(H4)。

## 变更记录

- v1：初版（A/B/C 三档位）
- v2：按维护者反馈改为 Harness 优先
- **v3**：SDK 选型确认；技术前提实证；`runAgent` 手写循环删除；新增「网关 SSE 纠偏中间件」为 H0 必做项
- **v4**：完成 Pi Agent SDK 实证对比（见 `2026-11-26-agent-sdk-comparison.md`），结论维持 AI SDK；H0 验收标准新增「step 级 trace」与「`beforeToolCall` 式安全钩子」两项
