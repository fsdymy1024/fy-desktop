/**
 * 主流程：启动 → 布局 → 渲染组件 → 玻璃底图 → 事件订阅 → 交互。
 *
 * 坐标系只有一套：设计像素。屏幕实际像素 = 设计像素 × scale，
 * 所以后端报上来的热区要乘 devicePixelRatio，拖拽位移要除以 scale。
 */

import { invoke, listen, dbg } from './bridge.js';
import { REGISTRY, setShowSeconds } from './widgets.js';
import { renderOrganizer, groupAtPoint, resetLoose } from './organizer.js';
import { openGallery } from './gallery.js';
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
  shotMode: false
};

/* ============================ 启动 ============================ */

async function boot() {
  const b = await invoke('boot');
  S.cfg = b.config;
  S.design = { w: b.design[0], h: b.design[1] };
  S.scale = b.scale || 1;
  S.shotMode = !!b.shot;

  layoutStage();
  applyMaterial();
  setShowSeconds(S.cfg.show_seconds !== false);

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

  // 调试：FY_UI=place|group 时自动打开对应弹层，方便截图核对样式与命中区
  if (b.uitest === 'place') setTimeout(() => pickPlace(), 400);
  if (b.uitest === 'group') setTimeout(() => promptInput('新建分组', '例如：设计素材'), 400);
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

/* ============================ 组件 ============================ */

function place(el, w) {
  el.style.left = `${w.x}px`;
  el.style.top = `${w.y}px`;
  el.style.width = `${w.w}px`;
  el.style.height = `${w.h}px`;
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

  el.insertAdjacentHTML(
    'beforeend',
    `<div class="wtool">
       <button data-tool="shrink" title="缩小">
         <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 6h7"/></svg>
       </button>
       <button data-tool="grow" title="放大">
         <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 2.5v7M2.5 6h7"/></svg>
       </button>
       <button data-tool="remove" title="移除组件">
         <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
       </button>
     </div>
     <div class="grip" title="拖动改变大小"></div>`
  );

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
  scheduleTone();
}

function bindCard(el, w) {
  el.addEventListener('pointerdown', (e) => {
    if (!S.edit) return;
    if (e.target.closest('.wtool') || e.target.closest('.grip')) return;
    if (e.button !== 0) return;
    startDrag(e, el, w, 'move');
  });

  el.addEventListener('click', (e) => {
    const tool = e.target.closest('[data-tool]')?.dataset.tool;
    if (!tool) return;
    if (tool === 'remove') return removeWidget(w.id);
    const def = REGISTRY[w.kind];
    const step = tool === 'grow' ? 1.12 : 1 / 1.12;
    const min = def.min || [180, 80];
    const nw = clamp(Math.round(w.w * step), min[0], S.design.w - w.x);
    const nh = clamp(Math.round(w.h * step), min[1], S.design.h - w.y);
    w.w = nw;
    w.h = nh;
    place(el, w);
    S.mounted.get(w.id)?.inst?.onSizeChange?.();
    save();
    scheduleHit();
  });

  const grip = el.querySelector('.grip');
  grip.addEventListener('pointerdown', (e) => {
    if (!S.edit) return;
    startDrag(e, el, w, 'resize');
  });

  // 双击天气卡直接改地区：这是最常用的设置，不该藏进托盘
  if (w.kind === 'weather') {
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.wtool')) return;
      pickPlace();
    });
  }
}

/* ---- 网格吸附 ----
 *
 * 两个层次：
 * 1) 兜底落 8 设计像素网格，拖出来的坐标不会出现 3px、5px 这种歪数；
 * 2) 优先贴其它卡片的参考线（左/中/右、上/中/下），6px 内直接对齐，
 *    这样不同组件能落在同一条线上，宽高也能对齐成一样。
 */
const GRID = 8;
const SNAP_TOL = 6;

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

