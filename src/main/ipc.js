'use strict';

/**
 * IPC 总线 + 采样调度
 * 渲染层只做展示，所有真实数据都从这里推送过去。
 */

const { ipcMain, app, shell } = require('electron');
const store = require('./store');
const win = require('./window');
const sysMon = require('./services/system');
const shortcuts = require('./services/shortcuts');
const weather = require('./services/weather');
const { NetworkMonitor } = require('./services/network');
const layoutMod = require('./layout');

let net = null;
const timers = {};

function start() {
  const cfg = store.load();

  // 系统指标 1s
  timers.sys = setInterval(async () => {
    const snap = await sysMon.snapshot();
    win.send('sys:tick', snap);
  }, 1000);
  sysMon.snapshot().then(s => win.send('sys:tick', s));

  // 网络 2s
  net = new NetworkMonitor({
    host: cfg.widgets.network.host,
    port: cfg.widgets.network.port,
    interval: 2000
  });
  net.start(snap => win.send('net:tick', snap));
  // 首次立刻采一次，别让组件空着等 2 秒
  net.sample().then(snap => win.send('net:tick', snap));

  // 天气 15min
  const pullWeather = async () => {
    const w = store.load().widgets.weather;
    const data = await weather.fetchWeather(w.lat, w.lon, w.city);
    win.send('weather:data', data);
  };
  pullWeather();
  timers.weather = setInterval(pullWeather, 15 * 60 * 1000);
}

function stop() {
  Object.values(timers).forEach(clearInterval);
  if (net) net.stop();
}

function register() {
  /* ---------- 渲染层就绪 ---------- */
  ipcMain.handle('app:boot', () => {
    const cfg = store.load();
    shortcuts.autoAssign();

    // 首次启动或从未拖动过布局时，按当前屏幕重新算一遍
    if (cfg.layoutAuto) {
      const area = win.bounds();
      const z = win.zoom();
      const layout = layoutMod.defaults(area.width / z, area.height / z);
      store.patch({ layout });
      cfg.layout = layout;
    }
    return {
      config: cfg,
      version: app.getVersion(),
      platform: process.platform,
      desktopDirs: shortcuts.desktopDirs(),
      tidyDir: shortcuts.tidyDir()
    };
  });

  /* ---------- 鼠标穿透 ---------- */
  ipcMain.on('ui:interactive', (_e, on) => {
    const cfg = store.load();
    if (cfg.editMode) return; // 编辑模式下始终可交互
    win.setClickThrough(!on);
  });

  ipcMain.handle('ui:setMaterial', (_e, material) => {
    store.patch({ material });
    require('./tray').rebuild();
    return true;
  });

  ipcMain.handle('ui:setEditMode', (_e, on) => {
    store.patch({ editMode: Boolean(on) });
    win.setEditMode(Boolean(on));
    return true;
  });

  ipcMain.handle('ui:saveLayout', (_e, layout) => {
    // 用户手动拖过之后就不再自动重排，否则下次启动会「跳回去」
    store.patch({ layout, layoutAuto: false });
    return true;
  });

  ipcMain.handle('ui:resetLayout', () => {
    const area = win.bounds();
    const z = win.zoom();
    const layout = layoutMod.defaults(area.width / z, area.height / z);
    store.patch({ layout, layoutAuto: true });
    return layout;
  });

  ipcMain.handle('ui:toggleWidget', (_e, id, visible) => {
    store.patch({ widgets: { [id]: { visible: Boolean(visible) } } });
    return true;
  });

  ipcMain.handle('notes:update', (_e, items) => {
    store.patch({ widgets: { notes: { items } } });
    return true;
  });

  /* ---------- 桌面条目 ---------- */
  ipcMain.handle('desk:list', () => shortcuts.grouped());
  ipcMain.handle('desk:open', (_e, p) => shortcuts.open(p));
  ipcMain.handle('desk:reveal', (_e, p) => shortcuts.reveal(p));
  ipcMain.handle('desk:assign', (_e, p, gid) => {
    const r = shortcuts.assign(p, gid);
    win.send('desk:refresh');
    return r;
  });
  ipcMain.handle('desk:plan', () => shortcuts.planTidy());
  ipcMain.handle('desk:tidy', async () => {
    const r = await shortcuts.tidy();
    win.send('desk:refresh');
    return r;
  });
  ipcMain.handle('desk:restore', async () => {
    const r = await shortcuts.restore();
    win.send('desk:refresh');
    return r;
  });
  ipcMain.handle('desk:openTidyDir', () => {
    const dir = shortcuts.tidyDir();
    require('node:fs').mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return dir;
  });

  /* ---------- 天气 ---------- */
  ipcMain.handle('weather:get', async () => {
    const w = store.load().widgets.weather;
    return weather.fetchWeather(w.lat, w.lon, w.city);
  });

  /* ---------- 网络 ---------- */
  ipcMain.handle('net:snapshot', () => (net ? net.snapshot() : null));

  /* ---------- 应用 ---------- */
  ipcMain.handle('app:quit', () => app.quit());
}

module.exports = { register, start, stop };
