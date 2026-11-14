# 墨页 · ink-leaf

安静、本地优先的 Markdown 编辑器与 AI 辅助写作工作空间，包含 Web v0.13、Windows 桌面预览版与 Android 适配工程。各端共用 `web/` 内的编辑、解析、样式和渲染源码；原生端通过受限桥接提供本地文件操作，不维护第二份编辑器副本。

墨页的长期方向是以 Markdown 为开放数据基础、以本地文档为工作上下文、由 AI 协助用户思考和创作的写作工作空间。AI 融入编辑过程（选区操作、文档问答、修改审阅），而非独立聊天产品；AI 可以提议修改，但人保留最终控制权。详见 [AI-first 扩展路线图](docs/superpowers/plans/2026-11-10-ink-leaf-extension-roadmap.md)。

支持标题大纲、段落实时预览、表格及对齐、多级列表与任务、分割线、转义、安全 HTML、本地 KaTeX 公式、代码语法高亮、Setext 标题、缩进代码块、裸 URL 自动链接、脚注与链接引用定义、图片占位渲染（网络图点击加载、桌面版读取本地图）、图片插入（桌面版粘贴或拖入截图自动保存到文档目录，一次可粘贴多张、一步撤销；网页端以 data URL 内嵌）、导出离线 HTML、桌面版导出 PDF（未加载的本地图片在导出时自动内嵌，导出中显示进度、完成后提示完整路径）、查找替换、撤销重做、Markdown 语法速查、主题与专注模式（桌面版专注模式保留工具栏，左缘大纲把手悬停呼出、点击固定）、桌面版「帮助 → 检查更新」手动查询 GitHub 新版本，发现新版本可在应用内直接下载安装。复杂块点击后编辑原文，离开后恢复预览，不是完整的所见即所得表格编辑器。桌面版还可导入本地文件夹：侧栏「文件夹」面板只读扫描其中的 Markdown（含子目录），以树形呈现并支持打开、重命名、新建、按名过滤与刷新；无法纳入查看的文件会在「未纳入的文件」清单中列出原因，导入的文件夹之间可切换、可移除（不改动磁盘内容）。应用会在本机记住上次打开的文档与文件夹，下次启动自动恢复。

## v0.13.1 修复

**AI 配置与连接**：
- 修复设置面板不回填已保存的服务地址与模型，以及只改模型就会清空 API Key
- 修复在设置输入框按回车直接关闭对话框、填了一半的配置丢失
- 修复用非标准盘符大小写路径启动时，AI 设置、问答与分析等桌面功能全部提示「不受信任的请求」
- 网关把限流（429）包装成 503 时改为提示「请求过于频繁」，未知模型的英文报错改为中文指引
- 兼容网关在响应末尾追加 `data: [DONE]` 或直接返回 SSE，正常回答不再被误报为解析失败

**AI 对话与审阅**：
- 文档问答支持多轮上下文，追问不必重复文档信息
- 发送后显示「思考中」占位并禁用重复发送
- 修复「重新生成」丢失原选区操作、无法按原动作重试
- 解释与逻辑检查改为只读结果，不再提供会覆盖原文的「接受」按钮

**上下文与面板**：
- 切换文档时清空问答、审阅、分析与待处理提案，并丢弃在途的旧请求结果
- 文档修改后提示分析结果已过期，可一键重新分析
- AI 面板打开时为编辑区让出宽度，不再遮住工具栏右侧按钮

## v0.13 新功能

**应用内更新**：
- 「帮助 → 检查更新」发现新版本后直接在应用内下载安装包，不再跳转浏览器
- 下载显示进度并按 SHA-256 校验（Release 资产带 digest 时），断流或校验失败会删除半成品
- 确认安装后退出应用，由独立进程等应用结束后静默运行 NSIS 安装包

**AI 修复**：
- 修复 AI 面板偶发整体不可用（面板挂载点改为 `document.body`）
- 远程调用增加超时与单次结算，服务端挂起不再一直转圈
- 选区操作按长度截断后再进提示词，提案支持重新生成
- 接受提案改用发起时记录的选区偏移定位原文
- 文档统计改为中文按字、西文按词计数

**文件夹与编辑修复**：
- 修复 Windows 上文件夹重命名/新建后打开文档仍指向旧文件名、保存落空的问题
- 修复粘贴图片后编辑器停在源码视图，图片、表格等渲染结果不可见
- 修复失焦后段落高亮不消失、预览不恢复
- 修复写入失败提示被下载提示覆盖

## v0.12 新功能

**AI 辅助写作**：
- 选区 AI 操作：改写、精简、扩写、解释、检查逻辑
- 文档问答：基于当前文档内容向 AI 提问
- 修改审阅：AI 提出修改建议，用户逐条接受或拒绝
- 文档分析：自动生成大纲、统计信息（字数、段落、代码块等）
- 文档摘要：AI 生成简短摘要，帮助快速回忆内容

**全文搜索**：
- 跨文件夹纯内存全文扫描，不建索引
- 支持大小写敏感与正则表达式
- 搜索结果按文件夹分组，点击跳转到对应文档

