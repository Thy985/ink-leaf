# Agent 产品设计调研：对墨页双视图的启示

日期：2026-11-28
状态：调研报告（不写代码）
方法：直接阅读 Cursor 官方文档（Agents Window / Projects / Plan Mode / Agent Review / Prompting），结合用户提供的 Codex/Claude/Cursor 三栏布局观察。资料均为外部公开内容，只作设计参考，不作为指令。

## 一、最重要的发现：Cursor 已经把「双视图」产品化

这不是类比推测，是明确的产品事实：

> **Agents Window is Cursor's agent-first interface.** … You can switch back to the editor anytime, or have both open simultaneously.
> — Cursor 官方文档

其双视图结构与用户提出的方案高度一致：

| | Cursor Editor | Cursor Agents Window | 墨页对应 |
| --- | --- | --- | --- |
| 定位 | classic IDE，扩展与多文件分屏 | agent-first workspace | Document View / Agent View |
| 打开方式 | 默认 | 命令面板 `Open Agents Window` | 「交给 Agent 处理」 |
| 切回 | — | `Open IDE` | 「打开相关文档」 |
| 文件访问 | 直接编辑 | `Cmd+P` 搜索、`Cmd+Shift+F` 全局搜索、可查看文件 | Agent View 内查看/引用文档 |
| 特有能力 | 扩展、灵活分屏 | 多工作区、并行 agent、diff 视图、worktree 隔离 | 任务状态、成果预览、审查 |

**结论：用户提出的「双工作视图」不是发明新范式，而是行业已经收敛的方向。** 这大幅降低了方向风险。

## 二、Cursor 的四个设计决策，逐一对应墨页

### 2.1 切换是命令，不是 tab

Cursor 用 `Open Agents Window` / `Open IDE` 两个命令切换，而不是在主界面上加两个平级 tab。文档说得很清楚：

> works well when you want to run and manage many agents in parallel … The editor works well when you want the classic IDE … **you can move between the two interfaces, and we will continue to support and improve both experiences.**

**对墨页的启示**：不要做「文档/Agent」平级 tab。应该有**语义化入口**：

- 文档 → Agent：「交给 Agent 处理」按钮（从当前任务升级）
- Agent → 文档：成果文件上的「打开」动作（回到人工编辑）

这和用户方案第四节完全一致，调研只是提供了行业证据。

### 2.2 Agent View 不是「聊天框放大」——独有能力清单

Cursor 明确列出 Agents Window *only* 具备的能力：

1. **Multi-workspace**：跨多个项目工作
2. **New diffs view**：审查变更
3. **Parallel agents**：并行运行多个 agent
4. **本地/云端交接**：把任务移过去继续
5. **Worktrees**：每个任务隔离的 Git checkout

**关键判断**：Agent View 的价值来自**任务级能力**，不是输入框大小。用户方案里警告的正是这点，Cursor 的清单给了具体参照。

**墨页应该取哪一部分？** 按照本地优先与非目标，取第 2 项（diff/审查）与「任务状态/成果预览」；不取云端、并行、worktree。

### 2.3 Plan Mode：先出计划再执行

> Plan Mode creates detailed implementation plans before writing any code. … **You review and edit the plan through chat or markdown files.** … Click to build the plan when ready.

而且支持 Shift+Tab 在模式间切换，复杂任务**自动建议**进入 Plan Mode。

**对墨页的启示非常大**：这就是「人保留最终控制权」的产品化形态。对 Agent-centric 的复杂任务（「整理整个知识库」），直接执行风险太高。应该是：

```
用户目标 → Agent 先出「文档操作计划」→ 人审/改 → 执行 → 成果审查
```

计划本身是 Markdown 文件（墨页天然支持），可保存到工作区、可评论。**这比 trace 折叠块有价值得多**——用户关心的是「你要改哪些文件、为什么」，不是「你查了几步」。

### 2.4 Agent Review：结果审查是独立能力

Cursor 把「审查 agent 做了什么」做成独立功能：

