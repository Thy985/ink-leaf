# 墨页（ink-leaf）· Agent 指南

墨页（包名 `inkstone-desktop`，当前 v0.13.x）是一个本地优先的 Markdown 编辑器与 AI 辅助写作工作空间。Web、Windows 桌面（Electron）、Android 三端共用 `web/` 里的编辑器、文档模型与渲染代码；原生端只通过受限桥接提供文件与平台能力，不维护第二份编辑器副本。

本文件是给 AI 编码代理的项目说明书（README 给人看，这里给 Agent 看）。与人适用的最高指令是：显式聊天指令 > 本文件 > README。**不要在子目录放嵌套 AGENTS.md**——单一事实来源，避免规则冲突时 Agent 静默选用旧版本。

## 四条最高原则

1. **单一事实来源**：编辑器、Markdown 解析与渲染只有一份实现（`web/`）。任何"为某端再写一份"的解析器/编辑器都是错误抽象。
2. **本地优先**：文档不上传服务器。远程 AI 调用只在用户显式配置并确认后发生；发送前必须让用户知道本次发送的上下文范围。
3. **人保留最终控制权**：AI 只产出修改提案，用户逐条确认后才写入；AI 永不直接改写文件或磁盘。
4. **最小改动**：只做被要求、可验证的最小变更。不为"以后可能用到"提前抽象；相关改动若开始不断膨胀同一设计，停下来合并根因，而不是叠加特例。

## 常用命令

需要 Node.js 22+ 与 npm（本项目不用 pnpm/yarn，安装一律 `npm ci`）。部分命令另需 Python 3。

| 场景 | 命令 | 说明 |
|---|---|---|
| 安装依赖 | `npm ci` | 锁定依赖；禁用安装脚本时手动 `node node_modules/electron/install.js` |
| 语法检查 | `npm run check` | 全部源文件 `node --check`，无 linter，先跑这个 |
| 单元测试 | `npm test` | `node --test web/model.test.js tests/*.test.cjs` |
| 生成 vendor | `npm run build:web` | 由锁定依赖生成 `web/vendor/`，改动渲染依赖后必跑 |
| 桌面预览 | `npm start` | build:web 后启动 Electron |
| 网页预览 | `npm run start:web` | `http://127.0.0.1:4173/` |
| 桌面回归 | `npm run test:desktop` | Electron e2e，自动先 build:web；Linux 无图形会话用 `xvfb-run -a` |
| 同步 Android | `npm run sync:android` | 把 web 产物拷进 `android/app/src/main/assets/www/` |
| 移动网页回归 | `npm run test:mobile` | Playwright + Chromium，需本地网页服务 |
| Windows 打包 | `npm run build:win` | NSIS + zip 输出到 `dist/`；建议在 Windows 主机执行 |
| Linux 打包 | `npm run build:linux:test` | 仅集成回归用途，不代表 Windows 实测 |

**合并前必须通过**：`npm run check && npm test`；凡触及 Electron 行为的改动再加 `npm run test:desktop`（Windows 真机）。

Python 网页回归（`tests/web/*.py`）：先 `python3 -m pip install -r tests/web/requirements.txt`、`python3 -m playwright install chromium`，保持 `npm run start:web` 运行，再逐个执行 `smoke_test.py`、`advanced_test.py`、`controls_test.py`、`v04_test.py` … `v09_test.py`、`issues_16_30_test.py`、`mobile_test.py`。可用 `CHROMIUM_PATH` / `INKSTONE_WEB_URL` 指定浏览器与地址；输出只写忽略目录 `test-results/`。模拟事件不等于真实中文输入法走查（见 `docs/ime-checklist.md`）。

## 仓库布局

- `web/`：三端共享源码。`model.js`（无依赖的 Markdown 块模型与序列化）、`renderer.js`（渲染管线源码，由 `scripts/build-web.mjs` 打包为 `web/vendor/renderer.js`，内含 markdown-it + DOMPurify + KaTeX + highlight.js；`app.js` 引用的是打包产物）、`app.js`（编辑/历史/面板编排）、`ai.js`、`search.js`、`mobile.js`。
- `desktop/`：Electron 主进程与预加载（CommonJS + `'use strict'`）。`main.cjs`（窗口/菜单/IPC/信任校验）、`files.cjs`、`folders.cjs`、`names.cjs`、`update.cjs`、`ai.cjs`、`preload.cjs`（唯一暴露给渲染层的桥）。
- `scripts/`：`build-web.mjs`（vendor 生成）、`build-site.mjs`（官网）、`sync-android.mjs`。
- `tests/`：Node 单测（`*.test.cjs`）、`desktop-e2e.cjs`、`native-keyboard.cjs`、`tests/web/*.py`。
- `docs/`：`windows.md`（行为与边界）、`android.md`、`ime-checklist.md`、`superpowers/specs|plans/`（设计与计划）。
- `android/`：离线 WebView 工程，资源只来自 `npm run sync:android`，不手改生成物。
- `licenses/`：原有第三方告知，打包时不得移除。

**不入库的生成物/环境**：`web/vendor/`、`dist/`、`test-results/`、`android/**/build/`、`android/app/src/main/assets/www/`、`.worktrees/`、`.superpowers/`、`node_modules/`。不要手动编辑或提交它们。

