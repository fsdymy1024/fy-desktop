/**
 * 主流程：启动 → 布局 → 渲染组件 → 玻璃底图 → 事件订阅 → 交互。
 *
 * 坐标系只有一套：设计像素。屏幕实际像素 = 设计像素 × scale，
 * 所以后端报上来的热区要乘 devicePixelRatio，拖拽位移要除以 scale。
 */

import { invoke, listen, dbg } from './bridge.js';
import { REGISTRY, setShowSeconds, SIZE_LABEL, dimsOf, GAP } from './widgets.js';
import { renderOrganizer, groupAtPoint, resetLoose } from './organizer.js';
import { openGallery } from './gallery.js';
import { openAbout, updateHint } from './about.js';
import { makeDraggable, closeOnBackdrop } from './floatwin.js';
import { clamp } from './util.js';

const $ = (s, r = document) => r.querySelector(s);
const dpr = () => window.devicePixelRatio || 1;

const S = {
  cfg: null,
  design: { w: 1920, h: 1080 },
  scale: 1,
  view: null,
  edit: false,
  force: false,
  mounted: new Map(),
  gallery: null,
  about: null,
  version: '',
  shotMode: false
};

/* 吸附网格。网格粒度 = 最小缝隙 GAP = 6（widgets.js 导出，和尺寸同源）：
 * 三档尺寸（102 / 210 / 126）全是它的整数倍，邻卡之间也固定留 GAP，
 * 所以无论拖动吸附还是自动补位，卡片缝隙都只可能是 6 或它的整数倍。 */
const GRID = GAP;
const SNAP_TOL = 6;

/* ============================ 启动 ============================ */

// 截图模式下把未捕获异常记下来，随 dump 一起落盘
window.addEventListener('error', (e) => {
  S.err = `${e.message} @${e.filename}:${e.lineno}`;
});
window.addEventListener('unhandledrejection', (e) => {
  S.err = `reject: ${e.reason?.message || e.reason}`;
});

async function boot() {
  const b = await invoke('boot');
  S.uitest = b.uitest || '';
  S.cfg = b.config;
  S.design = { w: b.design[0], h: b.design[1] };
  S.scale = b.scale || 1;
  S.version = b.version || '';
  S.shotMode = !!b.shot;

  layoutStage();
  applyMaterial();
  setShowSeconds(S.cfg.show_seconds !== false);

  normalizeSizes();
  renderWidgets();

  // 窗口显示必须早于任何耗时/易失败的 IO。
  // 之前 refreshDesktop（扫桌面 + 提图标）排在前面，开机自启时这一步最慢，
  // 一旦抛异常窗口就永远保持隐藏——用户看到的是「桌面上什么都没有」，
  // 而且没有任何提示能说明是渲染层没起来。
  // 诊断：区分「正常首帧」与「页面被重建」。
  // sessionStorage 在重载后仍然存在，计数 > 1 就说明浏览器把页面从头跑了一遍。
  let boots = 1;
  try {
    boots = (Number(sessionStorage.getItem('fy:boots')) || 0) + 1;
    sessionStorage.setItem('fy:boots', String(boots));
  } catch {
    // 存储不可用时不影响启动，只是拿不到计数
  }
  const navEntry = performance.getEntriesByType('navigation')[0];
  invoke('ui_ready', { nav: navEntry ? navEntry.type : '?', boots });

  document.body.dataset.ready = '1';

  bindGlobalEvents();

  // 桌面内容与玻璃底图都不阻断主流程：两者失败，组件照样可用。
  refreshDesktop().catch((e) => console.warn('[desk] 首屏加载失败', e));
  if (!S.shotMode) loadGlass();

  if (S.shotMode) {
    // 等玻璃底图就绪再落盘，否则 json 里 glass 永远是 false
    // 两拍：400ms 那次拿布局与底图状态，6s 那次带上真实的指标/天气值
    // （第一拍太早，counters 全是 0，看不出「数据到底有没有到」）
    loadGlass().then(() => {
      setTimeout(dumpLayout, 400);
      setTimeout(dumpLayout, 6000);
    });
  }

  // 调试：自动化验证会把窗口拖到奇怪的位置并存进 localStorage，
  // 跑一次 resetpos 清掉，免得正式使用时窗口默认不在正中。
  if (b.uitest === 'resetpos') {
    ['gallery', 'about', 'modal'].forEach((k) => {
      try {
        localStorage.removeItem(`fy.float.${k}`);
      } catch (_) {
        // localStorage 被禁就算了
      }
    });
  }
  // 调试：FY_UI=place|group 时自动打开对应弹层，方便截图核对样式与命中区
  if (b.uitest === 'place') setTimeout(() => pickPlace(), 400);
  // FY_UI=placesearch：再自动搜一次，用来核对结果项的对比度与行高
  if (b.uitest === 'placesearch')
    setTimeout(() => {
      pickPlace();
      setTimeout(() => {
        const input = document.querySelector('.modal .modal-input');
        if (!input) return;
        input.value = '西湖区';
        document.querySelector('.modal [data-search]')?.click();
      }, 600);
    }, 400);
  // FY_UI=edit：进编辑模式，用来核对虚线框、参考线这些只在编辑态出现的东西
  if (b.uitest === 'edit') setTimeout(() => setEdit(true), 400);
  if (b.uitest === 'group') setTimeout(() => promptInput('新建分组', '例如：设计素材'), 400);
  // FY_UI=gal：打开组件库；FY_UI=menu：在首张卡片上弹右键菜单
  // FY_UI=galadd / menusize：再点一下，用来验证「按档位添加」「右键换档」真的生效
  if (b.uitest === 'gal') setTimeout(() => openGal(), 500);
  if (b.uitest === 'galadd')
    setTimeout(() => {
      openGal();
      setTimeout(
        () => document.querySelector('#gallery .gcard[data-kind="weather"][data-size="s"]')?.click(),
        700
      );
    }, 500);
  // FY_UI=galmat：打开组件库点一下「玻璃」，验证材质真的落到了底层卡片上
  if (b.uitest === 'galmat')
    setTimeout(() => {
      openGal();
      setTimeout(
        () => document.querySelector('#gallery .matbtn[data-mat="glass"]')?.click(),
        800
      );
    }, 500);
  // FY_UI=matall：验证「改材质 = 所有元素一起变」。切暮色后关掉组件库、
  // 打开关于页，dump 里可同时看到 body / 全部卡片 / 组件库 / 关于页的材质与底色。
  // cardmats 是 v0.9 用的旧名，保留兼容。
  if (b.uitest === 'matall' || b.uitest === 'cardmats')
    setTimeout(() => {
      openGal();
      setTimeout(() => {
        document.querySelector('#gallery .matbtn[data-mat="dusk"]')?.click();
        setTimeout(() => {
          S.gallery?.close();
          openAboutPanel();
        }, 900);
      }, 700);
    }, 500);
  // FY_UI=floatwin：验证浮层「点遮罩关 / 拖动不误关 / x 也关」。
  // 结果写进 S.floatProbe，dump 里读；最后重新打开窗口便于截图核对。
  if (b.uitest === 'floatwin')
    setTimeout(() => {
      openAboutPanel();
      setTimeout(() => {
        const host = $('#about');
        const M = (t, o) => new MouseEvent(t, { bubbles: true, button: 0, ...o });
        // 按下与点击都落在遮罩上 → 应该关闭（否则桌面会被透明板锁死）
        host.dispatchEvent(M('mousedown', {}));
        host.dispatchEvent(M('click', {}));
        const closedByBackdrop = host.hidden;
        openAboutPanel();
        setTimeout(() => {
          const h2 = $('#about');
          // 从标题栏按下、拖到遮罩上松手：不应关闭
          h2.querySelector('.ab-head').dispatchEvent(M('mousedown', { clientX: 200, clientY: 200 }));
          document.dispatchEvent(M('mousemove', { clientX: 300, clientY: 260 }));
          document.dispatchEvent(M('mouseup', {}));
          h2.dispatchEvent(M('click', {}));
          const stayedAfterDrag = !h2.hidden;
          const moved = h2.querySelector('.ab')?.style.transform || '';
          h2.querySelector('.ab-close')?.click();
          const closedByX = h2.hidden;
          openAboutPanel();
          S.floatProbe = { closedByBackdrop, stayedAfterDrag, moved, closedByX };
          setTimeout(() => dumpLayout(), 250);
        }, 400);
      }, 700);
    }, 500);
  if (b.uitest === 'about') setTimeout(() => openAboutPanel(), 500);
  // FY_UI=aboutcheck：打开关于并点一次「检查更新」，验证 GitHub 那条链路
  if (b.uitest === 'aboutcheck')
    setTimeout(() => {
      openAboutPanel();
      setTimeout(() => document.querySelector('#about [data-act="check"]')?.click(), 600);
    }, 500);
  if (b.uitest === 'menu') setTimeout(() => openFirstCardMenu(), 500);
  if (b.uitest === 'menusize')
    setTimeout(() => {
      openFirstCardMenu();
      setTimeout(() => document.querySelector('#menu button')?.click(), 600);
    }, 500);
}

