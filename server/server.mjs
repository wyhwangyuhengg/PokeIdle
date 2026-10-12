// ===== 口袋挂机 · 后端服务（Node，无依赖） =====
// 现在只有一个功能：在线统计 /api/telemetry/*。加新功能就在下面 ROUTES 里加一条。
// 环境变量：PORT（默认 4000）/ DATA_DIR（默认 ./data）/ TELEMETRY_SALT（生产必填）/ TELEMETRY_ORIGINS（额外跨域来源）
// 数据全在一个文件里：DATA_DIR/stats.json
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 4000);
const DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const SALT = process.env.TELEMETRY_SALT || '';
const ONLINE_TTL = 150000;  // 150 秒没心跳就不算在线
const MIN_BEATS = 2;        // 两次心跳才算在线：随机刷 id 只能骗到一瞬
const RATE_MS = 10000;      // 单 IP 最快 10 秒一次（客户端节奏 60 秒）
const RATE_BURST = 6;
const MAX_BODY = 128;
const ORIGINS = new Set([
  'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost',
  'capacitor://localhost', 'http://localhost', 'https://localhost',
  ...(process.env.TELEMETRY_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);

if (!SALT) console.warn('[server] 未设置 TELEMETRY_SALT（仅限本地调试）');

// ---------- 在线统计 ----------
const seen = new Map();  // hash -> { last, beats }
const rate = new Map();  // ip -> { n, ts }
// 落盘就一个文件 data/stats.json：{ days: { '2026-10-12': [哈希...] }, total: [哈希...] }
const DB_FILE = path.join(DATA_DIR, 'stats.json');
const db = { days: {}, total: [] };
const totalSet = new Set();
let day = dayKey();
let today = new Set();

function dayKey() { return new Date().toISOString().slice(0, 10); }
function rollDay() { // 跨天：换一天的桶（历史留在 db.days 里）
  const now = dayKey();
  if (now === day) return;
  if (today.size) db.days[day] = [...today].sort();
  day = now;
  today = new Set(db.days[day] || []);
}
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (today.size) db.days[day] = [...today].sort();
    const days = {};
    for (const k of Object.keys(db.days).sort()) days[k] = [...db.days[k]].sort();
    db.total = [...totalSet].sort();
    fs.writeFileSync(DB_FILE, JSON.stringify({ days, total: db.total }));
  } catch (e) { console.error('[server] 落盘失败:', e.message); }
}
function load() {
  try { // 新格式
    const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (j && typeof j.days === 'object') db.days = j.days || {};
    if (Array.isArray(j && j.total)) j.total.forEach((h) => totalSet.add(h));
    today = new Set(db.days[day] || []);
    return;
  } catch (_) {}
  // 旧格式（每天一个 json + total.json）：一次性并进来，之后只用 stats.json
  try {
    const t = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'total.json'), 'utf8'));
    if (Array.isArray(t)) t.forEach((h) => totalSet.add(h));
  } catch (_) {}
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (!m) continue;
      const arr = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      if (Array.isArray(arr)) db.days[m[1]] = arr;
    }
  } catch (_) {}
  today = new Set(db.days[day] || []);
  if (Object.keys(db.days).length || totalSet.size) save();
}

// 真实客户端 IP：反代后 socket 里全是 127.0.0.1，取 X-Forwarded-For 第一跳；直连时用 socket
const ipOf = (req) => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const hashOf = (id) => crypto.createHash('sha256').update(SALT + id).digest('hex').slice(0, 24);
function onlineCount() {
  const cut = Date.now() - ONLINE_TTL;
  let n = 0;
  for (const v of seen.values()) if (v.beats >= MIN_BEATS && v.last >= cut) n++;
  return n;
}
function prune() {
  const cut = Date.now() - ONLINE_TTL;
  for (const [k, v] of seen) if (v.last < cut) seen.delete(k);
  const rcut = Date.now() - 60000;
  for (const [k, v] of rate) if (v.ts < rcut) rate.delete(k);
}

// ---------- HTTP ----------
function json(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}
function allowOrigin(req) {
  const origin = req.headers.origin;
  return origin && ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {};
}

// 路由表：加功能就往这里加一条 { method, path, handle(req, res, body) }
const ROUTES = [
  {
    method: 'POST',
    path: '/api/telemetry/ping',
    handle(req, res, body) {
      const ip = ipOf(req);
      const now = Date.now();
      const r = rate.get(ip) || { n: 0, ts: 0 };
      if (now - r.ts > RATE_MS) { r.n = 1; r.ts = now; }
      else if (++r.n > RATE_BURST) { rate.set(ip, r); return json(res, 429, { ok: false }, allowOrigin(req)); }
      rate.set(ip, r);

      const id = body.trim();
      if (!/^[0-9a-f]{16,64}$/.test(id)) return json(res, 400, { ok: false }, allowOrigin(req));
      const h = hashOf(id);
      const cur = seen.get(h);
      if (cur) { cur.last = now; cur.beats++; } else seen.set(h, { last: now, beats: 1 });
      rollDay();
      if (today.size < 500000) today.add(h);
      if (totalSet.size < 500000) totalSet.add(h);
      json(res, 200, { ok: true }, allowOrigin(req)); // 不回统计值：客户端不需要，也少一个被探测的口子
    },
  },
  {
    method: 'GET',
    path: '/api/telemetry/stats',
    handle(req, res) {
      rollDay();
      json(res, 200, { online: onlineCount(), today: today.size, total: totalSet.size }, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=10', // 官网读数由这层缓存兜住
      });
    },
  },
  {
    method: 'GET',
    path: '/healthz',
    handle(req, res) {
      json(res, 200, { ok: true, online: onlineCount(), today: today.size, total: totalSet.size }, { 'Cache-Control': 'no-store' });
    },
  },
];

http.createServer((req, res) => {
  const method = req.method || 'GET';
  const url = (req.url || '').split('?')[0];

  if (method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204, allowOrigin(req));
    res.end();
    return;
  }

  const route = ROUTES.find((r) => r.method === method && r.path === url);
  if (!route) return json(res, 404, { ok: false });

  if (method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', () => route.handle(req, res, body));
    return;
  }
  route.handle(req, res, '');
}).listen(PORT, '127.0.0.1', () => console.log(`[server] 127.0.0.1:${PORT}`));

setInterval(() => { prune(); rollDay(); }, 30000);
setInterval(save, 30000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });
