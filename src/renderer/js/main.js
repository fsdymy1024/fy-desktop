/**
 * 主流程：启动 → 布局 → 渲染组件 → 玻璃底图 → 事件订阅 → 交互。
 *
 * 坐标系只有一套：设计像素。屏幕实际像素 = 设计像素 × scale，
 * 所以后端报上来的热区要乘 devicePixelRatio，拖拽位移要除以 scale。
 */

import { invoke, invokeRetry, listen, unlistenAll } from './bridge.js';
import { REGISTRY, setShowSeconds, SIZE_LABEL, dimsOf, GAP } from './widgets.js';
import { renderOrganizer, groupAtPoint, resetLoose, clearIconCache } from './organizer.js';
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
  version: '',
  shotMode: false,
  /// 分组配色由后端下发（boot.palette），前端不再自己写一份
  palette: []
};

/* 吸附网格。网格粒度 = 最小缝隙 GAP = 6（widgets.js 导出，和尺寸同源）：
 * 三档尺寸（102 / 210 / 126）全是它的整数倍，邻卡之间也固定留 GAP，
 * 所以无论拖动吸附还是自动补位，卡片缝隙都只可能是 6 或它的整数倍。 */
const GRID = GAP;
const SNAP_TOL = 6;

/** 点一下就打开 Windows 自带的对应界面。没列出的组件点了不做事。
 *  值是后端 open_system 的白名单键，前端不拼命令行。 */
const SYSTEM_TARGETS = {
  system: 'taskmgr',
  network: 'network',
  clock: 'clock',
  digital: 'clock'
};
const SYSTEM_TARGET_LABEL = {
  taskmgr: '任务管理器',
  network: '网络和 Internet 设置',
  clock: '时钟'
};

/* ============================ 启动 ============================ */

// 截图模式下把未捕获异常记下来，随 dump 一起落盘
window.addEventListener('error', (e) => {
  S.err = `${e.message} @${e.filename}:${e.lineno}`;
});
window.addEventListener('unhandledrejection', (e) => {
  S.err = `reject: ${e.reason?.message || e.reason}`;
});

async function boot() {
  // 页面可能比后端 setup() 里的 manage() 先到，这类失败重试即可（见 bridge.js）
  const b = await invokeRetry('boot');
  S.uitest = b.uitest || '';
  S.cfg = b.config;
  S.design = { w: b.design[0], h: b.design[1] };
  S.scale = b.scale || 1;
  S.version = b.version || '';
  S.shotMode = !!b.shot;
  S.palette = Array.isArray(b.palette) ? b.palette : [];

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

  // 截图 / 自检的调试分支统一收进 debug.js，只在需要时动态加载：
  // 正常运行时这些代码既不会执行也不会被解析，main.js 只留业务流程。
  if (S.shotMode || S.uitest) loadDebug();
}

/** 动态加载调试探针（FY_SHOT / FY_UI）。失败只影响自检，不影响正常使用。 */
function loadDebug() {
  import('./debug.js')
    .then((m) => {
      const api = m.installDebug(S, {
        pickPlace,
        setEdit,
        openGal,
        openAboutPanel,
        promptInput,
        loadGlass
      });
      // 托盘菜单探针还留在本文件（它要复用闭包里的 trayMenuOpen 等状态），
      // 落盘能力由 debug.js 回传
      dumpHook = api?.dump || null;
    })
    .catch((e) => console.warn('[fy] 调试探针加载失败', e));
}

function layoutStage() {
  const stage = $('#stage');
  stage.style.width = `${S.design.w}px`;
  stage.style.height = `${S.design.h}px`;
  stage.style.transform = `scale(${S.scale})`;
  document.documentElement.style.setProperty('--shot-w', `${S.design.w}px`);
  document.documentElement.style.setProperty('--shot-h', `${S.design.h}px`);
  // 缩放档位变了，底图被放大的倍数跟着变，模糊半径要重算
  applyShotBlur();
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
  save();
  // 只切材质不是换壁纸：底图还在就直接用，不必再整屏抓一次
  ensureGlass();
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
    inst = def.mount(body, {
      id: w.id,
      // 备忘录正文存进 config.json（随配置落盘），不再依赖 WebView 的 localStorage
      getNote: () => S.cfg.notes?.[w.id] ?? '',
      setNote: (text) => {
        if (!S.cfg.notes) S.cfg.notes = {};
        if (text) S.cfg.notes[w.id] = text;
        else delete S.cfg.notes[w.id];
        // 正文单独落盘，不等 320ms 的整份回传：关窗/崩溃也不丢最后几个字。
        // 命令不可用时退回整份回传。
        invoke('set_note', { id: w.id, text }).catch(() => save());
      }
    });
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
  // 键盘可达：Tab 能聚焦卡片，Shift+F10 / 菜单键代替右键唤出设置
  const def = REGISTRY[w.kind] || { name: w.kind };
  el.tabIndex = 0;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', `${def.name}组件`);
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    openCardMenu(el, w, r.left + 16, r.top + 16);
  });

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

  // 双击天气卡直接改地区：这是最常用的设置，不该藏进托盘。
  // v1.1 起弹层统一由控制中心承载，和「设置 → 天气地区」是同一套 UI 与逻辑。
  if (w.kind === 'weather') {
    el.addEventListener('dblclick', () => openHub('settings', { type: 'weather', compact: true }));
  }

  // 单击系统监视 / 网络 / 时钟：打开 Windows 自带的对应界面。
  // 编辑态不触发（那时点击是拖动），卡片里的输入控件也不劫持。
  const sysTarget = SYSTEM_TARGETS[w.kind];
  if (sysTarget) {
    el.dataset.opener = '1';
    el.title = `点击打开${SYSTEM_TARGET_LABEL[sysTarget] || '系统界面'}`;
    const openSys = () =>
      invoke('open_system', { target: sysTarget }).catch((err) =>
        toast(`打开${SYSTEM_TARGET_LABEL[sysTarget] || '系统界面'}失败：${err?.message || err}`)
      );
    el.addEventListener('click', (e) => {
      if (S.edit) return;
      if (e.target.closest('textarea, input, button, select, a, [contenteditable="true"]')) return;
      openSys();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || S.edit) return;
      e.preventDefault();
      openSys();
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
      label: `${SIZE_LABEL[k]}　${sw}×${sh}`,
      disabled: k === cur,
      checked: k === cur,
      act: () => setCardSize(el, w, k)
    });
  }

  // 材质：每张卡自己记，改一张不影响别的卡
  items.push({ sep: true });
  const curMat = w.material || S.cfg.material || 'glass';
  items.push({ head: true, label: `材质 · ${{ glass: '玻璃', dusk: '暮色', solid: '石墨' }[curMat] || curMat}` });
  for (const [k, label] of [['glass', '玻璃'], ['dusk', '暮色'], ['solid', '石墨']]) {
    items.push({
      label,
      disabled: k === curMat,
      checked: k === curMat,
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
 *  吸附时要靠它判断「往邻卡后面接」还是「同向对齐」。
 *  拖收纳面板自己时传 withOrg = false：否则面板会去贴它自己的三条边，动不了。 */
function refLines(exceptId, withOrg = true) {
  const xs = [];
  const ys = [];
  for (const o of S.cfg.widgets) {
    if (o.id === exceptId) continue;
    xs.push({ v: o.x, kind: 'left' }, { v: o.x + o.w / 2, kind: 'center' }, { v: o.x + o.w, kind: 'right' });
    ys.push({ v: o.y, kind: 'top' }, { v: o.y + o.h / 2, kind: 'center' }, { v: o.y + o.h, kind: 'bottom' });
  }
  const org = S.cfg.organizer;
  if (withOrg && org && org.enabled !== false) {
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
  // 组件没了，正文也别一直躺在配置里（后端 normalize 也会再清一次）
  if (S.cfg.notes) delete S.cfg.notes[id];
  renderWidgets();
  save();
  toast(`已移除「${REGISTRY[w.kind]?.name || w.kind}」`);
}

function freeSpot(w, h) {
  // pad 与步进都取 GAP 的整数倍，扫出来的坐标才能和已有卡片的边缘对齐，
  // 缝隙才会是 GAP 而不是 4px、12px 这种歪数。
  const pad = 4 * GRID;
  // 收纳面板还在时，新卡片不越过它的左边缘；面板被移除后整屏都是可用区
  const org = S.cfg.organizer;
  const orgEdge = org && org.enabled !== false ? org.x : S.design.w;
  const limitX = Math.max(pad + w, orgEdge - 20);
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

  // 面板被移除（organizer.enabled = false）：整块藏起来，不画热区、不参与拖放命中。
  // 内容留着不清，从控制中心加回来时直接显形，chrome 监听也不用重新绑。
  if (o && o.enabled === false) {
    el.hidden = true;
    scheduleHit();
    return;
  }
  el.hidden = false;
  el.className = 'panel surface';
  el.style.left = `${o.x}px`;
  el.style.top = `${o.y}px`;
  el.style.width = `${o.w}px`;
  // h=0 表示高度跟内容走；用户拖过之后才固定
  el.style.height = o.h ? `${o.h}px` : 'auto';
  el.style.setProperty('--shot-x', `${-o.x}px`);
  el.style.setProperty('--shot-y', `${-o.y}px`);

  // 调色板随后端下发；handlers 里没带时 organizer.js 用自己的兜底
  renderOrganizer(el, S.cfg, S.view, { ...handlers, palette: S.palette });
  attachPanelChrome(el);
  paintShotVars();
  scheduleHit();
}

/** 桌面收纳面板的显示开关：只关显示，分组与磁盘上的文件原样保留。
 *  控制中心「分组」页那个开关也是通过 hub_action 走到这里，所以不加 toast ——
 *  用户看的是控制中心，桌面上再飘一条反而碍事。 */
function setOrganizer(on) {
  const o = S.cfg.organizer;
  if (!o || (o.enabled !== false) === !!on) return;
  o.enabled = !!on;
  renderPanel();
  save();
}

/** 面板右键「移除桌面收纳」：这一步发生在桌面上，给一条反馈。 */
function removeOrganizer() {
  const o = S.cfg.organizer;
  if (!o || o.enabled === false) return;
  setOrganizer(false);
  toast('已移除桌面收纳，可在控制中心「分组」页加回来');
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
  /** 顶部按钮：一次折叠/展开所有分组（已经全折起来了就反过来全展开） */
  foldAll: () => {
    const ids = S.cfg.organizer.groups.map((g) => g.id);
    const cur = new Set(S.cfg.organizer.folded || []);
    S.cfg.organizer.folded = ids.length && ids.every((id) => cur.has(id)) ? [] : ids;
    renderPanel();
    save();
  },
  /** 面板顶部 / 空白处右键：跟组件右键菜单同一套结构（标题 · 材质 · 动作），
   *  但面板没有尺寸档位，所以不出「尺寸」和「调整布局」这两段。 */
  panelMenu: (e) => {
    const o = S.cfg.organizer;
    const groups = S.view?.groups ?? o.groups ?? [];
    const total = groups.reduce((n, g) => n + (g.items?.length || 0), 0);
    const ids = o.groups.map((g) => g.id);
    const cur = new Set(o.folded || []);
    const allFolded = ids.length > 0 && ids.every((id) => cur.has(id));
    const curMat = S.cfg.material || 'glass';

    const items = [{ head: true, label: `桌面收纳 · ${groups.length} 组 · ${total} 项` }];

    // 面板没有自己的材质字段，材质只有全局一份：这里改的是全局，
    // 和组件库里的材质按钮、卡片右键的「材质」都是同一套值。
    items.push({ sep: true });
    items.push({ head: true, label: `材质 · ${{ glass: '玻璃', dusk: '暮色', solid: '石墨' }[curMat] || curMat}` });
    for (const [k, label] of [['glass', '玻璃'], ['dusk', '暮色'], ['solid', '石墨']]) {
      items.push({
        label,
        disabled: k === curMat,
        checked: k === curMat,
        act: () => setGlobalMaterial(k)
      });
    }

    items.push({ sep: true });
    items.push({ label: allFolded ? '全部展开' : '全部折叠', act: () => handlers.foldAll() });
    items.push({ label: '新建分组…', act: () => handlers.addGroup() });
    items.push({ label: '在资源管理器中打开', act: () => handlers.openRoot() });
    items.push({ label: '刷新', act: () => handlers.refresh() });
    // 移除只关掉这块面板，分组和文件原样留在磁盘上，随时能从控制中心加回来
    items.push({ sep: true });
    items.push({ label: '移除桌面收纳', act: () => removeOrganizer() });

    showMenu({ x: e.clientX, y: e.clientY }, items);
  },
  addGroup: () => {
    // 命名弹层搬进了控制中心：和天气地区同一套输入框，不再需要整窗接管鼠标
    openHub('groups', { type: 'groupCreate', compact: true });
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
        act: () => openHub('groups', { type: 'groupRename', id: gid, name: g.name, compact: true })
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
          try {
            const n = await invoke('delete_group', { id: gid });
            await syncConfig();
            await refreshDesktop();
            toast(n ? `已移出 ${n} 项并删除分组` : '分组已删除');
          } catch (e) {
            toast(`删除失败：${e?.message || e}`);
          }
        }
      }
    ]);
  },
  openRoot: () => guardOpen(invoke('open_root')),
  refresh: async () => {
    // 「刷新」= 前端图标缓存清空 + 后端过期缓存清理 + 重新扫描。
    // 以前 clearIconCache / clear_cache 都定义了却没有任何调用方，
    // 换了图标只能重启程序才看得到。
    clearIconCache();
    resetLoose();
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
        // 「待整理」里的东西本来就在桌面上，移出没有意义（后端也会拒绝越界移动）
        ...(group === '__loose'
          ? []
          : [{ label: '移出到桌面', act: () => handlers.moveOut([path]) }, { sep: true }]),
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

/** 分组顺序交给后端改。
 *  以前是前端交换数组再整份回传：配合 320ms 防抖，很容易和「建/删分组」
 *  这类后端命令互相覆盖。改成命令式之后顺序只有一个写入方。 */
async function moveGroup(i, delta) {
  const arr = S.cfg.organizer.groups;
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  try {
    await invoke('move_group', { id: arr[i].id, delta });
  } catch (e) {
    return toast(`调整顺序失败：${e?.message || e}`);
  }
  await syncConfig();
  renderPanel();
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
      // 宽高也落 6px 网格：面板边缘才能和卡片边缘落在同一条线上
      o.w = onGrid(clamp(origin.w + (ev.clientX - sx) / S.scale, 320, S.design.w - o.x));
      o.h = onGrid(clamp(origin.h + (ev.clientY - sy) / S.scale, 260, S.design.h - o.y));
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
    // h=0 表示高度跟内容走，此时配置里没有真实高度，得读一次布局
    const oh = o.h || el.offsetHeight || 0;
    // 和卡片同一套吸附：先贴邻卡的边（含其它卡片），贴不上再落 6px 网格
    const { xs, ys } = refLines(null, false);
    S.force = true;
    const onMove = (ev) => {
      const nx = clamp(origin.x + (ev.clientX - sx) / S.scale, 0, S.design.w - o.w);
      const ny = clamp(origin.y + (ev.clientY - sy) / S.scale, 0, S.design.h - oh);
      const hitX = snapStart(nx, o.w, xs);
      const hitY = snapStart(ny, oh, ys);
      o.x = Math.round(hitX ? clamp(hitX.pos, 0, S.design.w - o.w) : onGrid(nx));
      o.y = Math.round(hitY ? clamp(hitY.pos, 0, S.design.h - oh) : onGrid(ny));
      showGuides(hitX?.line ?? null, hitY?.line ?? null);
      el.style.left = `${o.x}px`;
      el.style.top = `${o.y}px`;
      el.style.setProperty('--shot-x', `${-o.x}px`);
      el.style.setProperty('--shot-y', `${-o.y}px`);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      hideGuides();
      S.force = false;
      save();
      scheduleHit();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

/* ============================ 毛玻璃 ============================ */

/** 后端出的底图是多大幅度的降采样原图，模糊就按图上多少像素算。
 *  这两个值必须和 glass.rs 里 snapshot 的 grab_screen(3, ...) 对上：
 *  图上 sigma 13 的特征尺度，放大 k 倍落到舞台上就是 13k 个 design px。 */
const SHOT_SIGMA = 13;
let shotImgW = 0;
let shotSrc = '';

/** 把「1/3 降采样图上的 sigma」换算成当前舞台坐标系的 CSS blur 半径。
 *  换缩放档位（S.scale 变）或换 DPI 时底图会被放大不同倍数，写死 39px
 *  在 200% 缩放的屏上会糊得过头，所以每次都要按图宽重算。 */
function applyShotBlur() {
  if (!shotImgW) return; // 图还没量出来，先用 CSS 的兜底值
  const k = (S.design.w || shotImgW) / shotImgW;
  document.documentElement.style.setProperty('--glass-blur', `${(SHOT_SIGMA * k).toFixed(1)}px`);
}

/** 量一次底图的像素宽。只在底图本身换了才重新解码，切材质/挪卡片不碰它。 */
function measureShot() {
  if (shotSrc === S.shot) {
    applyShotBlur();
    return;
  }
  const img = new Image();
  img.onload = () => {
    shotSrc = S.shot;
    shotImgW = img.naturalWidth || 0;
    applyShotBlur();
  };
  img.src = S.shot;
}

function paintShotVars() {
  if (!S.shot) return;
  document.documentElement.style.setProperty('--shot', `url("${S.shot}")`);
  document.body.dataset.glass = '1';
  measureShot();
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

/**
 * 需要底图时保证 S.shot 可用。
 *
 * 切材质 ≠ 换壁纸。以前 setGlobalMaterial 里是直接 loadGlass()，每点一次材质就
 * 走一次 glass_snapshot：排除窗口 → 整屏抓图 → 编码成 data URL，4K 上足够让
 * 控制中心卡上小半秒（玻璃卡上还会看到一次闪）。底图没变就把已有那张贴回去，
 * 真正需要重抓的只有启动那一刻和「刷新桌面底图」。
 */
function ensureGlass() {
  if (!needsShot()) {
    document.body.dataset.glass = '0';
    toneImage = null;
    document.body.dataset.tone = '';
    return;
  }
  if (S.shot) {
    document.body.dataset.glass = '1';
    paintShotVars();
    return;
  }
  loadGlass();
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
let hitTimer = 0;
/// debug.js 提供的落盘能力（只有 FY_SHOT / FY_UI 时才存在）
let dumpHook = null;

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

  // 右键菜单不开「整窗接管」：它只是热区之一。菜单外的空白要能穿透回桌面，
  // 这样在空白处点右键，桌面自己的菜单会照常弹出来（和别的桌面软件一致），
  // 我们的菜单则靠后端的「菜单外点击」检测收起（见 set_menu_rect）。
  const force = S.edit || S.force || S.trayMenu;
  invoke('set_hit_regions', { rects, force: !!force }).catch(() => {});
}

/** 写入配置。后端返回它最终采纳的那份（含新的 rev），
 *  这里只取 rev / 分组 / 天气——这三样是后端命令也会改的，前端副本可能已经落后。 */
function save() {
  clearTimeout(save._t);
  save._t = setTimeout(() => {
    invoke('save_config', { config: S.cfg })
      .then(adoptConfig)
      .catch((e) => console.error('[fy] 保存失败', e));
  }, 320);
}

/** 采纳后端给的配置片段。rev 必须跟上，否则下一次整份回传会被判成过期。 */
function adoptConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  if (typeof cfg.rev === 'number') S.cfg.rev = cfg.rev;
  if (cfg.organizer?.groups) S.cfg.organizer.groups = cfg.organizer.groups;
  if (cfg.weather) S.cfg.weather = cfg.weather;
}

/** 后端命令改过配置之后重新拉一份：不然前端手里还是旧的，
 *  下一次防抖回传就会把刚建/改/删的分组和刚换的地区覆盖回去。 */
async function syncConfig() {
  try {
    adoptConfig(await invoke('get_config'));
  } catch (e) {
    console.warn('[fy] 拉取配置失败', e);
  }
}

function setEdit(on) {
  S.edit = on;
  document.body.dataset.edit = on ? '1' : '0';
  $('#editbar').hidden = !on;
  updateHit();
}

/* ---- 控制中心 → 桌面窗口 ---- */

/**
 * 控制中心发来的修改。这里执行而不是让 hub 直接改配置：
 * 找空位、吸网格、热区、防抖落盘都只有这一份实现，两边不会漂移。
 */
function handleHubAction(a) {
  if (!a || typeof a.type !== 'string') return;
  switch (a.type) {
    case 'add-widget':
      addWidget(a.kind, a.size || 'm', a.material || '');
      break;
    case 'remove-widget':
      if (S.cfg.widgets.length > 1) removeWidget(a.id);
      break;
    case 'set-size': {
      const w = S.cfg.widgets.find((x) => x.id === a.id);
      const m = S.mounted.get(a.id);
      if (w && m && sizesOf(w.kind).includes(a.size) && w.size !== a.size) {
        setCardSize(m.el, w, a.size);
      }
      break;
    }
    case 'set-material':
      setGlobalMaterial(a.material);
      break;
    case 'set-scale':
      applyScale(a.scale);
      break;
    case 'set-labels':
      S.cfg.show_labels = !!a.on;
      applyMaterial();
      save();
      break;
    case 'set-seconds':
      S.cfg.show_seconds = !!a.on;
      setShowSeconds(!!a.on);
      save();
      break;
    case 'refresh-glass':
      loadGlass();
      break;
    case 'edit-layout':
      startLayout();
      break;
    case 'set-organizer':
      setOrganizer(!!a.on);
      break;
    default:
      console.warn('[fy] 未知的控制中心操作', a);
  }
}

/**
 * 后端配置变了：同步「不属于布局」的字段。
 * 自己的 save() 也会回到这里，所以只在真的变了的时候碰 DOM。
 */
function onConfigChanged(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  const prev = S.cfg;
  const labelsChanged = (prev.show_labels !== false) !== (cfg.show_labels !== false);
  const secChanged = (prev.show_seconds !== false) !== (cfg.show_seconds !== false);

  adoptConfig(cfg);
  S.cfg.autostart = !!cfg.autostart;
  S.cfg.auto_update = cfg.auto_update !== false;
  S.cfg.show_labels = cfg.show_labels !== false;
  S.cfg.show_seconds = cfg.show_seconds !== false;
  S.cfg.scale = Number(cfg.scale) || 0;
  S.cfg.material = cfg.material || 'glass';

  if (labelsChanged) applyMaterial();
  if (secChanged) setShowSeconds(S.cfg.show_seconds);
}

/**
 * 手动缩放：重算设计坐标系，把卡片和收纳面板夹回画布内。
 * 和启动时 lib.rs 的做法保持同一套规则（自动 = 屏宽/1920）。
 */
function applyScale(scale) {
  const v = Number(scale) || 0;
  const auto = clamp(window.innerWidth / 1920, 1, 2);
  const ui = v > 0 ? clamp(v, 1, 2) : auto;

  S.cfg.scale = v;
  S.scale = ui;
  S.design = { w: window.innerWidth / ui, h: window.innerHeight / ui };

  const o = S.cfg.organizer;
  if (o) {
    o.x = Math.round(clamp(o.x, 0, Math.max(0, S.design.w - o.w)));
    o.y = Math.round(clamp(o.y, 0, Math.max(0, S.design.h - o.h)));
  }

  layoutStage();
  normalizeSizes();
  renderWidgets();
  renderPanel();
  updateHit();
  toast(v > 0 ? `界面缩放固定为 ${v}×` : '界面缩放跟随屏宽自动');
}

/* ---- 控制中心（独立窗口） ----
 *
 * 添加组件 / 关于 / 天气地区 / 分组命名全部搬进控制中心。桌面层只保留
 * 「打开哪一页、弹哪个框」这一个入口；组件库、关于页、弹层不再各画一套。
 */
function openHub(view, dialog) {
  invoke('open_hub', { view, dialog: dialog || null }).catch((e) =>
    toast(`打开控制中心失败：${e?.message || e}`)
  );
}

function openGal() {
  openHub('gallery');
}

function openAboutPanel() {
  openHub('about');
}

/** 兼容旧调用点与调试探针：天气地区现在在控制中心里改。 */
function pickPlace() {
  openHub('settings', { type: 'weather', compact: true });
}

/** 兼容调试探针（FY_UI=group）：分组命名统一走控制中心。 */
function promptInput() {
  openHub('groups', { type: 'groupCreate', compact: true });
  return Promise.resolve(null);
}

/* ---- 上下文菜单 ---- */
function menuAnchor() {
  const el = $('#organizer');
  const r = el.getBoundingClientRect();
  // 面板被移除时 rect 全是 0，退到屏幕中间，别把菜单挤到左上角外面
  if (r.width < 3) return { x: window.innerWidth / 2 - 80, y: window.innerHeight / 2 - 40 };
  return { x: r.right - 160, y: r.bottom - 40 };
}

function showMenu(anchor, items) {
  const menu = $('#menu');
  // 勾选列与托盘菜单一致：固定宽位的 tick，没勾时占位隐藏，
  // 不再靠 label 前面的「✓ / 全角空格」对齐（那样每行文字起点会跳）。
  const tick = '<span class="mi-tick" aria-hidden="true">✓</span>';
  menu.innerHTML = items
    .map((it, i) => {
      if (it.sep) return '<div class="sep"></div>';
      if (it.head) return `<div class="lab">${escapeHtml(it.label)}</div>`;
      const dis = it.disabled ? ' disabled' : '';
      const on = it.checked ? ' aria-checked="true"' : '';
      return `<button data-i="${i}"${dis}${on}>${tick}${escapeHtml(it.label)}</button>`;
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
  syncCardMenuRect();
}

/** 把卡片右键菜单的矩形报给后端。
 *
 *  菜单外的那一下点击（左键或右键）落在窗口之外，前端根本收不到，
 *  所以「点外面收起菜单」由后端的 hit guard 轮询全局按键判定（menu:outside）。
 *  菜单本身只是热区，不开整窗接管——空白处才能穿透回桌面。 */
function syncCardMenuRect() {
  const menu = $('#menu');
  if (!menu || menu.hidden) {
    invoke('set_menu_rect', { rect: null }).catch(() => {});
    return;
  }
  const r = menu.getBoundingClientRect();
  const d = dpr();
  invoke('set_menu_rect', {
    rect: [r.left * d, r.top * d, r.right * d, r.bottom * d]
  }).catch(() => {});
}

function hideMenu() {
  const menu = $('#menu');
  if (menu.hidden) return;
  menu.hidden = true;
  invoke('set_menu_rect', { rect: null }).catch(() => {});
  updateHit();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 桌面层不再有 modal / promptInput / 天气弹层：
 * 天气地区、分组命名、关于、组件库都搬进了控制中心（hub 窗口），
 * 那里有真正的输入焦点，也不用为了一个输入框把整窗鼠标强行接管。 */

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
      if (!$('#menu').hidden) return hideMenu();
      if (S.edit) setEdit(false);
    }
    // 编辑模式下 Delete 移除最后一个选中的组件
    if (S.edit && (e.key === 'Delete' || e.key === 'Backspace') && document.activeElement?.tagName !== 'TEXTAREA') {
      const hit = document.querySelector('.card:focus-within');
      if (hit) removeWidget(hit.dataset.id);
    }
  });

  // 点菜单外面 = 关菜单。点在窗口之外（桌面空白、别的应用）时页面收不到这个
  // pointerdown，那一路由后端的 menu:outside 兜底。
  document.addEventListener('pointerdown', (e) => {
    if ($('#menu').hidden) return;
    if (e.target.closest('#menu')) return;
    hideMenu();
  });

  // 兜底：桌面层里没有需要「系统右键菜单」的地方。卡片、收纳面板、自绘菜单
  // 各自的处理器都会先 preventDefault；走到这里的只剩「窗口正好接管鼠标时的空白处」
  // （菜单开着、编辑态、拖拽中），这一下右键不该冒出 WebView 的默认菜单。
  // 平时窗口是穿透的，空白处的右键根本到不了页面，Windows 桌面菜单照旧。
  document.addEventListener('contextmenu', (e) => {
    if (!e.defaultPrevented) e.preventDefault();
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
    if (e.payload?.has_update) {
      toast(`发现新版本 v${e.payload.latest}，左键托盘 → 关于 里可更新`);
    }
  });

  // 控制中心发来的操作：布局、空位、热区、落盘都在这边执行，算法只有一份
  listen('hub:action', (e) => handleHubAction(e.payload));

  // 后端改过配置（天气地区、分组、自启、自动更新、以及本窗口自己的落盘）
  listen('config:changed', (e) => onConfigChanged(e.payload));

  // 干净截图时后端会重抓一张不含其它窗口的底图，这里直接换掉
  listen('glass:update', (e) => {
    if (!e.payload) return;
    S.shot = e.payload;
    paintShotVars();
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

  /**
   * 托盘菜单定位。三条约束，按优先级：
   * 1) 菜单必须落在屏幕内、且不能压到任务栏那一条上——窗口铺满整屏（含任务栏区域），
   *    而任务栏永远在最上层，被它盖住的部分看起来就是「菜单跑屏幕外了」；
   * 2) 往任务栏的**对面**展开，尽量贴着托盘图标；
   * 3) 空间不够就翻到图标另一侧，最后才夹回可用区域。
   *
   * 任务栏在哪条边，用**图标矩形**判断：托盘图标就画在任务栏里，离哪条屏幕边最近，
   * 任务栏就在哪条边。不用工作区判断——竖排任务栏下它并不可靠（实测右侧任务栏时，
   * 拿到的 work_area 一度仍是「下方少了 48px」的形状），而图标矩形是系统直接给的。
   * 工作区只做最后一道兜底。
   *
   * rect 是物理像素的图标矩形（后端已换成窗口坐标），wa 是工作区 [x, y, w, h]。
   */
  function placeTrayMenu(tm, rect) {
    const d = dpr();
    const W = window.innerWidth;
    const H = window.innerHeight;
    const iconL = rect.x / d;
    const iconT = rect.y / d;
    const iconR = iconL + (rect.w || 0) / d;
    const iconB = iconT + (rect.h || 0) / d;

    const gap = 8; // 菜单与图标之间的空隙
    const pad = 8; // 菜单与屏幕边缘的最小留白
    const mw = tm.offsetWidth;
    const mh = tm.offsetHeight;

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

    // 最后夹回窗口内（菜单比屏幕还大时以左上留白优先）
    x = Math.min(Math.max(x, pad), Math.max(pad, W - mw - pad));
    y = Math.min(Math.max(y, pad), Math.max(pad, H - mh - pad));

    tm.style.left = `${Math.round(x)}px`;
    tm.style.top = `${Math.round(y)}px`;
    tm.style.right = '';
    tm.style.bottom = '';
  }

  function openTrayMenu(rect) {
    closeTrayMenu();
    const tick = '<span class="tm-tick" aria-hidden="true">✓</span>';
    // 添加组件 / 刷新底图 / 天气地区 / 关于都已经是控制中心里的页面，
    // 菜单不再各留一个入口，只在第一行给一个「控制中心」。
    trayHost.innerHTML = `<div class="tm" role="menu">
      <button class="tm-item" data-act="hub" role="menuitem">${tick}控制中心</button>
      <div class="tm-sep"></div>
      <button class="tm-item check" data-act="autostart" aria-checked="${!!S.cfg.autostart}" role="menuitemcheckbox">${tick}开机自启</button>
      <button class="tm-item check" data-act="seconds" aria-checked="${S.cfg.show_seconds !== false}" role="menuitemcheckbox">${tick}时钟显示秒</button>
      <div class="tm-sep"></div>
      <button class="tm-item" data-act="root" role="menuitem">${tick}打开收纳文件夹</button>
      <button class="tm-item" data-act="conf" role="menuitem">${tick}设置文件…</button>
      <div class="tm-sep"></div>
      <button class="tm-item danger" data-act="quit" role="menuitem">${tick}退出 fy-desktop</button>
    </div>`;

    // 定位：先显示再量尺寸——`hidden` 的祖先里 `offsetWidth` 恒为 0，量不出菜单大小。
    const tm = trayHost.firstElementChild;
    trayMenuOpen = true;
    trayHost.hidden = false;
    placeTrayMenu(tm, rect);
    // 调试：把量到的尺寸与落点记进 dump，核对定位是不是按预期算的
    if (S.uitest.startsWith('tray')) {
      const box = tm.getBoundingClientRect();
      S.trayProbe = {
        ...(S.trayProbe || {}),
        input: rect,
        inner: [window.innerWidth, window.innerHeight],
        dpr: dpr(),
        menu: [tm.offsetWidth, tm.offsetHeight],
        at: [tm.style.left, tm.style.top],
        box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)]
      };
    }
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
    // 对一次账：注册表里的真实值可能被系统/其它清理工具改过，
    // 菜单上的勾选必须反映系统现状，而不是配置里的意愿
    invoke('get_autostart')
      .then((on) => {
        S.cfg.autostart = !!on;
        trayHost.querySelector('[data-act="autostart"]')?.setAttribute('aria-checked', String(!!on));
      })
      .catch(() => {});
  }

  listen('menu:outside', () => {
    // 卡片右键菜单与托盘菜单共用一个后端矩形槽位，两个都收一下
    if (!$('#menu').hidden) hideMenu();
    closeTrayMenu();
  }).catch(() => {});

  // 调试：FY_UI=traymenu|traybottom|trayright|trayleft|traytop 直接弹出托盘菜单，
  // 再点一下菜单外面，验证「点其它地方收回」。结果写进 S.trayProbe。
  const trayEdge = {
    traymenu: 'bottom',
    traybottom: 'bottom',
    trayright: 'right',
    trayleft: 'left',
    traytop: 'top'
  }[S.uitest];
  if (trayEdge)
    setTimeout(() => {
      const d = dpr();
      const W = window.innerWidth;
      const H = window.innerHeight;
      // 真实点击时这些数由后端下发；探针假造一条 48px 厚的任务栏贴在该条边上，
      // 把「按任务栏所在边定位」的四条分支都走到。图标取该条边的中段。
      const t = 48; // 任务栏厚度（CSS 像素）
      const s = 40; // 图标边长
      const rect =
        trayEdge === 'right'
          ? { x: (W - t) * d, y: ((H - s) / 2) * d, w: s * d, h: s * d, wa: [0, 0, (W - t) * d, H * d] }
          : trayEdge === 'left'
            ? { x: 0, y: ((H - s) / 2) * d, w: s * d, h: s * d, wa: [t * d, 0, (W - t) * d, H * d] }
            : trayEdge === 'top'
              ? { x: ((W - s) / 2) * d, y: 0, w: s * d, h: s * d, wa: [0, t * d, W * d, (H - t) * d] }
              : { x: (W - 140) * d, y: (H - 120) * d, w: s * d, h: s * d, wa: [0, 0, W * d, (H - t) * d] };
      openTrayMenu(rect);
      setTimeout(() => {
        const box = trayHost.querySelector('.tm');
        if (!box) return;
        const r = box.getBoundingClientRect();
        const x = Math.max(1, r.left - 30);
        const y = Math.max(1, r.top + 20);
        const target = document.elementFromPoint(x, y) || document.body;
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
        S.trayProbe = { ...(S.trayProbe || {}), closedByOutside: trayHost.hidden };
        setTimeout(() => dumpHook?.(), 200);
      }, 700);
    }, 500);

  trayHost.addEventListener('click', async (e) => {
    if (!trayMenuOpen) return;
    const btn = e.target.closest('.tm-item');
    if (!btn) return;
    const act = btn.dataset.act;
    switch (act) {
      case 'hub':
        // view 传 null：沿用控制中心上次停留的页面，冷启动时走默认页。
        // 不能用 toggle_hub —— 菜单点了就是要「打开」，不该把已开的窗口收起来。
        closeTrayMenu();
        openHub(null);
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
        const want = !S.cfg.autostart;
        try {
          const after = await invoke('set_autostart', { on: want });
          S.cfg.autostart = !!after;
          btn.setAttribute('aria-checked', String(!!after));
          syncConfig();
        } catch (e) {
          // 写注册表失败：把勾选态回滚到真实值，并明确提示。
          // 以前这里 catch {} 静默吞掉，界面显示「已开」但系统里其实没有。
          const real = await invoke('get_autostart').catch(() => !!S.cfg.autostart);
          S.cfg.autostart = !!real;
          btn.setAttribute('aria-checked', String(!!real));
          toast(`开机自启设置失败：${e?.message || e}`);
        }
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

  // 每 500ms 兜一次热区，防止某些布局变化没触发上报。
  // 句柄留着给 pagehide 清掉，否则页面重建后会有两条定时器一起跑。
  hitTimer = setInterval(updateHit, 500);

  // 页面被 WebView2 回收/重载前统一退订，避免同一事件被处理两次
  window.addEventListener('pagehide', () => {
    unlistenAll();
    clearInterval(hitTimer);
  });

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
