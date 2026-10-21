# 墨页 Android 适配预览

Android 原生容器复用 `web/` 中的编辑器、解析和渲染核心，不维护第二套编辑器。触屏布局、中文输入法提交保护、后台草稿及系统文件导入导出已经接入；当前是开发预览，尚未完成 APK 编译和真机验收，没有签名或发布安装包。

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

成功构建后的调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。Android 工具链默认会用本机自动生成的调试密钥签署 debug APK；这不是发行签名。本任务没有构建产出、创建发行密钥或发布 APK。

## 文件和草稿

“导入”调用系统 Storage Access Framework，读取不超过 2 MiB 的 UTF-8 `.md`、`.markdown` 或 `.txt`。允许 UTF-8 BOM，CRLF/CR 会统一为 LF；非法 UTF-8、超限或读取失败会保留当前草稿。

“导出 .md”调用系统创建文档界面，写出新的 UTF-8 Markdown 文件，不持有或覆盖导入原件的 URI。只有写入、flush 和关闭输出流成功后才标记导出成功。取消或失败不清除未导出状态；文件选择期间继续编辑的内容不会被错误标记为已导出。受文档提供方限制，失败的导出可能留下空白或部分文件，应用会报错，不会假称写入成功。

草稿在 WebView 的 localStorage 内保存，网页隐藏、页面离开和原生 Activity 暂停时会触发保留。清除应用数据或卸载会删除草稿；草稿不替代定期导出，也无法保证系统强制终止或断电前最后一次输入一定落盘。

## 触屏和输入法

常用按钮至少 44px；横向滑动格式栏可以找到表格、公式及缩进/退级按钮。大纲是可关闭的遮罩侧栏。小屏布局使用可视视口高度，原生容器处理系统栏、刘海和 IME inset，横竖屏切换保留当前 WebView。

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

已通过 26 项模型/文件层单测、35 项原有网页回归、22 项桌面集成回归，以及 10 项移动专项回归。移动专项覆盖 320/360/393/412 和横屏布局、触控目标、大纲、Web 导入导出、合成中文组合输入、后台保留，以及模拟 Android 桥接的取消/失败/快照状态。

当前环境只有 JDK、没有 Android SDK：Gradle Wrapper 可运行，但构建在 SDK 缺失处停止，尚未验证 Java/Android 编译、安装、原生系统选择器或真实输入法。浏览器模拟不能代替 Android 真机。

进入下一阶段前需在设备上测试：

- Android 8+ 与 Android 15+ 的系统栏、手势导航、横竖屏和键盘遮挡。
- Gboard、搜狗、百度等输入法的拼音选词、连续输入、回删、换行、候选取消和选区替换。
- SAF 本地及云端文档提供方的取消、无权限、非法编码、超限和导出失败。
- 后台切换、系统回收、返回键退出后的草稿恢复。
