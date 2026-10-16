// ===== 全服事件时间表 =====
// 服务端每天生成一份排期（大量出没 / 时空扭曲），所有玩家共用：同一时刻看到同一个事件。
// 时间一律以"服务器时间"为准 —— 拿到排期后用单调时钟推进，玩家改系统时间无效。
// 拉不到（离线 / 服务器故障）时 hasSchedule() 为 false，游戏退回本地随机事件，照常能玩。
const EVENTS_ENDPOINT = 'https://pokeidle.shiliu.space/api/events/';   // 末尾斜杠直连，避开 nginx 的 301
const CACHE_KEY = 'pokeidle_events_cache_v1';
const RETRY_MIN = 10;   // 轮询间隔（分钟）：正常情况下只靠回前台与跨天补拉

let _schedule = null;   // { date, serverNow, mass: [...], twist: [...] }
let _srvAt = 0;         // 对齐用的服务器时刻
let _perfAt = 0;        // 对齐时的单调时钟
let _loading = null;
let _tick = 0;

export function hasSchedule() { return !!_schedule; }
export function serverNow() {
  return _perfAt ? _srvAt + (performance.now() - _perfAt) : Date.now();
}

const listOf = (kind) => (_schedule && Array.isArray(_schedule[kind]) ? _schedule[kind] : []);
// 正在进行的事件段 / 下一段未开始的事件段
export function activeSlot(kind) {
  if (!_schedule) return null;
  const t = serverNow();
  return listOf(kind).find((s) => t >= s.from && t < s.to) || null;
}
export function nextSlot(kind) {
  if (!_schedule) return null;
  const t = serverNow();
  return listOf(kind).find((s) => s.from > t) || null;
}
export function scheduleExhausted() {
  if (!_schedule) return true;
  return expiredAt(_schedule, serverNow());
}

// 整份排期是否已翻篇（一段都没有、或所有时段都结束）：离线久了缓存里那份就是这样。
// 这种排期不能当"有排期"用 —— 事件生成会一直等一个永远不会来的时段，
// 本地随机兜底（拉不到时的正常退路）也起不来，等于彻底没有事件
function expiredAt(data, t) {
  const all = [...(data.mass || []), ...(data.twist || [])];
  return all.length === 0 || t > Math.max(...all.map((s) => s.to));
}

// 在用的排期整段翻篇了（离线太久 / 服务端迟迟没更新）→ 就地作废，退回本地随机事件。
// 不清掉的话 hasSchedule() 恒为真，事件生成永远停在"等下一段"（__refreshAll 也刷不出事件）
export function pruneExpiredSchedule() {
  if (!_schedule || !expiredAt(_schedule, serverNow())) return false;
  _schedule = null;
  console.warn('[事件排期] 排期已全部结束，退回本地随机事件');
  import('./phone.js').then((m) => m.refreshPhoneHome()).catch(() => {});
  return true;
}

function apply(data, srvAt, perfAt) {
  if (!data || !Array.isArray(data.mass) || !Array.isArray(data.twist) || typeof data.date !== 'string') return false;
  // 整段翻篇的排期当作没拉到（缓存里那份离线久了就是这样）：退回本地随机事件
  if (expiredAt(data, srvAt)) return false;
  const first = !_schedule;
  _schedule = data;
  _srvAt = srvAt;
  _perfAt = perfAt;
  // 第一次拿到排期：「全服事件」那颗图标该出现了（apps.js 里按 hasSchedule() 决定显不显示），让手机页重画
  if (first) import('./phone.js').then((m) => m.refreshPhoneHome()).catch(() => {});
  return true;
}

// 某类事件的全部时段（手机页的事件时间带要用）
export function allSlots(kind) { return listOf(kind).slice(); }

// 拉取排期（并发请求会合并）；成功后写缓存并顺带校准时间
export async function loadEvents(force = false) {
  if (_loading) return _loading;
  if (!force && _schedule && !scheduleExhausted() && _freshAt && Date.now() - _freshAt < RETRY_MIN * 60000) return true;
  _loading = (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(`${EVENTS_ENDPOINT}?t=${Date.now()}`, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!apply(data, data.serverNow || Date.now(), performance.now())) throw new Error('格式不对或排期已过期');
      _freshAt = Date.now();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, savedAt: Date.now() })); } catch (_) {}
      return true;
    } catch (e) {
      console.warn('[事件排期] 拉取失败，本次沿用本地随机事件：', e.name === 'AbortError' ? '超时(6s)' : e.message);
      return false;
    } finally { _loading = null; }
  })();
  return _loading;
}
let _freshAt = 0;

// 先用缓存点亮事件状态（离线启动也能立刻按当天排期跑），随后会被最新数据覆盖
export function loadEventsFromCache() {
  try {
    const data = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!data || typeof data.serverNow !== 'number') return false;
    // 缓存里存着当时的服务器时间，补上"保存到现在"的间隔，离线期间也算得对
    const drift = Math.max(0, Date.now() - (data.savedAt || Date.now()));
    return apply(data, data.serverNow + drift, performance.now());
  } catch (_) { return false; }
}

// 开机：先吃缓存再拉最新；之后每分钟看一眼，跨天/跑完立刻重拉，否则每 10 分钟对一次
export function startEventRefresh() {
  loadEventsFromCache();
  pruneExpiredSchedule(); // 缓存里那份可能已经整段翻篇（离线久了）：先作废，直接走本地随机事件
  loadEvents(true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    pruneExpiredSchedule();
    loadEvents();
  });
  setInterval(() => {
    if (document.hidden) return;
    pruneExpiredSchedule(); // 跑着跑着跑完了：作废退回本地，别卡在"等下一段"
    if (scheduleExhausted()) loadEvents(true);
    else if (++_tick % RETRY_MIN === 0) loadEvents(true);
  }, 60000);
}