/** 调试用：在首张卡片上派发一次右键，等价于用户点右键 */
function openFirstCardMenu() {
  const el = document.querySelector('#stage .card');
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: Math.round(r.left + 46),
      clientY: Math.round(r.top + 40)
    })
  );
}

function layoutStage() {
  const stage = $('#stage');
  stage.style.width = `${S.design.w}px`;
  stage.style.height = `${S.design.h}px`;
  stage.style.transform = `scale(${S.scale})`;
  document.documentElement.style.setProperty('--shot-w', `${S.design.w}px`);
  document.documentElement.style.setProperty('--shot-h', `${S.design.h}px`);
}

function applyMaterial() {
  document.body.dataset.material = S.cfg.material || 'glass';
  document.body.dataset.labels = S.cfg.show_labels === false ? '0' : '1';
}

/** 卡片的 data-material 是渲染时写死的，只改 body 不会动它。
 *  改全局材质时必须逐张刷新，不然「所有元素一起变」就漏掉了桌面组件。 */
function syncCardMaterials() {
  const byId = new Map((S.cfg.widgets || []).map((w) => [w.id, w]));
  document.querySelectorAll('#stage .card').forEach((el) => {
    const w = byId.get(el.dataset.id);
    el.dataset.material = w?.material || S.cfg.material || 'glass';
  });
}

/** 用户改材质 = 全局统一应用。
 *  四类一起走：桌面所有组件、组件库窗口、关于页、天气地区弹窗。
 *  浮层靠 body[data-material] 的 --pop-* 变量自动跟随；组件库自己另有一套
 *  --gal-*（按 .gal[data-mat]），要显式同步选中态；卡片靠 syncCardMaterials。
 *  单卡右键换的材质被这次全局操作覆盖掉，这是「所有元素一起改」的语义；
 *  之后仍可右键某张卡再单独换。 */
function setGlobalMaterial(mat) {
  if (!['glass', 'dusk', 'solid'].includes(mat)) return;
  S.cfg.material = mat;
  for (const w of S.cfg.widgets || []) w.material = '';
  applyMaterial();
  syncCardMaterials();
  S.gallery?.setMaterial?.(mat);
  save();
  loadGlass();
}

/* ============================ 组件 ============================ */

/** 允许的尺寸档位。日历/备忘录塞不下正方形，只给中/大 */
const sizesOf = (kind) => REGISTRY[kind]?.sizes || ['m'];

/** 老配置只有 w/h、没有 size：统一归到「中」，再把 w/h 按档位重算。
 *  v0.6 起尺寸只认三档预设，手拉出来的 216×128 这种尺寸不再合法。 */
function normalizeSizes() {
  for (const w of S.cfg.widgets) {
    const list = sizesOf(w.kind);
    let size = w.size;
    if (!list.includes(size)) {
      // 这一档被砍掉了（v0.7 起除备忘额外取消「大」）：按档位距离就近归位。
      // 不能按宽高比——210×126 的 ratio 是 1.67，反而更像「小」的 1:1。
      const order = ['s', 'm', 'l'];
      const at = Math.max(0, order.indexOf(size || 'm'));
      size = list.reduce(
        (best, k) => (Math.abs(order.indexOf(k) - at) < Math.abs(order.indexOf(best) - at) ? k : best),
        list[0]
      );
    }
    const [nw, nh] = dimsOf(size);
    if (w.size !== size || w.w !== nw || w.h !== nh) {
      w.size = size;
      w.w = nw;
      w.h = nh;
    }
    // 改成预设尺寸后可能顶出屏幕，拉回来
    const nx = Math.round(clamp(w.x, 0, Math.max(0, S.design.w - nw)));
    const ny = Math.round(clamp(w.y, 0, Math.max(0, S.design.h - nh)));
    w.x = nx;
    w.y = ny;
  }

  // 旧尺寸是手拉出来的，换成 210 宽后会有卡片互相压住几个像素。
  // 让位规则：横着只差一点点就往右挪（保住同一排），差得多才往下挪——
  // 列是用户自己排的，随便拆开会前功尽弃。
  const clash = (a, b) =>
    a.x < b.x + b.w + GAP && a.x + a.w + GAP > b.x && a.y < b.y + b.h + GAP && a.y + a.h + GAP > b.y;
  const placed = [];
  for (const w of S.cfg.widgets) {
    let guard = 0;
    while (guard++ < 40) {
      const hit = placed.find((o) => clash(w, o));
      if (!hit) break;
      const right = hit.x + hit.w + GAP;
      if (right - w.x <= 3 * GRID && right + w.w <= S.design.w) w.x = right;
      else w.y = hit.y + hit.h + GAP;
    }
    w.x = Math.round(w.x / GRID) * GRID;
    w.y = Math.round(clamp(w.y, 0, Math.max(0, S.design.h - w.h)) / GRID) * GRID;
    placed.push(w);
  }

  // 位置可能被挪过，统一落一次盘（写盘本身有 320ms 防抖）
  save();
}

function place(el, w) {
  el.style.left = `${w.x}px`;
  el.style.top = `${w.y}px`;
  el.style.width = `${w.w}px`;
  el.style.height = `${w.h}px`;
  // 尺寸档位挂在卡片上，内容按档位增删由 CSS 负责
  el.dataset.size = w.size || 'm';
  // 玻璃背景按卡片在舞台里的坐标反推裁切位置
  el.style.setProperty('--shot-x', `${-w.x}px`);
  el.style.setProperty('--shot-y', `${-w.y}px`);
}

function buildCard(w) {
  const def = REGISTRY[w.kind];
  if (!def) return null;

  const el = document.createElement('div');
  el.className = 'card surface';
  el.dataset.id = w.id;
  el.dataset.kind = w.kind;
  el.dataset.size = w.size || 'm';
  // 每张卡自己的材质；空则跟随全局。CSS 用 [data-material] 决定这张卡的配色，
  // 不再只看 body——这样一张暮色卡旁边可以放一张玻璃卡。
  el.dataset.material = w.material || S.cfg.material || 'glass';

  const body = document.createElement('div');
  body.className = 'body';
  el.appendChild(body);

  let inst = null;
  try {
    inst = def.mount(body, { id: w.id });
  } catch (err) {
    console.error('[fy] 组件挂载失败', w.kind, err);
    body.innerHTML = `<div class="k">组件加载失败</div>`;
  }

  // 卡片上不再挂工具条：换尺寸、移除、调整布局全部收进右键菜单。
  // 编辑态只留「拖动」这一件事，卡片本身保持干净——工具条会压住右上角的
  // 内容（尤其是小号卡），而且三颗小按钮在桌面场景里太难点。
  return { el, inst };
}

