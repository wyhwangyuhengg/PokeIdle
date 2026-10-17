// ===== 匿名在线统计 =====
// 游戏可见时每 60 秒发一次心跳（本机随机标识 + 自己的版本号）；下面填了接口地址才生效。
// 服务端顺便回报"你是不是旧版本"，设置页底部的版本号据此加一个（可更新）
import { APP_VERSION, DEV } from './build-info.js';
const TELEMETRY_ENDPOINT = 'https://pokeidle.shiliu.space/api/telemetry';
const KEY = 'pokemon_idle_install';
const HEARTBEAT_MS = 60000;

// 开发运行（npm run dev）一律不联网：免得把开发中的版本号当成正式版本报上去。
// 想在开发时联一次网，控制台执行 localStorage.setItem('pokeidle_online','1')
const onlineAllowed = () => !DEV || localStorage.getItem('pokeidle_online') === '1';

function installId() {
  let v = localStorage.getItem(KEY);
  if (!v) {
    v = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(KEY, v);
  }
  return v;
}

// 服务端最近一次告诉我们的事：是否有比本机更新的版本
let _update = false;

const beat = () => {
  if (!TELEMETRY_ENDPOINT || !onlineAllowed() || document.hidden) return;
  try {
    fetch(`${TELEMETRY_ENDPOINT}/ping`, { method: 'POST', body: `${installId()}|${APP_VERSION}` })
      .then((r) => r.json())
      .then((j) => { if (j && typeof j.update === 'boolean') _update = j.update; })
      .catch(() => {});
  } catch (_) {}
};

// 是否有更新版本（拿到新包并连过一次服务器后才会变 true；拿不到就一直是 false）
export const hasUpdate = () => onlineAllowed() && _update;

export function startTelemetry() {
  if (!TELEMETRY_ENDPOINT || !onlineAllowed()) return;
  beat();
  setInterval(beat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
}
