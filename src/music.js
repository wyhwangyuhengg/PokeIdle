// ===== 音乐点播页 =====
// 入口：手机首页那条音乐栏（#phoneMusic）。左列选歌单（当前地区 / 我的喜爱 / 1~9 世代）、右列点歌。
// 播放全走 audio.js 的「地区曲」通道，覆盖曲（战斗/骑行/游戏厅）那条链路一行不碰。
import { $, showView, showConfirmBar, hideConfirmBar } from './ui.js';
import { pushNav, gameData, saveGame, getCurrentRegion } from './state.js';
import { REGION_PLAYLISTS, REGION_GENS } from './regions.js';
import { TRACK_META } from './audio-meta.js';
import { setMusicMode, playTrack, getNowPlaying } from './audio.js';

// 光盘图集：横排一行，每格 30x30 原像素、四周 1px 透明边（改图直接换这张图）
const CD_PAD = 1, CD_PITCH = 31, CD_SHEET_W = 311, CD_SHEET_H = 32;
const CD_SHOW = 24; // 显示 24px：原图是像素图，缩放在 CSS 里做（配 image-rendering: pixelated）
const CD_SCALE = CD_SHOW / 30;

const ALL_TRACKS = new Set(Object.values(REGION_PLAYLISTS).flat());
const regionOfGen = (gen) => (REGION_GENS.find((it) => it.gen === gen) || REGION_GENS[2]).region;
const genOfRegion = (name) => (REGION_GENS.find((it) => it.region === name) || {}).gen || 0;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const trackTitle = (path) => TRACK_META[path]?.title || path.split('/').pop().replace(/\.mp3$/i, '');
const trackDesc = (path) => TRACK_META[path]?.desc || '';

// 右列底部：当前这首的说明（没有就整块收起）
const descHtml = () => esc(trackDesc(getNowPlaying().path || ''));
const cdStyle = (n) => 'background-image:url(./icons/cd-sheet.png);'
  + `background-size:${(CD_SHEET_W * CD_SCALE).toFixed(2)}px ${(CD_SHEET_H * CD_SCALE).toFixed(2)}px;`
  + `background-position:${(-(CD_PAD + CD_PITCH * n) * CD_SCALE).toFixed(2)}px ${(-CD_PAD * CD_SCALE).toFixed(2)}px;`;

// 存档字段兜底：模式/世代越界拉回合法值，歌单里已经不存在的曲目剔掉
function ensureMusic() {
  if (!gameData.music) gameData.music = {};
  const m = gameData.music;
  const valid = m.mode === 'album' || m.mode === 'list';
  m.mode = valid ? m.mode : 'region';
  if (!(m.album >= 1 && m.album <= 9)) m.album = 3;
  if (!Array.isArray(m.playlist)) m.playlist = [];
  m.playlist = m.playlist.filter((p) => ALL_TRACKS.has(p));
  return m;
}

// 右列正在看哪张歌单：默认跟存档里的模式；空的「我的喜爱」也能进去看（那时候不切播放）
let _view = null;
const viewKey = (m) => _view || (m.mode === 'album' ? `g${m.album}` : m.mode);
const genOfView = (v) => Number(String(v).slice(1));

function currentList(m) {
  const v = viewKey(m);
  if (v === 'list') return m.playlist.slice();
  if (v === 'region') return REGION_PLAYLISTS[getCurrentRegion().name] || [];
  return REGION_PLAYLISTS[regionOfGen(genOfView(v))] || [];
}

// 切歌要淡 150ms 才真正换曲：等它换完补刷一次高亮，别干等秒级 tick
const refreshSoon = () => setTimeout(refreshMusicViewIfOpen, 300);

// 轻提示：1.4 秒自动收，期间被别的框替换过就不动它
function toast(msg) {
  showConfirmBar(msg, null, null, { noButtons: true });
  const bar = document.getElementById('confirmBar');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    if (document.getElementById('confirmBar') === bar) hideConfirmBar();
  }, 1400);
}

// ---------- 渲染 ----------
function colHtml(m) {
  const cur = getCurrentRegion().name;
  const v = viewKey(m);
  const item = (pick, cd, name, region = '') => `<div class="music-item${v === pick ? ' active' : ''}" data-pick="${pick}"${region ? ` data-region="${region}"` : ''}>
      <span class="music-cd" style="${cdStyle(cd)}"></span>
      <span class="music-item-name">${name}</span>
    </div>`;
  const gens = REGION_GENS.map((it) => item(`g${it.gen}`, it.gen, it.region)).join('');
  return `<div class="music-col">
      ${item('region', genOfRegion(cur), '当前地区', cur)}
      ${item('list', 0, '我的喜爱')}
      ${gens}
    </div>`;
}

