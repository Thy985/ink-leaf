# 墨页 Android 适配预览

Android 原生容器复用 `web/` 中的编辑器、解析和渲染核心，不维护第二套编辑器。触屏布局、中文输入法提交保护、后台草稿及系统文件导入导出已经接入；当前已构建调试 APK，但尚未完成真机验收，不是发行版本。

## 从源码构建

需要 Node.js 22+、JDK 17、Android SDK 35，以及 Android Studio 或命令行 SDK。使用 Gradle 8.7 Wrapper、Android Gradle Plugin 8.6.1，最低支持 Android 8.0（API 26）。请使用较新的 Android System WebView；缺少安全消息桥接能力时应用会提示更新。

在仓库根目录执行：

```sh
npm ci
npm run sync:android
cd android
./gradlew assembleDebug
```

Windows 使用 `gradlew.bat assembleDebug`。也可以先同步资源，再用 Android Studio 打开 `android/`。SDK 路径通过 `ANDROID_HOME` 或本地 `android/local.properties` 中的 `sdk.dir` 设置，该文件不应提交。

首次构建需要下载 Gradle、Android SDK 和 Maven 依赖，应用运行时不依赖网络。每次修改 `web/` 后重新运行 `npm run sync:android`；`android/scripts/copy-web.sh` 是同一命令的便捷入口。生成的 `assets/www/` 已被 Git 忽略，不要手工修改。

成功构建后的调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。Android 工具链默认会用本机自动生成的调试密钥签署 debug APK；这不是发行签名。本地构建不会自动发布 APK。

## 文件和草稿

“导入”调用系统 Storage Access Framework，读取不超过 2 MiB 的 UTF-8 `.md`、`.markdown` 或 `.txt`。允许 UTF-8 BOM，CRLF/CR 会统一为 LF；非法 UTF-8、超限或读取失败会保留当前草稿。

“导出 .md”调用系统创建文档界面，写出新的 UTF-8 Markdown 文件，不持有或覆盖导入原件的 URI。只有写入、flush 和关闭输出流成功后才标记导出成功。取消或失败不清除未导出状态；文件选择期间继续编辑的内容不会被错误标记为已导出。受文档提供方限制，失败的导出可能留下空白或部分文件，应用会报错，不会假称写入成功。

草稿在 WebView 的 localStorage 内保存，网页隐藏、页面离开和原生 Activity 暂停时会触发保留。清除应用数据或卸载会删除草稿；草稿不替代定期导出，也无法保证系统强制终止或断电前最后一次输入一定落盘。

## 触屏和输入法

常用按钮至少 44px；横向滑动格式栏可以找到表格、公式及缩进/退级按钮。工具操作第二行采用正常布局，不再依赖固定定位和占位间距；小屏隐藏纸张装饰标签，减少正文上方留白。大纲是可关闭的遮罩侧栏。小屏及窄横屏布局使用可视视口高度，原生容器统一处理并消费系统栏、刘海和 IME inset，避免子 WebView 重复处理；横竖屏切换保留当前 WebView。

点击工具栏第二行左侧的“沉浸写作”，隐藏文件栏、工具栏、大纲、装饰和底部状态栏。右上角始终保留至少 44px 高的“退出沉浸”；也可按 Esc，或在键盘收起后按安卓返回键退出。富文本和源码均支持，切换不重建编辑 DOM、不改文档和撤销历史，触屏操作保留编辑焦点与选区。这里的沉浸指减少编辑器界面干扰，不强行隐藏 Android 系统栏。

组合输入期间不重建编辑 DOM。`compositionend` 后延迟至下一任务提交，以容纳 Android 输入法在结束事件后产生的最终 `input`。组合期间不允许格式和文件操作。返回键先收起键盘，再关闭大纲、查找、对话框或专注模式，最后退出 Activity；退出前会触发草稿保留。

## 离线和桥接安全

页面通过 AndroidX WebViewAssetLoader 在 `https://appassets.androidplatform.net/assets/www/index.html` 加载。没有网络或存储权限，禁止远程导航、file/content 访问和混合内容；文档 HTML 继续由共享渲染器过滤。

AndroidX WebMessageListener 仅向可信 origin 的主 frame 提供消息桥接，不暴露任意路径或通用文件系统 API：

```js
window.InkLeafAndroid.postMessage(JSON.stringify({
  id: "唯一请求 id",
  action: "open", // 或 "export"
  filename: "文档.md",
  text: "导出时的文本快照"
}));
```

完成后由原生派发 `inkleaf-native-result`，detail 包含相同的 `id`，以及 `canceled`、`error` 或成功的 `filename`/`text`。文件读写在后台线程进行；只保留当前请求的导出快照，完成或失败后清理。

## 已通过与仍需验证

原有模型/文件层单测、网页回归、桌面集成和原生键盘回归可通过仓库脚本重跑。移动专项新增紧凑布局、沉浸入口/三种退出、切换中的组合输入焦点、续写撤销/重做与缩小视口检查；同时保留 320/360/393/412 和横屏布局、触控目标、大纲、Web 导入导出、后台保留，以及模拟 Android 桥接的取消/失败/快照状态检查。

v0.4 的代码高亮、Setext 标题、缩进代码块和裸 URL 链接由共享 `web/` 渲染器提供，Android 侧只同步资源，不改变原生文件桥；真机输入法与文件提供方验证要求不变。

v0.5 的脚注与链接引用定义同样只落在共享 `web/` 模型与渲染器里：解析、编号与锚点跳转都在网页层完成，Android 侧不需要新的权限、文件桥或原生代码；真机验证要求不变。

v0.6 的图片占位渲染与「导出 HTML」也由共享 `web/` 层完成：网络图片仅接受 https 并在点击后加载（CSP 已放行 img-src https:），本地图片在 Android 端不解析，只显示占位提示。导出 HTML 经由既有 export 动作携带渲染后的完整 HTML，由系统文件选择器保存为新文件，不改变 Markdown 文档的已导出状态；原生桥无需新增权限或接口。

v0.7 新增的桌面图片插入与 PDF 导出不涉及 Android：无任意文件写入权限，粘贴或拖入图片不落盘，仅网页路径以 data URL 内嵌（单张不超过 2 MB，内嵌进文档后随导入导出走既有桥接）；「导出 PDF」在 Android 端不可用。原生桥与 Android 工程代码无需变更。

v0.8 把图片插入踩实后，Android 端的多图粘贴同样适用：一次粘贴多张截图或复制的图片会以多个 data URL 一次性内嵌进文档（单张 2 MB 限制不变，个别失败跳过并汇总提示）；拖拽兜底与导出反馈属于桌面能力，PDF 导出在 Android 端仍不可用。共享 `web/` 层更新由 `npm run sync:android` 同步，原生桥与 Android 工程代码无需变更。

当前环境已安装 SDK，`assembleDebug` 和 `lintDebug` 已通过。未连接 Android 真机或模拟器，尚未验证安装、原生系统选择器或真实输入法。浏览器视口缩小和合成组合输入只能验证网页事件契约，不能代替 Android 真机。

进入下一阶段前需在设备上测试：

- Android 8+ 与 Android 15+ 的系统栏、手势导航、横竖屏和键盘遮挡。
- Gboard、搜狗、百度等输入法的拼音选词、连续输入、回删、换行、候选取消和选区替换。
- SAF 本地及云端文档提供方的取消、无权限、非法编码、超限和导出失败。
- 后台切换、系统回收、返回键退出后的草稿恢复。
