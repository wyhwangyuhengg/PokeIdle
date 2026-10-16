// ===== 资源热更 · 部署 =====
// 玩家端的算法是：拿"包里那份清单"跟"服务器上的清单"比，只下载哈希不一样的文件。
// 所以这里要上传的是：出包基线（tools/hot-baseline.json，每次 npm run build 会重写）→ 现在 src/ 的差异，
// 而且这批文件必须先都能从 /api/hot/file 下到，最后才传清单（不然客户端会读到指向空文件的清单）。
//
// 用法（项目根目录）：
//   node tools/deploy-res.mjs            生成清单 + 补齐差异文件 + 传清单 + 自检
//   node tools/deploy-res.mjs --dry      只看要传哪些文件，不连服务器
//   node tools/deploy-res.mjs --local    把缺的文件铺到 hot-upload/（项目根，已 gitignore）：先走 443 问服务器已有哪几个，只铺缺的
//   node tools/deploy-res.mjs --all      不管差异，清单里所有文件全传一遍（换机器/重建服务器时用）
//   node tools/deploy-res.mjs --check    只验服务器：清单是不是最新、该传的文件到位没有、
//                                        服务器上现存的文件跟清单对不对得上（走 443 拉文件，再加一次 ssh 列目录）
//   node tools/deploy-res.mjs --fix      在 --check 的基础上，把对不上的文件按本地补传一遍再复验
//
// 依赖 tools/deploy.config.json（和 deploy-web.mjs 共用）：key / host / user / port / hotDir / apiBase
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { homedir, tmpdir } from 'node:os';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SRC = join(ROOT, 'src');
const CFG_PATH = join(ROOT, 'tools', 'pokeidledeploy.config.json');
const MANIFEST = join(ROOT, 'src', 'res-manifest.json');
const BASELINE = join(ROOT, 'tools', 'hot-baseline.json');
const STAGING = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public', 'res-manifest.json');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const all = args.includes('--all');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}KB`);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// 每条 ssh/scp 都是一条新连接，连太密会被服务器当爆破掐掉（Connection reset / timed out）
function run(cmd, tries = 2) {
  for (let i = 1; ; i++) {
    const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT });
    if (r.status === 0) return;
    if (r.status === 255 && i < tries) { console.log('      连不上 22 端口（多半是连太密被服务器暂时拉黑了），等 20 秒再试一次'); sleepSync(20000); continue; }
    if (r.status === 255) console.error('      还是连不上：443 的官网/接口正常的话，就是 SSH 被临时封了，过几分钟再跑本命令（别连续重试，会续期）；急着发就用 --local 铺到本地手工传');
    console.error(`命令失败（${r.status}）：${cmd.slice(0, 70)}…`);
    process.exit(1);
  }
}

// 0. 防呆：DEV=true 是开发态（玩家端会关掉热更、还会开开发预览），绝不带上线
if (/export const DEV = true/.test(readFileSync(join(SRC, 'build-info.js'), 'utf8'))) {
  console.warn('[部署] src/build-info.js 还是 DEV=true（开发态），先按发布态重新生成再传');
  run('node tools/sync-version.mjs');
}

// 1. 本地清单
console.log('[1/3] 生成资源清单');
run('node tools/gen-manifest.mjs');
const local = readJson(MANIFEST);
console.log(`      ${local.app}｜${local.count} 个文件｜gen ${new Date(local.gen).toLocaleString('zh-CN')}`);

