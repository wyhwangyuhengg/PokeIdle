// ===== 口袋挂机 · 后端服务（Node，无依赖） =====
// 功能：在线统计 /api/telemetry/*；每日事件排期 /api/events（大量出没 / 时空扭曲全服共用）。加新功能就在下面 ROUTES 里加一条。
// 环境变量：PORT（默认 4000）/ DATA_DIR（默认 ./data）/ TELEMETRY_SALT（生产必填）/ TELEMETRY_ORIGINS（额外跨域来源）
// 数据全在一个文件里：DATA_DIR/stats.json
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 事件参数与客户端同源：优先读仓库里的 src/config.js（部署时把它一起放上去即可）。
// 读不到就用内置兜底值 —— 服务端不会因为目录结构不同而启动失败。
let CFG = {
  MASS_GEN_MIN: 20, MASS_GEN_MAX: 60, MASS_DURATION: 60,
  TWIST_GEN_MIN: 40, TWIST_GEN_MAX: 90, TWIST_DURATION: 30,
  REGION_CYCLE: ['关都', '城都', '丰缘', '神奥', '合众', '卡洛斯', '阿罗拉', '伽勒尔', '帕底亚'],
};
try {
  CFG = { ...CFG, ...(await import('../src/config.js')) };
} catch (_) {
  console.warn('[server] 未找到 ../src/config.js，事件参数改用内置兜底值');
}

const { MASS_GEN_MIN, MASS_GEN_MAX, MASS_DURATION, TWIST_GEN_MIN, TWIST_GEN_MAX, TWIST_DURATION, REGION_CYCLE } = CFG;

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

// ---------- 每日事件排期 ----------
// 每天一份、全服共用：同一时间所有玩家看到同一个事件；客户端拉一次后按"服务器时间"自行驱动，
// 因此改系统时间无效。位置/物种由这里定，内容细节（扭曲出什么）仍由客户端本地随机。
// 全存在 DATA_DIR/event.json（与 stats.json 同级）：{ days: { '日期': { mass, twist } } }，只留最近两天。
const EVENT_FILE = path.join(DATA_DIR, 'event.json');
const DAY_MS = 86400000;
const EVENT_KEEP_DAYS = 2;
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function dateKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 排一天：事件从 0 点后开始，按"时长 + 间隔"依次往后铺，
// 一旦结束时间超过当天 24:00 就停 —— 这样绝不会和次日排期重叠
function buildDay(dateStr, base) {
  const slots = (minGap, maxGap, durMin, extra) => {
    const out = [];
    const dur = durMin * 60000;
    let t = randInt(20, 60) * 60000;           // 当天第一个事件：0 点后留点缓冲
    for (;;) {
      if (t + dur > DAY_MS) break;
      out.push({ from: base + t, to: base + t + dur, ...extra() });
      t = t + dur + randInt(minGap, maxGap) * 60000;   // 事件结束 → 间隔 → 下一段
    }
    return out;
  };
  return {
    date: dateStr,
    // 大量出没：位置比例 + 物种种子，都和扭曲同一套（客户端按同一张路网换算，全服落在同一处）
    mass: slots(MASS_GEN_MIN, MASS_GEN_MAX, MASS_DURATION, () => ({
      pos: Math.random(),
      // 只给一个种子：客户端用"该地区野池 + 种子"取同一只，服务端不需要图鉴文件
      seed: Math.floor(Math.random() * 0x7fffffff),
    })),
    // 扭曲只给位置比例（0~1）：客户端按同一张路网换算成具体边，全服落在同一处
    twist: slots(TWIST_GEN_MIN, TWIST_GEN_MAX, TWIST_DURATION, () => ({ pos: Math.random() })),
  };
}

const eventDb = { days: {} };
function loadEvents() {
  try {
    const j = JSON.parse(fs.readFileSync(EVENT_FILE, 'utf8'));
    if (j && typeof j.days === 'object') eventDb.days = j.days || {};
  } catch (_) { /* 首次运行没有文件，正常 */ }
}
function saveEvents() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(EVENT_FILE, JSON.stringify({ days: eventDb.days }));
  } catch (e) { console.warn('[server] 事件排期落盘失败', e.message); }
}

// 保证有今天的排期，并只留最近两天
function ensureEvents(nowMs = Date.now()) {
  const key = dateKey(nowMs);
  let changed = false;
  if (!eventDb.days[key]) {
    const base = new Date(nowMs);
    base.setHours(0, 0, 0, 0);
    const data = buildDay(key, base.getTime());
    eventDb.days[key] = data;
    changed = true;
    console.log(`[server] 已生成 ${key} 事件排期：大量出没 ${data.mass.length} 场 / 时空扭曲 ${data.twist.length} 场`);
  }
  const keys = Object.keys(eventDb.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - EVENT_KEEP_DAYS))) {
    delete eventDb.days[k];
    changed = true;
  }
  if (changed) saveEvents();
  return eventDb.days[key] || null;
}

// 跨天时自动换页：日期没变就直接返回，不做多余 IO
let _eventsDay = '';
function tickEvents() {
  const k = dateKey(Date.now());
  if (k === _eventsDay) return;
  _eventsDay = k;
  ensureEvents();
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
    path: '/api/events',
    handle(req, res) {
      const data = ensureEvents();
      if (!data) return json(res, 503, { ok: false });
      json(res, 200, { ...data, serverNow: Date.now() }, {
        'Access-Control-Allow-Origin': '*',      // 公开只读数据，官网/客户端都能取
        'Cache-Control': 'public, max-age=60',   // 客户端自己会缓存整天，这层只防连点
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
  // 末尾斜杠归一化：反代（nginx）常把 /api/events 301 成 /api/events/，两边都要能命中路由
  const url = ((req.url || '').split('?')[0].replace(/\/+$/, '')) || '/';

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

loadEvents(); // 先读回已有排期（重启不能换掉当天已发的排期）
tickEvents(); // 没有今天的那份就现建（DATA_DIR 不存在会一并创建）
setInterval(() => { prune(); rollDay(); tickEvents(); }, 30000);
setInterval(save, 30000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });
