# 墨页 · ink-leaf

安静、本地优先的 Markdown 编辑器，包含 Web v0.8、Windows 桌面预览版与 Android 适配工程。各端共用 `web/` 内的编辑、解析、样式和渲染源码；原生端通过受限桥接提供本地文件操作，不维护第二份编辑器副本。

支持标题大纲、段落实时预览、表格及对齐、多级列表与任务、分割线、转义、安全 HTML、本地 KaTeX 公式、代码语法高亮、Setext 标题、缩进代码块、裸 URL 自动链接、脚注与链接引用定义、图片占位渲染（网络图点击加载、桌面版读取本地图）、图片插入（桌面版粘贴或拖入截图自动保存到文档目录，一次可粘贴多张、一步撤销；网页端以 data URL 内嵌）、导出离线 HTML、桌面版导出 PDF（未加载的本地图片在导出时自动内嵌，导出中显示进度、完成后提示完整路径）、查找替换、撤销重做、Markdown 语法速查、主题与专注模式（桌面版专注模式保留工具栏，鼠标移到窗口左缘呼出大纲）。复杂块点击后编辑原文，离开后恢复预览，不是完整的所见即所得表格编辑器。

## Android 适配

Android 工程位于 `android/`，使用离线 WebView 加载共享编辑器，系统文件选择器负责导入和导出，不申请存储全盘访问权限。先运行 `npm ci && npm run sync:android`，再用 Android Studio 打开 `android/`。详见 [Android 开发与验证说明](docs/android.md)。当前是适配开发版，不代表已完成真机输入法验证，也未签名或发布 Android 安装包。

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

## 目录

- `web/`：共享编辑器、文档模型和渲染入口 `renderer.js`。
- `desktop/`：Electron 窗口、原生菜单、受限 IPC 和本地文件层。
- `scripts/build-web.mjs`：由锁定依赖生成 `web/vendor/`，包含渲染器、公式样式、字体和上游许可文本。该目录不纳入 Git。
- `tests/`：文件层、桌面集成、原生键盘与网页回归。
- `docs/windows.md`：桌面文件行为、快捷键与已知限制。
- `licenses/`：原有第三方告知文本，保留其原始版权与许可。

## 数据安全与限制

桌面只接受不超过 10 MB 的 UTF-8 / UTF-8 BOM `.md`、`.markdown`、`.txt`，保存时保留已打开文件的 BOM 和换行方式。磁盘内容变化会提示冲突。写入临时文件后尝试替换目标；替换失败时保留原文件并报错，不以删除原文件作为回退。恢复草稿也不会先删除旧草稿；请始终使用 Ctrl+S，并为重要文件另行备份。此策略不承诺断电后的磁盘持久化，也不能消除其他进程同时写入的竞态。

文档内容不上传服务器；渲染层关闭 Node 集成并启用隔离沙箱。HTML 经过过滤，不执行脚本、表单或嵌入媒体。图片按 `![说明](路径)` 语法渲染为占位卡片：网络图片仅接受 https 且必须点击加载；桌面版的本地图片只读文档同目录内、扩展名与文件头（魔数）一致且不超过 5 MB 的文件，以 data URL 提供渲染层，不开放 file:// 访问。桌面版粘贴或拖入的截图经主进程原子写入文档同目录——文件名自动生成、扩展名由 MIME 类型映射并经文件头校验，单张不超过 5 MB，然后插入相对路径；网页与 Android 端粘贴截图以内嵌 data URL 写入文档，单张不超过 2 MB。「导出 HTML」生成离线单文件（公式以 MathML 内嵌），只内嵌 data: 与本次会话已实际加载的图片，其余显示占位提示；桌面版「导出 PDF」复用同一离线管线经系统打印输出，失败时报错不假称成功。不含图床集成、图片目录配置、多标签、云同步、自动升级或完整 CommonMark/LaTeX 支持。代码块在非编辑状态显示高亮预览，点击后编辑原始 Markdown；高亮资源离线内置。脚注定义为单段、链接引用只认 `[文字][标签]` 完整形式，可选标题写进锚点提示；两者都必须独占一行才识别，紧接在段落或列表正文之后的定义行按原文保留，未配对的引用原样显示。不支持 shortcut 链接引用与定义列表。真实 Windows 安装、文件关联、SmartScreen 和中文输入法仍需设备验证（清单见 [docs/ime-checklist.md](docs/ime-checklist.md)）。

## 许可证

本仓库第一方源码与文档适用根目录 [MIT LICENSE](LICENSE)，保留仓库原有版权声明。npm 的 `private: true` 只是防止误发布到 npm，不限制 MIT 授权。

第三方依赖、字体及运行时仍按各自许可证使用，不因项目采用 MIT 而重新授权。原有告知见 [licenses/third-party-original.txt](licenses/third-party-original.txt)；构建同时从实际安装的上游依赖复制完整许可到 `web/vendor/licenses.txt`，覆盖渲染依赖及其传递依赖。打包附带项目 LICENSE、第三方告知与 Electron/Chromium 自带许可证。分发时不得移除这些文件。
