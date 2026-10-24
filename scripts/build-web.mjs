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
async function notice(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const dir = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const files = (await readdir(dir)).filter(file => /^(license|licence|copying|notice)([.-]|$)/i.test(file));
  if (!files.length) throw new Error(`Missing upstream license: ${name}`);
  notices.push(`\n===== ${pkg.name} ${pkg.version} (${pkg.license || 'see upstream text'}) =====\n`);
  for (const file of files) notices.push(`\n--- ${file} ---\n${await readFile(path.join(dir, file), 'utf8')}`);
  for (const dependency of Object.keys(pkg.dependencies || {}).sort()) await notice(dependency);
}
for (const name of ['markdown-it', 'dompurify', 'katex', 'highlight.js']) await notice(name);
notices.push('\n===== Babel regenerator helpers embedded in DOMPurify (MIT) =====\n');
notices.push(await readFile(path.join(root, 'licenses/babel-helpers-MIT.txt'), 'utf8'));
await writeFile(path.join(vendor, 'licenses.txt'), notices.join('\n') + '\n');
console.log('Built shared Web/Desktop renderer, local KaTeX assets and upstream notices.');
