/**
 * 托盘右键菜单（独立小窗 `traypop` 的前端）。
 *
 * 为什么要单开一个窗口：主窗口是 alwaysOnBottom 的桌面层，菜单画在里面就永远
 * 压在别的窗口下面。做成独立窗口后它自己就是 alwaysOnTop，和系统托盘菜单一样
 * 浮在最上面，桌面组件也不用跟着被抬起来。
 *
 * 分工：
 * - 后端只管「图标被右键了」，发 `tray:open-menu`，带图标矩形 / 工作区 / 屏幕尺寸
 *   （全部屏幕物理像素）；窗口的显隐与摆位由 `traypop_show` / `traypop_hide` 完成。
 * - 菜单本体、勾选状态、落点计算都在这里。
 * - 点了哪一项回传主窗口执行（`tray:act`）：控制中心、打开目录、改配置这些能力
 *   本来就归主窗口管。主窗口改完再把新勾选态推回来（`tray:state`）。
 */

import { invoke, listen, emitTo } from './bridge.js';

/** 菜单盒四周留出的透明边（CSS 像素）。
 *  `.tm` 的投影是 `0 22px 40px -22px`，紧贴窗口边缘会被裁掉，看起来像没有投影的硬方块。 */
const PAD = 24;

const host = document.getElementById('traymenu');

/** 当前展开的菜单盒；null = 收起状态。 */
let box = null;

/** 上一次量到的菜单尺寸（CSS 像素）。窗口没显示过时万一量不出尺寸，用它兜底。 */
let lastSize = null;

const dpr = () => window.devicePixelRatio || 1;

const TICK = '<span class="tm-tick" aria-hidden="true">✓</span>';

function markup(autostart, seconds) {
  return `<div class="tm" role="menu">
    <button class="tm-item" data-act="hub" role="menuitem">${TICK}控制中心</button>
    <div class="tm-sep"></div>
    <button class="tm-item check" data-act="autostart" aria-checked="${!!autostart}" role="menuitemcheckbox">${TICK}开机自启</button>
    <button class="tm-item check" data-act="seconds" aria-checked="${seconds !== false}" role="menuitemcheckbox">${TICK}时钟显示秒</button>
    <div class="tm-sep"></div>
    <button class="tm-item" data-act="root" role="menuitem">${TICK}打开收纳文件夹</button>
    <button class="tm-item" data-act="conf" role="menuitem">${TICK}设置文件…</button>
    <div class="tm-sep"></div>
    <button class="tm-item danger" data-act="quit" role="menuitem">${TICK}退出 fy-desktop</button>
  </div>`;
}

/**
 * 菜单落点（CSS 像素的屏幕坐标）。三条约束，按优先级：
 * 1) 菜单必须落在屏幕内、且不能压到任务栏那一条上——任务栏永远在最上层，
 *    被它盖住的部分看起来就是「菜单跑到屏幕外了」；
 * 2) 往任务栏的**对面**展开，尽量贴着托盘图标；
 * 3) 空间不够就翻到图标另一侧，最后才夹回可用区域。
 *
 * 任务栏在哪条边，用**图标矩形**判断：托盘图标就画在任务栏里，离哪条屏幕边最近，
 * 任务栏就在哪条边。不用工作区判断——竖排任务栏下它并不可靠（实测右侧任务栏时，
 * 拿到的 work_area 一度仍是「下方少了 48px」的形状），而图标矩形是系统直接给的。
 * 工作区只做最后一道兜底。
 *
 * rect 里的数值是后端下发的屏幕物理像素，这里统一折成 CSS 像素再算。
 */
function place(mw, mh, rect) {
  const d = dpr();
  const W = rect.sw > 0 ? rect.sw / d : window.screen.width;
  const H = rect.sh > 0 ? rect.sh / d : window.screen.height;
  const iconL = rect.x / d;
  const iconT = rect.y / d;
  const iconR = iconL + (rect.w || 0) / d;
  const iconB = iconT + (rect.h || 0) / d;

  const gap = 8; // 菜单与图标之间的空隙
  const pad = 8; // 菜单与屏幕边缘的最小留白

  // 图标离哪条边最近 = 任务栏贴在哪条边
  const edge = [
    ['left', iconL],
    ['right', W - iconR],
    ['top', iconT],
    ['bottom', H - iconB]
  ].sort((a, b) => a[1] - b[1])[0][0];

  let x;
  let y;
  if (edge === 'left') {
    // 竖排任务栏：从任务栏内侧展开，底边与图标对齐（和系统菜单一致）
    x = iconR + gap;
    y = iconB - mh;
  } else if (edge === 'right') {
    x = iconL - gap - mw;
    y = iconB - mh;
  } else if (edge === 'top') {
    x = iconR - mw;
    y = iconB + gap;
  } else {
    // 底部任务栏（绝大多数场景）：向上弹，右对齐图标
    x = iconR - mw;
    y = iconT - gap - mh;
  }

  // 放不下就翻到图标另一侧
  if (x + mw > W - pad) x = iconL - gap - mw;
  if (x < pad) x = iconR + gap;
  if (y < pad) y = iconB + gap;
  if (y + mh > H - pad) y = iconT - gap - mh;

  // 工作区兜底：别压到任务栏那一条上。工作区明显不合理（装不下菜单）时直接忽略。
  if (Array.isArray(rect.wa) && rect.wa.length === 4 && rect.wa[2] > 0) {
    const wl = rect.wa[0] / d;
    const wt = rect.wa[1] / d;
    const wr = wl + rect.wa[2] / d;
    const wb = wt + rect.wa[3] / d;
    if (wr - wl >= mw + pad * 2 && wb - wt >= mh + pad * 2) {
      x = Math.min(Math.max(x, wl + pad), wr - mw - pad);
      y = Math.min(Math.max(y, wt + pad), wb - mh - pad);
    }
  }

  // 最后夹回屏幕内（菜单比屏幕还大时以左上留白优先）
  x = Math.min(Math.max(x, pad), Math.max(pad, W - mw - pad));
  y = Math.min(Math.max(y, pad), Math.max(pad, H - mh - pad));
  return { x, y };
}