function renderWidgets() {
  const host = $('#widgets');

  for (const [id, m] of [...S.mounted]) {
    if (!S.cfg.widgets.some((w) => w.id === id)) {
      m.inst?.destroy?.();
      m.el.remove();
      S.mounted.delete(id);
    }
  }

  for (const w of S.cfg.widgets) {
    let m = S.mounted.get(w.id);
    if (!m) {
      m = buildCard(w);
      if (!m) {
        S.cfg.widgets = S.cfg.widgets.filter((x) => x.id !== w.id);
        continue;
      }
      S.mounted.set(w.id, m);
      host.appendChild(m.el);
      bindCard(m.el, w);
    }
    place(m.el, w);
    if (S.metrics) m.inst?.metrics?.(S.metrics);
    if (S.weather) m.inst?.weather?.(S.weather);
  }
  paintShotVars();
  scheduleHit();
}

function bindCard(el, w) {
  el.addEventListener('pointerdown', (e) => {
    if (!S.edit) return;
    if (e.button !== 0) return;
    startDrag(e, el, w);
  });

  // 右键卡片 = 这张卡的全部设置：尺寸、调整布局、添加、移除。
  // 以前这些散在「编辑布局」和卡片右上角的小按钮里，先得进编辑态才找得到。
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCardMenu(el, w, e.clientX, e.clientY);
  });

  // 双击天气卡直接改地区：这是最常用的设置，不该藏进托盘
  if (w.kind === 'weather') {
    el.addEventListener('dblclick', (e) => {
      pickPlace();
    });
  }
}

/** 组件右键菜单 */
function openCardMenu(el, w, x, y) {
  const def = REGISTRY[w.kind] || { name: w.kind };
  const cur = w.size || 'm';
  const items = [{ head: true, label: `${def.name} · ${SIZE_LABEL[cur]} ${dimsOf(cur).join('×')}` }];

  for (const k of sizesOf(w.kind)) {
    const [sw, sh] = dimsOf(k);
    items.push({
      label: `${k === cur ? '✓' : '　'} ${SIZE_LABEL[k]}　${sw}×${sh}`,
      disabled: k === cur,
      act: () => setCardSize(el, w, k)
    });
  }

  // 材质：每张卡自己记，改一张不影响别的卡
  items.push({ sep: true });
  const curMat = w.material || S.cfg.material || 'glass';
  items.push({ head: true, label: `材质 · ${{ glass: '玻璃', dusk: '暮色', solid: '石墨' }[curMat] || curMat}` });
  for (const [k, label] of [['glass', '玻璃'], ['dusk', '暮色'], ['solid', '石墨']]) {
    items.push({
      label: `${k === curMat ? '✓' : '　'} ${label}`,
      disabled: k === curMat,
      act: () => setCardMaterial(el, w, k)
    });
  }

  items.push({ sep: true });
  items.push({ label: '调整布局…', act: () => startLayout() });
  items.push({ label: '添加组件…', act: () => openGal() });
  items.push({ sep: true });
  items.push({
    label: '移除组件',
    disabled: S.cfg.widgets.length <= 1,
    act: () => removeWidget(w.id)
  });

  showMenu({ x, y }, items);
}

/** 进入布局编辑：卡片可拖动（吸网格 + 参考线），Esc 或「完成」退出 */
function startLayout() {
  setEdit(true);
  toast('拖动卡片调整位置，Esc 结束');
}

/** 换档位：尺寸、位置、内容一起重排。
 *  位置也顺手夹回屏幕内——大号比中号高 60px，贴着底边的卡片会掉出去。 */
function setCardSize(el, w, size) {
  if (!sizesOf(w.kind).includes(size) || w.size === size) return;
  const [nw, nh] = dimsOf(size);
  w.size = size;
  w.w = nw;
  w.h = nh;
  w.x = Math.round(clamp(w.x, 0, Math.max(0, S.design.w - nw)));
  w.y = Math.round(clamp(w.y, 0, Math.max(0, S.design.h - nh)));

  place(el, w);
  paintShotVars();
  S.mounted.get(w.id)?.inst?.onSizeChange?.();
  save();
  scheduleHit();
  toast(`「${REGISTRY[w.kind]?.name || w.kind}」已切到${SIZE_LABEL[size]}号`);
}

/** 换单张卡的材质：只改这张卡，不动全局、不动别的卡 */
function setCardMaterial(el, w, material) {
  w.material = material;
  el.dataset.material = material;
  // 切成玻璃/暮色时若手上还没有底图（之前全是石墨），补抓一次
  if (material !== 'solid' && !S.shot) loadGlass();
  else paintShotVars();
  save();
  toast(`材质已换为${{ glass: '玻璃', dusk: '暮色', solid: '石墨' }[material]}`);
}

/* ---- 网格吸附 ----
 *
 * 两个层次：
 * 1) 兜底落 GRID 网格，拖出来的坐标不会出现 3px、5px 这种歪数；
 * 2) 优先贴其它卡片的参考线（左/中/右、上/中/下），6px 内直接对齐，
 *    这样不同组件能落在同一条线上，宽高也能对齐成一样。
 * 缝隙只由 GAP 决定：贴邻卡的「后边」时预留 GAP，同向对齐（左对左）仍贴齐。
 */

let guides = null;
function ensureGuides() {
  if (guides) return guides;
  const stage = $('#stage');
  const v = document.createElement('div');
  v.className = 'guide-v';
  v.hidden = true;
  const h = document.createElement('div');
  h.className = 'guide-h';
  h.hidden = true;
  stage.append(v, h);
  guides = { v, h };
  return guides;
}
function showGuides(gx, gy) {
  const g = ensureGuides();
  if (gx == null) g.v.hidden = true;
  else {
    g.v.hidden = false;
    g.v.style.left = `${gx}px`;
  }
  if (gy == null) g.h.hidden = true;
  else {
    g.h.hidden = false;
    g.h.style.top = `${gy}px`;
  }
}
function hideGuides() {
  const g = ensureGuides();
  g.v.hidden = true;
  g.h.hidden = true;
}

/** 其它卡片与收纳面板的参考线。kind 说明这是卡的哪条边，
 *  吸附时要靠它判断「往邻卡后面接」还是「同向对齐」。 */
function refLines(exceptId) {
  const xs = [];
  const ys = [];
  for (const o of S.cfg.widgets) {
    if (o.id === exceptId) continue;
    xs.push({ v: o.x, kind: 'left' }, { v: o.x + o.w / 2, kind: 'center' }, { v: o.x + o.w, kind: 'right' });
    ys.push({ v: o.y, kind: 'top' }, { v: o.y + o.h / 2, kind: 'center' }, { v: o.y + o.h, kind: 'bottom' });
  }
  const org = S.cfg.organizer;
  if (org) {
    xs.push({ v: org.x, kind: 'left' }, { v: org.x + org.w / 2, kind: 'center' }, { v: org.x + org.w, kind: 'right' });
    ys.push({ v: org.y, kind: 'top' });
  }
  return { xs, ys };
}

/** 起点吸附：本卡的前边 / 中线 / 后边各自去贴参考线，取最近的一处。
 *
 *  前边贴邻卡的「后边」（右边、底边）时预留 GAP，并排两张卡的缝隙因此恒为 GAP；
 *  后边贴邻卡的「前边」同理。同向对齐（左对左、上对上）仍然贴齐，
 *  这样一列卡片的边缘能落在同一条线上——缝隙统一，列也整齐。 */
