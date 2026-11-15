'use strict';

/**
 * 桌面层窗口
 * ------------------------------------------------------------------
 * 一块铺满工作区、完全透明的画布：
 *  - 无边框 / 无阴影 / 不上任务栏
 *  - 默认整窗穿透（forward:true），鼠标移到小组件上时才收回穿透，
 *    这样桌面图标、右键菜单照常可用，不会出现「点不到桌面」的经典坑
 *  - 点击「显示桌面」时窗口会被系统最小化，这里立刻恢复，保持常驻观感
 */

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');

let win = null;
let clickThrough = true;
let zoomFactor = 1;

function bounds() {
  const display = screen.getPrimaryDisplay();
  return display.workArea;
}

/**
 * 4K / 2K 屏上若照搬 1440 设计稿的像素值，组件会小得像贴纸。
 * 按屏宽等比放大，上限 1.75，避免在超宽屏上大到失真。
 */
function computeZoom(width) {
  return Math.max(1, Math.min(1.75, width / 1920));
}

function create() {
  if (win && !win.isDestroyed()) return win;
  const area = bounds();

  win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  zoomFactor = computeZoom(area.width);
  // 必须在导航完成后设置，否则会被 loadFile 重置回 1
  win.webContents.on('dom-ready', () => {
    win.webContents.setZoomFactor(zoomFactor);
  });
  win.setMenuBarVisibility(false);
  // #demo 只在截图/文档时加一层演示壁纸，真实运行保持完全透明
  const hash = process.env.FY_DEMO_BG ? 'demo' : undefined;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), hash ? { hash } : undefined);

  // showInactive：启动时不抢焦点，鼠标还在别处就继续在别处
  win.once('ready-to-show', () => {
    win.showInactive();
    setClickThrough(true);
  });

  // Win + D / 显示桌面 会把窗口最小化，立刻拉回来
  win.on('minimize', () => {
    if (!win || win.isDestroyed()) return;
    win.restore();
  });

  // 显示器分辨率变化时重新铺满
  screen.on('display-metrics-changed', () => {
    if (!win || win.isDestroyed()) return;
    const a = bounds();
    win.setBounds({ x: a.x, y: a.y, width: a.width, height: a.height });
  });

  win.on('closed', () => { win = null; });
  return win;
}

function get() {
  return win && !win.isDestroyed() ? win : null;
}

/** 穿透开关：true = 鼠标事件穿过窗口落到桌面 */
function setClickThrough(on) {
  const w = get();
  if (!w) return;
  if (on === clickThrough) return;
  clickThrough = on;
  if (on) w.setIgnoreMouseEvents(true, { forward: true });
  else w.setIgnoreMouseEvents(false);
}

/** 编辑模式：临时置顶并完全接管鼠标，方便拖拽 */
function setEditMode(on) {
  const w = get();
  if (!w) return;
  if (on) {
    w.setAlwaysOnTop(true, 'floating');
    setClickThrough(false);
  } else {
    w.setAlwaysOnTop(false);
    setClickThrough(true);
  }
}

function toggleVisible() {
  const w = get();
  if (!w) return false;
  if (w.isVisible()) w.hide();
  else w.showInactive();
  return w.isVisible();
}

function send(channel, payload) {
  const w = get();
  if (w && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
}

module.exports = {
  create, get, setClickThrough, setEditMode, toggleVisible, send, bounds,
  zoom: () => zoomFactor
};
