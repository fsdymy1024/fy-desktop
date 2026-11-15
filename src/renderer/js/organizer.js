/**
 * 桌面收纳面板。
 *
 * 每个分组就是磁盘上的一个真实文件夹（桌面/fy-desktop/<组名>），
 * 所以「拖进格子」= 真的移动文件，双击 = 真的打开。
 * 最后一组「待整理」是虚拟的：显示桌面上还没进任何格子的东西。
 */

import { esc } from './util.js';

const COLS = 8;
const LOOSE_PREVIEW = 16;

const ICON_CACHE = new Map();
let renderToken = 0;
let looseExpanded = false;

const PALETTE = ['#3d8bf0', '#b16ce0', '#2fa27c', '#e2712c', '#8d9aa6', '#d94f70', '#0f9bb0'];

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function placeholder(item, groupId) {
  const letter = (item.name.replace(/\.[^.]+$/, '').trim()[0] || '·').toUpperCase();
  const color = PALETTE[hash(item.name + groupId) % PALETTE.length];
  return `<span class="ph" style="background:${color}">${esc(letter)}</span>`;
}

function cellHtml(item, groupId, extraClass = '') {
  return `<div class="cell ${extraClass}" data-path="${esc(item.path)}" data-group="${esc(groupId)}"
      draggable="true" title="${esc(item.name)}">
      <div class="ic" data-path="${esc(item.path)}">${placeholder(item, groupId)}</div>
      <span class="lb">${esc(item.name.replace(/\.[^.]+$/, ''))}</span>
    </div>`;
}

function padCells(count) {
  const rest = (COLS - (count % COLS)) % COLS;
  if (!count || !rest) return '';
  return Array(rest)
    .fill('<div class="cell empty"><div class="ic"></div><span class="lb">空位</span></div>')
    .join('');
}

function shelfHtml(group, folded, isLoose) {
  const items = group.items || [];
  const shown = isLoose && !looseExpanded ? items.slice(0, LOOSE_PREVIEW) : items;
  const more = items.length - shown.length;

  const cells =
    shown.map((it) => cellHtml(it, group.id)).join('') +
    padCells(shown.length) +
    (more > 0
      ? `<div class="cell" data-more="1" title="展开全部 ${items.length} 项">
           <div class="ic"><span class="ph" style="background:rgba(120,90,70,.42)">+${more}</span></div>
           <span class="lb">更多</span>
         </div>`
      : '');

  const empty = !items.length
    ? `<div class="shelf-hint">${isLoose ? '桌面已经很干净' : '空 · 把快捷方式拖进来'}</div>`
    : `<div class="cells" style="--cols:${COLS}">${cells}</div>`;

  return `<div class="shelf ${folded ? 'folded' : ''}" data-g="${esc(group.id)}">
      <div class="shelf-head" data-g="${esc(group.id)}">
        <span class="swatch" style="background:${esc(group.color || '#8d9aa6')}"></span>
        <h3>${esc(group.name)}</h3>
        <span class="count">${items.length}</span>
        <button class="fold" data-fold="${esc(group.id)}" title="${folded ? '展开' : '折叠'}">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>
        </button>
      </div>
      ${folded ? '' : empty}
    </div>`;
}