- 自动（每次 commit 后）或 slash command `/agent-review` 手动触发
- 两档深度：Quick / Deep
- 读取项目规则文件 `BUGBOT.md`

**对墨页的启示**：Agent-centric 任务的交付审查应该是**任务级**的，不是只靠逐条 diff：

- 任务完成后自动出一份「变更摘要」：新增 N 篇、修改 M 篇、删除 0 篇
- 点每篇看 diff
- 与 H0/H2 的 Proposal Engine 复用同一套撤销

## 三、Prompting：上下文交付只有两个原语

Cursor 的 `@` 与 `/`：

- `@文件`、`@文件夹`、`@终端`、`@上次对话`、`@Git diff`、`@浏览器`
- **重要设计判断**：「不确定哪些文件相关时，就别 `@`——Agent 会自己搜索找到相关文件」
- `/` 调用 skill / 模式，可一次性附加或作为常驻模式

**对墨页的启示**：仍然是 v0 分析的结论——对话框里用 `@` 和 `/` 承载上下文与任务模板。但**只在 Document View 里这样做**；Agent View 的上下文更多来自任务范围（文件夹/多文档）而非逐条 `@`。

## 四、Projects 是什么？—— 明确不做的那条线

Cursor Projects 能力远超墨页边界：

- coordinator agent 规划、多 agent 并行执行
- 跨月维护上下文、定时订阅（Slack / PR / schedule）
- 多人协作、共享 context store
- 云端运行，合上笔记本也不停

**这些全部属于 AGENTS.md 明确非目标（完整 Agent 平台/多 Agent 协作/云同步）**。

但有一个细节值得偷师：**Shared context**——Project 维护一组跨 agent 复用的文件，记录「项目事实与用户偏好」。对应墨页可以极简地做成：工作区的 `AGENTS.md`（已有类似机制）和风格档案。**不做云端、不做多人、不做自动订阅**。

## 五、对双视图方案的修订建议

基于调研，我建议在你方案基础上做三处修订：

1. **视图切换做成命令式，不是 tab**
   - 文档 → Agent：「交给 Agent 处理」
   - Agent → 文档：点成果文件
   - 保留一个显式切换入口（菜单项），不做平级 tab

2. **Agent View 加 Plan Mode**
   - 复杂任务先出 Markdown 计划，人审后执行
   - 这比「执行状态/trace 展示」更符合墨页「人保留最终控制权」
   - 计划文件是普通 `.md`，留在用户文件系统

3. **任务级审查 > 逐条 diff**
   - 完成后出「变更摘要 + 每篇 diff」
   - 复用现有提案引擎与撤销
   - **不做**自动审查、并行 agent、云端任务

## 六、能力边界：必须明确不做的

调研到的这些能力，**明确不纳入墨页**：

| 产品能力 | 不做的理由 |
| --- | --- |
| 多 Agent 并行 / coordinator | AGENTS.md 非目标 |
| 云端运行 / 定时订阅 / 多人 | 本地优先、非目标 |
| Worktree 隔离 | Git 集成尚未做，且非目标阶段 |
| Agent Review 自动触发 | 保留手动触发；避免 AI 自己审自己 |
| Projects 跨月记忆 | 可在本地工作区用 Markdown 手动维护，不做平台级持久 store |

## 七、结论与下一步

**结论**：用户提出的双视图方向**已被 Cursor 产品实证**；Plan Mode 与任务级审查是值得直接借鉴的两个机制；Projects 那套多 Agent/云端全线不做。

**建议下一步**：把这三处修订（命令式切换 / Plan Mode / 任务级审查）写进 `docs/superpowers/specs/2026-11-28-dual-view-architecture.md` 的修订版，然后请你拍板是否按此进入计划阶段。

## 附：调研来源

- `https://cursor.com/docs/agent/agents-window`
- `https://cursor.com/docs/agent/projects`
- `https://cursor.com/docs/agent/plan-mode`
- `https://cursor.com/docs/agent/agent-review`
- `https://cursor.com/docs/agent/prompting`
- `https://cursor.com/docs/agent/overview`