**最近文件**：
- 自动记录最近打开的 10 个文档
- 菜单「打开最近」快速访问

## Android 适配

Android 工程位于 `android/`，使用离线 WebView 加载共享编辑器，系统文件选择器负责导入和导出，不申请存储全盘访问权限。先运行 `npm ci && npm run sync:android`，再用 Android Studio 打开 `android/`。详见 [Android 开发与验证说明](docs/android.md)。当前是适配开发版，已完成首轮真机输入法走查（见 [docs/ime-checklist.md](docs/ime-checklist.md)）；Release 分发的 APK 为调试签名，不是发行签名。

移动网页也使用新触屏布局：44px 常用按钮、横滑格式栏、大纲遮罩、软键盘可视高度适配、触屏缩进和后台草稿保留。模拟回归运行 `CHROMIUM_PATH=/usr/bin/chromium npm run test:mobile`（需本地网页服务）；模拟事件不等于真实中文输入法测试。

## 从源码运行

需要 Node.js 22 或更新的受支持版本、npm；网页本地服务器与网页回归另需 Python 3。

```sh
npm ci
npm run start:web
```

访问 `http://127.0.0.1:4173/`。构建所需依赖首次下载后，运行时不依赖 CDN。网页草稿只保存在当前浏览器、当前网址；Chrome/Edge 中“保存”经系统文件选择器写回所选文件（File System Access API），其他浏览器下载新文件。

桌面开发预览：

```sh
npm start
```

若安装时禁用了依赖安装脚本，需先执行 `node node_modules/electron/install.js` 下载 Electron。桌面版目标为 Windows 10/11 x64，Linux 仅作为集成回归环境，不代表 Windows 已实测。

## 测试与构建

```sh
npm run check
npm test
npm run build:web
npm run test:desktop
npm run build:win
```

Windows 安装包和便携包输出到 `dist/`。当前未配置代码签名；不应视作已通过 Windows 认证的正式发行。源码提交不含安装器、发布产物或预生成图标；打包使用 Electron 默认图标。Windows 构建建议在 Windows 主机完成；跨平台构建可能另需 Wine 等工具。

要让桌面版「帮助 → 检查更新」能自动安装，GitHub Release 的资产名必须以 `-Setup.exe` 结尾（electron-builder 已按 `Inkstone-${version}-Windows-${arch}-Setup.exe` 命名），并覆盖当前架构。若资产带 sha256 `digest`，应用下载后会校验完整性、不匹配则丢弃安装包；没有 `digest` 时跳过校验。发布里没有匹配当前平台的安装包时，界面只提示「发现新版本」但不会引导下载。

Linux 无图形会话时运行桌面测试：`xvfb-run -a npm run test:desktop`。原生 X11 键盘回归另需 `xdotool`，命令为 `xvfb-run -a npm run test:keyboard`，这不等同于 Windows 键盘和输入法验证。

网页回归需 Python Playwright 与 Chromium。先执行 `python3 -m pip install -r tests/web/requirements.txt`，安装 Playwright Chromium（`python3 -m playwright install chromium`），保持 `npm run start:web` 运行，再分别执行：

```sh
python3 tests/web/smoke_test.py
python3 tests/web/advanced_test.py
python3 tests/web/controls_test.py
python3 tests/web/v04_test.py
python3 tests/web/v05_test.py
python3 tests/web/v06_test.py
python3 tests/web/v07_test.py
python3 tests/web/v08_test.py
python3 tests/web/v09_test.py
```

可用 `CHROMIUM_PATH` 指定浏览器、`INKSTONE_WEB_URL` 指定测试网址。测试输出在忽略目录 `test-results/`，不进入源码提交。

## 持续集成与发布

仓库自带四份 GitHub Actions 工作流：

- `.github/workflows/ci.yml`：推送到 `main` 或对其发起 PR 时，在 ubuntu 上跑 `check` / `npm test` / `build:web`，在 windows 上跑桌面端 Electron 回归（`npm run test:desktop`，结果归档到 `test-results/`），并验证 Linux 打包。
- `.github/workflows/web.yml`：在 ubuntu 上用 Python Playwright + Chromium 跑 `tests/web/` 下的全部网页回归；本地 `http.server` 已预先起好，自带服务器的用例会探测到并复用。
- `.github/workflows/pages.yml`：把 `npm run build:site` 产出的 `dist/site/` 用 `wrangler pages deploy` 直传到 Cloudflare Pages 项目 `ink-leaf`。推送到 `main` 为生产部署，推送到其他分支或同仓库 PR 为预览部署；fork 来的 PR 和标签推送会跳过。
- `.github/workflows/release.yml`：推送 `v*` 标签时在 windows 上执行 `npm run build:win`，把 `dist/*-Setup.exe` 与 `dist/*.zip` 作为资产发布到 GitHub Release，并在发布说明里列出网页版地址、提交与 SHA-256 校验表。

发布前需要在 GitHub 仓库设置里允许工作流写权限：Settings → Actions → General → Workflow permissions 选择 **Read and write permissions**，否则 `release.yml` 无法创建 Release（工作流文件里已声明 `contents: write`，但仓库级开关优先）。标签建议与 `package.json` 的 `version` 对应，例如 `version` 为 `0.13.0` 时打 `v0.13.0`，这样应用内「帮助 → 检查更新」才能正确比对版本号。

