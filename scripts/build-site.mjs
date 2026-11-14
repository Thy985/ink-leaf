// 生成 Cloudflare Pages 部署目录 dist/site。
// `npm run build:web` 已经产出 web/vendor/（打包后的 renderer、KaTeX 资源与许可声明），
// 这里只挑选运行期文件：排除测试脚本和未打包的渲染器源码 renderer.js
// （app.js 引用的是 web/vendor/renderer.js）。
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'web');
const target = path.join(root, 'dist', 'site');

const RUNTIME_FILES = [
  'index.html',
  'styles.css',
  'app.js',
  'ai.js',
  'search.js',
  'model.js',
  'mobile.js',
  'link-activation.js',
  'folder-panel-state.js',
];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const name of RUNTIME_FILES) {
  await cp(path.join(source, name), path.join(target, name));
}
await cp(path.join(source, 'vendor'), path.join(target, 'vendor'), { recursive: true });

// 部署前自检：index.html 引用到的本地资源、以及 JS 里的相对 import 必须都落在 dist/site 中，
// 否则 Cloudflare Pages 上会出现空白页，而这类缺失在本地开发时不容易察觉。
async function exists(targetFile, spec) {
  try {
    await readFile(path.join(path.dirname(targetFile), spec));
    return true;
  } catch {
    return false;
  }
}

const problems = [];
const htmlPath = path.join(target, 'index.html');
const html = await readFile(htmlPath, 'utf8');
for (const [, spec] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(spec)) continue;
  if (!(await exists(htmlPath, spec))) problems.push(`index.html → ${spec}`);
}

for (const name of RUNTIME_FILES.filter((file) => file.endsWith('.js'))) {
  const file = path.join(target, name);
  const code = await readFile(file, 'utf8');
  for (const [, spec] of code.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    if (!(await exists(file, spec))) problems.push(`${name} → ${spec}`);
  }
}

if (problems.length) {
  throw new Error(`站点自检失败，以下引用在 dist/site 中不存在：\n- ${problems.join('\n- ')}`);
}

console.log(`Built Cloudflare Pages site at dist/site (${RUNTIME_FILES.length} files + vendor/).`);
