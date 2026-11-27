/**
 * 控制中心（hub 窗口）。
 *
 * 和桌面层是**两个窗口**：
 * - 这里只负责「看和改」，不画桌面组件，也不参与热区/穿透；
 * - 「加组件 / 换尺寸 / 换材质 / 换缩放」不直接改配置，而是把意图发给桌面窗口
 *   （invoke('hub_action')），由它用自己那套空位、吸附、热区逻辑执行。
 *   这样布局算法只有一份，不会两边漂移。
 * - 后端配置一改（不管谁改的）就广播 `config:changed`，这里重新渲染；
 *   所以窗口开着时，桌面上的右键操作也会实时反映到列表里。
 */

import { invoke, invokeRetry, listen } from './bridge.js';
import { REGISTRY, ORDER, SIZE_LABEL, dimsOf, launcherSvg } from './widgets.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MATERIALS = [
  ['glass', '玻璃', '深蓝黑，透出壁纸明暗'],
  ['dusk', '暮色', '深棕磨砂，暖字更柔和'],
  ['solid', '石墨', '中性深灰，不抓屏、最省']
];
const MAT_NAME = { glass: '玻璃', dusk: '暮色', solid: '石墨' };
const VIEWS = ['widgets', 'gallery', 'settings', 'groups', 'launcher', 'docs', 'about'];
const MATERIAL_KEYS = ['glass', 'dusk', 'solid'];

const H = {
  cfg: null,
  version: '',
  root: '',
  autostart: false,
  palette: [],
  /// 后端下发的系统入口白名单，卡片和控制中心共用
  entries: [],
  view: 'widgets',
  size: 'm',
  viewData: null,
  update: null,
  dialog: null
};

const appWindow = (() => {
  try {
    return window.__TAURI__?.window?.getCurrentWindow?.() || null;
  } catch {
    return null;
  }
})();

/* ============================ 启动 ============================ */

async function boot() {
  // 与桌面层同理：页面可能先于后端 manage() 就绪，重试即可（见 bridge.js）
  const b = await invokeRetry('hub_boot');
  H.cfg = b.config;
  H.version = b.version || '';
  H.root = b.root || '';
  H.autostart = !!b.autostart;
  H.palette = Array.isArray(b.palette) ? b.palette : [];
  H.entries = Array.isArray(b.launcher_entries) ? b.launcher_entries : [];

  restorePosition();
  applyMaterial();
  bindEvents();
  renderAll();
  await refreshDesktop();

  if (b.pending) {
    handleIntent(b.pending);
    return;
  }
  // 窗口隐藏时这个页面会被 WebView2 挂起，首次 hub_boot 往往早于桌面/托盘发来的意图：
  // 那个意图只留在后端 pending 里，hub:intent 事件也发在监听注册之前。
  // 监听装好后再补取一次，否则「冷启动时点桌面上的天气地区」会一点反应都没有。
  invoke('hub_boot')
    .then((b2) => {
      if (b2?.pending) handleIntent(b2.pending);
    })
    .catch(() => {});
}

/**
 * 界面缩放。
 *
 * 设计稿固定 900×620，窗口逻辑尺寸 = 900×620 × ui，内容用 transform 同步放大。
 * 4K 屏上 1:1 画字会小得离谱，但放到 2 倍窗口就吃掉半屏（3840×2160 上 1800×1240），
 * 所以按 2880 起算、上限 1.5：4K 上落在 1.33（窗口 1200×825），1080p 上就是 1:1。
 */
const UI_MAX = 1.5;

function applyUi() {
  const avail = screen.availWidth || 1920;
  const ui = Math.min(UI_MAX, Math.max(1, avail / 2880));
  document.documentElement.style.setProperty('--ui', String(ui));
  return ui;
}

/** 窗口尺寸与位置（主界面形态）。 */
function restorePosition() {
  if (!appWindow) return;
  const dpr = window.devicePixelRatio || 1;
  const ui = applyUi();

  // 设计稿 900×620（见 hub.css 的 .app），两边必须一致
  const W = 900 * ui;
  const Hh = 620 * ui;
  const DPI = window.__TAURI__?.dpi;
  if (!DPI) return;

  try {
    // 逻辑尺寸：Tauri 会按窗口 DPI 换算成物理像素
    if (DPI.LogicalSize) appWindow.setSize(new DPI.LogicalSize(W, Hh));

    const raw = localStorage.getItem('fy.hub.pos');
    const saved = raw ? JSON.parse(raw) : null;
    let x;
    let y;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      x = saved.x;
      y = saved.y;
    } else {
      // 默认贴着任务栏右上方，和托盘图标同一侧
      x = screen.availWidth - W - 24 * ui;
      y = screen.availHeight - Hh - 24 * ui;
    }
    x = Math.max(0, Math.min(x, screen.availWidth - W));
    y = Math.max(0, Math.min(y, screen.availHeight - Hh));
    if (DPI.LogicalPosition) appWindow.setPosition(new DPI.LogicalPosition(x, y));

    // 只挂一次：紧凑弹窗会反复改窗口尺寸/位置，重复挂会存下一堆中间值
    if (!posHooked) {
      posHooked = true;
      appWindow.onMoved?.(({ payload }) => {
        // 紧凑弹窗的位置是算出来的，不该覆盖用户自己拖好的主窗口位置
        if (compact) return;
        try {
          const d = window.devicePixelRatio || 1;
          localStorage.setItem('fy.hub.pos', JSON.stringify({ x: payload.x / d, y: payload.y / d }));
        } catch {
          /* 存不了就下次用默认位置，不影响功能 */
        }
      });
    }
  } catch (e) {
    console.warn('[hub] 位置恢复失败', dpr, e);
  }
}

