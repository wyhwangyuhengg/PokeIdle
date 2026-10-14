// ===== 限时活动注册表 =====
// 写活动只改这个文件：键 = 服务端 activity.json 里那条的 id。
// 容器负责标题、倒计时、进出与"到点自动收起"，活动只管自己的界面和结算。
// 能用的东西都在 ctx 里（见 activity.js 的 ctxFor）：from / to / payload / slot / left / grant / take / confirm / save / refresh。
// 约定：改游戏状态一律走 ctx（grant / take），别的地方只读。

import { getPokemonByIndex, gameData, allPokemon, isPowerForm, isPokemon, isWildExcluded, POKEMON_NATURES } from './state.js';
import { tryLoadImage, tryLoadPokemonImage } from './ui.js';
import { itemIconSrc, MINT_KEYS, pickFamilyBySeed } from './items.js';
import { ITEM_NAMES, EVO_PRICES, eggSprite } from './config.js';
import { MG_LEVELS, levelOf } from './memory-game.js';

const TIERS = 4;      // 四档：进化道具 / 薄荷·王冠 / 大师球·闪耀护符 / 闪光蛋
const PER_TIER = 3;   // 每档交 3 只（payload.perTier 可覆盖），四档共 12 只
const TIER_NAMES = ['奖励1', '奖励2', '奖励3', '奖励4'];
const perTierOf = ctx => Math.max(1, Number(ctx.payload && ctx.payload.perTier) || PER_TIER);
const tiersDone = ctx => Math.min(TIERS, Math.max(0, Number(ctx.slot && ctx.slot.tiers) || 0));

// 活动固定那一只：由活动种子从"全野池"里挑 —— 全服同一只，而且它在自己地区的路边池里
// 本来就会正常刷新，玩家任何时段都能去抓（不用赶某一小时的出没）
function wildPool() {
  return allPokemon.filter(p => !p.legend && !isPowerForm(p) && !isWildExcluded(p));
}
function targetPoke(ctx) {
  const poke = pickFamilyBySeed(wildPool(), seedOf(ctx));   // 多变体家族先折一簇，再在簇内定一只
  return poke && poke.index ? poke : null;
}

