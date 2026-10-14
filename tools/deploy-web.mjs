// ===== 官网一键部署：构建 web/dist 并推送到服务器 =====
// 用法（在项目根目录）：
//   node tools/deploy-web.mjs            构建 + 上传
//   node tools/deploy-web.mjs --skip-build   跳过构建，直接传现有的 web/dist
//   node tools/deploy-web.mjs --dry          只构建并报告，不连服务器
//
// 连接信息在 tools/deploy.config.json（已在 .gitignore 里，不会进 git）：
//   { "host": "<你的服务器 IP 或域名>", "user": "root", "port": 22,
//     "key": "~/.ssh/rainyun-pokeidle.pem",
//     "webDist": "/www/wwwroot/pokeidle/dist" }   ← 服务器上网站根目录（dist 内容铺在这里）
// 上传走一条 tar 流（ssh 一条连接）：先铺到 <目录>.incoming，成功后再整体换上去，
// 中途断线也不会留下半份站点；旧的那份直接删掉。
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const DIST = join(ROOT, 'web', 'dist');
const CFG_PATH = join(ROOT, 'tools', 'deploy.config.json');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const skipBuild = args.includes('--skip-build');

function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) { console.error(`命令失败（${r.status}）：${cmd}`); process.exit(1); }
}

// ---------- 1. 构建 ----------
if (!skipBuild) {
  console.log('[1/3] 构建官网：web 下 npm run build');
  run('npm run build', { cwd: join(ROOT, 'web') });
} else {
  console.log('[1/3] 跳过构建（--skip-build）');
}
if (!existsSync(DIST)) { console.error(`没有找到构建产物：${DIST}`); process.exit(1); }

// ---------- 2. 看看要传什么 ----------
function walk(dir, base = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, join(base, e.name)));
    else out.push({ rel: join(base, e.name).split(/[\\/]/).join('/'), size: statSync(p).size });
  }
  return out;
}
const files = walk(DIST);
const total = files.reduce((a, f) => a + f.size, 0);
const top = files.filter((f) => !f.rel.includes('/')).sort((a, b) => b.size - a.size).slice(0, 6);
console.log(`[2/3] 产物 ${files.length} 个文件，共 ${(total / 1048576).toFixed(2)} MB`);
console.log('      ' + top.map((f) => `${f.rel} ${(f.size / 1024).toFixed(0)}KB`).join('　'));
if (dry) { console.log('[3/3] --dry：不连服务器，结束'); process.exit(0); }

// ---------- 3. 推送 ----------
if (!existsSync(CFG_PATH)) {
  console.error(`缺少配置：${CFG_PATH}（照着脚本顶部注释建一份）`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
const key = String(cfg.key || '~/.ssh/id_ed25519_pokeidle').replace(/^~/, homedir());
if (!existsSync(key)) { console.error(`找不到私钥：${key}`); process.exit(1); }
const sshBase = `ssh -i "${key}" -p ${cfg.port || 22} -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${cfg.user || 'root'}@${cfg.host}`;
const remote = cfg.webDist;
if (!remote) { console.error('配置里少了 webDist（服务器上网站根目录）'); process.exit(1); }

console.log(`[3/3] 推送到 ${cfg.user || 'root'}@${cfg.host}:${remote}`);
// 远端：确认目录存在（第一次自动建），准备一个临时目录接新文件
const prep = [
  `set -e`,
  `mkdir -p '${remote}'`,
  `rm -rf '${remote}.incoming' && mkdir -p '${remote}.incoming'`,
].join(' && ');
run(`${sshBase} "${prep.replace(/"/g, '\\"')}"`);

// 打包（排除 node_modules 之类，dist 里本来也不会有）
run(`tar -czf - -C "${DIST}" . | ${sshBase} "tar -xzf - -C '${remote}.incoming'"`);

// 就位：新文件已经全在 .incoming 里，同分区 mv 一下就是瞬间完成
run(`${sshBase} "set -e; rm -rf '${remote}'; mv '${remote}.incoming' '${remote}'; ls -1 '${remote}' | head -5; du -sh '${remote}'"`);
console.log('完成。');