/* ------------------------- 只显示弹窗 -------------------------
 *
 * 从桌面上改天气地区 / 建分组时，用户要的只是那个小输入框。
 * 以前是「把控制中心整个弹出来，再在中间浮一个框」，主界面白白占一屏；
 * 这里把主界面（标题栏 + 侧栏 + 内容）藏起来，**窗口尺寸和位置完全不动**，
 * 只在原来的窗口里留下那个弹窗，关掉弹窗窗口跟着隐藏。
 *
 * 刻意不 resize：改窗口大小会带出一阵跳变，弹窗本身也会跟着变尺寸。
 */
let compact = false;
let posHooked = false;

function enterCompact() {
  if (!appWindow || compact) return;
  compact = true;
  document.body.dataset.compact = '1';
}

/** 退出弹窗形态。hideWindow=false 用于「同一个窗口接着显示主界面」的情况。 */
function exitCompact(hideWindow = true) {
  if (!compact) return;
  compact = false;
  delete document.body.dataset.compact;
  if (hideWindow) invoke('hide_hub').catch(() => {});
}

/* ============================ 渲染 ============================ */

function applyMaterial() {
  const mat = MATERIAL_KEYS.includes(H.cfg?.material) ? H.cfg.material : 'glass';
  document.body.dataset.mat = mat;
}

function renderAll() {
  renderNav();
  renderWidgets();
  renderGallery();
  renderSettings();
  renderLauncherFavorites();
  renderGroups();
  renderAbout();
  renderSide();
}

/** 判断「要不要整窗重绘」用的配置指纹。
 *  材质刻意不在里面——它只是换一组 CSS 变量，换不着重建 DOM。 */
function cfgSig(c) {
  return JSON.stringify([
    c?.widgets,
    c?.organizer?.groups,
    c?.organizer?.enabled,
    c?.organizer?.root,
    c?.show_labels,
    c?.show_seconds,
    c?.scale,
    c?.weather,
    c?.launcher_favorites
  ]);
}

function renderNav() {
  $$('.nav').forEach((n) => n.classList.toggle('on', n.dataset.view === H.view));
  const count = H.cfg?.widgets?.length || 0;
  $('#nav-count').textContent = String(count);
  $('#nav-groups').textContent = String(H.cfg?.organizer?.groups?.length || 0);
  $('#ver-side').textContent = `v${H.version}`;
}

function renderSide() {
  const groups = H.viewData?.groups || [];
  const total = groups.reduce((n, g) => n + (g.items?.length || 0), 0);
  const loose = H.viewData?.loose_total ?? 0;
  $('#side-desc').textContent = H.viewData
    ? `${total} 项已归入 ${groups.length} 个分组，桌面上还留着 ${loose} 个快捷方式。`
    : '收纳目录暂时读取不到，可稍后刷新。';
}

function setView(view) {
  if (!VIEWS.includes(view)) return;
  H.view = view;
  document.body.dataset.page = view;
  renderNav();
  if (view === 'groups') refreshDesktop();
  if (view === 'gallery') renderGallery();
}

function chipsHtml() {
  const scale = H.cfg.scale > 0 ? `${H.cfg.scale}×` : '自动';
  return `
    <span class="chip"><span class="dot"></span>组件运行中</span>
    <span class="chip">材质 <b>${MAT_NAME[H.cfg.material] || '玻璃'}</b></span>
    <span class="chip">缩放 <b>${scale}</b></span>
    <span class="chip">开机自启 <b>${H.autostart ? '已开启' : '已关闭'}</b></span>`;
}