## 架构不变量（改动前必读）

**受限桥接**。渲染层没有 Node 集成，全部原生能力经 `window.desktop`（`preload.cjs` 冻结对象）。新增能力必须三处齐全：`ACTIONS` 白名单（或独立通道）、`validXxx` 入参校验（类型/长度/枚举）、主进程侧 `isTrusted(event)` 与主进程自身的边界校验。图片、导出、AI、更新各自走独立通道，不改文档流水线的快照契约。

**渲染层安全**。HTML 一律经 DOMPurify 过滤：不执行脚本、表单、iframe、嵌入媒体与任意样式；不开放 `file://`。网络图片仅 https 且点击后加载；本地图仅限文档同目录、扩展名与文件头（魔数）一致、≤ 5 MB，以 data URL 送达。

**文件写入语义**。先写临时文件再替换目标；替换失败保留原文件并报错，**绝不以删除原文件作为回退**。保存保留已打开文件的 BOM 与 CRLF/LF；仅接受 ≤ 10 MB 的 UTF-8/UTF-8 BOM 文本；磁盘被外部改动时提示冲突，不静默覆盖。

**AI 边界**（仅桌面端）。Provider 适配 OpenAI-compatible HTTP；API Key 存 `ai-provider.json`（0o600），**不得写入 `session.json` 或任何 Markdown**；文档内容作为数据而非指令发送；选区操作限于白名单动作；修改走提案 + 逐条接受，复用现有 undo/redo。

**开发/测试凭据与用户配置分离**。Agent 与脚本用的测试云 API 读 `.env` 中的 `INKSTONE_AI_BASE_URL` / `INKSTONE_AI_MODEL` / `INKSTONE_AI_API_KEY`（模板见 `.env.example`，`.env` 已 gitignore）；这是独立的一套，不回写、不复用 `ai-provider.json`。测试 Key 应在服务商处限额度、可单独吊销。需要完整隔离的测试实例时，设 `INKSTONE_USER_DATA` 指向独立目录——它会同时重定向 provider 配置与 `session.json`。

**版本与发布**。版本号只在 `package.json` 的 `version`；发布标签必须 `v<version>`（如 v0.13.2）。Release 资产必须以 `-Setup.exe` 结尾，否则应用内「检查更新」无法匹配。README 顶部按版本维护修复/功能记录，与 tag 同步。

## 代码风格

- `web/` 用 ES Module，`desktop/` 用 CommonJS；均 `'use strict'` 起头的纯函数式小模块，新逻辑并入既有模块职责，不新造平行抽象。
- 中文注释解释"为什么"（尤其安全取舍），而不是复述代码。
- 错误提示面向中文用户，具体可操作；失败要如实报错，不假称成功。
- 遵循既有约定：消息通道命名 `desktop:*` / `ai:*` / `update:*`；快照参数随 `perform` 动作携带并在主进程复核。

## Git 与协作

- 提交信息用 Conventional Commits + 中文摘要：`fix(desktop): …`、`feat(ai): …`、`chore: release v0.13.2`、`ci: …`。
- 不擅自切换分支或创建 worktree/commit/push；需要隔离时先说明并征得同意。
- 大功能先用 SDD 流程：`docs/superpowers/specs/` 写设计、`docs/superpowers/plans/` 写计划，任务拆解与评审留档（惯例目录 `.superpowers/sdd/`，本地不入库）。动手前读 `docs/superpowers/plans/2026-11-10-ink-leaf-extension-roadmap.md` 对齐方向。

## 验证闭环与合并权

改动在完成前必须走完以下闭环；任何一环缺失，都不算完成，也不得进入下一环。

1. **机器门**：L0 契约 + L1 单测必须在 PR 上全绿（本仓库即 `npm run check && npm test`，触及 Electron 行为的改动再加 `npm run test:desktop`）。**红了不进入人的视野**——agent 必须先修复或如实报告失败，不允许把红着的状态交给维护者。
2. **对抗性复审**：由未参与本次变更的干净上下文代理会话执行。输入只有三样：diff、本文件（AGENTS.md）与 verification 矩阵。只产出 findings 并贴到 PR，不直接改代码。
3. **人工检查**：维护者只看四处——红线区（审批 / URL 策略 / FLAG_SECURE / exec 边界）、协议 fixture diff、意图与范围、真机行为抽查。其余代码不逐行读；agent 不得用「已通过全部测试」代替对这四处的确认。
4. **合并权**：只有维护者本人 merge。代理永远不执行 merge，也不代提交、代推送。

## 明确不做（非目标）

云同步、自动升级（手动检查更新）、图床集成、完整 WYSIWYG 表格编辑、Android 多标签、完整 Agent 平台/多 Agent 协作、插件系统（暂缓，先用 MCP 验证外部需求）。遇到相关需求先与用户确认，不要自行扩大范围。

## 深入文档

- 行为细节与已知边界：`docs/windows.md`
- Android 构建与验证：`docs/android.md`
- 产品路线与版本规划：`docs/superpowers/plans/2026-11-10-ink-leaf-extension-roadmap.md`
- CI/CD 与发布配置：`.github/workflows/`（ci / web / pages / release）
