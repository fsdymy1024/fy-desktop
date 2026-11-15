/**
 * 渲染层入口：布局、拖拽、鼠标穿透、材质切换
 */

import { $, $$ } from './util.js';
import { openCtx } from './overlay.js';
import { initClock, initCalendar, initWeather, initSystem, initNetwork, initNotes } from './widgets.js';
import { initOrganizer, refresh } from './organizer.js';

const ID_MAP = {
  weather: 'w-weather',
  clock: 'w-clock',
  calendar: 'w-calendar',
  system: 'w-system',
  network: 'w-network',
  notes: 'w-notes',
  organizer: 'w-organizer'
};

let cfg = null;

/* ---------------- 布局 ---------------- */

function elOf(id) {
  return document.getElementById(ID_MAP[id]);
}

function applyLayout(layout) {
  for (const [id, box] of Object.entries(layout || {})) {
    const el = elOf(id);
    if (!el || !box) continue;
    const x = Math.max(0, Math.min(box.x, innerWidth - 120));
    const y = Math.max(0, Math.min(box.y, innerHeight - 80));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (id === 'organizer') {
      el.style.width = `${box.w || 756}px`;
    } else {
      el.style.width = `${box.w}px`;
      el.style.height = `${box.h}px`;
    }
  }
}

function snapshotLayout() {
  const out = {};
  for (const [id, domId] of Object.entries(ID_MAP)) {
    const el = document.getElementById(domId);
    if (!el) continue;
    out[id] = {
      x: Math.round(el.offsetLeft),
      y: Math.round(el.offsetTop),
      w: Math.round(el.offsetWidth),
      h: Math.round(el.offsetHeight)
    };
  }
  return out;
}

function applyVisibility(widgets) {
  for (const [id, conf] of Object.entries(widgets || {})) {
    const el = elOf(id);
    if (el) el.style.display = conf.visible === false ? 'none' : '';
  }
}

/* ---------------- 拖拽 ---------------- */

let drag = null;

document.addEventListener('mousedown', (e) => {
  if (!document.body.classList.contains('edit') || e.button !== 0) return;
  const el = e.target.closest('[data-widget]');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  drag = { el, dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
  el.style.zIndex = '60';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const rect = drag.el.getBoundingClientRect();
  const x = Math.max(0, Math.min(innerWidth - rect.width, e.clientX - drag.dx));
  const y = Math.max(0, Math.min(innerHeight - rect.height, e.clientY - drag.dy));
  drag.el.style.left = `${Math.round(x)}px`;
  drag.el.style.top = `${Math.round(y)}px`;
  drag.moved = true;
});

document.addEventListener('mouseup', async () => {
  if (!drag) return;
  drag.el.style.zIndex = '';
  const moved = drag.moved;
  drag = null;
  if (moved) await window.fy.saveLayout(snapshotLayout());
});

/* ---------------- 鼠标穿透 ---------------- */

let interactive = false;

function updateInteractive(e) {
  if (document.body.classList.contains('edit')) {
    if (!interactive) { interactive = true; window.fy.setInteractive(true); }
    return;
  }
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const hit = !!(el && el.closest('.widget, .org, .modal.open, .ctx.open, .edittip'));
  if (hit !== interactive) {
    interactive = hit;
    window.fy.setInteractive(hit);
  }
}

document.addEventListener('mousemove', updateInteractive);
document.addEventListener('mouseleave', () => {
  if (interactive && !document.body.classList.contains('edit')) {
    interactive = false;
    window.fy.setInteractive(false);
  }
});

/* ---------------- 组件右键 ---------------- */

document.addEventListener('contextmenu', async (e) => {
  const el = e.target.closest('.widget');
  if (!el || el.id === 'w-organizer') return;
  e.preventDefault();
  const id = el.dataset.widget;
  openCtx(e.clientX, e.clientY, {
    title: el.querySelector('.city')?.textContent || id,
    items: [
      { label: '编辑布局', onClick: () => setEdit(true) },
      { label: '隐藏这个组件', onClick: async () => {
        await window.fy.toggleWidget(id, false);
        el.style.display = 'none';
      } }
    ]
  });
});

/* ---------------- 编辑模式 ---------------- */

async function setEdit(on) {
  document.body.classList.toggle('edit', on);
  await window.fy.setEditMode(on);
  if (on) interactive = true; // 编辑时强制接管鼠标
  else {
    interactive = false;
    window.fy.setInteractive(false);
    window.fy.saveLayout(snapshotLayout());
  }
}

$('#btnExitEdit').addEventListener('click', () => setEdit(false));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('edit')) setEdit(false);
});

/* ---------------- 启动 ---------------- */

async function boot() {
  const info = await window.fy.boot();
  cfg = info.config;

  document.body.dataset.mat = cfg.material || 'follow';
  document.body.classList.toggle('edit', Boolean(cfg.editMode));
  window.__fyCols = cfg.organizer.columns || 8;

  if (location.hash === '#demo') document.body.classList.add('demo-wall');

  applyLayout(cfg.layout);
  applyVisibility(cfg.widgets);

  initClock();
  initCalendar();
  initWeather();
  initSystem();
  initNetwork();
  initNotes(cfg.widgets.notes?.items);
  initOrganizer({ tidyDir: info.tidyDir });

  // 主进程事件
  window.fy.on('ui:material', (m) => { document.body.dataset.mat = m; });
  window.fy.on('ui:editMode', (on) => {
    document.body.classList.toggle('edit', Boolean(on));
    if (!on) window.fy.saveLayout(snapshotLayout());
  });
  window.fy.on('ui:resetLayout', async () => {
    const layout = await window.fy.resetLayout();
    applyLayout(layout);
  });

  // 分辨率变化后重新夹一遍位置，避免组件跑到屏幕外
  addEventListener('resize', () => {
    applyLayout(snapshotLayout());
    refresh();
  });
}

boot().catch((err) => {
  console.error('[fy-desktop] 启动失败', err);
});