function renderWidgets() {
  const list = $('#wlist');
  if (!list) return;
  $('#chips').innerHTML = chipsHtml();
  const widgets = H.cfg.widgets || [];
  list.innerHTML = widgets
    .map((w) => {
      const def = REGISTRY[w.kind] || { name: w.kind, desc: '' };
      const cur = w.size || 'm';
      const allowed = def.sizes || ['m'];
      const seg = ['s', 'm', 'l']
        .map(
          (k) =>
            `<button data-act="size" data-id="${esc(w.id)}" data-size="${k}" class="${k === cur ? 'on' : ''}" ${
              allowed.includes(k) ? '' : 'disabled'
            }>${SIZE_LABEL[k]}</button>`
        )
        .join('');

      let meta = esc(def.desc || '');
      if (w.kind === 'weather') {
        meta = `${esc(H.cfg.weather?.admin || H.cfg.weather?.city || '未设置')}<br><em>双击桌面卡片可快速改地区</em>`;
      } else if (w.kind === 'clock') {
        meta = `显示秒：${H.cfg.show_seconds !== false ? '开' : '关'}<br><em>关掉秒后字号会自动放大一档</em>`;
      }

      const canRemove = widgets.length > 1;
      return `<div class="wrow" data-id="${esc(w.id)}">
          <div class="prev"><div class="sk">${def.preview ? def.preview(cur) : ''}</div></div>
          <div class="who"><b>${esc(def.name)}</b><span>${SIZE_LABEL[cur]}号 · ${dimsOf(cur).join('×')}</span></div>
          <div class="meta">${meta}</div>
          <div class="seg">${seg}</div>
          <button class="iconbtn danger" data-act="remove" data-id="${esc(w.id)}" title="${
            canRemove ? '移除组件' : '至少保留一个组件'
          }" ${canRemove ? '' : 'disabled'}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
          </button>
        </div>`;
    })
    .join('');
}

function sizesOf(kind) {
  return REGISTRY[kind]?.sizes || ['m'];
}

function renderGallery() {
  const tabs = $('#gtabs');
  if (!tabs) return;
  const counts = { s: 0, m: 0, l: 0 };
  for (const k of ORDER) for (const size of sizesOf(k)) counts[size]++;

  tabs.innerHTML = ['s', 'm', 'l']
    .map((k) => {
      const [w, h] = dimsOf(k);
      return `<button data-size-tab="${k}" class="${k === H.size ? 'on' : ''}" ${
        counts[k] ? '' : 'disabled'
      }>${SIZE_LABEL[k]}<em>${w}×${h}</em></button>`;
    })
    .join('');

  $('#gmat').innerHTML =
    `<span class="lab">材质</span>` +
    MATERIALS.map(
      ([k, label]) =>
        `<button class="matbtn ${k === H.cfg.material ? 'on' : ''}" data-setmat="${k}"><i></i>${label}</button>`
    ).join('');

  $('#ggrid').innerHTML = ORDER.filter((kind) => sizesOf(kind).includes(H.size))
    .map((kind) => {
      const d = REGISTRY[kind];
      return `<button class="gcard" data-kind="${kind}">
          <div class="gprev"><div class="sk">${d.preview ? d.preview(H.size) : ''}</div></div>
          <div class="gname">${esc(d.name)}<span class="add">＋ 添加</span></div>
          <div class="gdesc">${esc(d.desc || '')}</div>
        </button>`;
    })
    .join('');
}

function renderMaterialRows() {
  $('#matlist').innerHTML = MATERIALS.map(
    ([k, label, note]) =>
      `<button class="matrow ${k === H.cfg.material ? 'on' : ''}" data-setmat="${k}">
        <span class="sw sw-${k}"></span>
        <div><b>${label}</b><span>${note}</span></div>
        <span class="tick">✓</span>
      </button>`
  ).join('');
}

function renderSwitches() {
  const on = {
    autostart: H.autostart,
    auto_update: H.cfg.auto_update !== false,
    show_labels: H.cfg.show_labels !== false,
    show_seconds: H.cfg.show_seconds !== false,
    organizer: H.cfg.organizer?.enabled !== false
  };
  $$('[data-switch]').forEach((el) => {
    const key = el.dataset.switch;
    el.classList.toggle('on', !!on[key]);
    el.setAttribute('aria-checked', String(!!on[key]));
  });
}

function renderSettings() {
  const w = H.cfg.weather || {};
  $('#weather-lab').innerHTML = `${esc(w.admin || w.city || '未设置')}<small>${Number(w.lat).toFixed(2)}, ${Number(
    w.lon
  ).toFixed(2)} · 15 分钟刷新一次</small>`;

  renderMaterialRows();

  const scale = H.cfg.scale > 0 ? H.cfg.scale : 0;
  const opts = [
    [0, '自动'],
    [1, '1.0×'],
    [1.25, '1.25×'],
    [1.5, '1.5×']
  ];
  $('#scaleseg').innerHTML = opts
    .map(
      ([v, label]) =>
        `<button data-scale="${v}" class="${Math.abs(v - scale) < 0.001 ? 'on' : ''}">${label}</button>`
    )
    .join('');

  renderSwitches();
}