function listHtml(m) {
  const tracks = currentList(m);
  const inList = new Set(m.playlist);
  const curPath = getNowPlaying().path;
  const v = viewKey(m);
  const head = `<div class="music-head">
      <span>${v === 'list' ? '我的喜爱' : v === 'region' ? getCurrentRegion().name : regionOfGen(genOfView(v))}</span>
      <span>${tracks.length} 首</span>
    </div>`;
  const rows = tracks.map((path) => {
    const playing = path === curPath;
    const liked = inList.has(path);
    return `<div class="music-row${playing ? ' playing' : ''}" data-track="${encodeURIComponent(path)}">
        <span class="music-note"><span class="eq${playing ? ' on' : ''}"><i></i><i></i><i></i></span></span>
        <span class="music-name">${esc(trackTitle(path))}</span>
        <span class="music-like${liked ? ' on' : ''}" data-like="${liked ? '1' : '0'}"><svg><use xlink:href="#icon-${liked ? 'liked' : 'like'}"/></svg></span>
      </div>`;
  }).join('');
  return head + (tracks.length ? rows : '');
}

// 重绘（右列滚动位置保留，别每次点一下都跳回顶部）
function render() {
  const box = $('musicContent');
  if (!box) return;
  const m = ensureMusic();
  const oldCol = box.querySelector('.music-col');
  const oldList = box.querySelector('.music-list');
  const keepCol = oldCol ? oldCol.scrollTop : 0;
  const keepList = oldList ? oldList.scrollTop : 0;
  box.innerHTML = `<div class="music-page">${colHtml(m)}<div class="music-right">`
    + `<div class="music-list list-scroll">${listHtml(m)}</div>`
    + `<div class="music-desc">${descHtml()}</div></div></div>`;
  // 换歌单/点歌都别把列表滚回顶部：写完立刻设一次，布局完再补一次
  const restore = () => {
    const c = box.querySelector('.music-col');
    const l = box.querySelector('.music-list');
    if (c) c.scrollTop = keepCol;
    if (l) l.scrollTop = keepList;
  };
  restore();
  requestAnimationFrame(restore);
}

// 只刷新"正在播"标记与底部说明（每秒由手机时钟的 tick 调，省一个定时器）
export function refreshMusicViewIfOpen() {
  const box = $('musicContent');
  if (!$('musicView') || $('musicView').style.display === 'none' || !box) return;
  const curPath = getNowPlaying().path;
  box.querySelectorAll('.music-row').forEach((row) => {
    const on = decodeURIComponent(row.dataset.track) === curPath;
    row.classList.toggle('playing', on);
    const eq = row.querySelector('.eq');
    if (eq) eq.classList.toggle('on', on);
  });
  // 换曲后同步底部说明
  const desc = box.querySelector('.music-desc');
  if (desc) {
    const html = descHtml();
    if (desc.innerHTML !== html) desc.innerHTML = html;
  }
  const first = box.querySelector('.music-item[data-pick="region"]');
  if (first && first.dataset.region !== getCurrentRegion().name) render();
}

// ---------- 交互 ----------
function onPick(id) {
  const m = ensureMusic();
  _view = id;
  // 空歌单也让人进去看（空态里写了怎么加曲），只是这时候不切播放
  if (id === 'list' && m.playlist.length === 0) { render(); return; }
  if (id === 'list') m.mode = 'list';
  else if (id === 'region') m.mode = 'region';
  else { m.mode = 'album'; m.album = Number(id.slice(1)); }
  // 只有点「当前地区」才立刻换曲；切到其它歌单只换歌单，这首继续放，播完再从新歌单接
  const ok = setMusicMode(m.mode, { album: m.album, playlist: m.playlist, keepCurrent: id !== 'region' });
  saveGame();
  if (!ok) toast('离开游戏厅后生效');
  render();
  refreshSoon();
}

function onLike(path, liked) {
  const m = ensureMusic();
  if (liked) {
    m.playlist = m.playlist.filter((p) => p !== path);
    if (m.mode === 'list' && m.playlist.length === 0) { // 喜爱清空：播放切回当前地区（右列停在空列表上）
      m.mode = 'region';
      setMusicMode('region', { album: m.album });
    } else if (m.mode === 'list') {
      setMusicMode('list', { playlist: m.playlist, keepCurrent: true }); // 正在放的那首还在表里就不换歌
    }
  } else {
    if (!m.playlist.includes(path)) m.playlist.push(path);
    if (m.mode === 'list') setMusicMode('list', { playlist: m.playlist, keepCurrent: true }); // 空喜爱加第一首：这才真正切过去
  }
  saveGame();
  render();
}

// 启动恢复：把存档里的点播模式灌给 audio（main.js 读完存档后调用）
export function restoreMusicMode() {
  const m = ensureMusic();
  setMusicMode(m.mode, { album: m.album, playlist: m.playlist });
}

// ---------- 入口 ----------
export function showMusicView() {
  installMusicPage();
  pushNav('musicView');
  showView('musicView');
  render();
}

export function installMusicPage() {
  const box = $('musicContent');
  if (!box || box._wired) return;
  box._wired = true;
  box.addEventListener('click', (e) => {
    const like = e.target.closest('.music-like');
    const row = e.target.closest('.music-row');
    if (like && row) { onLike(decodeURIComponent(row.dataset.track), like.dataset.like === '1'); return; }
    if (row) {
      const path = decodeURIComponent(row.dataset.track);
      if (!playTrack(path)) toast('离开游戏厅后生效');
      else { render(); refreshSoon(); }
      return;
    }
    const item = e.target.closest('.music-item');
    if (item) onPick(item.dataset.pick);
  });
}