async function hide() {
  if (!box) return;
  box = null;
  host.hidden = true;
  host.innerHTML = '';
  await invoke('traypop_hide').catch(() => {});
}

/** 弹菜单。rect 是后端下发的图标矩形（屏幕物理像素）。 */
async function show(rect) {
  if (!rect || typeof rect.x !== 'number') return;
  // 连点两次托盘：先把上一次收掉，避免两套 DOM 叠在一起
  await hide();

  // 材质跟着全局配置走；勾选态以注册表里的真实值为准（可能被系统/清理工具改过）
  const cfg = await invoke('get_config').catch(() => null);
  document.body.dataset.material = cfg?.material || 'glass';
  const autostart = await invoke('get_autostart').catch(() => !!cfg?.autostart);

  host.innerHTML = markup(autostart, cfg?.show_seconds);
  host.hidden = false;
  box = host.firstElementChild;
  box.style.left = `${PAD}px`;
  box.style.top = `${PAD}px`;

  // 先量尺寸再摆窗口：窗口此刻还是隐藏的，但 WebView 已经完成布局，量得到。
  // 万一量到 0（窗口还没真正呈现过），退回上一次的尺寸；连上一次也没有就用一个
  // 足够大的保底值——宁可留白多一点，也不能把菜单裁掉。
  const mw = box.offsetWidth || lastSize?.[0] || 200;
  const mh = box.offsetHeight || lastSize?.[1] || 260;
  if (box.offsetWidth && box.offsetHeight) lastSize = [mw, mh];
  const at = place(mw, mh, rect);

  const d = dpr();
  const pad = Math.round(PAD * d);
  // 窗口比菜单大一圈（四周留 PAD 给投影），所以窗口位置要往回退一个 PAD，
  // 菜单盒才会正好落在算出来的 at 上。
  const x = Math.round((at.x - PAD) * d);
  const y = Math.round((at.y - PAD) * d);
  // 菜单真实占据的屏幕矩形，交给后端做「点在菜单外面就收起」的判定
  const guard = [x + pad, y + pad, x + pad + Math.round(mw * d), y + pad + Math.round(mh * d)];

  await invoke('traypop_show', {
    x,
    y,
    w: Math.round((mw + PAD * 2) * d),
    h: Math.round((mh + PAD * 2) * d),
    rect: guard
  }).catch((err) => console.error('[tray] 显示菜单失败', err));
}

// ---- 交互 ----

host.addEventListener('click', (e) => {
  const btn = e.target.closest('.tm-item');
  if (!btn || !box) return;
  const act = btn.dataset.act;
  // 勾选项不关菜单（和原生勾选菜单一致），等主窗口把真实状态推回来再更新勾
  if (act === 'autostart' || act === 'seconds') {
    emitTo('main', 'tray:act', act).catch(() => {});
    return;
  }
  // 其余动作先收起再执行：菜单是要盖在最上面的，留着会挡住刚打开的控制中心
  hide();
  emitTo('main', 'tray:act', act).catch(() => {});
});

// 小窗是 no-activate 的，Esc 实际上很少能收到；留着当兜底
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape') hide();
  },
  true
);

// 三个订阅都挂好之后才告诉后端「我准备好了」：右键请求会在那一刻补发
// （见 commands::traypop_ready），抢在订阅之前发就白发了。
// 用 allSettled 而不是 all：某个订阅被 ACL 挡掉时（新窗口忘了配 capabilities 就是这症状），
// 至少要把错误打到控制台，别让「点了托盘没反应」查无实据。
const subs = Promise.allSettled([
  // 点了菜单外面（包括别的应用、任务栏）时，窗口这边收不到任何事件，
  // 全靠后端的全局按键轮询发现后推过来。
  listen('menu:outside', () => hide()),
  // 主窗口改完配置后回推勾选态
  listen('tray:state', (e) => {
    const s = e.payload || {};
    if (!box) return;
    box
      .querySelector('[data-act="autostart"]')
      ?.setAttribute('aria-checked', String(!!s.autostart));
    box
      .querySelector('[data-act="seconds"]')
      ?.setAttribute('aria-checked', String(s.seconds !== false));
  }),
  listen('tray:open-menu', (e) => show(e.payload))
]);

subs
  .then((list) => {
    for (const r of list) {
      if (r.status === 'rejected') console.error('[tray] 订阅失败', r.reason);
    }
    return invoke('traypop_ready');
  })
  .catch((err) => console.error('[tray] 就绪上报失败', err));