function renderLauncherFavorites() {
  const picked = $('#launcher-picked');
  const all = $('#launcher-all');
  if (!picked || !all) return;
  const favs = Array.isArray(H.cfg?.launcher_favorites) ? H.cfg.launcher_favorites : [];
  const entries = Array.isArray(H.entries) ? H.entries : [];
  const byId = (id) => entries.find((e) => e.id === id);
  const counter = $('#launcher-count');
  if (counter) counter.textContent = `${favs.length} / 10`;

  picked.innerHTML = favs.length
    ? favs
        .map((id, i) => {
          const e = byId(id);
          if (!e) return '';
          return `<div class="fav-row">
            <span class="fav-ico">${launcherSvg(e.icon)}</span>
            <span class="idx">${i + 1}</span>
            <span class="fav-name">${esc(e.name)}<small>${esc(e.cmd)}</small></span>
            <span class="ops">
              <button data-launch-move="-1" data-launch-id="${esc(id)}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
              <button data-launch-move="1" data-launch-id="${esc(id)}" ${i === favs.length - 1 ? 'disabled' : ''} title="下移">↓</button>
              <button data-launch-toggle="${esc(id)}" title="移出常用位">×</button>
            </span>
          </div>`;
        })
        .join('')
    : `<div class="fav-empty">还没有常用项，从下面挑 10 个。</div>`;

  all.innerHTML = entries
    .map((e) => {
      const on = favs.includes(e.id);
      return `<button class="all-entry ${on ? 'on' : ''}" data-launch-toggle="${esc(e.id)}">
        <span class="dotmark">${on ? '✓' : '+'}</span>
        <span class="nm">${esc(e.name)}<small>${esc(e.desc)}</small></span>
        <span class="tag">${esc(e.cat)}</span>
      </button>`;
    })
    .join('');
}

async function saveLauncherFavorites(list) {
  try {
    await invoke('set_launcher_favorites', { favorites: list });
    H.cfg.launcher_favorites = list;
    renderLauncherFavorites();
    return true;
  } catch (e) {
    toast(`保存常用项失败：${e?.message || e}`);
    return false;
  }
}

async function toggleLauncherEntry(id) {
  const favs = [...(H.cfg.launcher_favorites || [])];
  const i = favs.indexOf(id);
  if (i >= 0) {
    favs.splice(i, 1);
  } else {
    if (favs.length >= 10) return toast('最多 10 个常用位，先移出一个再加');
    favs.push(id);
  }
  if (await saveLauncherFavorites(favs)) toast(i >= 0 ? '已移出常用位' : '已加入常用位');
}

async function moveLauncherEntry(id, delta) {
  const favs = [...(H.cfg.launcher_favorites || [])];
  const i = favs.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= favs.length) return;
  const tmp = favs[i];
  favs[i] = favs[j];
  favs[j] = tmp;
  await saveLauncherFavorites(favs);
}

function renderGroups() {
  const list = $('#grouplist');
  if (!list) return;

  const groups = H.cfg.organizer?.groups || [];
  const counts = new Map((H.viewData?.groups || []).map((g) => [g.id, g.items?.length || 0]));
  const folder = new Map((H.viewData?.groups || []).map((g) => [g.id, g.folder]));

  $('#rootpath').textContent = H.viewData?.root || H.root || '默认（桌面\\fy-desktop）';
  $('#rootpath').title = H.viewData?.root || H.root || '';
  $('#group-count').textContent = String(groups.length);
  $('#item-count').textContent = String([...counts.values()].reduce((a, b) => a + b, 0));
  $('#nav-groups').textContent = String(groups.length);

  if (!groups.length) {
    list.innerHTML = `<div class="wrow"><div class="meta">还没有分组。新建一个之后，把桌面上的快捷方式拖进格子即可。</div></div>`;
    return;
  }

  list.innerHTML = groups
    .map((g, i) => {
      const n = counts.get(g.id) ?? 0;
      return `<div class="wrow" data-gid="${esc(g.id)}">
          <span class="dot" style="width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:${esc(g.color || '#8d9aa6')}"></span>
          <div class="who" style="width:auto;flex:1"><b>${esc(g.name)}</b><span>${n} 项</span></div>
          <button class="btn sm" data-act="rename" data-id="${esc(g.id)}">重命名</button>
          <button class="iconbtn" data-act="up" data-id="${esc(g.id)}" title="上移" ${i === 0 ? 'disabled' : ''}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 7.5L6 4.5l3 3"/></svg>
          </button>
          <button class="iconbtn" data-act="down" data-id="${esc(g.id)}" title="下移" ${i === groups.length - 1 ? 'disabled' : ''}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5L6 7.5l3-3"/></svg>
          </button>
          <button class="iconbtn" data-act="reveal" data-id="${esc(g.id)}" data-folder="${esc(folder.get(g.id) || '')}" title="在资源管理器中打开">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 5.5v7h11v-7"/><path d="M2 5.5l1.6-2h3l1 1.4h5.3l1.1 1.6"/></svg>
          </button>
          <button class="iconbtn danger" data-act="del" data-id="${esc(g.id)}" title="删除分组（内容移回桌面）">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
          </button>
        </div>`;
    })
    .join('');
}

function renderAbout() {
  $('#ver').textContent = `v${H.version}`;
  renderSwitches();
}

/* ============================ 事件 ============================ */

