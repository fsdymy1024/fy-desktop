/**
 * 桌面收纳格子
 * ------------------------------------------------------------------
 * 数据来自主进程扫描的真实桌面条目（用户桌面 + 公共桌面）。
 * 默认是「虚拟分组」：只在配置里记录归属，不动任何文件。
 * 只有点「一键整理」并二次确认后，才会把散落文件移动到收纳目录，
 * 并且写 _manifest.json 支持「还原」。
 */

import { $, toast, esc } from './util.js';
import { openCtx, confirmBox } from './overlay.js';

const PALETTE = ['g-blue', 'g-slate', 'g-orange', 'g-sky', 'g-teal', 'g-violet', 'g-pink', 'g-amber', 'g-red', 'g-green'];

let state = { groups: [], total: 0, loose: 0 };
let tidyDir = '';
let restoredVisible = false;
const folded = new Map();

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function iconHTML(item) {
  const label = item.badge || (item.base ? item.base.trim().charAt(0) : '·');

  switch (item.kind) {
    case 'folder':
      return `<div class="ic g-amber"><svg viewBox="0 0 24 24"><use href="#g-folder"/></svg></div>`;
    case 'link':
      return `<div class="ic g-sky"><svg viewBox="0 0 24 24"><use href="#g-link"/></svg></div>`;
    case 'image':
      return `<div class="ic g-green"><svg viewBox="0 0 24 24"><use href="#g-image"/></svg></div>`;
    case 'archive':
      return `<div class="ic g-slate"><svg viewBox="0 0 24 24"><use href="#g-archive"/></svg></div>`;
    case 'media':
      return `<div class="ic g-pink"><svg viewBox="0 0 24 24"><use href="#g-wave"/></svg></div>`;
    case 'doc':
      return `<div class="ic g-blue"><span class="lt${label.length > 2 ? ' xs' : ' sm'}">${esc(label)}</span></div>`;
    case 'sheet':
      return `<div class="ic g-green"><span class="lt${label.length > 2 ? ' xs' : ' sm'}">${esc(label)}</span></div>`;
    case 'slide':
      return `<div class="ic g-orange"><span class="lt${label.length > 2 ? ' xs' : ' sm'}">${esc(label)}</span></div>`;
    case 'shortcut': {
      const cls = PALETTE[hash(item.name) % PALETTE.length];
      return `<div class="ic ${cls}"><span class="lt">${esc(item.initial || '·')}</span></div>`;
    }
    default: {
      const cls = PALETTE[hash(item.name) % PALETTE.length];
      return `<div class="ic ${cls}"><span class="lt sm">${esc(item.initial || label || 'F')}</span></div>`;
    }
  }
}

function cellHTML(item) {
  return `<div class="cell" data-path="${esc(item.path)}" title="${esc(item.name)}">
    ${iconHTML(item)}
    <span>${esc(item.base || item.name)}</span>
  </div>`;
}

function render() {
  const cols = window.__fyCols || 8;
  const host = $('#shelves');

  host.innerHTML = state.groups.map((g) => {
    const isFolded = folded.has(g.id) ? folded.get(g.id) : g.folded;
    const items = g.items || [];
    let cells = items.map(cellHTML).join('');

    // 补齐整行：让每一组都是一个完整的收纳盒，而不是参差的豆腐块
    const pad = items.length ? (cols - (items.length % cols)) % cols : 0;
    for (let i = 0; i < pad; i++) cells += `<div class="cell empty"><div class="ic"></div><span>空位</span></div>`;

    if (!items.length) {
      cells = g.inbox
        ? `<div class="empty-note">桌面已经没有散落的图标了。</div>`
        : `<div class="empty-note">这个格子还是空的。右键桌面图标 →「移入分组」即可收纳。</div>`;
    }

    return `<div class="shelf${isFolded ? ' folded' : ''}" data-id="${g.id}" style="--cols:${cols}">
      <div class="shelf-head">
        <span class="dot" style="--c:${g.color}"></span>
        <h3>${esc(g.name)}</h3>
        <span class="count">${items.length}</span>
        ${isFolded ? '<span class="fold-hint">已折叠</span>' : ''}
        <span class="grow"></span>
        <button class="chev" data-fold="${g.id}" title="${isFolded ? '展开' : '折叠'}">
          <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
      <div class="cells">${cells}</div>
    </div>`;
  }).join('');

  const names = state.groups.filter(g => !g.inbox).length;
  $('#orgSub').textContent = `${names} 组 · ${state.total} 项快捷方式`;
  $('#orgFoot').innerHTML = `桌面共 <b>${state.total}</b> 项 · 待整理 <b>${state.loose}</b> 项`;
  $('#btnRestore').style.display = restoredVisible ? '' : 'none';
}

