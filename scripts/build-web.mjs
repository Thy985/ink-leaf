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
async function notice(name, { fallback } = {}) {
  if (seen.has(name)) return;
  seen.add(name);
  const dir = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const files = (await readdir(dir)).filter(file => /^(license|licence|copying|notice)([.-]|$)/i.test(file));
  notices.push(`\n===== ${pkg.name} ${pkg.version} (${pkg.license || 'see upstream text'}) =====\n`);
  if (!files.length) {
    // 有些上游包（例如 @ai-sdk/provider-utils）只在 package.json 声明许可证，
    // 分发包里却不带 LICENSE 文本。合规要求随分发提供完整许可证，
    // 所以用仓库里保存的 Apache-2.0 全文兜底，并在标题里注明来源。
    if (!fallback) throw new Error(`Missing upstream license: ${name}`);
    notices.push(`\n--- LICENSE (full text supplied by ink-leaf; upstream package omits it) ---\n${await readFile(path.join(root, fallback), 'utf8')}`);
  } else {
    for (const file of files) notices.push(`\n--- ${file} ---\n${await readFile(path.join(dir, file), 'utf8')}`);
  }
  for (const dependency of Object.keys(pkg.dependencies || {}).sort()) await notice(dependency, { fallback });
}
for (const name of ['markdown-it', 'dompurify', 'katex', 'highlight.js']) await notice(name);
notices.push('\n===== Babel regenerator helpers embedded in DOMPurify (MIT) =====\n');
notices.push(await readFile(path.join(root, 'licenses/babel-helpers-MIT.txt'), 'utf8'));

// 桌面端的 AI 层引入了 Vercel AI SDK（Apache-2.0），它是**运行时**依赖，会随 asar 一起分发。
// 之前这里只聚合渲染层的四个包，AI 依赖的许可证因此没有出现在 THIRD-PARTY-NOTICES.txt 里。
// 其中 @ai-sdk/provider-utils 上游分发包不带 LICENSE 文件，用 licenses/apache-2.0.txt 兜底。
// 这些包不进 web/vendor 的打包产物（渲染层不用 AI SDK），但必须出现在 notices 里，
// 因为桌面安装包会把 node_modules 里的它们一并分发。
for (const name of ['ai', '@ai-sdk/openai-compatible']) {
  await notice(name, { fallback: 'licenses/apache-2.0.txt' });
}
await writeFile(path.join(vendor, 'licenses.txt'), notices.join('\n') + '\n');
console.log('Built shared Web/Desktop renderer, local KaTeX assets and upstream notices.');