function bindEvents() {
  // 标题栏拖动：按钮之外按下都算拖窗口
  $('#tb').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    appWindow?.startDragging?.();
  });

  // 紧凑模式下标题栏被藏起来了，窗口里只剩一个弹窗，所以它的标题行就是抓手。
  // 拖弹窗 = 拖窗口（弹窗居中于窗口，视觉上跟着鼠标走）。
  // 主界面里的弹窗不启用：那里拖一下会把整个 900×620 的窗口带跑。
  document.addEventListener('mousedown', (e) => {
    if (!compact || e.button !== 0) return;
    if (!e.target.closest?.('.dlg-head')) return;
    if (e.target.closest('button')) return;
    appWindow?.startDragging?.();
  });

  $('#btn-min').onclick = () => appWindow?.minimize?.();
  $('#btn-close').onclick = () => hideHub();
  $('#btn-quit').onclick = () => invoke('quit_app');
  $('#btn-check').onclick = () => (H.update?.has_update ? installUpdate() : checkUpdate());

  document.addEventListener('click', async (e) => {
    // 导航 / 「完成」
    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) return setView(viewBtn.dataset.view);

    // 组件库尺寸分档
    const tab = e.target.closest('[data-size-tab]');
    if (tab) {
      H.size = tab.dataset.sizeTab;
      return renderGallery();
    }

    // 材质（组件库与设置页共用）
    const mat = e.target.closest('[data-setmat]');
    if (mat) return setMaterial(mat.dataset.setmat);

    // 缩放
    const scale = e.target.closest('[data-scale]');
    if (scale) return setScale(Number(scale.dataset.scale));

    // 开关
    const sw = e.target.closest('[data-switch]');
    if (sw) return toggleSwitch(sw.dataset.switch);

    // 添加组件卡片
    const card = e.target.closest('.gcard');
    if (card) return addWidget(card.dataset.kind);

    // 系统入口常用项
    const toggleEntry = e.target.closest('[data-launch-toggle]');
    if (toggleEntry) return toggleLauncherEntry(toggleEntry.dataset.launchToggle);
    const moveEntry = e.target.closest('[data-launch-move]');
    if (moveEntry) return moveLauncherEntry(moveEntry.dataset.launchId, Number(moveEntry.dataset.launchMove));

    // 具体动作
    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const act = actEl.dataset.act;
    const id = actEl.dataset.id;

    if (act === 'add') return setView('gallery');
    if (act === 'launcher-reset') {
      if (await saveLauncherFavorites([])) toast('已恢复默认 10 个常用项');
      return;
    }
    if (act === 'weather') return openWeatherDialog();
    if (act === 'new-group') return openGroupDialog('create');
    if (act === 'refresh-glass') {
      send({ type: 'refresh-glass' });
      return toast('正在重抓桌面底图…');
    }
    if (act === 'config-dir') return guardOpen(invoke('open_config_dir'));
    if (act === 'open-root') return guardOpen(invoke('open_root'));
    if (act === 'repo') return guardOpen(invoke('open_url', { url: `${REPO}/releases` }));
    if (act === 'size') {
      const w = H.cfg.widgets.find((x) => x.id === id);
      if (!w || w.size === actEl.dataset.size) return;
      send({ type: 'set-size', id, size: actEl.dataset.size });
      w.size = actEl.dataset.size;
      w.w = dimsOf(w.size)[0];
      w.h = dimsOf(w.size)[1];
      return renderWidgets();
    }
    if (act === 'remove') {
      if (H.cfg.widgets.length <= 1) return toast('至少保留一个组件');
      send({ type: 'remove-widget', id });
      H.cfg.widgets = H.cfg.widgets.filter((x) => x.id !== id);
      return renderWidgets();
    }
    if (act === 'rename') {
      const g = H.cfg.organizer.groups.find((x) => x.id === id);
      return openGroupDialog('rename', g);
    }
    if (act === 'up' || act === 'down') {
      return moveGroup(id, act === 'up' ? -1 : 1);
    }
    if (act === 'reveal') {
      const folder = actEl.dataset.folder;
      if (folder) guardOpen(invoke('open_path', { path: folder }));
      return;
    }
    if (act === 'del') {
      const g = H.cfg.organizer.groups.find((x) => x.id === id);
      const n = (H.viewData?.groups || []).find((x) => x.id === id)?.items?.length || 0;
      return confirmDelete(g, n);
    }
  });

  // 键盘：Esc 关弹层 / 关窗口；开关支持空格
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (H.dialog) return closeDialog();
      return hideHub();
    }
    const sw = e.target.closest?.('[data-switch]');
    if (sw && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      toggleSwitch(sw.dataset.switch);
    }
  });

  listen('hub:intent', (e) => handleIntent(e.payload));
  listen('config:changed', (e) => {
    const p = e.payload;
    if (!p) return;
    const before = cfgSig(H.cfg);
    const matBefore = H.cfg?.material;
    H.cfg = p;
    H.autostart = p.autostart ?? H.autostart;
    applyMaterial();
    // 这条事件多半是「我们自己刚发出去的操作，桌面执行完又广播回来」。
    // 结构没变就只同步颜色和开关：否则每点一次开关/材质都重绘整个窗口。
    if (before === cfgSig(p)) {
      if (matBefore !== p.material) renderMaterialRows();
      renderSwitches();
      return;
    }
    renderAll();
  });
  // 后端命令改完分组/文件后会推 desktop:changed 给桌面窗口；控制中心自己再拉一次
  listen('desktop:changed', () => refreshDesktop());
}

