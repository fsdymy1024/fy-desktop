'use strict';

/**
 * 主进程入口
 * 组装顺序：配置 → 窗口 → IPC/采样 → 托盘
 * 没有主窗口概念，关闭任一窗口都不退出；退出只走托盘菜单。
 */

const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const store = require('./store');
const win = require('./window');
const ipc = require('./ipc');
const tray = require('./tray');

const isDev = process.argv.includes('--dev');
const SHOT = process.env.FY_SHOT; // 截图自检：FY_SHOT=path/to.png npm run shot
if (SHOT) app.commandLine.appendSwitch('force-device-scale-factor', '1');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = win.get();
    if (w) {
      if (!w.isVisible()) w.showInactive();
      w.focus();
    }
  });

  // 透明窗口在部分显卡驱动上需要关掉 GPU 合成才稳定，配置项留给用户排查
  if (process.env.FY_NO_GPU === '1') app.disableHardwareAcceleration();

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.fy.desktop');

    store.load();
    win.create();
    ipc.register();
    ipc.start();
    tray.create();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win.create();
    });

    if (isDev) win.get()?.webContents.openDevTools({ mode: 'detach' });

    // 截图自检：等首帧渲染稳定后抓一张再退出，用于无人工验证 UI
    if (SHOT) {
      const w = win.get();
      w.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            // FY_SHOT_RECT="x,y,w,h" 可只截局部，便于放大看细节
            let rect;
            if (process.env.FY_SHOT_RECT) {
              const [x, y, width, height] = process.env.FY_SHOT_RECT.split(',').map(Number);
              rect = { x, y, width, height };
            }
            // 同时落一份布局数据，便于无人值守时核对坐标
            try {
              const meta = await w.webContents.executeJavaScript(`JSON.stringify({
                inner: [innerWidth, innerHeight],
                dpr: devicePixelRatio,
                widgets: [...document.querySelectorAll('[data-widget]')].map(el => {
                  const r = el.getBoundingClientRect();
                  return [el.id, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
                })
              })`);
              require('node:fs').writeFileSync(SHOT.replace(/\.png$/, '') + '.json', meta);
            } catch (e) { console.error('[shot] meta failed', e.message); }

            let img = await w.capturePage(rect);
            // 整屏截图缩到 1920 宽，避免仓库里塞一张 4K 大图；局部截图保留原始像素
            if (!rect) img = img.resize({ width: 1920, quality: 'best' });
            require('node:fs').writeFileSync(SHOT, img.toPNG());
            console.log('[shot] saved', SHOT);
          } catch (err) {
            console.error('[shot] failed', err.message);
          }
          app.quit();
        }, 7000);
      });
    }
  });

  // 托盘常驻：窗口全关也不退出
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    ipc.stop();
    store.flush();
  });
}

process.on('uncaughtException', (err) => {
  console.error('[fy-desktop] 未捕获异常:', err);
  try {
    dialog.showErrorBox('fy-desktop 出错', `${err.message}\n\n${err.stack || ''}`);
  } catch { /* ignore */ }
});