// 活动种子：payload.seed 这一个数决定"目标是哪只 + 奖励是什么"（同一份配置 → 全服完全一致），
// 改它就换一只、换一份奖励；老配置没写种子则退回用活动开始时刻，效果一样是全服同一份。
function seedOf(ctx) {
  const raw = (ctx.payload || {}).seed;
  const n = Number(raw);
  const s = raw != null && raw !== '' && Number.isFinite(n) ? n : null;   // 手写配置里写成字符串也认
  const str = `${ctx.id}|${s != null ? s : Math.round(Number(ctx.from) || 0)}`;
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// mulberry32：小而稳的种子随机
function rngFrom(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
// ---- 奖励：四档各摇一件，全部由活动种子摇 ----
//   ① 进化道具 ×1（EVO_PRICES 里的通用道具；形态专属要等进化表加载，会把"全服一致"弄丢就不放）
//   ② 薄荷 / 王冠 ×1（21 种薄荷 + 银冠 + 金冠）
//   ③ 大师球 / 闪耀护符 ×1
//   ④ 闪光蛋 ×1
// 摇法固定成一条 r 流（谁先谁后写死），所以同一个种子在任何客户端都得到同一份结果。
// 结果存进活动存档槽做缓存，页面直接按它显示图标；领取时照发。
const EVO_REWARD_POOL = Object.keys(EVO_PRICES).filter(k => !k.endsWith('crown'));
const MINT_CROWN_POOL = [...MINT_KEYS, 'silver-crown', 'golden-crown'];
const RARE_POOL = ['master-ball', 'shiny-charm'];
const EGG_SPECIES_POOL = () => allPokemon.filter(p => !p.legend && !isPowerForm(p));   // 神兽与超级/超极巨形态不发蛋
const REWARD_V = 2;   // 奖励结构版本：v1 是三条槽，对不上就重摇（不用管老存档）

// 闪光蛋：物种可指定（payload.eggSpecies），留空就按种子从"除神兽与强化形态"里随机一只，
// 全服都是同一只蛋；个体值改成每个玩家自己摇（同一颗蛋，谁孵出什么个体看手气），性格仍按种子
function eggFrom(ctx, r) {
  const pick = list => list[Math.floor(r() * list.length)];
  const want = String((ctx.payload && ctx.payload.eggSpecies) || '').trim();
  const poke = want ? getPokemonByIndex(want) : null;
  const species = poke && !poke.legend && !isPowerForm(poke) ? poke.index : pick(EGG_SPECIES_POOL()).index;
  const ivs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  for (const k of Object.keys(ivs)) ivs[k] = Math.floor(Math.random() * 32);
  return { species, ivs, nature: pick(POKEMON_NATURES)[0], shiny: true };
}

function rollReward(ctx) {
  const r = rngFrom(seedOf(ctx));
  const pick = list => list[Math.floor(r() * list.length)];
  const items = [pick(EVO_REWARD_POOL), pick(MINT_CROWN_POOL), pick(RARE_POOL)];   // 前三档
  return { v: REWARD_V, items, egg: eggFrom(ctx, r) };
}

// 奖励只在第一次打开页面时摇一次并落盘（页面上显示的、发出去的必须是同一份）。
// 缓存里记着是按哪个种子摇的 —— 改了 payload.seed 就会重摇。
function rewardOf(ctx) {
  const seed = seedOf(ctx);
  const rw = ctx.slot.reward;
  if (!rw || rw.v !== REWARD_V || !rw.egg || !Array.isArray(rw.items) || ctx.slot.rewardSeed !== seed) {
    ctx.slot.reward = rollReward(ctx);
    ctx.slot.rewardSeed = seed;
    ctx.save();
  }
  return ctx.slot.reward;
}

// 展示用图标：act-anim 是动图立绘（目标宝可梦），其余小图标走静态 icon
function pokeAnimHtml(index, box) {
  const poke = getPokemonByIndex(String(index));
  if (!poke) return '';
  return `<img class="act-anim" data-anim="${poke.index}" alt="" style="width:${box}px;height:${box}px;">`;
}
function itemIconHtml(key, box = 24) {
  return `<img src="${itemIconSrc(key)}" alt="" title="${ITEM_NAMES[key] || key}" style="width:${box}px;height:${box}px;">`;
}
function loadIcons(root) {
  root.querySelectorAll('.act-anim[data-anim]').forEach((img) => {
    const poke = getPokemonByIndex(img.dataset.anim);
    if (poke) tryLoadPokemonImage(img, poke, '');
  });
  root.querySelectorAll('img[data-icon]').forEach((img) => {
    const poke = getPokemonByIndex(img.dataset.icon);
    if (poke?.icon) tryLoadImage(img, poke.icon);
  });
}

// 挑提交用的个体：只认"活动期间在路上抓到的"（孵蛋、交换来的都不算，
// 否则饲育屋喂树果批量孵就能白拿）；等级最低优先（再比个体值总和），锁定/蛋/已不在仓库的不算
const ivSum = p => ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].reduce((s, k) => s + ((p.ivs || {})[k] || 0), 0);
function submittable(species, from) {
  return (gameData?.roster || [])
    .filter(p => String(p.species) === String(species) && isPokemon(p) && !p.locked && p.inRoster !== false
      && p.source !== 'egg' && p.source !== 'trade' && (p.obtainedAt || 0) >= (from || 0))
    .sort((a, b) => (a.level || 1) - (b.level || 1) || ivSum(a) - ivSum(b));
}

// 槽位：空位显示「＋」，放入后显示这只的图标（点一下取出）
function slotHtml(ctx, i) {
  const entry = (gameData?.roster || []).find(p => p.id === ctx.picks[i]);
  if (!entry) return `<div class="act-slot empty" data-slot="${i}" title="点击放入宝可梦">＋</div>`;
  return `<div class="act-slot" data-slot="${i}" title="点击取出">
    <img class="act-slot-icon" data-icon="${entry.species}" alt="">
  </div>`;
}

// 选择器的候选范围：只留能上交的（本种、未锁定、在仓库里），再扣掉别的槽位已经占用的
function pickerExclude(ctx, slot) {
  const poke = targetPoke(ctx);
  const ok = new Set(poke ? submittable(poke.index, ctx.from).map(p => p.id) : []);
  const used = new Set(ctx.picks.filter((rid, i) => rid && i !== slot));
  return (gameData?.roster || [])
    .filter(p => !ok.has(p.id) || used.has(p.id))
    .map(p => p.id);
}

// 蛋的图标（按属性）与名字「闪光×××的蛋」：档位与兑换所两处共用
function eggIconHtml(species, box = 24) {
  const ep = getPokemonByIndex(String(species));
  return `<img src="${eggSprite(ep?.types?.[0])}" alt="蛋" title="闪光蛋" style="width:${box}px;height:${box}px;">`;
}
function eggLabel(species) {
  const ep = getPokemonByIndex(String(species));
  return `闪光${ep ? (ep.name || ep.form) : species}的蛋`;
}

// 某一档给什么：前三档是道具图标，第四档是属性蛋图 + 「闪光×××的蛋」
function giftHtml(i, rw) {
  if (i < TIERS - 1) {
    const k = rw.items[i];
    return `${itemIconHtml(k)}<i>${ITEM_NAMES[k] || k}</i>`;
  }
  return `${eggIconHtml(rw.egg.species)}<i>${eggLabel(rw.egg.species)}</i>`;
}

// 一档一行：档位 + 这档给什么 + 状态；当前这一档才画槽位和领取按钮
function tierHtml(ctx, i, rw, per, done) {
  const cur = i === done;
  const base = i * per;
  const ids = ctx.picks.slice(base, base + per);
  const full = ids.length === per && ids.every(Boolean);
  const state = i < done
    ? '<span class="catch-confirm-btn off">已领取</span>'
    : cur
      ? `<span class="catch-confirm-btn${full ? '' : ' off'}" data-claim="${i}">领取</span>`
      : '';
  return `
    <div class="act-tier ${i < done ? 'done' : cur ? 'cur' : 'locked'}">
      <div class="act-tier-head">
        <span class="act-tier-no">${TIER_NAMES[i] || `奖励${i + 1}`}</span>
        <span class="act-tier-gift">${giftHtml(i, rw)}</span>
        ${state}
      </div>
      ${cur ? `<div class="act-slots">${Array.from({ length: per }, (_, j) => slotHtml(ctx, base + j)).join('')}</div>` : ''}
    </div>`;
}

// ===== 宝可翻牌（id: poke-flip）：玩配对翻牌赚气球，在兑换所换道具（每样限一次，换完即止）=====
const BALLOON_ICON = './items/goods/balloon-cyan.png';
// 兑换表：价格按"一周活动能换完"配（合计 5800）；每样限一次，所以不用怕刷
const SHOP_ITEMS = [
  { id: 'ball',   price: 100,  qty: 10, name: '精灵球 ×10',       icon: 'poke-ball' },
  { id: 'honey',  price: 150,  qty: 1,  name: '甜甜蜜',           icon: 'sweet-honey' },
  { id: 'candy',  price: 150,  qty: 2,  name: '经验糖果 ×2',      icon: 'exp-candy' },
  { id: 'ultra',  price: 200,  qty: 5,  name: '高级球 ×5',        icon: 'ultra-ball' },
  { id: 'mint',   price: 300,  qty: 1,  name: '薄荷（随机）',     icon: MINT_KEYS[0] },
  { id: 'stone',  price: 400,  qty: 1,  name: '进化道具（随机）', icon: EVO_REWARD_POOL[0] },
  { id: 'silver', price: 500,  qty: 1,  name: '银色王冠',         icon: 'silver-crown' },
  { id: 'golden', price: 700,  qty: 1,  name: '金色王冠',         icon: 'golden-crown' },
  { id: 'master', price: 900,  qty: 1,  name: '大师球',           icon: 'master-ball' },
  { id: 'charm',  price: 900,  qty: 1,  name: '闪耀护符',         icon: 'shiny-charm' },
  { id: 'egg',    price: 1500, qty: 1,  name: '闪光蛋',           egg: true },
];

const coinsOf = ctx => Math.max(0, Math.round(Number(ctx.slot && ctx.slot.coins) || 0));
function boughtOf(ctx) {
  if (!ctx.slot.bought || typeof ctx.slot.bought !== 'object') ctx.slot.bought = {};
  return ctx.slot.bought;
}
// 兑换所那颗蛋：和大量悬赏同口径（可指定物种，否则按活动种子摇，全服同一只），定下来就存着
function shopEgg(ctx) {
  if (!ctx.slot.egg) {
    ctx.slot.egg = eggFrom(ctx, rngFrom(seedOf(ctx) ^ 0x9e3779b9));
    ctx.save();
  }
  return ctx.slot.egg;
}
function shopName(ctx, item) {
  return item.egg ? eggLabel(shopEgg(ctx).species) : item.name;
}
function shopRowHtml(ctx, item) {
  const bought = !!boughtOf(ctx)[item.id];
  const can = !bought && coinsOf(ctx) >= item.price;
  const icon = item.egg ? eggIconHtml(shopEgg(ctx).species) : itemIconHtml(item.icon);
  return `
    <div class="act-shop-row${bought ? ' done' : ''}">
      ${icon}
      <span class="act-shop-name">${shopName(ctx, item)}</span>
      <span class="act-shop-price"><img src="${BALLOON_ICON}" alt="">${item.price}</span>
      <span class="catch-confirm-btn${can ? '' : ' off'}" data-buy="${item.id}">${bought ? '已兑换' : '兑换'}</span>
    </div>`;
}
function buyShopItem(ctx, id) {
  const item = SHOP_ITEMS.find(x => x.id === id);
  if (!item) return;
  const bought = boughtOf(ctx);
  if (bought[item.id] || coinsOf(ctx) < item.price) return;
  ctx.confirm(`花 ${item.price} 个气球换「${shopName(ctx, item)}」？`, () => {
    // 确认框开着的这段时间余额/已兑换可能变了：再核一次
    if (bought[item.id] || coinsOf(ctx) < item.price) { ctx.refresh(); return; }
    const r = rngFrom(seedOf(ctx) + (Object.keys(bought).length + 1) * 7919);   // 随机的薄荷/进化道具：按种子顺着摇
    if (item.egg) {
      const egg = shopEgg(ctx);
      ctx.grantEgg(egg.species, egg);
    } else if (item.id === 'mint') {
      ctx.grant(MINT_KEYS[Math.floor(r() * MINT_KEYS.length)], item.qty);
    } else if (item.id === 'stone') {
      ctx.grant(EVO_REWARD_POOL[Math.floor(r() * EVO_REWARD_POOL.length)], item.qty);
    } else {
      ctx.grant(item.icon, item.qty);
    }
    ctx.slot.coins = coinsOf(ctx) - item.price;
    bought[item.id] = true;
    ctx.save();
    ctx.refresh();
  });
}

export const ACTIVITIES = {
  // ---- 大量悬赏（id: mass-bounty）：活动期间固定一只宝可梦，每交 3 只领一档，四档共 12 只 ----
  // 服务器 activity.json 里加一条：
  // { "id": "mass-bounty", "from": …, "to": …, "payload": { "seed": …, "perTier": 3, "eggSpecies": "0133" } }
  // seed 决定"固定哪一只（全野池随机、去神兽）+ 四档奖励"，改 seed 就整份重摇
  'mass-bounty': {
    name: '大量悬赏',
    icon: './items/goods/balloon-red.png',   // 背包入口用的气球（每个活动一个颜色）

    // 页头标题：活动名 + 当前目标（"大量悬赏-皮卡丘"）
    title(ctx) {
      const poke = targetPoke(ctx);
      return poke ? `大量悬赏-${poke.form || poke.name}` : '大量悬赏';
    },

    // 拿不到排期就没法确定"固定那一只"，这种情况入口直接不显示
    ready(ctx) { return !!targetPoke(ctx); },

    render(ctx) {
      const poke = targetPoke(ctx);
      const rw = rewardOf(ctx);
      const per = perTierOf(ctx);
      const done = tiersDone(ctx);
      const have = poke ? submittable(poke.index, ctx.from).length : 0;
      return `
        <div class="act-hero">${pokeAnimHtml(poke.index, 48)}</div>
        <p class="act-own">活动期间在路上抓到 <b>${have}</b> 只</p>
        <div class="act-tiers">${Array.from({ length: TIERS }, (_, i) => tierHtml(ctx, i, rw, per, done)).join('')}</div>`;
    },

    mount(root, ctx) {
      loadIcons(root);
      const per = perTierOf(ctx);
      const done = tiersDone(ctx);
      const poke = targetPoke(ctx);
      // 槽位：空位去仓库挑一只放进去，已放的再点一下取出
      root.querySelectorAll('.act-slot[data-slot]').forEach((el) => {
        el.addEventListener('click', () => {
          const i = Number(el.dataset.slot);
          if (ctx.picks[i]) { ctx.setPick(i, null); ctx.refresh(); return; }
          ctx.openPicker(i, pickerExclude(ctx, i));
        });
      });
      if (!poke || done >= TIERS) return;
      const btn = root.querySelector(`[data-claim="${done}"]`);
      if (!btn) return;
      const base = done * per;
      const ids = ctx.picks.slice(base, base + per);
      const ok = new Set(submittable(poke.index, ctx.from).map(p => p.id));
      if (ids.length < per || ids.some(id => !ok.has(id))) return;   // 没凑齐 / 有失效的：按钮不接
      btn.addEventListener('click', () => {
        if (tiersDone(ctx) !== done) return;   // 页面重画前被连点：认准档位
        ctx.confirm(`上交这 ${per} 只「${poke.form || poke.name}」换${TIER_NAMES[done]}？上交后不可找回。`, () => {
          if (!ctx.take(ids, `大量悬赏：${poke.name} ×${per}`)) { ctx.refresh(); return; }
          const rw = rewardOf(ctx);
          if (done < TIERS - 1) ctx.grant(rw.items[done], 1);
          else ctx.grantEgg(rw.egg.species, rw.egg);
          ctx.slot.tiers = done + 1;
          for (let j = 0; j < per; j++) ctx.setPick(base + j, null);
          ctx.save();
          ctx.refresh();
        });
      });
    },

    // 每秒看一眼：换场/仓库/档位有变化才重画（容器已经在刷倒计时，这里不碰别的 DOM）
    tick(root, ctx) {
      const poke = targetPoke(ctx);
      const ok = new Set(poke ? submittable(poke.index, ctx.from).map(p => p.id) : []);
      // 槽位里那只被放生/进化了（id 变了）：直接清掉，别等提交时才失败
      for (let i = 0; i < ctx.picks.length; i++) if (ctx.picks[i] && !ok.has(ctx.picks[i])) ctx.picks[i] = null;
      const key = `${poke ? poke.index : '-'}|${ok.size}|${tiersDone(ctx)}|${seedOf(ctx)}|${ctx.picks.map(x => x || '-').join(',')}`;
      if (root.dataset.key !== key) { root.dataset.key = key; ctx.refresh(); }
    },
  },

  // ---- 宝可翻牌（poke-flip）：靠配对翻牌赚气球，换道具（每样限一次）----
  // 服务器 activity.json 里加一条 { "id": "poke-flip", "from": …, "to": …,
  //   "payload": { "seed": …, "eggSpecies": "0133" } }
  'poke-flip': {
    name: '宝可翻牌',
    icon: BALLOON_ICON,

    // 顶栏中间那格：气球就一个图标接一个数字（和标题、剩余时间同一行，不占正文高度）
    badge(ctx) { return `<img src="${BALLOON_ICON}" alt="">${coinsOf(ctx)}`; },

    render(ctx) {
      const lv = levelOf(ctx.slot.level || 'normal');
      return `
        <div class="act-card act-rules">点击卡片翻开，相同图案的配对，将所有卡片两两配对后获得气球奖励。<br>翻得次数越少、难度越高，获得的气球越多。<br>
          气球可以兑换下面的奖励，每样限一次。</div>
        <div class="act-levels">${MG_LEVELS.map(l => `<span class="act-level${l.id === lv.id ? ' on' : ''}" data-level="${l.id}">${l.name}<em>${l.time}秒 · ${l.tries}次</em></span>`).join('')}</div>
        <div class="act-actions"><span class="catch-confirm-btn" id="actPlay">开始游戏</span></div>
        <div class="act-shop">${SHOP_ITEMS.map(it => shopRowHtml(ctx, it)).join('')}</div>`;
    },

    mount(root, ctx) {
      root.querySelectorAll('[data-level]').forEach((el) => el.addEventListener('click', () => {
        ctx.slot.level = el.dataset.level;
        ctx.save();
        ctx.refresh();
      }));
      const play = root.querySelector('#actPlay');
      if (play) play.addEventListener('click', () => {
        import('./memory-game.js').then(m => m.startMemoryGame({
          level: ctx.slot.level || 'normal',
          // 结算回调：币记账，页面的数字等回来时重画
          onFinish: (coins) => {
            ctx.slot.coins = coinsOf(ctx) + coins;
            ctx.save();
          },
        }));
      });
      root.querySelectorAll('[data-buy]').forEach((btn) => {
        btn.addEventListener('click', () => buyShopItem(ctx, btn.dataset.buy));
      });
    },

    // 每秒看一眼：币数/兑换状态有变化才重画
    tick(root, ctx) {
      const key = `${coinsOf(ctx)}|${Object.keys(boughtOf(ctx)).sort().join(',')}|${ctx.slot.level || ''}`;
      if (root.dataset.key !== key) { root.dataset.key = key; ctx.refresh(); }
    },
  },
};
