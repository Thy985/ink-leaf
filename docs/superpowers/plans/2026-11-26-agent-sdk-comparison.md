# Agent 运行时选型对比：Vercel AI SDK vs Pi Agent SDK

日期：2026-11-26
状态：实证完成（两个 SDK 均已实际安装、探针验证、环境已复原）
结论：**继续用 Vercel AI SDK**，但吸收 Pi 的两个设计优点。

## 一、两个候选是什么

| | Vercel AI SDK | Pi Agent SDK |
| --- | --- | --- |
| 包名 | `ai@7.0.183` + `@ai-sdk/openai-compatible@3.0.96` | `@earendil-works/pi-agent-core@1.6.1` + `pi-ai` + `pi-schema` |
| 作者 | Vercel（`matt.straka` 等） | Mario Zechner（libGDX）、Armin Ronacher（Flask/Jinja2） |
| License | Apache-2.0 | MIT |
| 定位 | 「一个接口调所有模型」+ 工具循环 + 结构化输出 | 「Agent 工具包」：统一 LLM API、常驻 Agent 循环、TUI、编码 Agent CLI |
| 仓库 | `github.com/vercel/ai` | `github.com/earendil-works/pi` |

**注**：npm 上搜「pi agent sdk」会撞到 `pi@2.0.5`（算圆周率）、`piapi`（树莓派）、`pi-sdk`（Pay Insights）等无关包。真实包名是 `@earendil-works/pi-agent-core`。

**重要发现**：Vercel 官方提供了 `@ai-sdk/harness-pi@1.0.198`，依赖 `@earendil-works/pi-coding-agent`。说明**两者不是竞争关系**，AI SDK 把 Pi 当作一种 harness 后端。技术上可以叠加使用。

## 二、实证数据

### 依赖重量（实测 `npm install --dry-run`）

| 方案 | 新增包数 | 主要传递依赖 |
| --- | --- | --- |
| Vercel AI SDK | **11 个** | `@ai-sdk/provider`、`@ai-sdk/provider-utils` |
| Pi Agent SDK | **79 个** | `openai`、`@anthropic-ai/sdk`、`@google/genai`、`@aws-sdk/client-bedrock-runtime`（含 **12 个 AWS 子包**）、`protobufjs` |

**这是最显著的差异。** Pi 的 `pi-ai` 主打「统一所有 Provider」，把 OpenAI / Anthropic / Google / Bedrock 的官方 SDK 全打进来。对一个只有本地 `openai-compatible` HTTP 需求的桌面应用，这是 7 倍的依赖膨胀，还会多出 `protobufjs` 这类带 postinstall 脚本的包（与 AGENTS.md 的 `npm ci` 干净安装约定有摩擦）。

### 包体积

| 包 | 体积 | 依赖数 |
| --- | --- | --- |
| `ai` | 8.16 MB | 3 |
| `@earendil-works/pi-ai` | 4.42 MB | 11 |
| `@earendil-works/pi-agent-core` | 0.26 MB | 2 |

`ai` 主包虽大，但主要体积是 provider 定义与类型声明；Pi 的总量（4.42+0.26+schema+telemetry+79 包）会更大。

### 接口形态（读 d.ts + 实跑探针）

**Vercel AI SDK**（已验证跑通）：
```js
const result = await generateText({
  model: provider('model-id'),
  prompt: '...',
  tools: { search_folder: tool({ inputSchema, execute }) },
  stopWhen: stepCountIs(4),
});
// → { text, steps, toolCalls, usage }
```
- **无状态函数调用**：一次调用一次结果，工具循环由 SDK 内部完成
- 探针实测：`steps: 2, executed: 1`，工具结果正确回填，**零手写循环代码**
- 流式用 `streamText`，结构化输出用 `generateObject`

**Pi Agent SDK**（探针暴露关键约束）：
```js
const agent = new Agent({
  initialState: { model, systemPrompt, messages, tools },
  streamFn,          // ← 必填，不传直接抛错
  beforeToolCall,    // 工具执行前钩子
  afterToolCall,
});
agent.subscribe((event) => { /* 全生命周期事件 */ });
agent.steer(msg); agent.followUp(msg); agent.abort();
```
- **有状态常驻 Agent 对象**：持有 transcript、事件流、消息队列、可中断
- 探针报错：`No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn()` —— 传输层必须自己接，或用 `pi-ai` 的 provider（又拉回 79 个包）
- 额外能力：`steer` / `followUp` 消息队列、`beforeToolCall` 钩子、`waitForIdle`、session 管理

### 网关兼容性（本项目特有风险）

| | Vercel AI SDK | Pi Agent SDK |
| --- | --- | --- |
| 非标准网关（SSE 混用、`data:[DONE]`） | 严格按 `content-type` 判断，**会直接报错**——探针实证 | 可自写 `streamFn` 完全掌控解析，**更宽容** |
| 纠偏成本 | 需注入 `fetch` 中间件（约 30 行） | 天然在 `streamFn` 里做 |