export function renderOrganizer(el, cfg, view, handlers) {
  const token = ++renderToken;
  const scrollTop = el.querySelector('.shelves')?.scrollTop || 0;

  const groups = view
    ? view.groups.map((g) => ({ ...g }))
    : cfg.organizer.groups.map((g) => ({ ...g, items: [] }));

  const loose = {
    id: '__loose',
    name: '待整理',
    color: '#c9a227',
    items: view?.loose || []
  };

  const foldedIds = new Set(cfg.organizer.folded || []);
  const total = groups.reduce((n, g) => n + (g.items?.length || 0), 0);
  const looseTotal = loose.items.length;

  el.innerHTML = `
    <div class="body">
      <div class="org-head">
        <span class="org-title">桌面收纳</span>
        <span class="org-sub">${groups.length} 组 · ${total} 项</span>
        <div class="org-tools">
          <button class="iconbtn" data-act="add-group" title="新建分组">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 2.5v7M2.5 6h7"/></svg>
          </button>
          <button class="iconbtn" data-act="open-root" title="在资源管理器中打开收纳文件夹">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M1.6 4.2a1 1 0 0 1 1-1h3l1.2 1.6h4.6a1 1 0 0 1 1 1v4.4a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z"/></svg>
          </button>
          <button class="iconbtn" data-act="refresh" title="重新扫描">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 7a5 5 0 1 0 1.6-3.7"/><path d="M2 2.4v2.8h2.8"/></svg>
          </button>
        </div>
      </div>
      <div class="shelves">
        ${groups.map((g) => shelfHtml(g, foldedIds.has(g.id), false)).join('')}
        ${shelfHtml(loose, false, true)}
      </div>
      <div class="org-foot">
        <span>桌面还有 <b>${looseTotal}</b> 项未收纳</span>
        <span class="spacer"></span>
        <button class="pbtn" data-act="tidy">
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 4h10M5.6 4V2.6h2.8V4M3.4 4l.6 8h6l.6-8"/></svg>
          一键整理
        </button>
      </div>
    </div>`;

  const shelves = el.querySelector('.shelves');
  if (shelves && scrollTop) shelves.scrollTop = scrollTop;

  // ---- 图标：先用色块占位，再分批取真实图标 ----
  const slots = [...el.querySelectorAll('.cell .ic[data-path]')];
  const missing = [...new Set(slots.map((s) => s.dataset.path))].filter((p) => !ICON_CACHE.has(p));

  const apply = () => {
    if (token !== renderToken) return;
    el.querySelectorAll('.cell .ic[data-path]').forEach((node) => {
      const url = ICON_CACHE.get(node.dataset.path);
      if (url && node.querySelector('.ph')) {
        node.innerHTML = `<img src="${url}" alt="" draggable="false">`;
      }
    });
  };
  apply();

  if (missing.length) {
    (async () => {
      for (let i = 0; i < missing.length; i += 8) {
        const chunk = missing.slice(i, i + 8);
        try {
          const pairs = await handlers.icons(chunk);
          for (const [p, url] of pairs) ICON_CACHE.set(p, url);
        } catch {
          /* 单个图标失败不该影响整个面板 */
        }
        apply();
        if (token !== renderToken) return;
      }
    })();
  }

  // ---- 事件 ----
  el.onclick = (e) => {
    const foldBtn = e.target.closest('[data-fold]');
    if (foldBtn) {
      handlers.fold(foldBtn.dataset.fold);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add-group') return handlers.addGroup();
    if (act === 'open-root') return handlers.openRoot();
    if (act === 'refresh') return handlers.refresh();
    if (act === 'tidy') return handlers.tidy();

    const more = e.target.closest('[data-more]');
    if (more) {
      looseExpanded = true;
      handlers.rerender();
      return;
    }

    const cell = e.target.closest('.cell[data-path]');
    if (cell) handlers.open(cell.dataset.path);
  };

  el.oncontextmenu = (e) => {
    const cell = e.target.closest('.cell[data-path]');
    if (!cell) return;
    e.preventDefault();
    handlers.menu(e, cell.dataset.path, cell.dataset.group);
  };

  // ---- 拖拽 ----
  el.ondragstart = (e) => {
    const cell = e.target.closest('.cell[data-path]');
    if (!cell) return;
    e.dataTransfer.setData('text/plain', cell.dataset.path);
    e.dataTransfer.setData('application/x-fy-path', cell.dataset.path);
    e.dataTransfer.effectAllowed = 'move';
    handlers.dragStart?.(true);
  };

  el.ondragend = () => handlers.dragStart?.(false);

  const shelfAt = (y) => {
    let hit = null;
    el.querySelectorAll('.shelf[data-g]').forEach((s) => {
      if (s.dataset.g === '__loose') return;
      const r = s.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) hit = s.dataset.g;
    });
    return hit;
  };

  el.ondragover = (e) => {
    const gid = shelfAt(e.clientY);
    if (!gid) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.querySelectorAll('.cell.drop').forEach((c) => c.classList.remove('drop'));
    const target = el.querySelector(`.shelf[data-g="${gid}"]`);
    target?.querySelectorAll('.cell').forEach((c) => c.classList.add('drop'));
  };

  el.ondragleave = () => {
    el.querySelectorAll('.cell.drop').forEach((c) => c.classList.remove('drop'));
  };

  el.ondrop = async (e) => {
    const gid = shelfAt(e.clientY);
    el.querySelectorAll('.cell.drop').forEach((c) => c.classList.remove('drop'));
    if (!gid) return;
    e.preventDefault();
    const path = e.dataTransfer.getData('application/x-fy-path') || e.dataTransfer.getData('text/plain');
    if (!path) return;
    if (gid === e.target.closest('.cell[data-group]')?.dataset.group) return; // 拖回原组，不折腾
    await handlers.moveInto([path], gid);
  };

  return { shelves };
}

/** OS 文件拖进来时，按坐标找落在哪个分组 */
export function groupAtPoint(el, x, y) {
  let hit = null;
  el.querySelectorAll('.shelf[data-g]').forEach((s) => {
    if (s.dataset.g === '__loose') return;
    const r = s.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hit = s.dataset.g;
  });
  return hit;
}

export function resetLoose() {
  looseExpanded = false;
}

export function clearIconCache() {
  ICON_CACHE.clear();
}