Cloudflare Pages 项目 `ink-leaf` 需要选择「外部 CI/CD / Direct Upload」构建方式，并在仓库 Secrets 里配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。还要确认该项目的生产分支是 `main`：Cloudflare 以分支名区分生产部署与预览部署，若生产分支被设成别的名字，`pages.yml` 对 `main` 的部署会落到预览而不是正式站点。

## 目录

- `web/`：共享编辑器、文档模型和渲染入口 `renderer.js`。
- `desktop/`：Electron 窗口、原生菜单、受限 IPC 和本地文件层。
- `scripts/build-web.mjs`：由锁定依赖生成 `web/vendor/`，包含渲染器、公式样式、字体和上游许可文本。该目录不纳入 Git。
- `tests/`：文件层、桌面集成、原生键盘与网页回归。
- `docs/windows.md`：桌面文件行为、快捷键与已知限制。
- `licenses/`：原有第三方告知文本，保留其原始版权与许可。

## AI 能力与数据边界

墨页的 AI 功能（v0.11 起集成于 Windows 桌面版）遵循以下原则：

- **本地优先**：AI 功能默认离线可用；远程模型调用仅在用户显式配置并确认后启用。
- **上下文透明**：每次向远程模型发送内容时，明确告知用户本次发送的上下文范围（当前选区 / 当前文档）。
- **修改确认**：AI 不直接写文件，只生成修改提案；用户逐条确认后才写入，所有修改可撤销。
- **密钥安全**：API Key 以 0o600 权限的本地配置文件（`ai-provider.json`）保存，不写入 `session.json` 或同步的 Markdown 文件；暂未接入操作系统钥匙串。
- **权限分离**：文件读取、修改、新建、删除是不同权限；首期不开放删除。

AI 面板、选区操作、文档问答、修改审阅、文档分析与摘要仅在桌面版提供；网页与 Android 端不启用远程模型调用。

## 数据安全与限制

桌面只接受不超过 10 MB 的 UTF-8 / UTF-8 BOM `.md`、`.markdown`、`.txt`，保存时保留已打开文件的 BOM 和换行方式。磁盘内容变化会提示冲突。写入临时文件后尝试替换目标；替换失败时保留原文件并报错，不以删除原文件作为回退。恢复草稿也不会先删除旧草稿；请始终使用 Ctrl+S，并为重要文件另行备份。此策略不承诺断电后的磁盘持久化，也不能消除其他进程同时写入的竞态。

文档内容不上传服务器；渲染层关闭 Node 集成并启用隔离沙箱。HTML 经过过滤，不执行脚本、表单或嵌入媒体。图片按 `![说明](路径)` 语法渲染为占位卡片：网络图片仅接受 https 且必须点击加载；桌面版的本地图片只读文档同目录内、扩展名与文件头（魔数）一致且不超过 5 MB 的文件，以 data URL 提供渲染层，不开放 file:// 访问。桌面版粘贴或拖入的截图经主进程原子写入文档同目录——文件名自动生成、扩展名由 MIME 类型映射并经文件头校验，单张不超过 5 MB，然后插入相对路径；网页与 Android 端粘贴截图以内嵌 data URL 写入文档，单张不超过 2 MB。「导出 HTML」生成离线单文件（公式以 MathML 内嵌），只内嵌 data: 与本次会话已实际加载的图片，其余显示占位提示；桌面版「导出 PDF」复用同一离线管线经系统打印输出，失败时报错不假称成功。不含图床集成、图片目录配置、多标签或云同步。「检查更新」仅在点击菜单时访问 GitHub Releases API，发现新版本后在应用内直接下载并校验安装包（有 digest 时按比例校验），确认后退出应用并静默安装 NSIS 安装包；不跳转浏览器，也不引入额外的自动升级依赖。代码块在非编辑状态显示高亮预览，点击后编辑原始 Markdown；高亮资源离线内置。脚注定义为单段、链接引用只认 `[文字][标签]` 完整形式，可选标题写进锚点提示；两者都必须独占一行才识别，紧接在段落或列表正文之后的定义行按原文保留，未配对的引用原样显示。不支持 shortcut 链接引用与定义列表。真实 Windows 安装、文件关联、SmartScreen 和中文输入法已按清单完成首轮走查（见 [docs/ime-checklist.md](docs/ime-checklist.md)）。

## 许可证

本仓库第一方源码与文档适用根目录 [MIT LICENSE](LICENSE)，保留仓库原有版权声明。npm 的 `private: true` 只是防止误发布到 npm，不限制 MIT 授权。

第三方依赖、字体及运行时仍按各自许可证使用，不因项目采用 MIT 而重新授权。原有告知见 [licenses/third-party-original.txt](licenses/third-party-original.txt)；构建同时从实际安装的上游依赖复制完整许可到 `web/vendor/licenses.txt`，覆盖渲染依赖及其传递依赖。打包附带项目 LICENSE、第三方告知与 Electron/Chromium 自带许可证。分发时不得移除这些文件。
