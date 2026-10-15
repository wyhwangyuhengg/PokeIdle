// ===== 资源热更（客户端） =====
// 进游戏时问一句：发现新资源就弹一个居中对话框——
//   取消 → 本次运行不再问，照常玩；下次进游戏还会再问一遍；
//   更新 → 对话框里就地显示进度，把差异文件下载进本地缓存（CacheStorage），
//          下完自动重启游戏，重启后由 sw.js 优先返回这些新文件，等于"更新完再进游戏"。
// 没有 Service Worker 的环境（老 WebView / file://）静默跳过，游戏照常跑。
//
// 服务器侧接口：GET /api/hot/manifest.json、GET /api/hot/file?p=<相对路径>
// 开发调试：localStorage.pokeidle_hot_on = '1' 打开（dev 构建默认关），
//          localStorage.pokeidle_hot_base 换成本地源（见 tools/pokeidledeploy.config.json 里的 apiBase）
import { DEV } from './build-info.js';

const HOT_BASE = 'https://pokeidle.shiliu.space/api/hot';
const CACHE = 'pokeidle-hot';
const MANIFEST_KEY = '/__hot__.json';   // 缓存里存"已应用"的 { 相对路径: hash }
const META_KEY = 'pokeidle_hot_v1';     // 资源状态记录：{ app, gen, at, applied, added }，设置页显示"资源 月-日 时:分 · N 个文件"
const CONCURRENCY = 4;
// 这几个永远用包里的：SW 不能被自己替换；res-manifest.json 是基线；build-info.js 里是版本号和
// DEV 开关——被热更成 DEV=true 的一版就会关掉热更、把客户端锁死在开发态（自己清不掉）
const SKIP = new Set(['res-manifest.json', 'sw.js', 'build-info.js']);

let _busy = false;
let _skippedGen = 0;   // 本次运行取消/没下成的清单 gen：只在内存里，大退重进还会再问

function hotBase() {
  try { return localStorage.getItem('pokeidle_hot_base') || HOT_BASE; } catch (_) { return HOT_BASE; }
}
function enabled() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  if (!/^https?:$/.test(location.protocol)) return false;
  if (!DEV) return true;
  try { return localStorage.getItem('pokeidle_hot_on') === '1'; } catch (_) { return false; }
}
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (_) {} }

