// ===== 匿名在线统计 =====
// 游戏可见时每 60 秒发一次心跳（只带一个本机随机标识）；下面填了接口地址才生效
const TELEMETRY_ENDPOINT = 'https://pokeidle.shiliu.space/api/telemetry';
const KEY = 'pokemon_idle_install';
const HEARTBEAT_MS = 60000;

function installId() {
  let v = localStorage.getItem(KEY);
  if (!v) {
    v = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(KEY, v);
  }
  return v;
}

const beat = () => {
  if (!TELEMETRY_ENDPOINT || document.hidden) return;
  try {
    fetch(`${TELEMETRY_ENDPOINT}/ping`, { method: 'POST', body: installId() }).catch(() => {});
  } catch (_) {}
};

export function startTelemetry() {
  if (!TELEMETRY_ENDPOINT) return;
  beat();
  setInterval(beat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
}