function hideHub() {
  invoke('hide_hub').catch(() => {});
}

function send(action) {
  invoke('hub_action', { action }).catch((err) => toast(`操作失败：${err?.message || err}`));
}

function guardOpen(p) {
  return Promise.resolve(p).catch((err) => toast(`打开失败：${err?.message || err}`));
}

async function refreshDesktop() {
  try {
    H.viewData = await invoke('desktop_view');
  } catch (e) {
    console.warn('[hub] 读取桌面失败', e);
    H.viewData = null;
  }
  renderGroups();
  renderSide();
}

/* ============================ 动作 ============================ */

function addWidget(kind) {
  send({ type: 'add-widget', kind, size: H.size, material: '' });
  const def = REGISTRY[kind];
  toast(`已添加「${def?.name || kind}」${SIZE_LABEL[H.size]}号`);
}

function setMaterial(mat) {
  if (!MATERIAL_KEYS.includes(mat) || mat === H.cfg.material) return;
  H.cfg.material = mat;
  // 换材质只是换一组 CSS 变量。整窗重绘（所有页面 + 21 张预览卡 + 分组列表）
  // 除了让点击迟滞一下没有别的收益，这里只刷材质行自己的选中态。
  applyMaterial();
  renderMaterialRows();
  send({ type: 'set-material', material: mat });
}

function setScale(v) {
  if (Math.abs((H.cfg.scale || 0) - v) < 0.001) return;
  H.cfg.scale = v;
  renderSettings();
  renderWidgets();
  send({ type: 'set-scale', scale: v });
}

async function toggleSwitch(key) {
  if (key === 'autostart') {
    const want = !H.autostart;
    try {
      const real = await invoke('set_autostart', { on: want });
      H.autostart = !!real;
      H.cfg.autostart = !!real;
      renderSwitches();
      toast(real ? '已开启开机自启' : '已关闭开机自启');
    } catch (e) {
      toast(`开机自启设置失败：${e?.message || e}`);
    }
    return;
  }
  if (key === 'auto_update') {
    const want = H.cfg.auto_update === false;
    try {
      await invoke('set_auto_update', { on: want });
      H.cfg.auto_update = want;
      renderSwitches();
      toast(want ? '已开启自动检查更新' : '已关闭自动检查更新');
    } catch (e) {
      toast(`设置失败：${e?.message || e}`);
    }
    return;
  }
  if (key === 'show_labels') {
    H.cfg.show_labels = H.cfg.show_labels === false;
    renderWidgets();
    renderSwitches();
    send({ type: 'set-labels', on: H.cfg.show_labels });
    return;
  }
  if (key === 'show_seconds') {
    H.cfg.show_seconds = H.cfg.show_seconds === false;
    renderWidgets();
    renderSwitches();
    send({ type: 'set-seconds', on: H.cfg.show_seconds });
    return;
  }
  // 桌面收纳面板的显示开关：只影响面板显不显示，分组与磁盘文件都不动
  if (key === 'organizer') {
    if (!H.cfg.organizer) return;
    const want = H.cfg.organizer.enabled === false;
    H.cfg.organizer.enabled = want;
    renderSwitches();
    send({ type: 'set-organizer', on: want });
    toast(want ? '桌面已显示收纳面板' : '桌面收纳已移除，分组和文件都还在');
  }
}

async function moveGroup(id, delta) {
  try {
    await invoke('move_group', { id, delta });
  } catch (e) {
    toast(`调整顺序失败：${e?.message || e}`);
  }
}

/* ============================ 弹层 ============================ */

/**
 * 通用弹层。onOk 返回 false 表示「不关闭」（表单校验失败时用）。
 */