/** 其它卡片与收纳面板的参考线 */
function refLines(exceptId) {
  const xs = [];
  const ys = [];
  for (const o of S.cfg.widgets) {
    if (o.id === exceptId) continue;
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const org = S.cfg.organizer;
  if (org) {
    xs.push(org.x, org.x + org.w / 2, org.x + org.w);
    ys.push(org.y);
  }
  return { xs, ys };
}

/** 起点吸附：card 的左/中/右 三条线各自去贴，取最近的一处 */
function snapStart(pos, size, lines) {
  let best = null;
  for (const off of [0, size / 2, size]) {
    const at = pos + off;
    for (const l of lines) {
      const d = Math.abs(at - l);
      if (d <= SNAP_TOL && (!best || d < best.d)) best = { d, pos: l - off, line: l };
    }
  }
  return best;
}

/** 终点吸附：card 的右/下 边去贴（改大小时用） */
function snapEnd(pos, size, lines) {
  let best = null;
  const at = pos + size;
  for (const l of lines) {
    const d = Math.abs(at - l);
    if (d <= SNAP_TOL && (!best || d < best.d)) best = { d, size: l - pos, line: l };
  }
  return best;
}

const onGrid = (v) => Math.round(v / GRID) * GRID;

function startDrag(e, el, w, mode) {
  e.preventDefault();
  e.stopPropagation();

  const sx = e.clientX;
  const sy = e.clientY;
  const origin = { x: w.x, y: w.y, w: w.w, h: w.h };
  const min = REGISTRY[w.kind]?.min || [180, 80];

  S.force = true;
  updateHit();

  const onMove = (ev) => {
    const dx = (ev.clientX - sx) / S.scale;
    const dy = (ev.clientY - sy) / S.scale;
    const { xs, ys } = refLines(w.id);

    if (mode === 'move') {
      const nx = clamp(origin.x + dx, 0, S.design.w - w.w);
      const ny = clamp(origin.y + dy, 0, S.design.h - w.h);
      const hitX = snapStart(nx, w.w, xs);
      const hitY = snapStart(ny, w.h, ys);
      w.x = Math.round(hitX ? clamp(hitX.pos, 0, S.design.w - w.w) : onGrid(nx));
      w.y = Math.round(hitY ? clamp(hitY.pos, 0, S.design.h - w.h) : onGrid(ny));
      showGuides(hitX?.line ?? null, hitY?.line ?? null);
    } else {
      const nw = clamp(origin.w + dx, min[0], S.design.w - w.x);
      const nh = clamp(origin.h + dy, min[1], S.design.h - w.y);
      const hitX = snapEnd(w.x, nw, xs);
      const hitY = snapEnd(w.y, nh, ys);
      w.w = Math.round(clamp(hitX ? hitX.size : onGrid(nw), min[0], S.design.w - w.x));
      w.h = Math.round(clamp(hitY ? hitY.size : onGrid(nh), min[1], S.design.h - w.y));
      showGuides(hitX?.line ?? null, hitY?.line ?? null);
    }
    place(el, w);
    scheduleTone();
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    S.force = false;
    hideGuides();
    S.mounted.get(w.id)?.inst?.onSizeChange?.();
    save();
    updateHit();
    scheduleTone();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function addWidget(kind) {
  const def = REGISTRY[kind];
  if (!def) return;
  const [w, h] = def.size;
  const spot = freeSpot(w, h);
  S.cfg.widgets.push({
    id: `${kind}-${Date.now().toString(36)}`,
    kind,
    x: spot.x,
    y: spot.y,
    w,
    h
  });
  renderWidgets();
  save();
  toast(`已添加「${def.name}」`);
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
  const pad = 36;
  const limitX = Math.max(pad + w, (S.cfg.organizer?.x ?? S.design.w) - 20);
  const boxes = S.cfg.widgets.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
  const clash = (a) =>
    boxes.some((b) => a.x < b.x + b.w + 8 && a.x + a.w + 8 > b.x && a.y < b.y + b.h + 8 && a.y + a.h + 8 > b.y);

  for (let y = pad; y + h <= S.design.h - pad; y += 20) {
    for (let x = pad; x + w <= limitX; x += 20) {
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
  scheduleTone();
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
  reveal: (path) => invoke('reveal_path', { path }),
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
        { label: '打开所在位置', act: () => invoke('reveal_path', { path }) },
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
      scheduleTone();
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
}

async function loadGlass() {
  if (!S.cfg.glass || S.cfg.material === 'solid') {
    document.body.dataset.glass = '0';
    return;
  }
  try {
    S.shot = await invoke('glass_snapshot');
    paintShotVars();
    toneImage = null;
    scheduleTone();
  } catch (e) {
    console.warn('[fy] 抓屏失败，退回半透明填充', e);
    document.body.dataset.glass = '0';
  }
}

/* ---- 自适应明暗：采样底图，卡片下面偏暗就换浅色字 ---- */
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
  if (document.body.dataset.tone !== tone) {
    document.body.dataset.tone = tone;
  }
  document.querySelectorAll('#stage .surface').forEach((el) => el.classList.remove('on-dark'));
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

  const force = S.edit || S.force || !!S.gallery || (menu && !menu.hidden);
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
    onAdd: (kind) => addWidget(kind),
    onClose: () => {
      S.gallery = null;
      updateHit();
    },
    onChange: (patch) => {
      Object.assign(S.cfg, patch);
      applyMaterial();
      save();
      if (S.cfg.material === 'solid') document.body.dataset.glass = '0';
      else if (!S.shot) loadGlass();
      else document.body.dataset.glass = '1';
      scheduleTone();
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
        <div class="modal-title">${escapeHtml(title)}</div>
        ${bodyHtml}
        <div class="modal-foot">
          <button class="ebtn" data-close>${escapeHtml(opts.cancelText || '取消')}</button>
          ${opts.okText ? `<button class="ebtn primary" data-ok>${escapeHtml(opts.okText)}</button>` : ''}
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const close = (v) => {
      wrap.remove();
      S.force = wasForce;
      updateHit();
      resolve(v);
    };

    // 点遮罩不关闭、也不让焦点跑掉：想取消就按「取消」或 Esc
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) {
        e.preventDefault();
        wrap.querySelector('input,textarea')?.focus();
      }
    });
    wrap.querySelector('[data-close]').onclick = () => close(null);
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
    scheduleTone();
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

  // 干净截图时后端会重抓一张不含其它窗口的底图，这里换掉并重新判明暗
  listen('glass:update', (e) => {
    if (!e.payload) return;
    S.shot = e.payload;
    toneImage = null;
    paintShotVars();
    scheduleTone();
  });

  listen('tray:action', (e) => {
    if (e.payload === 'gallery') openGal();
    if (e.payload === 'edit') setEdit(!S.edit);
    if (e.payload === 'place') pickPlace();
    if (e.payload === 'glass') {
      toneImage = null;
      loadGlass();
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
        return [el.dataset.kind, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      }),
      organizer: (() => {
        const r = $('#organizer').getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      })(),
      glass: document.body.dataset.glass === '1',
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
