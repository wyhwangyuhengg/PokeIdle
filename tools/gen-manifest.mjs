// ===== 资源清单生成器 =====
// 扫一遍前端目录，给每个文件记 size + sha1，产出 res-manifest.json。
// 客户端拿这份清单跟服务器上的比对，只下载变过的文件（热更）。
//
// 用法（项目根目录）：
//   node tools/gen-manifest.mjs                扫 src/，写 src/res-manifest.json（跟着包一起发，作为基线）
//   node tools/gen-manifest.mjs --dir src --out /tmp/manifest.json
//
// 说明：清单自己不进清单（不然互相包含算不出来）；路径一律用相对路径、正斜杠。
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const argv = process.argv.slice(2);
const argOf = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const DIR = resolve(ROOT, argOf('--dir', 'src'));
const OUT = resolve(ROOT, argOf('--out', 'src/res-manifest.json'));
const SELF = relative(DIR, OUT).split(/[\\/]/).join('/');

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const app = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || '';
  } catch (_) { return ''; }
})();

const files = {};
let bytes = 0;
const t0 = Date.now();
for (const abs of walk(DIR)) {
  const rel = relative(DIR, abs).split(/[\\/]/).join('/');
  if (rel === SELF) continue;                      // 清单本身不列
  const buf = readFileSync(abs);
  bytes += buf.length;
  files[rel] = { size: buf.length, hash: createHash('sha1').update(buf).digest('hex').slice(0, 16) };
}
const manifest = { app, gen: Date.now(), count: Object.keys(files).length, files };
writeFileSync(OUT, JSON.stringify(manifest) + '\n');
const kb = (n) => `${(n / 1048576).toFixed(1)}MB`;
console.log(`清单已生成：${relative(ROOT, OUT).split(/[\\/]/).join('/')}`);
console.log(`  版本 ${app}｜${manifest.count} 个文件｜源 ${kb(bytes)}｜清单 ${(statSync(OUT).size / 1024).toFixed(0)}KB｜耗时 ${Date.now() - t0}ms`);