export async function refresh() {
  try {
    const data = await window.fy.deskList();
    state = data;
    for (const g of data.groups) {
      if (!folded.has(g.id)) folded.set(g.id, Boolean(g.folded));
    }
    render();
  } catch (err) {
    $('#orgSub').textContent = '扫描失败';
    console.error('[organizer]', err);
  }
}

/* ---------------- 交互 ---------------- */

function cellMenu(item, x, y) {
  const targets = state.groups.filter(g => !g.inbox);
  openCtx(x, y, {
    title: item.name,
    items: [
      { label: '打开', onClick: () => window.fy.deskOpen(item.path) },
      { label: '在资源管理器中显示', onClick: () => window.fy.deskReveal(item.path) },
      { sep: true },
      ...targets.map(g => ({
        label: `移入「${g.name}」`,
        onClick: async () => {
          await window.fy.deskAssign(item.path, g.id);
          toast(`已移入「${g.name}」`);
          refresh();
        }
      })),
      { label: '移出分组', onClick: async () => {
        await window.fy.deskAssign(item.path, null);
        toast('已移出分组');
        refresh();
      } }
    ]
  });
}

export function initOrganizer(opts = {}) {
  tidyDir = opts.tidyDir || '';

  const host = $('#shelves');

  host.addEventListener('click', (e) => {
    const fold = e.target.closest('[data-fold]');
    if (fold) {
      const id = fold.dataset.fold;
      folded.set(id, !folded.get(id));
      render();
      return;
    }

    const cell = e.target.closest('.cell[data-path]');
    if (cell) window.fy.deskOpen(cell.dataset.path);
  });

  host.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('.cell[data-path]');
    if (!cell) return;
    e.preventDefault();
    const item = state.groups.flatMap(g => g.items || []).find(i => i.path === cell.dataset.path);
    if (item) cellMenu(item, e.clientX, e.clientY);
  });

  $('#btnScan').addEventListener('click', () => { refresh(); toast('已重新扫描桌面'); });

  $('#btnTidyDir').addEventListener('click', () => window.fy.openTidyDir());

  $('#btnMore').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openCtx(r.left - 120, r.bottom + 6, {
      items: [
        { label: '重新扫描桌面', onClick: () => refresh() },
        { label: '打开收纳目录', onClick: () => window.fy.openTidyDir() },
        { sep: true },
        { label: '还原收纳的文件', onClick: () => restore() },
        { label: '编辑布局', onClick: () => window.fy.setEditMode(true) },
        { sep: true },
        { label: '退出 fy-desktop', onClick: () => window.fy.quit() }
      ]
    });
  });

  $('#btnTidy').addEventListener('click', async () => {
    const plan = await window.fy.deskPlan();
    if (!plan.length) { toast('桌面已经没有可收纳的文件了'); return; }

    const names = plan.slice(0, 8).map(p => p.path);
    if (plan.length > 8) names.push(`…等 ${plan.length} 个文件`);

    const ok = await confirmBox({
      title: `把 ${plan.length} 个桌面文件收进收纳区？`,
      desc: `目标目录：${tidyDir || '桌面/fy-desktop 收纳区'}。只会移动文件，不会删除；移动记录会写进 _manifest.json，随时可以一键还原。`,
      list: names,
      okText: '开始整理',
      danger: true
    });
    if (!ok) return;

    const r = await window.fy.deskTidy();
    restoredVisible = true;
    toast(`已收纳 ${r.moved.length} 项`);
    refresh();
  });

  $('#btnRestore').addEventListener('click', () => restore());

  async function restore() {
    const ok = await confirmBox({
      title: '把收纳区里的文件还原回桌面？',
      desc: '会按照 _manifest.json 的记录，把文件放回移动前的位置。已存在的同名文件不会被覆盖。',
      okText: '还原'
    });
    if (!ok) return;
    const r = await window.fy.deskRestore();
    toast(r.ok ? `已还原 ${r.restored} 项` : '找不到收纳记录');
    refresh();
  }

  window.fy.on('desk:refresh', () => refresh());
  refresh();
}
