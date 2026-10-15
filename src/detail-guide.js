// ===== 详情页道具引导 =====
// 第一次进详情页时挡一层，依次高亮三个入口：等级（经验糖果）→ 性格（薄荷）→ 个体值（王冠）。
// 位置用目标的 offset 布局像素写（高亮环挂在它自己的定位父级里），跟整体缩放无关。
import { gameData, saveGame } from './state.js';

const STEPS = [
  { sel: '[data-exp-candy-open]', title: '经验糖果', text: '点「等级」使用「经验糖果」给它加经验' },
  { sel: '[data-mint-open]',      title: '薄荷',     text: '点「性格」使用「薄荷」换成想要的性格' },
  { sel: '[data-crown-open]',     title: '王冠',     text: '点「个体值」使用「王冠」练个体值' },
];

let _active = false;
let _watch = 0;

// 入口：详情页渲染完成后调用（三个入口不全时不引导，也不记标记）
export function maybeShowDetailGuide() {
  if (_active || gameData?.detailGuideSeen) return;
  const targets = STEPS.map((s) => document.querySelector(s.sel));
  if (targets.some((t) => !t)) return;
  start(targets);
}

function start(targets) {
  _active = true;
  // 挡点击：body 级透明 fixed 层，盖住一切；点它就下一步
  const blocker = document.createElement('div');
  blocker.className = 'dg-blocker';
  document.body.appendChild(blocker);
  // 高亮环：插进目标的定位父级，与目标同坐标空间
  const ring = document.createElement('div');
  ring.className = 'dg-ring';
  // 气泡：挂在同一个父级里，左右各留 8px 吃满宽度 —— 永远不出容器
  const bubble = document.createElement('div');
  bubble.className = 'dg-bubble';
  bubble.innerHTML = '<div class="dg-title"></div><div class="dg-text"></div><div class="dg-hint"></div>';
  let step = 0;

  const paint = () => {
    const el = targets[step];
    if (!el || !el.isConnected) { finish(false); return; }
    // 目标不在视野里先滚到中间，再摆位
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > innerHeight) el.scrollIntoView({ block: 'center' });
    // 与目标同父级：offset 坐标天然对齐，不受任何缩放影响
    const host = el.offsetParent || el.parentElement || document.body;
    if (ring.parentElement !== host) { host.appendChild(ring); host.appendChild(bubble); }
    const ox = el.offsetLeft, oy = el.offsetTop;
    const w = el.offsetWidth, h = el.offsetHeight;
    ring.style.left = `${ox - 4}px`;
    ring.style.top = `${oy - 4}px`;
    ring.style.width = `${w + 8}px`;
    ring.style.height = `${h + 8}px`;
    // 文案
    bubble.querySelector('.dg-title').textContent = STEPS[step].title;
    bubble.querySelector('.dg-text').textContent = STEPS[step].text;
    bubble.querySelector('.dg-hint').textContent = `点击继续 ${step + 1}/${STEPS.length}`;
    // 气泡固定贴在高亮块下方
    bubble.style.top = `${oy + h + 12}px`;
    bubble.style.transform = 'none';
  };
  const finish = (seen = true) => {
    if (!_active) return;
    _active = false;
    clearInterval(_watch);
    removeEventListener('resize', reflow);
    removeEventListener('scroll', reflow, true);
    blocker.remove();
    ring.remove();
    bubble.remove();
    if (seen) { gameData.detailGuideSeen = true; saveGame(); }
  };
  blocker.addEventListener('click', () => {
    step++;
    if (step >= STEPS.length) finish(true);
    else paint();
  });
  // 图片加载完 / 滚动 / 转屏时重新摆位；详情页被关掉就收摊（不记标记，下次进来再引导）
  const reflow = () => {
    if (!_active) return;
    if (document.getElementById('rosterView')?.style.display === 'none') { finish(false); return; }
    paint();
  };
  _watch = setInterval(reflow, 250);
  addEventListener('resize', reflow);
  addEventListener('scroll', reflow, true);
  paint();
}