function snapStart(pos, size, lines) {
  let best = null;
  for (const l of lines) {
    const after = l.kind === 'right' || l.kind === 'bottom';
    const before = l.kind === 'left' || l.kind === 'top';
    const targets = [
      l.v + (after ? GAP : 0), // 本卡前边
      l.v - size / 2, // 本卡中线
      l.v - size - (before ? GAP : 0) // 本卡后边
    ];
    for (const t of targets) {
      const d = Math.abs(t - pos);
      if (d <= SNAP_TOL && (!best || d < best.d)) best = { d, pos: t, line: l.v };
    }
  }
  return best;
}

const onGrid = (v) => Math.round(v / GRID) * GRID;

/** 拖动改位置。尺寸不在这里改——只有三档预设，从卡片右键菜单里选 */
function startDrag(e, el, w) {
  e.preventDefault();
  e.stopPropagation();

  const sx = e.clientX;
  const sy = e.clientY;
  const origin = { x: w.x, y: w.y };

  S.force = true;
  updateHit();

  const onMove = (ev) => {
    const dx = (ev.clientX - sx) / S.scale;
    const dy = (ev.clientY - sy) / S.scale;
    const { xs, ys } = refLines(w.id);

    const nx = clamp(origin.x + dx, 0, S.design.w - w.w);
    const ny = clamp(origin.y + dy, 0, S.design.h - w.h);
    const hitX = snapStart(nx, w.w, xs);
    const hitY = snapStart(ny, w.h, ys);
    w.x = Math.round(hitX ? clamp(hitX.pos, 0, S.design.w - w.w) : onGrid(nx));
    w.y = Math.round(hitY ? clamp(hitY.pos, 0, S.design.h - w.h) : onGrid(ny));
    showGuides(hitX?.line ?? null, hitY?.line ?? null);
    place(el, w);
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    S.force = false;
    hideGuides();
    save();
    updateHit();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function addWidget(kind, size, material) {
  const def = REGISTRY[kind];
  if (!def) return;
  // 组件库按档位分组列出，点的是「哪个组件的哪一档」，别一律按默认档加
  const want = sizesOf(kind).includes(size) ? size : def.def || 'm';
  const [w, h] = dimsOf(want);
  const spot = freeSpot(w, h);
  S.cfg.widgets.push({
    id: `${kind}-${Date.now().toString(36)}`,
    kind,
    x: spot.x,
    y: spot.y,
    size: want,
    w,
    h,
    // 点材质按钮时 setGlobalMaterial 已经把全局统一应用过了，这里带上同一个值；
    // 下次再改全局会被统一清空。真正算「单卡覆盖」的只有右键换材质。
    // 空串＝跟随全局，老配置 / 托盘添加都走这条。
    material: material || ''
  });
  renderWidgets();
  save();
  toast(`已添加「${def.name}」${SIZE_LABEL[want]}号`);
}

function removeWidget(id) {
  const w = S.cfg.widgets.find((x) => x.id === id);
  if (!w) return;
  S.cfg.widgets = S.cfg.widgets.filter((x) => x.id !== id);
  renderWidgets();
  save();
  toast(`已移除「${REGISTRY[w.kind]?.name || w.kind}」`);
}

function freeSpot(w, h) {
  // pad 与步进都取 GAP 的整数倍，扫出来的坐标才能和已有卡片的边缘对齐，
  // 缝隙才会是 GAP 而不是 4px、12px 这种歪数。
  const pad = 4 * GRID;
  const limitX = Math.max(pad + w, (S.cfg.organizer?.x ?? S.design.w) - 20);
  const boxes = S.cfg.widgets.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
  const clash = (a) =>
    boxes.some((b) => a.x < b.x + b.w + GAP && a.x + a.w + GAP > b.x && a.y < b.y + b.h + GAP && a.y + a.h + GAP > b.y);

  for (let y = pad; y + h <= S.design.h - pad; y += GAP) {
    for (let x = pad; x + w <= limitX; x += GAP) {
      const box = { x, y, w, h };
      if (!clash(box)) return box;
    }
  }
  return { x: pad, y: pad };
}

/* ============================ 收纳面板 ============================ */

async function refreshDesktop() {
  try {
    S.view = await invoke('desktop_view');
  } catch (e) {
    console.error('[fy] 读取桌面失败', e);
    S.view = null;
  }
  renderPanel();
}

function renderPanel() {
  const el = $('#organizer');
  const o = S.cfg.organizer;
  el.className = 'panel surface';
  el.style.left = `${o.x}px`;
  el.style.top = `${o.y}px`;
  el.style.width = `${o.w}px`;
  // h=0 表示高度跟内容走；用户拖过之后才固定
  el.style.height = o.h ? `${o.h}px` : 'auto';
  el.style.setProperty('--shot-x', `${-o.x}px`);
  el.style.setProperty('--shot-y', `${-o.y}px`);

  renderOrganizer(el, S.cfg, S.view, handlers);
  attachPanelChrome(el);
  paintShotVars();
  scheduleHit();
}

/** 打开类动作失败必须说话。
 *  以前 invoke 被拒时 promise 静默 reject，界面上只表现为「点了没反应」，
 *  连是路径问题还是系统拒绝都分不清。 */
function guardOpen(p) {
  return Promise.resolve(p).catch((err) => {
    toast(`打开失败：${err?.message || err}`);
  });
}

const handlers = {
  icons: (paths) => invoke('desktop_icons', { paths }),
  open: (path) => guardOpen(invoke('open_path', { path })),
  reveal: (path) => guardOpen(invoke('reveal_path', { path })),
  fold: (id) => {
    const f = new Set(S.cfg.organizer.folded || []);
    f.has(id) ? f.delete(id) : f.add(id);
    S.cfg.organizer.folded = [...f];
    renderPanel();
    save();
  },
  addGroup: async () => {
    const name = await promptInput('新建分组', '例如：设计素材');
    if (!name) return;
    await invoke('create_group', { name });
    await refreshDesktop();
  },
  /** 分组自身的右键菜单：改名、调顺序、打开目录、删除 */
  groupMenu: (e, gid) => {
    const groups = S.cfg.organizer.groups;
    const i = groups.findIndex((g) => g.id === gid);
    if (i < 0) return;
    const g = groups[i];

    showMenu({ x: e.clientX, y: e.clientY }, [
      { label: g.name, head: true },
      {
        label: '重命名…',
        act: async () => {
          const name = await promptInput('重命名分组', '新的分组名', g.name);
          if (!name || name === g.name) return;
          try {
            await invoke('rename_group', { id: gid, name });
            await refreshDesktop();
            toast(`已改名为「${name}」`);
          } catch (err) {
            toast(`重命名失败：${err?.message || err}`);
          }
        }
      },
      { label: '上移', disabled: i === 0, act: () => moveGroup(i, -1) },
      { label: '下移', disabled: i >= groups.length - 1, act: () => moveGroup(i, 1) },
      { sep: true },
      {
        label: '在资源管理器中打开',
        act: () => {
          const folder = S.view?.groups?.find((x) => x.id === gid)?.folder;
          if (folder) guardOpen(invoke('open_path', { path: folder }));
        }
      },
      { sep: true },
      {
        label: '删除分组（内容移回桌面）',
        act: async () => {
          const n = await invoke('delete_group', { id: gid });
          await refreshDesktop();
          toast(n ? `已移出 ${n} 项并删除分组` : '分组已删除');
        }
      }
    ]);
  },
  openRoot: () => guardOpen(invoke('open_root')),
  refresh: async () => {
    await invoke('desktop_icons', { paths: [] }).catch(() => {});
    await refreshDesktop();
  },
  moveInto: async (paths, group) => {
    const n = await invoke('move_into', { paths, group });
    await refreshDesktop();
    if (n) toast(`已收纳 ${n} 项`);
  },
  moveOut: async (paths) => {
    const n = await invoke('move_out', { paths });
    await refreshDesktop();
    if (n) toast(`已移出 ${n} 项到桌面`);
  },
  tidy: async () => {
    const preview = await invoke('tidy_preview');
    if (!preview.length) return toast('桌面已经没有可整理的项目');
    showMenu(
      menuAnchor(),
      [
        { label: '一键整理预览', head: true },
        ...preview.map((b) => ({ label: `${b.name} · ${b.count} 项`, disabled: true })),
        { sep: true },
        {
          label: `开始整理（共 ${preview.reduce((n, b) => n + b.count, 0)} 项）`,
          act: async () => {
            const n = await invoke('tidy_apply');
            await refreshDesktop();
            toast(`已收纳 ${n} 项`);
          }
        }
      ]
    );
  },
  menu: (e, path, group) => {
    const groups = S.cfg.organizer.groups.filter((g) => g.id !== group);
    showMenu(
      { x: e.clientX, y: e.clientY },
      [
        { label: decodeURIComponent(path.split(/[\\/]/).pop()), head: true },
        { label: '打开', act: () => guardOpen(invoke('open_path', { path })) },
        { label: '打开所在位置', act: () => guardOpen(invoke('reveal_path', { path })) },
        { sep: true },
        { label: '移出到桌面', act: () => handlers.moveOut([path]) },
        { sep: true },
        ...groups.slice(0, 6).map((g) => ({
          label: `收进「${g.name}」`,
          act: () => handlers.moveInto([path], g.id)
        }))
      ]
    );
  },
  dragStart: (on) => {
    S.force = on;
  },
  rerender: () => renderPanel()
};

function moveGroup(i, delta) {
  const arr = S.cfg.organizer.groups;
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  renderPanel();
  save();
  toast('分组顺序已调整');
}

function attachPanelChrome(el) {
  if (el.querySelector('.grip')) return;
  // renderOrganizer 每次都会重写 innerHTML，但面板元素本身不换，
  // 所以监听只在该元素上绑一次，否则重渲染几次就会拖出好几倍事件
  if (el.dataset.chrome === '1') return;
  el.dataset.chrome = '1';
  el.insertAdjacentHTML('beforeend', `<div class="grip" title="拖动改变面板大小"></div>`);
  const grip = el.querySelector('.grip');
  grip.addEventListener('pointerdown', (e) => {
    if (!S.edit) return;
    e.preventDefault();
    const o = S.cfg.organizer;
    const sx = e.clientX;
    const sy = e.clientY;
    const origin = { w: o.w, h: o.h || el.offsetHeight };
    S.force = true;
    const onMove = (ev) => {
      o.w = Math.round(clamp(origin.w + (ev.clientX - sx) / S.scale, 320, S.design.w - o.x));
      o.h = Math.round(clamp(origin.h + (ev.clientY - sy) / S.scale, 260, S.design.h - o.y));
      el.style.height = `${o.h}px`;
      el.style.width = `${o.w}px`;
      el.style.height = `${o.h}px`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      S.force = false;
      save();
      scheduleHit();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  el.addEventListener('pointerdown', (e) => {
    if (!S.edit) return;
    if (!e.target.closest('.org-head')) return;
    if (e.target.closest('.iconbtn')) return;
    const o = S.cfg.organizer;
    const sx = e.clientX;
    const sy = e.clientY;
    const origin = { x: o.x, y: o.y };
    S.force = true;
    const onMove = (ev) => {
      o.x = Math.round(clamp(origin.x + (ev.clientX - sx) / S.scale, 0, S.design.w - o.w));
      o.y = Math.round(clamp(origin.y + (ev.clientY - sy) / S.scale, 0, S.design.h - o.h));
      el.style.left = `${o.x}px`;
      el.style.top = `${o.y}px`;
      el.style.setProperty('--shot-x', `${-o.x}px`);
      el.style.setProperty('--shot-y', `${-o.y}px`);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      S.force = false;
      save();
      scheduleHit();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

/* ============================ 毛玻璃 ============================ */

function paintShotVars() {
  if (!S.shot) return;
  document.documentElement.style.setProperty('--shot', `url("${S.shot}")`);
  document.body.dataset.glass = '1';
  scheduleTone();
}

/** 有没有任何 surface 需要真实壁纸底图。
 *  全局材质决定收纳面板/弹层；卡片各有自己的材质，任一玻璃/暮色卡都要抓屏。
 *  全是无纹理的石墨时才省掉这一次抓屏。 */
function needsShot() {
  if (!S.cfg.glass) return false;
  if (S.cfg.material !== 'solid') return true; // 收纳面板跟随全局
  return (S.cfg.widgets || []).some((w) => {
    const m = w.material || S.cfg.material;
    return m === 'glass' || m === 'dusk';
  });
}

async function loadGlass() {
  if (!needsShot()) {
    document.body.dataset.glass = '0';
    toneImage = null;
    document.body.dataset.tone = '';
    return;
  }
  try {
    S.shot = await invoke('glass_snapshot');
    S.glassErr = '';
    paintShotVars();
  } catch (e) {
    S.glassErr = String(e?.message || e);
    console.warn('[fy] 抓屏失败，退回半透明填充', e);
    document.body.dataset.glass = '0';
  }
}

/* ---- 自适应明暗：采样底图，壁纸偏暗时让「玻璃」翻深色 + 浅字 ----
   0.8 曾整套删掉，因为那时候只有全局材质，暗壁纸会把玻璃翻成石墨，
   用户以为材质选择器坏了。v0.9 改成组件级材质后，采样只作用于玻璃卡
   （暮色/石墨由卡片自己的 data-material 决定，不受 tone 影响），老的
   矛盾不存在了，于是把 0.7 这套观感请回来。 */

let toneImage = null;
let tonePending = false;

function scheduleTone() {
  if (tonePending) return;
  tonePending = true;
  setTimeout(() => {
    tonePending = false;
    sampleTone();
  }, 220);
}

function sampleTone() {
  if (!S.shot) return;
  if (!toneImage) {
    toneImage = new Image();
    toneImage.src = S.shot;
    toneImage.onload = () => sampleTone();
    return;
  }
  if (!toneImage.complete || !toneImage.naturalWidth) return;

  const CW = 180;
  const CH = Math.max(1, Math.round((CW * S.design.h) / S.design.w));
  const cv = document.createElement('canvas');
  cv.width = CW;
  cv.height = CH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(toneImage, 0, 0, CW, CH);

  // 统一按整屏平均明暗决定色调：逐卡片判断会让同一块面板里出现明暗两套玻璃，
  // 视觉上拼不起来，宁可整体统一。
  const data = ctx.getImageData(0, 0, CW, CH).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  const avg = sum / (data.length / 4) / 255;
  const tone = avg < 0.52 ? 'dark' : 'light';
  if (document.body.dataset.tone !== tone) document.body.dataset.tone = tone;
}

/* ============================ 交互基础设施 ============================ */

let hitPending = false;

function scheduleHit() {
  if (hitPending) return;
  hitPending = true;
  requestAnimationFrame(() => {
    hitPending = false;
    updateHit();
  });
}

function updateHit() {
  const rects = [];
  const push = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return;
    rects.push([r.left * dpr(), r.top * dpr(), r.right * dpr(), r.bottom * dpr()]);
  };

  document.querySelectorAll('#stage .surface').forEach(push);
  const bar = $('#editbar');
  if (bar && !bar.hidden) push(bar);
  const menu = $('#menu');
  if (menu && !menu.hidden) push(menu);
  const trayMenu = $('#traymenu');
  if (trayMenu && !trayMenu.hidden) push(trayMenu.firstElementChild || trayMenu);

  const force = S.edit || S.force || !!S.gallery || !!S.about || S.trayMenu || (menu && !menu.hidden);
  invoke('set_hit_regions', { rects, force: !!force }).catch(() => {});
}

function save() {
  clearTimeout(save._t);
  save._t = setTimeout(() => {
    invoke('save_config', { config: S.cfg }).catch((e) => console.error('[fy] 保存失败', e));
  }, 320);
}

function setEdit(on) {
  S.edit = on;
  document.body.dataset.edit = on ? '1' : '0';
  $('#editbar').hidden = !on;
  updateHit();
}

function openGal() {
  if (S.gallery) return;
  S.gallery = openGallery($('#gallery'), {
    cfg: S.cfg,
    onAdd: (kind, size, material) => addWidget(kind, size, material),
    onClose: () => {
      S.gallery = null;
      updateHit();
    },
    onChange: (patch) => setGlobalMaterial(patch.material),
  });
  updateHit();
}

/* ---- 关于 ---- */
function openAboutPanel() {
  if (S.about) return;
  S.about = openAbout($('#about'), {
    version: S.version,
    cfg: S.cfg,
    onClose: () => {
      S.about = null;
      updateHit();
    },
    onAutoUpdate: (on) => {
      S.cfg.auto_update = on;
      save();
      toast(on ? '已开启自动更新检查' : '已关闭自动更新检查');
    }
  });
  updateHit();
}

/* ---- 上下文菜单 ---- */
function menuAnchor() {
  const el = $('#organizer');
  const r = el.getBoundingClientRect();
  return { x: r.right - 160, y: r.bottom - 40 };
}

function showMenu(anchor, items) {
  const menu = $('#menu');
  menu.innerHTML = items
    .map((it) => {
      if (it.sep) return '<div class="sep"></div>';
      if (it.head) return `<div class="lab">${escapeHtml(it.label)}</div>`;
      return `<button data-i="${items.indexOf(it)}" ${it.disabled ? 'disabled style="opacity:.5"' : ''}>${escapeHtml(it.label)}</button>`;
    })
    .join('');
  menu.hidden = false;

  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.min(anchor.x, window.innerWidth - w - 8)}px`;
  menu.style.top = `${Math.min(anchor.y, window.innerHeight - h - 8)}px`;

  menu.onclick = async (e) => {
    const i = e.target.closest('[data-i]')?.dataset.i;
    if (i == null) return;
    const item = items[Number(i)];
    hideMenu();
    if (item?.act) await item.act();
  };
  updateHit();
}

function hideMenu() {
  $('#menu').hidden = true;
  updateHit();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---- 弹层 ----
 *
 * 窗口平时是「按热区穿透」的：只有卡片和面板所在矩形接收鼠标，其余位置直接
 * 交给桌面。弹层挂到页面中央，那块区域不在任何热区里，所以鼠标一点就穿到
 * 桌面上去了——表现就是「输入框还在，但再也打不了字」。
 * 因此弹层打开期间必须把 force 打开，让整窗接管鼠标，关闭时再还原。
 */
function modal(title, bodyHtml, opts = {}) {
  return new Promise((resolve) => {
    const wasForce = S.force;
    S.force = true;
    updateHit();

    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">
          <span>${escapeHtml(title)}</span>
          <button class="modal-x" data-x title="关闭 (Esc)" aria-label="关闭">
            <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
          </button>
        </div>
        ${bodyHtml}
        <div class="modal-foot">
          <button class="ebtn" data-close>${escapeHtml(opts.cancelText || '取消')}</button>
          ${opts.okText ? `<button class="ebtn primary" data-ok>${escapeHtml(opts.okText)}</button>` : ''}
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const disposeDrag = makeDraggable(
      wrap.querySelector('.modal-card'),
      wrap.querySelector('.modal-title'),
      'modal'
    );

    const close = (v) => {
      disposeDrag();
      wrap.remove();
      S.force = wasForce;
      updateHit();
      resolve(v);
    };

    // 点遮罩 = 取消。浮层打开期间整窗接管鼠标（见函数头注释），
    // 遮罩若不吃这一下，桌面就完全点不动了；判定「按下也在遮罩上」才关，
    // 从窗口里拖出去松手不会误关。
    closeOnBackdrop(wrap, () => close(null));
    wrap.querySelector('[data-close]').onclick = () => close(null);
    wrap.querySelector('[data-x]').onclick = () => close(null);
    wrap.querySelector('[data-ok]')?.addEventListener('click', () => close(opts.onOk?.(wrap) ?? null));
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
    });

    opts.mount?.(wrap, close);
  });
}

/* ---- 输入框（Tauri 里没有 window.prompt） ---- */
function promptInput(title, placeholder, value = '') {
  return modal(
    title,
    `<input class="modal-input" placeholder="${escapeHtml(placeholder || '')}" value="${escapeHtml(value)}" />`,
    {
      okText: '确定',
      onOk: (wrap) => wrap.querySelector('.modal-input').value.trim() || null,
      mount: (wrap, close) => {
        const input = wrap.querySelector('.modal-input');
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') close(input.value.trim() || null);
        });
      }
    }
  );
}

/* ---- 天气地区选择：支持省 / 市 / 区县 ---- */
function pickPlace() {
  return modal(
    '设置天气地区',
    `<div class="modal-hint">支持省 / 市 / 区县，如「西湖区」。回车搜索。</div>
     <div class="modal-row">
       <input class="modal-input" placeholder="输入地名" value="${escapeHtml(S.cfg.weather?.city || '')}" />
       <button class="ebtn primary" data-search>搜索</button>
     </div>
     <div class="place-list" hidden></div>`,
    {
      okText: '',
      mount: (wrap, close) => {
        const input = wrap.querySelector('.modal-input');
        const list = wrap.querySelector('.place-list');

        const search = async () => {
          const q = input.value.trim();
          if (!q) return;
          list.hidden = false;
          list.innerHTML = `<div class="place-tip">搜索中…</div>`;
          let rows = [];
          try {
            rows = await invoke('geo_search', { q });
          } catch (err) {
            list.innerHTML = `<div class="place-tip">搜索失败：${escapeHtml(String(err?.message || err))}</div>`;
            return;
          }
          if (!rows.length) {
            list.innerHTML = `<div class="place-tip">没找到「${escapeHtml(q)}」。试试只留区县名，如「西湖区」</div>`;
            return;
          }
          list.innerHTML = rows
            .map(
              (p, i) => `<button class="place-item" data-i="${i}">
                <b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.label)}</span></button>`
            )
            .join('');
          list.querySelectorAll('.place-item').forEach((btn) => {
            btn.onclick = async () => {
              const p = rows[Number(btn.dataset.i)];
              close(null);
              try {
                await invoke('set_weather_place', {
                  label: p.label,
                  name: p.name,
                  lat: p.lat,
                  lon: p.lon
                });
                toast(`天气地区已改为「${p.name}」`);
              } catch (err) {
                toast(`设置失败：${err?.message || err}`);
              }
            };
          });
        };

        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            search();
          }
        });
        wrap.querySelector('[data-search]').onclick = search;
      }
    }
  );
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2000);
}

/* ============================ 全局事件 ============================ */

function bindGlobalEvents() {
  $('#editbar').onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') openGal();
    if (act === 'done') setEdit(false);
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (S.about) return S.about.close();
      if (S.gallery) return S.gallery.close();
      if (!$('#menu').hidden) return hideMenu();
      if (S.edit) setEdit(false);
    }
    // 编辑模式下 Delete 移除最后一个选中的组件
    if (S.edit && (e.key === 'Delete' || e.key === 'Backspace') && document.activeElement?.tagName !== 'TEXTAREA') {
      const hit = document.querySelector('.card:focus-within');
      if (hit) removeWidget(hit.dataset.id);
    }
  });

  // 右键空白处关闭菜单
  document.addEventListener('pointerdown', (e) => {
    if (!$('#menu').hidden && !e.target.closest('#menu')) hideMenu();
  });

  window.addEventListener('resize', () => {
    layoutStage();
    updateHit();
  });

  // 后端数据
  S.counters = { metrics: 0, weather: 0, desktop: 0 };

  listen('metrics', (e) => {
    S.counters.metrics++;
    S.metrics = e.payload;
    for (const m of S.mounted.values()) m.inst?.metrics?.(e.payload);
  });

  listen('weather', (e) => applyWeather(e.payload));
  listen('weather:error', () => {
    for (const m of S.mounted.values()) m.inst?.weatherError?.();
  });

  listen('desktop:changed', () => refreshDesktop());

  // 启动时后台检查到新版本：只提示一句，不弹窗抢焦点
  listen('update:available', (e) => {
    if (e.payload?.has_update) toast(updateHint(e.payload));
  });

  // 干净截图时后端会重抓一张不含其它窗口的底图，这里直接换掉
  listen('glass:update', (e) => {
    if (!e.payload) return;
    S.shot = e.payload;
    paintShotVars();
  });

  listen('tray:action', (e) => {
    if (e.payload === 'gallery') openGal();
    if (e.payload === 'about') openAboutPanel();
    if (e.payload === 'edit') setEdit(!S.edit);
    if (e.payload === 'place') pickPlace();
    if (e.payload === 'glass') {
      loadGlass();
    }
  });

  // ---- 托盘自绘菜单 ----
  // 原生 Win32 托盘菜单的字体和配色是系统样式，没法跟随材质、也用不上
  // 组件的 MiSans。托盘点击只把图标位置发过来（tray:open-menu），
  // 菜单本体在 #traymenu：配色走 --pop-*（跟着全局材质变），
  // 字体走 --font（跟组件一致）。动作复用现有命令与面板。
  listen('tray:open-menu', (e) => {
    if (e.payload && typeof e.payload.x === 'number') openTrayMenu(e.payload);
  });

  const trayHost = $('#traymenu');
  let trayMenuOpen = false;

  const closeTrayMenu = () => {
    if (!trayMenuOpen) return;
    trayMenuOpen = false;
    trayHost.hidden = true;
    S.trayMenu = false;
    S.force = false;
    document.removeEventListener('mousedown', trayOutside, true);
    document.removeEventListener('keydown', trayEsc, true);
    // 通知后端停止「菜单外点击」监听
    invoke('set_menu_rect', { rect: null }).catch(() => {});
    updateHit();
  };

  // 注意判的是 .tm 菜单盒，不是 trayHost：#traymenu 是铺满全屏的容器，
  // 用 contains(trayHost) 的话任何点击都算「在菜单里」，菜单永远收不回去。
  const trayOutside = (e) => {
    const box = trayHost.querySelector('.tm');
    if (!box || !box.contains(e.target)) closeTrayMenu();
  };
  const trayEsc = (e) => {
    if (e.key === 'Escape') closeTrayMenu();
  };

  /** 把菜单盒的物理矩形报给后端：左键落在它外面（包括点在别的应用、任务栏上）
   *  时后端推 menu:outside，把菜单收起。前端 mousedown 只能覆盖我们自己窗口内的点击。 */
  const syncMenuRect = () => {
    const box = trayHost.querySelector('.tm');
    if (!trayMenuOpen || !box) {
      invoke('set_menu_rect', { rect: null }).catch(() => {});
      return;
    }
    const r = box.getBoundingClientRect();
    const d = dpr();
    invoke('set_menu_rect', {
      rect: [r.left * d, r.top * d, r.right * d, r.bottom * d]
    }).catch(() => {});
  };

  function openTrayMenu(rect) {
    closeTrayMenu();
    const tick = '<span class="tm-tick" aria-hidden="true">✓</span>';
    trayHost.innerHTML = `<div class="tm" role="menu">
      <button class="tm-item" data-act="gallery" role="menuitem">${tick}添加组件…</button>
      <button class="tm-item" data-act="glass" role="menuitem">${tick}刷新桌面底图</button>
      <button class="tm-item" data-act="place" role="menuitem">${tick}天气地区…</button>
      <button class="tm-item check" data-act="autostart" aria-checked="${!!S.cfg.autostart}" role="menuitemcheckbox">${tick}开机自启</button>
      <button class="tm-item check" data-act="seconds" aria-checked="${S.cfg.show_seconds !== false}" role="menuitemcheckbox">${tick}时钟显示秒</button>
      <div class="tm-sep"></div>
      <button class="tm-item" data-act="root" role="menuitem">${tick}打开收纳文件夹</button>
      <button class="tm-item" data-act="conf" role="menuitem">${tick}设置文件…</button>
      <div class="tm-sep"></div>
      <button class="tm-item" data-act="about" role="menuitem">${tick}关于 fy-desktop…</button>
      <button class="tm-item danger" data-act="quit" role="menuitem">${tick}退出 fy-desktop</button>
    </div>`;

    // 定位：贴着托盘图标弹。rect 是图标的物理坐标，换算成 CSS 像素。
    const d = dpr();
    const iconRight = (rect.x + (rect.w || 0)) / d;
    const iconTop = rect.y / d;
    const iconBottom = (rect.y + (rect.h || 0)) / d;
    const tm = trayHost.firstElementChild;
    if (iconTop > window.innerHeight / 2) {
      // 底部任务栏（绝大多数场景）：菜单向上弹，底边贴图标顶
      tm.style.top = '';
      tm.style.bottom = `${Math.max(8, window.innerHeight - iconTop + 8)}px`;
    } else {
      // 顶部任务栏：向下弹
      tm.style.bottom = '';
      tm.style.top = `${iconBottom + 8}px`;
    }
    tm.style.right = `${Math.max(8, window.innerWidth - iconRight + 4)}px`;

    trayMenuOpen = true;
    trayHost.hidden = false;
    S.trayMenu = true;
    // 菜单开着时整窗必须可点（平时穿透）：updateHit 的 force 会放行
    S.force = true;
    updateHit();
    // 托盘点击本身不在文档流里，mousedown 监听下一拍再挂也无妨；
    // 用捕获阶段，防止菜单内按钮的 mousedown 冒泡误关
    setTimeout(() => document.addEventListener('mousedown', trayOutside, true), 0);
    document.addEventListener('keydown', trayEsc, true);
    // 等菜单完成布局再量矩形，交给后端做「全局点击」判定
    requestAnimationFrame(syncMenuRect);
  }

  listen('menu:outside', () => closeTrayMenu());

  // 调试：FY_UI=traymenu 直接弹出托盘菜单，再点一下菜单外面，
  // 验证「点其它地方收回」。结果写进 S.trayProbe。
  if (S.uitest === 'traymenu')
    setTimeout(() => {
      openTrayMenu({
        x: (window.innerWidth - 140) * dpr(),
        y: (window.innerHeight - 120) * dpr(),
        w: 40 * dpr(),
        h: 40 * dpr()
      });
      setTimeout(() => {
        const box = trayHost.querySelector('.tm');
        if (!box) return;
        const r = box.getBoundingClientRect();
        const x = Math.max(1, r.left - 30);
        const y = Math.max(1, r.top + 20);
        const target = document.elementFromPoint(x, y) || document.body;
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
        S.trayProbe = { closedByOutside: trayHost.hidden };
        setTimeout(() => dumpLayout(), 200);
      }, 700);
    }, 500);

  trayHost.addEventListener('click', async (e) => {
    if (!trayMenuOpen) return;
    const btn = e.target.closest('.tm-item');
    if (!btn) return;
    const act = btn.dataset.act;
    switch (act) {
      case 'gallery':
        closeTrayMenu();
        openGal();
        break;
      case 'glass':
        closeTrayMenu();
        loadGlass();
        break;
      case 'place':
        closeTrayMenu();
        pickPlace();
        break;
      case 'about':
        closeTrayMenu();
        openAboutPanel();
        break;
      case 'root':
        closeTrayMenu();
        invoke('open_root').catch(() => {});
        break;
      case 'conf':
        closeTrayMenu();
        invoke('open_config_dir').catch(() => {});
        break;
      case 'quit':
        invoke('quit_app');
        break;
      case 'autostart': {
        // 勾选切换不关菜单，和原生勾选菜单的行为一致
        try {
          const after = await invoke('set_autostart', { on: !S.cfg.autostart });
          S.cfg.autostart = !!after;
          btn.setAttribute('aria-checked', String(!!after));
          save();
        } catch {}
        break;
      }
      case 'seconds': {
        const next = !(S.cfg.show_seconds !== false);
        S.cfg.show_seconds = next;
        setShowSeconds(next);
        for (const inst of S.mounted.values()) inst?.tick?.();
        btn.setAttribute('aria-checked', String(next));
        save();
        break;
      }
    }
  });

  // 托盘切换「时钟显示秒」：改全局开关后手动 tick 一次，不必重建卡片。
  // 注意回调拿到的是事件对象，开关值在 payload 里——直接 `!!on` 会永远是 true，
  // 这正是「关掉了却还在显示秒」的原因。
  listen('clock:seconds', (e) => {
    const on = !!e.payload;
    S.cfg.show_seconds = on;
    setShowSeconds(on);
    for (const inst of S.mounted.values()) inst?.tick?.();
  });

  // 从资源管理器拖文件进来：按落点判断要收进哪个格子
  const onDragPos = (payload) => {
    const p = payload?.position || payload;
    if (!p || typeof p.x !== 'number') return null;
    return { x: p.x / dpr(), y: p.y / dpr() };
  };

  listen('tauri://drag-enter', () => {
    S.force = true;
    updateHit();
  });

  listen('tauri://drag-leave', () => {
    S.force = false;
    updateHit();
  });

  listen('tauri://drag-drop', async (e) => {
    S.force = false;
    const paths = e.payload?.paths || [];
    const pos = onDragPos(e.payload);
    if (!paths.length || !pos) return;
    const gid = groupAtPoint($('#organizer'), pos.x, pos.y);
    if (!gid) return;
    await handlers.moveInto(paths, gid);
  });

  // 每 500ms 兜一次热区，防止某些布局变化没触发上报
  setInterval(updateHit, 500);

  loadWeatherOnce();
}

async function loadWeatherOnce() {
  try {
    const w = await invoke('weather_now');
    if (w) applyWeather(w);
    else invoke('weather_refresh');
  } catch {
    /* 天气失败不影响主流程 */
  }
}

function applyWeather(w) {
  S.counters.weather = (S.counters.weather || 0) + 1;
  S.weather = w;
  for (const m of S.mounted.values()) m.inst?.weather?.(w);
}

function dumpLayout() {
  const json = JSON.stringify(
    {
      inner: [innerWidth, innerHeight],
      dpr: dpr(),
      scale: S.scale,
      design: S.design,
      widgets: [...document.querySelectorAll('#stage .card')].map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return [el.dataset.kind, el.dataset.size, el.dataset.material || '',
          Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height),
          cs.backgroundColor, cs.color];
      }),
      organizer: (() => {
        const r = $('#organizer').getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      })(),
      glass: document.body.dataset.glass === '1',
      // 材质的三个来源必须一致：DOM 属性（CSS 用）、内存配置、磁盘配置
      mat: {
        attr: document.body.dataset.material,
        cfg: S.cfg.material,
        tone: document.body.dataset.tone || '',
        shot: !!S.shot,
        glassErr: S.glassErr || '',
        fill: (() => {
          const s = document.querySelector('#stage .surface');
          return s ? getComputedStyle(s).backgroundColor : '';
        })()
      },
      // 日历卡与时钟卡在最小尺寸下的内部盒子：核对内容是「刚好塞下」还是「溢出被裁」
      probe: (() => {
        const out = {};
        for (const kind of ['calendar', 'clock']) {
          const card = document.querySelector(`#stage .card[data-kind="${kind}"]`);
          if (!card) continue;
          const body = card.querySelector('.body');
          const box = (sel) => {
            const el = card.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
          };
          out[kind] = {
            body: box('.body'),
            bodyScroll: [body?.clientWidth, body?.clientHeight, body?.scrollWidth, body?.scrollHeight],
            grid: box('.cd-grid'),
            week: box('.cd-week'),
            side: box('.ck-side'),
            dial: box('.ck-dial')
          };
        }
        return out;
      })(),
      net: (() => {
        const card = document.querySelector('#stage .card[data-kind="network"]');
        if (!card) return null;
        const box = (sel) => {
          const el = card.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
        };
        return {
          top: box('.net-top'),
          mid: box('.net-mid'),
          main: box('.net-main'),
          num: box('.net-num b'),
          spark: box('.net-spark'),
          foot: box('.net-foot'),
          text: card.querySelector('.down')?.textContent,
          bodyH: card.querySelector('.body')?.clientHeight
        };
      })(),
      counters: S.counters || {},
      // 弹层调试：菜单到底有没有渲染出来（FY_UI=menu 时靠这个判断）
      menu: {
        hidden: $('#menu')?.hidden,
        items: $('#menu')?.querySelectorAll('button').length || 0,
        text: $('#menu')?.innerText?.slice(0, 200) || ''
      },
      // 浮层调试：窗口是否还在、拖到哪了、配色是否跟着全局材质
      floats: {
        body: document.body.dataset.material,
        gallery: {
          hidden: $('#gallery')?.hidden,
          mat: $('#gallery .gal')?.dataset.mat || '',
          transform: $('#gallery .gal')?.style.transform || '',
          bg: $('#gallery .gal') ? getComputedStyle($('#gallery .gal')).backgroundColor : ''
        },
        about: {
          hidden: $('#about')?.hidden,
          transform: $('#about .ab')?.style.transform || '',
          bg: $('#about .ab') ? getComputedStyle($('#about .ab')).backgroundColor : ''
        },
        modal: {
          count: document.querySelectorAll('.modal').length,
          transform: document.querySelector('.modal-card')?.style.transform || '',
          bg: document.querySelector('.modal-card') ? getComputedStyle(document.querySelector('.modal-card')).backgroundColor : ''
        }
      },
      probe: { float: S.floatProbe || null, mat: S.matProbe || null, tray: S.trayProbe || null },
      err: S.err || '',
      bridge: dbg,
      shot: !!S.shot
    },
    null,
    1
  );
  invoke('dev_dump', { json }).catch(() => {});
}

boot().catch((e) => {
  console.error('[fy] 启动失败', e);
  document.body.innerHTML = `
    <div style="position:fixed;inset:0;display:grid;place-items:center;background:rgba(20,14,10,.92);color:#ffd9c7;
                font:12.5px/1.7 ui-monospace,Consolas,monospace;padding:40px">
      <div style="max-width:720px">
        <div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:10px">fy-desktop 启动失败</div>
        <div style="color:#ffb08a;margin-bottom:10px">${escapeHtml(e?.message || String(e))}</div>
        <pre style="white-space:pre-wrap;color:#e8cfc2;margin:0">${escapeHtml(e?.stack || '')}</pre>
      </div>
    </div>`;
});