if (!existsSync(CFG_PATH)) { console.error(`缺少配置：${CFG_PATH}`); process.exit(1); }
const cfg = readJson(CFG_PATH);
const key = String(cfg.key || '~/.ssh/rainyun-pokeidle.pem').replace(/^~/, homedir());
const sshBase = `ssh -i "${key}" -p ${cfg.port || 22} -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ${cfg.user || 'root'}@${cfg.host}`;
const scpBase = `scp -i "${key}" -P ${cfg.port || 22} -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
const remote = `${cfg.user || 'root'}@${cfg.host}`;
const hotDir = cfg.hotDir || '/www/wwwroot/pokeidle/server-data/hot';
const apiBase = cfg.apiBase || 'https://pokeidle.shiliu.space/api/hot';

// 2. 跟出包基线比差异 —— 这批就是玩家端会来下载的文件
console.log('[2/3] 对比出包基线');
let base = null, baseFrom = '';
for (const [p, from] of [[BASELINE, 'tools/hot-baseline.json'], [STAGING, '安卓工程里那份清单']]) {
  if (!existsSync(p)) continue;
  try { const m = readJson(p); if (m && m.files) { base = m; baseFrom = from; break; } } catch (_) {}
}
const need = [];
let needBytes = 0;
if (base) {
  console.log(`      基线 ${base.app}（${baseFrom}）`);
  for (const [p, info] of Object.entries(local.files)) {
    const b = base.files[p];
    if (!b || b.hash !== info.hash) { need.push(p); needBytes += info.size; }
  }
  console.log(`      基线 → 现在：${need.length} 个文件要更新（${kb(needBytes)}）`);
} else {
  console.log('      ⚠ 找不到出包基线（tools/hot-baseline.json）—— 按服务器上已有清单估算，跑一次 npm run build 就能补上');
}
if (dry) {
  for (const p of need.slice(0, 40)) console.log(`      · ${p}  ${kb(local.files[p].size)}`);
  if (need.length > 40) console.log(`      … 其余 ${need.length - 40} 个`);
  console.log('[3/3] --dry：不连服务器，结束');
  process.exit(0);
}

// 上传一批文件：按目标目录分组，一批 15 个一条命令 —— 连接数少，又不会撑爆命令行
const pushScp = (paths) => {
  const groups = new Map();
  for (const rel of paths) {
    const dir = dirname(rel).split('\\').join('/');   // 相对路径的分目录（顶层是 '.'）
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(rel);
  }
  const dirs = [...groups.keys()].filter((d) => d !== '.').map((d) => `'${hotDir}/${d}'`).join(' ');
  run(`${sshBase} "mkdir -p '${hotDir}'${dirs ? ' ' + dirs : ''}"`);
  for (const [dir, rels] of groups) {
    const dest = dir === '.' ? hotDir : `${hotDir}/${dir}`;
    for (let i = 0; i < rels.length; i += 15) {
      const srcs = rels.slice(i, i + 15).map((r) => `"${join(SRC, r)}"`).join(' ');
      run(`${scpBase} ${srcs} "${remote}:${dest}/"`);
    }
  }
};

// 客户端永远不从热更取的文件（和 hot-update.js 的 SKIP、sw.js 的 BYPASS 保持一致）：
// 它们跟清单对不上也不影响玩家，报出来时标一下，免得看着吓人
const NEVER_HOT = new Set(['res-manifest.json', 'sw.js', 'build-info.js']);

// --check：对账。查两件事：
//   ① 该传的那批（出包基线 → 本地）服务器上到位了没有；
//   ② 服务器上现存的文件，是不是都跟清单里的哈希对得上。
// ② 是踩过的坑：文件跟清单对不上时，客户端下到了却校验不过 → 跳过 → 每次进游戏都被再问一次，
// 而面板里 ls 得到文件，看不出来。加 --fix 就按本地补传这些文件再复验。
if (args.includes('--check') || args.includes('--fix')) {
  const fix = args.includes('--fix');
  console.log(`[3/3] ${fix ? '--fix：对账 + 补传对不上的文件' : '--check：只验服务器（不传文件）'}`);
  let remoteManifest = null;   // 注意别叫 remote：外层那个是 user@host
  try {
    const r = await fetch(`${apiBase}/manifest.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (r.ok) remoteManifest = await r.json();
  } catch (_) {}
  if (!remoteManifest || !remoteManifest.files) {
    console.log(`      ✘ 拉不到服务器清单（${apiBase}/manifest.json）—— 服务器上没有清单时客户端不会弹更新，属正常静默状态`);
    process.exit(0);
  }
  const sameManifest = JSON.stringify(remoteManifest.files) === JSON.stringify(local.files);
  console.log(`      服务器清单 gen ${new Date(remoteManifest.gen).toLocaleString('zh-CN')}｜${sameManifest ? '和本地最新一致 ✔' : '和本地最新不一致 ✘（该重传清单）'}`);

  const bad = await probe(need);   // ①
  // ② 服务器上现存的文件：ssh 列一遍 hot 目录，只验清单里也有的（清单里没有的是早前的残留，不影响）
  const ls = spawnSync(`${sshBase} "cd '${hotDir}' 2>/dev/null && find . -type f"`, { shell: true, encoding: 'utf8', cwd: ROOT, timeout: 20000 });
  const onServer = ls.status === 0
    ? (ls.stdout || '').split('\n').map((s) => s.trim().replace(/^\.\//, '')).filter((p) => p && p !== 'manifest.json')
    : null;
  if (!onServer) console.log('      （ssh 列不到 hot 目录，只验了"该传的那批"）');
  else {
    for (const b of await probe(onServer.filter((p) => local.files[p]))) {
      if (!bad.some((x) => x.rel === b.rel)) bad.push(b);
    }
    const leftover = onServer.filter((p) => !local.files[p]);
    if (leftover.length) console.log(`      （服务器上还留着 ${leftover.length} 个本地已经没有的文件：${leftover.slice(0, 5).join('、')}${leftover.length > 5 ? ' …' : ''}，不影响使用）`);
  }

  const harmful = (b) => !NEVER_HOT.has(b.rel);
  if (!bad.length && sameManifest) console.log('      ✔ 服务器上的文件和清单完全一致');
  else if (bad.length) {
    console.log(`      ✘ ${bad.length} 个文件对不上（面板里能看到文件 ≠ 版本对）：`);
    for (const b of bad) console.log(`         ${b.rel}  ${kb(local.files[b.rel].size)}  ${whyText(b)}${harmful(b) ? '' : '  ← 客户端不下载它，无害'}`);
    if (bad.some(harmful)) console.log('      客户端会一直弹「发现新资源」（下到了但校验不过 → 跳过 → 下次再问）');
  }

  let remaining = bad;
  let manifestOk = sameManifest;
  const targets = bad.map((b) => b.rel);
  if (fix && targets.length) {
    console.log(`      --fix：按本地重传 ${targets.length} 个`);
    pushScp(targets);
    remaining = await probe(targets);
    console.log(remaining.length ? `      ✘ 仍有 ${remaining.length} 个对不上：${remaining.map((b) => b.rel).join(' ')}` : '      ✔ 补传后都对上了');
  }
  // 清单放最后：先文件后清单，客户端不会读到"指向不存在文件"的清单
  if (fix && !remaining.filter(harmful).length && !manifestOk) {
    run(`${scpBase} "${MANIFEST}" "${remote}:${hotDir}/manifest.json"`);
    manifestOk = true;
    console.log('      --fix：清单也重传了');
  }
  process.exit(remaining.filter(harmful).length || !manifestOk ? 1 : 0);
}

// --local：不连服务器，把"要传的文件 + 改名后的清单"铺到一个本地目录，手动往宝塔面板里传
if (args.includes('--local')) {
  const li = args.indexOf('--local');
  const dir = args[li + 1] && !args[li + 1].startsWith('--') ? resolve(args[li + 1]) : join(ROOT, 'hot-upload');
  // 先走 443 问问服务器上已经有哪几个（探测不需要 ssh，封禁期间也能用），只铺缺的
  let missing = need, already = [], badList = [];
  if (need.length) {
    let reach = false;
    try {
      const r = await fetch(`${apiBase}/manifest.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      reach = r.ok;
    } catch (_) { reach = false; }
    if (!reach) {
      console.log(`      ⚠ 拉不到 ${apiBase}（没网或服务器不通）—— 按"这些都要传"给你铺`);
    } else {
      badList = await probe(need);
      const badSet = new Set(badList.map((b) => b.rel));
      missing = need.filter((p) => badSet.has(p));
      already = need.filter((p) => !badSet.has(p));
      console.log(`      服务器上已经有 ${already.length} 个${already.length ? `（${already.join('、')}）` : ''}，要传 ${missing.length} 个`);
      for (const b of badList) console.log(`        · ${b.rel}：${whyText(b)}`);
    }
  }
  rmSync(dir, { recursive: true, force: true });   // 清掉上次铺的，免得把已经不需要的文件一起传上去
  rmSync(join(ROOT, 'hot-upload.tar.gz'), { force: true });
  mkdirSync(dir, { recursive: true });
  for (const rel of missing) {
    const to = join(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(SRC, rel), to);
  }
  copyFileSync(MANIFEST, join(dir, 'manifest.json'));   // 服务器上这份要叫 manifest.json
  console.log(`[3/3] --local：${missing.length} 个文件 + 清单已铺到 ${dir}`);
  for (const rel of missing) {
    const buf = readFileSync(join(dir, rel));
    const why = badList.find((b) => b.rel === rel);
    console.log(`      ${rel}  ${kb(buf.length)}  ${sha1(buf) === local.files[rel].hash ? '✔' : '✘ 拷贝损坏'}${why ? '  ← ' + whyText(why) : ''}`);
  }
  if (!missing.length) console.log('      文件服务器上都是最新，只需传 manifest.json');
  console.log(`      传到 ${hotDir}/：先传上面这些文件，最后传 manifest.json（顺序不能反）`);
  if (need.includes('build-info.js')) console.log('      ⚠ build-info.js 也在列表里：传了，老包玩家设置页会显示新版号（无害）；不传，他们每次进游戏都会被再问一次（清单里有、文件下不到）');
  if (need.some((p) => p.includes('/'))) {
    const tgz = join(ROOT, 'hot-upload.tar.gz');
    const r = spawnSync(`tar -czf "${tgz}" -C "${dir}" .`, { shell: true });
    if (r.status === 0) console.log(`      这次有子目录里的文件：也可以只传 ${tgz} 再在面板里解压到 hot/`);
  }
  process.exit(0);
}

// 3. 传文件 + 传清单 + 自检
console.log(`[3/3] 上传到 ${hotDir}`);

// 上传策略：默认走 scp（tar 管道在覆盖已存在文件时偶发不生效，2026-10-15 连踩两次）；
// 超过 200 个文件（--all 全量重传）才回退 tar 管道，免得几千次 scp 把服务器当爆破拦掉；传完照常自检，漏的用 scp 补。
const pushTar = (paths) => {
  const dir = mkdtempSync(join(tmpdir(), 'hot-'));
  const list = join(dir, 'files.txt');
  writeFileSync(list, paths.join('\n') + '\n');   // -T 从文件读清单：文件多、名字带中文都不会撑爆命令行
  run(`tar -czf - -C "${SRC}" -T "${list}" | ${sshBase} "mkdir -p '${hotDir}' && tar -xzf - -C '${hotDir}'"`);
  rmSync(dir, { recursive: true, force: true });
};

const push = (paths) => {
  if (paths.length > 200) { console.log(`      这批 ${paths.length} 个文件走 tar 全量通道`); pushTar(paths); return; }
  pushScp(paths);
};

const targets = all ? Object.keys(local.files) : need;
let uploaded = 0;
if (all) {
  push(targets);
  uploaded = targets.length;
  console.log(`      全量上传 ${uploaded} 个文件`);
} else if (targets.length) {
  const missing = await probe(targets);
  if (missing.length) {
    push(missing.map((b) => b.rel));
    uploaded = missing.length;
    console.log(`      传了 ${uploaded} 个（服务器上已经有 ${targets.length - uploaded} 个）`);
  } else {
    console.log('      服务器上这些文件都在，不用重传');
  }
}
// 清单放最后：先文件后清单，客户端不会读到"指向不存在文件"的清单
run(`${scpBase} "${MANIFEST}" "${remote}:${hotDir}/manifest.json"`);

// 自检：把该有的文件挨个拉回来比哈希。tar 遇到中文名/特殊字符偶尔会漏文件，
// 漏了的话客户端只会 404 静默跳过（更新看着成功其实没生效），所以必须自己发现并重传
if (targets.length) {
  let apiOk = true;
  try {
    const r = await fetch(`${apiBase}/manifest.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    apiOk = r.ok;
  } catch (_) { apiOk = false; }
  if (!apiOk) {
    console.log(`      ⚠ 拉不到 ${apiBase}（域名/网络不通）—— 跳过上传后自检`);
  } else {
    const step = Math.max(1, Math.ceil(targets.length / 24));            // --all 是老机器重建，抽查就够
    const check = all ? targets.filter((_, i) => i % step === 0) : targets;
    let bad = await probe(check);
    if (bad.length) {
      console.log(`      自检发现 ${bad.length} 个没传成功，用 scp 重传一次：${bad.slice(0, 5).map((b) => b.rel).join(' ')}`);
      pushScp(bad.map((b) => b.rel));
      uploaded += bad.length;
      bad = await probe(bad.map((b) => b.rel));
    }
    if (bad.length) console.log(`      ✘ 仍有 ${bad.length} 个传不上去：${bad.map((b) => b.rel + '（' + whyText(b) + '）').join('、')}`);
    else console.log(`      自检通过：${all ? '抽查' : ''}${check.length} 个文件都能下到、哈希一致`);
  }
}

// 收尾：hot 目录现状（里面只该有"要更新"的那批文件 + 清单）
const tail = spawnSync(`${sshBase} "du -sh '${hotDir}'; cd '${hotDir}' && find . -type f | sort"`, { shell: true, encoding: 'utf8', cwd: ROOT });
if (tail.status === 0 && tail.stdout) {
  const lines = tail.stdout.trim().split('\n');
  console.log(`      ${lines[0]}`);
  const extra = lines.slice(1).map((l) => l.trim().replace(/^\.\//, ''))
    .filter((p) => p && p !== 'manifest.json' && !targets.includes(p));
  if (extra.length) console.log(`      （目录里还留着 ${extra.length} 个早前的文件，不影响使用：${extra.slice(0, 5).join('、')}${extra.length > 5 ? ' …' : ''}）`);
}
console.log(`完成：客户端要更新 ${targets.length} 个文件${uploaded ? `（本次上传 ${uploaded} 个）` : ''} + 清单`);

// 逐个拉回来比哈希（并发 6）。返回 [{ rel, why, got }]，why: 'missing' 服务器没有 | 'old' 有但是旧版 | 'error' 拉不动
async function probe(paths) {
  const bad = [];
  const queue = paths.slice();
  const one = async (rel) => {
    const want = local.files[rel].hash;
    try {
      const res = await fetch(`${apiBase}/file?p=${encodeURIComponent(rel)}&v=${want}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!res.ok) return bad.push({ rel, why: 'missing', got: `HTTP ${res.status}` });
      const got = sha1(Buffer.from(await res.arrayBuffer()));
      if (got !== want) bad.push({ rel, why: 'old', got });
    } catch (e) { bad.push({ rel, why: 'error', got: e.name === 'TimeoutError' ? '超时' : e.message }); }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) await one(queue.shift());
  }));
  return bad;
}
// 一句话说明这个文件为什么"要传"（面板里 ls 得到 ≠ 版本对；这里区分"没有"和"是旧版"）。
// 函数声明（会被提升）：--local / --check 在文件前段就要用
function whyText(b) {
  if (b.why === 'missing') return `服务器上没有（${b.got}）`;
  if (b.why === 'old') return `服务器上是旧版（${b.got}，要的是 ${local.files[b.rel].hash}）`;
  return `拉不动（${b.got}）`;
}