本项目 `parseProviderPayload`（`desktop/ai.cjs:54-71`）的存在就是为了兼容这类网关，v0.13.1 修过真实问题。**Pi 在这一点上设计更优**——但这恰好是因为它把传输层交给你写，也意味着这部分工作量不会消失，只是从「中间件」变成「streamFn」。

## 三、对墨页的适配度评分

| 维度 | Vercel AI SDK | Pi Agent SDK | 说明 |
| --- | --- | --- | --- |
| 依赖轻量 | ★★★★★ | ★★☆☆☆ | 11 vs 79 包；Pi 含 AWS/Bedrock 全家桶 |
| 上手成本 | ★★★★★ | ★★★☆☆ | AI SDK 一个函数；Pi 要接 `streamFn` |
| 工具循环 | ★★★★★ | ★★★★★ | 两者都完整 |
| 结构化输出 | ★★★★★ | ★★★☆☆ | AI SDK `generateObject` 成熟；Pi 需自行约束 |
| 流式 | ★★★★★ | ★★★★★ | 两者都可 |
| 可观测 / trace | ★★★☆☆ | ★★★★★ | **Pi 的 `subscribe` 事件流 + `before/afterToolCall` 钩子更强** |
| 中断与中途干预 | ★★☆☆☆ | ★★★★★ | **Pi 的 `steer`/`followUp`/`abort` 是独有优势** |
| 网关宽容 | ★★☆☆☆ | ★★★★☆ | Pi 可自控解析 |
| 生态与文档 | ★★★★★ | ★★★☆☆ | AI SDK 文档极全，社区大 |
| 与现有 CJS 集成 | ★★★★☆ | ★★★★☆ | 两者都是纯 ESM，需动态 `import()` |
| 长期维护风险 | ★★★★★ | ★★★☆☆ | Vercel 大厂投入；Pi 属精品小团队 |

## 四、结论与建议

### 选 Vercel AI SDK（维持原方案）

理由按权重排序：

1. **依赖重量是硬约束**。79 个包（含 AWS Bedrock 全家桶 + `protobufjs` postinstall）对一个本地优先、离线可用的桌面 Markdown 编辑器是明显负担，且与 AGENTS.md 的干净安装约定有摩擦。AI SDK 只加 11 个。
2. **H0 只需要工具循环**。墨页当前场景是「提问→检索→引用」，不需要常驻 Agent、消息队列、中途干预。AI SDK 的 `generateText` 探针已实证够用，且零手写循环。
3. **生态成熟的容错价值**。文档齐全、社区大，出问题容易找到答案；这是小团队的精品 SDK 给不了的。

### 但从 Pi 吸收三个设计

Pi 的架构在两件事上确实更高明，H0 应借鉴：

1. **`beforeToolCall` / `afterToolCall` 钩子**——这是**安全边界的最佳挂载点**。在 H0 的 `tools.mjs` 里实现等价的 `beforeToolCall`，做白名单复核与越界拒绝，比事后校验更可靠。
2. **事件流可观测**——Pi 的 `subscribe` 让每一步都可观测。AI SDK 可用 `onStepFinish` / `experimental_telemetry` 达到类似效果，H0 应接上，产出 trace。
3. **流式传输自控**——既然 Pi 选择把 `streamFn` 交给你写来换取宽容性，说明**网关解析不该完全交给 SDK**。这印证了规划 v3 已定的事项：必须保留一个协议纠偏中间件。

### 可选：两者叠加

`@ai-sdk/harness-pi` 存在，意味着可以「AI SDK 做门面 + Pi 做 harness」。但当前不建议：
- 会同时背上 79 个包的依赖
- H0 的需求用纯 AI SDK 已足够
- 引入第二层抽象违反 AGENTS.md「不为以后可能用到提前抽象」

**留作 H3/H4 的后手**：若将来确实需要「常驻可干预 Agent」或多 Agent 协作，再评估接入 `harness-pi`，届时它是增量而非重写。

## 五、待确认

1. 是否接受「维持 Vercel AI SDK + 吸收 Pi 三个设计」的结论？
2. 是否需要我把「`beforeToolCall` 式安全钩子」和「step 级 trace」写入 H0 的验收标准？

## 附：实证方法与可复现性

- 两 SDK 均用 `npm install --no-save` 实际安装，探针用 mock 传输，**未发任何真实网络请求**
- 依赖数量来自 `npm install --dry-run` 输出（AI SDK 11 个 / Pi 79 个）
- 体积来自 npm registry `unpackedSize` 字段
- 探针结束后已 `npm uninstall` 并将 `package.json` / `package-lock.json` 复原，当前依赖只有 `ai` + `@ai-sdk/openai-compatible`