function openDialog(opts) {
  // 换弹窗 ≠ 关弹窗：拆掉旧的那个时不能让它把窗口一起收起来。
  // 走 closeDialog() 会在紧凑模式下调 hide_hub，于是从「天气地区」点开
  // 「新建分组」时整个窗口直接消失，看起来就是闪退。
  H.dialog?.close(null, false);
  const layer = $('#dialog');
  layer.hidden = false;
  layer.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
      <div class="dlg-head">
        <div>
          <h3>${esc(opts.title)}</h3>
          ${opts.desc ? `<p>${esc(opts.desc)}</p>` : ''}
        </div>
        <button class="dlg-x" data-x title="关闭 (Esc)" aria-label="关闭">
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
        </button>
      </div>
      <div class="dlg-body">${opts.body || ''}</div>
      <div class="dlg-foot">
        <button class="btn" data-cancel>取消</button>
        ${opts.okText ? `<button class="btn primary ${opts.danger ? 'dlg-danger' : ''}" data-ok>${esc(opts.okText)}</button>` : ''}
      </div>
    </div>`;

  const box = layer.querySelector('.dlg');

  const close = (v, hideWindow = true) => {
    layer.hidden = true;
    layer.innerHTML = '';
    layer.onmousedown = null;
    H.dialog = null;
    // 紧凑模式下弹窗就是窗口的全部内容，关掉它窗口也该收起来。
    // 但换弹窗不是关窗：openDialog 传 false 把窗口留住。
    if (compact && hideWindow) exitCompact();
    opts.onClose?.(v);
  };
  H.dialog = { close };

  layer.onmousedown = (e) => {
    if (e.target === layer) close(null);
  };
  box.querySelector('[data-x]').onclick = () => close(null);
  box.querySelector('[data-cancel]').onclick = () => close(null);
  box.querySelector('[data-ok]')?.addEventListener('click', async () => {
    const ok = await opts.onOk?.(box, close);
    if (ok !== false) close(ok ?? true);
  });

  // 单行输入里回车 = 确定；搜索框自己处理回车（stopPropagation）
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      box.querySelector('[data-ok]')?.click();
    }
  });

  requestAnimationFrame(() => {
    const input = box.querySelector('input');
    if (input) {
      input.focus();
      input.select();
    }
  });

  return { close };
}

function closeDialog() {
  H.dialog?.close(null);
}

function openWeatherDialog() {
  const cur = H.cfg.weather || {};
  openDialog({
    title: '设置天气地区',
    desc: '支持省 / 市 / 区县，如「西湖区」。回车搜索，选中即生效。',
    body: `
      <div class="dlg-row">
        <input class="dlg-input" id="place-q" placeholder="输入地名" value="${esc(cur.city || '')}" />
        <button class="btn primary" data-search>搜索</button>
      </div>
      <div class="dlg-list" id="place-list"><div class="dlg-tip">搜索后从列表里选一个地区。</div></div>`,
    okText: '',
    onOk: null
  });

  const box = H.dialog;
  const layerBox = $('#dialog .dlg');
  const input = layerBox.querySelector('#place-q');
  const list = layerBox.querySelector('#place-list');
  const searchBtn = layerBox.querySelector('[data-search]');

  const search = async () => {
    const q = input.value.trim();
    if (!q) return;
    list.innerHTML = `<div class="dlg-tip">搜索中…</div>`;
    let rows = [];
    try {
      rows = await invoke('geo_search', { q });
    } catch (err) {
      list.innerHTML = `<div class="dlg-tip">搜索失败：${esc(String(err?.message || err))}</div>`;
      return;
    }
    if (!rows.length) {
      list.innerHTML = `<div class="dlg-tip">没找到「${esc(q)}」。试试只留区县名，如「西湖区」。</div>`;
      return;
    }
    list.innerHTML = rows
      .map(
        (p, i) => `<button class="place-item" data-i="${i}">
          <b>${esc(p.name)}</b><span>${esc(p.label)}</span>
        </button>`
      )
      .join('');
    list.querySelectorAll('.place-item').forEach((btn) => {
      btn.onclick = async () => {
        const p = rows[Number(btn.dataset.i)];
        box.close(null);
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

  searchBtn.onclick = search;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      search();
    }
  });
}

function openGroupDialog(mode, g) {
  const rename = mode === 'rename';
  openDialog({
    title: rename ? '重命名分组' : '新建分组',
    desc: rename ? '改的是磁盘上的文件夹名，里面的文件会一起跟着改。' : '分组名就是文件夹名，之后也能再改。',
    body: `
      <input class="dlg-input" id="grp-name" placeholder="例如：设计素材" value="${esc(g?.name || '')}" maxlength="40" />
      <div class="dlg-err" id="grp-err" hidden></div>`,
    okText: rename ? '保存' : '创建',
    onOk: async (box) => {
      const input = box.querySelector('#grp-name');
      const err = box.querySelector('#grp-err');
      const name = input.value.trim();
      if (!name) {
        err.hidden = false;
        err.textContent = '分组名不能为空';
        input.focus();
        return false;
      }
      try {
        if (rename) {
          await invoke('rename_group', { id: g.id, name });
          toast(`已改名为「${name}」`);
        } else {
          await invoke('create_group', { name });
          toast(`已新建分组「${name}」`);
        }
        refreshDesktop();
        return true;
      } catch (e) {
        err.hidden = false;
        err.textContent = String(e?.message || e);
        return false;
      }
    }
  });
}

function confirmDelete(g, n) {
  if (!g) return;
  openDialog({
    title: '删除分组',
    desc: '分组里的项目会先移回桌面，不会删除任何文件。',
    body: `<div class="dlg-tip">「${esc(g.name)}」里的 ${n} 项会移回桌面，然后删除这个分组。</div>`,
    okText: '删除并移回桌面',
    danger: true,
    onOk: async () => {
      try {
        const moved = await invoke('delete_group', { id: g.id });
        toast(moved ? `已移出 ${moved} 项并删除分组` : '分组已删除');
        refreshDesktop();
        return true;
      } catch (e) {
        toast(`删除失败：${e?.message || e}`);
        return false;
      }
    }
  });
}

/* ============================ 关于 / 更新 ============================ */

const REPO = 'https://github.com/fsdymy1024/fy-desktop';

function plain(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]+/g, '')
    .replace(/\r/g, '')
    .trim()
    .slice(0, 600);
}

function sizeText(n) {
  if (!n) return '';
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`;
}

