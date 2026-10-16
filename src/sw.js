// ===== 热更 Service Worker =====
// 作用：把"下载到本地缓存里的新文件"优先返回给页面，没有的照常走网络（也就是包里的原文件）。
// 只接管本应用自己的 GET 请求；跨域（比如服务器 API）一律放行。
// 缓存名固定，内容由 hot-update.js 维护；清单和版本开关永远走包里那份。
const CACHE = 'pokeidle-hot';
const MANIFEST_KEY = '/__hot__.json';   // 已应用的 { gen, files: { 相对路径: hash } }
// build-info.js 里是版本号和 DEV 开关：被热更成 DEV=true 的一版，客户端会关掉热更、停在开发态，
// 而且因为热更关了，它自己再也清不掉缓存里那份 —— 死锁。所以这两个文件永远从包里取。
const BYPASS = new Set(['res-manifest.json', 'build-info.js']);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// 热更清单里记了哪些路径：SW 每次请求都要看它，所以放内存里缓存一下，收到消息再刷新
let applied = null;
let appliedAt = 0;
async function loadApplied() {
  if (applied && Date.now() - appliedAt < 5000) return applied;
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match(MANIFEST_KEY);
    const data = res ? await res.json() : null;
    // 老格式是一张裸的 { 路径: hash }，没有 gen：当成 0（比任何包都旧），让包里的文件先顶上
    applied = data && data.files
      ? { gen: Number(data.gen) || 0, files: data.files }
      : { gen: 0, files: {} };
    appliedAt = Date.now();
  } catch (_) { applied = { gen: 0, files: {} }; }
  return applied;
}

// 包内清单的 gen：装了新包（比热更缓存新）就得让包里的文件说话，旧缓存不能再盖上去。
// 只在要用的时候读一次本地那份小清单，十几秒内不重复读（重开应用会重新读）
let packGen = null;
let packAt = 0;
async function loadPackGen() {
  if (packGen !== null && Date.now() - packAt < 15000) return packGen;
  try {
    const res = await fetch('/res-manifest.json', { cache: 'no-store' });
    const m = await res.json();
    packGen = Number(m && m.gen) || 0;
  } catch (_) { packGen = 0; }
  packAt = Date.now();
  return packGen;
}

self.addEventListener('message', (e) => { if (e.data === 'pokeidle-hot-refresh') { applied = null; packGen = null; } });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;      // 外部请求（服务器 API 等）不碰
  e.respondWith(serve(req, url));
});

async function serve(req, url) {
  try {
    // 根路径按 index.html 处理，否则外壳永远热更不到
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (!BYPASS.has(rel) && !rel.startsWith('__hot__')) {
      const map = await loadApplied();
      // 缓存里的这份必须比包里的新才认：刚装完新包、服务器还没跟着部署时，
      // 缓存里躺着的是上一版代码，再让它返回就等于"新包白装"
      if (map.files[rel] && map.gen > await loadPackGen()) {
        const hit = await (await caches.open(CACHE)).match(`${self.location.origin}/${rel}`);
        if (hit) return hit;
      }
    }
  } catch (_) { /* 出错就当没有热更，正常走网络 */ }
  return fetch(req);
}
