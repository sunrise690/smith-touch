import { cp, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = path.join(root, 'dist');
const assets = ['index.html', 'src', 'icons', 'manifest.webmanifest', 'sw.js', '.nojekyll'];
await mkdir(target, { recursive: true });
for (const asset of assets) { await access(path.join(root, asset)); await cp(path.join(root, asset), path.join(target, asset), { recursive: true }); }
console.log('已生成 dist/，可部署至任意静态网站托管服务。');