async function checkUpdate() {
  const btn = $('#btn-check');
  btn.disabled = true;
  btn.textContent = '检查中…';
  $('#upd-title').textContent = '正在连接 GitHub…';
  $('#upd-note').textContent = '';
  try {
    const u = await invoke('check_update');
    if (u.error) {
      H.update = null;
      $('#upd-title').textContent = '检查失败';
      $('#upd-note').textContent = u.error;
      return;
    }
    if (!u.has_update) {
      H.update = null;
      $('#upd-title').textContent = `已是最新版本 v${u.latest || H.version}`;
      $('#upd-note').textContent = u.published ? `发布于 ${u.published}` : '更新源里没有更新的版本';
      return;
    }
    H.update = u;
    $('#upd-title').textContent = `发现新版本 v${u.latest}${u.published ? ` · ${u.published}` : ''}`;
    $('#upd-note').textContent = plain(u.notes) || '可以下载并安装。';
    btn.textContent = u.asset ? `下载并安装${u.size ? ` · ${sizeText(u.size)}` : ''}` : '打开发布页';
  } catch (e) {
    H.update = null;
    $('#upd-title').textContent = '检查失败';
    $('#upd-note').textContent = String(e?.message || e);
  } finally {
    btn.disabled = false;
    if (!H.update?.has_update) btn.textContent = '检查更新';
  }
}

async function installUpdate() {
  const u = H.update;
  if (!u) return;
  if (!u.asset) {
    guardOpen(invoke('open_url', { url: u.page || `${REPO}/releases` }));
    return;
  }
  const btn = $('#btn-check');
  btn.disabled = true;
  $('#upd-title').textContent = `正在下载 v${u.latest}`;
  $('#upd-note').innerHTML = '';

  const un = await listen('update:download', ({ payload }) => {
    const p = payload || {};
    const pct = p.total ? Math.min(100, Math.round((p.downloaded / p.total) * 100)) : 0;
    const right = p.total
      ? `${pct}% · ${sizeText(p.downloaded)} / ${sizeText(p.total)}`
      : sizeText(p.downloaded);
    $('#upd-note').innerHTML = `<i class="dl-bar"><b style="width:${p.done ? 100 : pct}%"></b></i><span class="dl-note">${right}</span>`;
  }).catch(() => null);

  try {
    const path = await invoke('download_update', { asset: u.asset, version: u.latest });
    $('#upd-title').textContent = '下载完成，正在启动安装程序';
    $('#upd-note').textContent = '程序会自动退出，装完再打开即可。';
    await invoke('install_update', { path });
  } catch (e) {
    $('#upd-title').textContent = '更新失败';
    $('#upd-note').textContent = String(e?.message || e);
    btn.disabled = false;
  } finally {
    un?.();
  }
}

/* ============================ 意图 / 提示 ============================ */

function handleIntent(it) {
  if (!it || typeof it !== 'object') return;
  // 紧凑弹窗还开着时又从托盘喊了主界面：先还原成完整窗口
  const d = it.dialog;
  if (compact && (!d || typeof d !== 'object')) exitCompact(false);
  if (it.view) setView(it.view);
  if (!d || typeof d !== 'object') return;
  if (d.type === 'weather') openWeatherDialog();
  else if (d.type === 'groupCreate') openGroupDialog('create');
  else if (d.type === 'groupRename') {
    const g = H.cfg.organizer?.groups?.find((x) => x.id === d.id) || { id: d.id, name: d.name || '' };
    openGroupDialog('rename', g);
  } else {
    return;
  }
  // 桌面点出来的「一次性弹窗」：只要那个小框，不把主界面一起带上来
  if (d.compact) enterCompact();
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = String(msg);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

/* ============================ 入口 ============================ */

boot().catch((err) => {
  console.error('[hub] 启动失败', err);
  invoke('hub_log', { msg: `boot failed: ${err?.message || err}` }).catch(() => {});
  document.body.innerHTML = `<div class="noscript">控制中心启动失败：${esc(err?.message || err)}<br>可关闭窗口后从托盘重新打开。</div>`;
});
