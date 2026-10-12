// ===== 道具详情卡片（商店 / 道具盒共用）=====
import { $ } from './ui.js';

let _mask = null;
let _host = null;

export function showDetailCard(detail, hostId) {
  if (!detail) { hideDetailCard(); return; }
  const host = hostId ? $(hostId) : _host;
  if (!host) return;
  if (!_mask) {
    _mask = document.createElement('div');
    _mask.id = 'shopDetailMask';
    _mask.className = 'shop-detail-mask';
    _mask.innerHTML = `<div class="shop-detail-card">
      <div class="shop-detail-head">
        <span class="shop-detail-badge"></span>
        <span class="shop-detail-name"></span>
      </div>
      <div class="move-edit-detail-stats"></div>
      <div class="shop-detail-desc"></div>
    </div>`;
    _mask.addEventListener('click', () => hideDetailCard());
    _mask.querySelector('.shop-detail-card').addEventListener('click', (e) => e.stopPropagation());
  }
  if (host !== _host) { host.appendChild(_mask); _host = host; }
  _mask.querySelector('.shop-detail-badge').innerHTML = detail.badgeHtml || '';
  _mask.querySelector('.shop-detail-name').textContent = detail.title || '';
  _mask.querySelector('.move-edit-detail-stats').innerHTML = detail.statsHtml || '';
  _mask.querySelector('.shop-detail-desc').textContent = detail.desc || '';
  _mask.style.display = 'flex';
}

export function hideDetailCard() {
  if (_mask) _mask.style.display = 'none';
}
