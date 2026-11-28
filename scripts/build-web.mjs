import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'web/vendor');
await mkdir(vendor, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['web/renderer.js'],
  outfile: 'web/vendor/renderer.js',
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  legalComments: 'eof',
});
await cp(path.join(root, 'node_modules/katex/dist/katex.min.css'), path.join(vendor, 'katex.min.css'));
await cp(path.join(root, 'node_modules/katex/dist/fonts'), path.join(vendor, 'fonts'), { recursive: true });

// Include the upstream texts unchanged; project MIT does not replace them.
const seen = new Set();
const notices = [];

// 判断一份许可证文本是否「足够完整」。
// 只看「有没有 license 文件」是不够的：实测 ai / @ai-sdk/gateway / @ai-sdk/provider /
// @ai-sdk/openai-compatible 的 LICENSE 都是 552 字节的引用式声明（"Licensed under the
// Apache License, Version 2.0 …" + 一个链接），@workflow/serde 的 LICENSE.md 只有 73 字节、
// 只是指向仓库根的指针。它们都有文件，却都没有条款全文——按「有文件即通过」判断，
// 随安装包分发的这几个 Apache-2.0 包就只拿到样板声明，不满足 §4(a)
// 「须给接收者一份 License」。
// 这里用特征串判断：Apache-2.0 必须有完整条款标题。
const LICENSE_COMPLETENESS = [
  { match: /Apache License/i, need: /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/ },
];

function isCompleteLicense(text, declared) {
  if (typeof text !== 'string' || text.length < 512) return false;
  if (!/apache-?2\.0/i.test(String(declared || ''))) return true; // 只对 Apache 系列做严格判断
  return LICENSE_COMPLETENESS.every(({ match, need }) => !match.test(text) || need.test(text));
}

// fallback: { file, packages }。只在 packages 明确列出的包上生效——
// 不沿依赖树无差别下传，否则任何缺文件的依赖都会被盖上一份 Apache 全文，
// 连 MIT/BSD 的包也会被标成「upstream omits it」，那是在合规材料里编造事实。
async function notice(name, fallback = null) {
  if (seen.has(name)) return;
  seen.add(name);
  const dir = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const files = (await readdir(dir)).filter(file => /^(license|licence|copying|notice)([.-]|$)/i.test(file));
  const texts = [];
  for (const file of files) {
    try { texts.push({ file, text: await readFile(path.join(dir, file), 'utf8') }); }
    catch { /* 目录或不可读文件，跳过 */ }
  }
  notices.push(`\n===== ${pkg.name} ${pkg.version} (${pkg.license || 'see upstream text'}) =====\n`);

  const complete = texts.length > 0 && texts.some(({ text }) => isCompleteLicense(text, pkg.license));
  if (complete) {
    for (const { file, text } of texts) notices.push(`\n--- ${file} ---\n${text}`);
  } else if (fallback && fallback.packages.includes(name)) {
    // 上游只给了引用声明或指针文件：附上完整条款，并在标题里如实说明原因。
    const reason = texts.length ? 'upstream ships only a short reference, not the full text' : 'upstream package omits it';
    let full;
    try {
      full = await readFile(path.join(root, fallback.file), 'utf8');
    } catch (error) {
      throw new Error(`缺少许可证兜底文件 ${fallback.file}（${name} 需要）：${error.message}`);
    }
    for (const { file, text } of texts) notices.push(`\n--- ${file} (upstream) ---\n${text}`);
    notices.push(`\n--- LICENSE (full text supplied by ink-leaf; ${reason}) ---\n${full}`);
  } else if (texts.length) {
    for (const { file, text } of texts) notices.push(`\n--- ${file} ---\n${text}`);
  } else {
    throw new Error(`Missing upstream license: ${name}`);
  }
  for (const dependency of Object.keys(pkg.dependencies || {}).sort()) await notice(dependency, fallback);
}
for (const name of ['markdown-it', 'dompurify', 'katex', 'highlight.js']) await notice(name);
notices.push('\n===== Babel regenerator helpers embedded in DOMPurify (MIT) =====\n');
notices.push(await readFile(path.join(root, 'licenses/babel-helpers-MIT.txt'), 'utf8'));

// 桌面端的 AI 层引入了 Vercel AI SDK（Apache-2.0），它是**运行时**依赖，会随 asar 一起分发。
// 之前这里只聚合渲染层的四个包，AI 依赖的许可证因此没有出现在 THIRD-PARTY-NOTICES.txt 里。
// 这些包的上游 LICENSE 都只有几百字节的引用声明，所以用 licenses/apache-2.0.txt 补全文。
// 它们不进 web/vendor 的打包产物（渲染层不用 AI SDK），但必须出现在 notices 里，
// 因为桌面安装包会把 node_modules 里的它们一并分发。
const AI_LICENSE_FALLBACK = {
  file: 'licenses/apache-2.0.txt',
  packages: [
    'ai',
    '@ai-sdk/gateway',
    '@ai-sdk/provider',
    '@ai-sdk/provider-utils',
    '@ai-sdk/openai-compatible',
    '@workflow/serde',
    '@vercel/oidc',
  ],
};
for (const name of ['ai', '@ai-sdk/openai-compatible']) await notice(name, AI_LICENSE_FALLBACK);
await writeFile(path.join(vendor, 'licenses.txt'), notices.join('\n') + '\n');
console.log('Built shared Web/Desktop renderer, local KaTeX assets and upstream notices.');
