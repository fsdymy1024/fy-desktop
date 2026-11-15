'use strict';

/**
 * 托盘：桌面小组件没有主窗口，托盘就是唯一入口。
 * 菜单项与配置双向同步——任何一次点击都会重算配置再重建菜单。
 */

const path = require('node:path');
const { app, Menu, Tray, nativeImage, shell } = require('electron');
const store = require('./store');
const win = require('./window');

let tray = null;

const MAT_LABEL = { follow: '跟随', dusk: '暮色', tone: '原色' };

function iconPath() {
  return path.join(__dirname, '..', '..', 'assets', 'tray.png');
}

function build({ onRescan } = {}) {
  const cfg = store.load();
  const visible = win.get()?.isVisible() ?? true;

  const template = [
    { label: 'fy-desktop', enabled: false },
    { type: 'separator' },
    {
      label: visible ? '隐藏小组件' : '显示小组件',
      click: () => {
        win.toggleVisible();
        rebuild({ onRescan });
      }
    },
    {
      label: '编辑布局',
      type: 'checkbox',
      checked: Boolean(cfg.editMode),
      click: (item) => {
        store.patch({ editMode: item.checked });
        win.setEditMode(item.checked);
        win.send('ui:editMode', item.checked);
      }
    },
    {
      label: '材质',
      submenu: Object.entries(MAT_LABEL).map(([key, label]) => ({
        label,
        type: 'radio',
        checked: cfg.material === key,
        click: () => {
          store.patch({ material: key });
          win.send('ui:material', key);
          rebuild({ onRescan });
        }
      }))
    },
    { type: 'separator' },
    {
      label: '重新扫描桌面',
      click: () => {
        win.send('desk:refresh');
        if (onRescan) onRescan();
      }
    },
    {
      label: '打开收纳目录',
      click: () => {
        const dir = require('./services/shortcuts').tidyDir();
        require('node:fs').mkdirSync(dir, { recursive: true });
        shell.openPath(dir);
      }
    },
    {
      label: '打开配置目录',
      click: () => shell.openPath(app.getPath('userData'))
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
      }
    },
    { type: 'separator' },
    {
      label: '重置布局',
      click: () => {
        const fresh = store.DEFAULTS.layout;
        store.patch({ layout: JSON.parse(JSON.stringify(fresh)) });
        win.send('ui:resetLayout');
      }
    },
    { label: '退出 fy-desktop', click: () => { app.quit(); } }
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function rebuild(opts) {
  if (!tray) return;
  build(opts);
}

function create() {
  const img = nativeImage.createFromPath(iconPath());
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('fy-desktop · 桌面小组件');
  tray.on('click', () => {
    win.toggleVisible();
    rebuild();
  });
  build();
  return tray;
}

module.exports = { create, rebuild };
