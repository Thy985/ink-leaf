import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'android/app/src/main/assets/www');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'model.js', 'mobile.js', 'vendor']) {
  await cp(path.join(root, 'web', file), path.join(destination, file), { recursive: true });
}
console.log('Android assets synced from the shared editor (no test or desktop files).');