async function jsonOrNull(url, ms = 8000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    return res.ok ? await res.json() : null;
  } catch (_) { return null; }
}
async function sha1Hex(buf) {
  try {
    const d = await crypto.subtle.digest('SHA-1', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch (_) { return null; }   // 环境没有 crypto.subtle：跳过校验
}
async function readApplied(cache) {
  try {
    const res = await cache.match(MANIFEST_KEY);
    return res ? await res.json() : {};
  } catch (_) { return {}; }
}

// 对账：缓存里的每一条都必须和"服务器当前清单"一致，否则删掉。
// 目的是让"装了新包"以包为准——旧缓存不能盖住包里的新内容（app 里已经是 500，缓存还留着热更的 450）。
async function reconcile(cache, stored, remote) {
  let dropped = 0;
  const next = {};
  for (const [path, hash] of Object.entries(stored)) {
    if (remote && remote.files && remote.files[path] && remote.files[path].hash === hash) { next[path] = hash; continue; }
    try { await cache.delete(new Request(`${location.origin}/${path}`)); } catch (_) {}
    dropped++;
  }
  if (dropped) {
    await cache.put(new Request(MANIFEST_KEY),
      new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json' } }));
    try { (await navigator.serviceWorker.ready).active?.postMessage('pokeidle-hot-refresh'); } catch (_) {}
  }
  return next;
}

// 比对：服务器清单 vs（包里基线 + 已下过的）。没有差异、或这份已经拒绝过 → null
async function findChanges() {
  const bundled = await jsonOrNull('./res-manifest.json');
  if (!bundled || !bundled.files) return null;
  const remote = await jsonOrNull(`${hotBase()}/manifest.json?t=${Date.now()}`);   // 带时间戳：绕过中间层缓存
  const cache = await caches.open(CACHE);
  const applied = await reconcile(cache, await readApplied(cache), remote && remote.files ? remote : null);
  if (!remote || !remote.files) return null;
  const list = [];
  let bytes = 0;
  for (const [path, info] of Object.entries(remote.files)) {
    if (SKIP.has(path)) continue;
    const have = applied[path] || (bundled.files[path] && bundled.files[path].hash);
    if (have !== info.hash) { list.push([path, info]); bytes += info.size || 0; }
  }
  // 记一笔"本机资源状态"给设置页那个小圆点用：pending = 还没更上的文件数（0 = 已是最新）
  lsSet(META_KEY, JSON.stringify({
    app: remote.app || '', gen: remote.gen, at: Date.now(), applied: Object.keys(applied).length,
    pending: list.length,
  }));
  if (_skippedGen && _skippedGen === remote.gen) return null;   // 本次运行已经拒绝过这份清单
  return list.length ? { gen: remote.gen, app: remote.app || '', list, bytes } : null;
}

// 读取热更记录（设置页那行的绿/红小圆点用）
function readMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch (_) { return null; }
}
export function hotMeta() { return readMeta(); }

// 居中对话框（同一个 overlay 两种状态）：ask 询问 / progress 进度。样式在 styles.css 的 .hot-mask
function hotOverlay() {
  let el = document.getElementById('hotMask');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hotMask';
    el.className = 'hot-mask';
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  return el;
}
function hideOverlay() { document.getElementById('hotMask')?.remove(); }

function askUpdate(changes, onYes, onNo) {
  const el = hotOverlay();
  const mb = (changes.bytes / 1048576).toFixed(1);
  el.innerHTML = `
    <div class="hot-box">
      <div class="hot-title">发现新资源</div>
      <div class="hot-text">共 ${changes.list.length} 个文件 · ${mb} MB<br>更新完会自动重启游戏</div>
      <div class="hot-btns">
        <span class="catch-confirm-btn" data-hot="no">取消</span>
        <span class="catch-confirm-btn" data-hot="yes">更新</span>
      </div>
    </div>`;
  el.onclick = (e) => {
    const btn = e.target.closest('[data-hot]');
    if (!btn) return;
    e.stopPropagation();
    if (btn.dataset.hot === 'yes') onYes(); else onNo();
  };
}

function showProgress() {
  const el = hotOverlay();
  el.onclick = null;
  el.innerHTML = '<div class="hot-box"><div class="hot-title">正在更新资源…</div>'
    + '<div class="hot-bar"><i id="hotBarFill"></i></div><div class="hot-num" id="hotNum"></div></div>';
  const set = (done, total, got, all) => {
    const fill = document.getElementById('hotBarFill');
    if (fill) fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    const num = document.getElementById('hotNum');
    if (num) num.textContent = `${done}/${total} 个文件 · ${(got / 1048576).toFixed(1)}/${(all / 1048576).toFixed(1)} MB`;
  };
  return { set };
}

// 下载差异文件：逐个校验 sha1，坏的跳过（下次再补）；返回成功数
async function download(changes, ui) {
  const cache = await caches.open(CACHE);
  const applied = await readApplied(cache);
  const queue = changes.list.slice();
  const total = changes.list.length;
  let done = 0, got = 0;
  ui.set(0, total, 0, changes.bytes);
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const [path, info] = item;
      try {
        const res = await fetch(`${hotBase()}/file?p=${encodeURIComponent(path)}&v=${info.hash}`, { cache: 'no-store' });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          const h = await sha1Hex(buf);
          if (!h || h === info.hash) {
            await cache.put(new Request(`${location.origin}/${path}`),
              new Response(buf, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } }));
            applied[path] = info.hash;
            done++; got += buf.byteLength;
            ui.set(done, total, got, changes.bytes);
            continue;
          }
        }
      } catch (_) { /* 单个失败不影响别的 */ }
      ui.set(done, total, got, changes.bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) || 0 }, worker));
  await cache.put(new Request(MANIFEST_KEY),
    new Response(JSON.stringify(applied), { headers: { 'Content-Type': 'application/json' } }));
  lsSet(META_KEY, JSON.stringify({ app: changes.app || '', gen: changes.gen, at: Date.now(), applied: Object.keys(applied).length, pending: 0, added: done }));
  try { (await navigator.serviceWorker.ready).active?.postMessage('pokeidle-hot-refresh'); } catch (_) {}
  return done;
}

// 进游戏时调用：有更新就问一句，确认后下完自动重启（重启后就是新资源）
export async function startHotUpdate() {
  if (_busy || !enabled()) return;
  _busy = true;
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    const changes = await findChanges();
    if (!changes) return;
    askUpdate(changes,
      async () => {
        try { window.__saveLastChance && window.__saveLastChance(); } catch (_) {}   // 重启前把存档同步落盘
        const ui = showProgress();
        const ok = await download(changes, ui);
        if (ok > 0) { location.reload(); return; }            // 交给 SW 提供新文件
        _skippedGen = changes.gen;                            // 一个都没下成：这次先算了
        hideOverlay();
      },
      () => { _skippedGen = changes.gen; hideOverlay(); });   // 取消：本次不再问，下次进游戏再弹
  } catch (e) {
    console.warn('[热更] 出错（忽略，游戏照常跑）：', e && e.message);
  } finally { _busy = false; }
}
