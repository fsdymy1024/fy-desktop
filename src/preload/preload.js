'use strict';

/**
 * 预加载：只暴露白名单方法，渲染层拿不到 Node。
 * 事件订阅同样走白名单，避免任意 channel 注入。
 */

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'sys:tick',
  'net:tick',
  'weather:data',
  'ui:material',
  'ui:editMode',
  'ui:resetLayout',
  'desk:refresh'
]);

contextBridge.exposeInMainWorld('fy', {
  /* 启动 */
  boot: () => ipcRenderer.invoke('app:boot'),

  /* 窗口交互 */
  setInteractive: (on) => ipcRenderer.send('ui:interactive', Boolean(on)),
  setMaterial: (m) => ipcRenderer.invoke('ui:setMaterial', m),
  setEditMode: (on) => ipcRenderer.invoke('ui:setEditMode', Boolean(on)),
  saveLayout: (layout) => ipcRenderer.invoke('ui:saveLayout', layout),
  resetLayout: () => ipcRenderer.invoke('ui:resetLayout'),
  toggleWidget: (id, visible) => ipcRenderer.invoke('ui:toggleWidget', id, visible),
  notesUpdate: (items) => ipcRenderer.invoke('notes:update', items),

  /* 桌面条目 */
  deskList: () => ipcRenderer.invoke('desk:list'),
  deskOpen: (p) => ipcRenderer.invoke('desk:open', p),
  deskReveal: (p) => ipcRenderer.invoke('desk:reveal', p),
  deskAssign: (p, gid) => ipcRenderer.invoke('desk:assign', p, gid),
  deskPlan: () => ipcRenderer.invoke('desk:plan'),
  deskTidy: () => ipcRenderer.invoke('desk:tidy'),
  deskRestore: () => ipcRenderer.invoke('desk:restore'),
  openTidyDir: () => ipcRenderer.invoke('desk:openTidyDir'),

  /* 数据 */
  weatherGet: () => ipcRenderer.invoke('weather:get'),
  netSnapshot: () => ipcRenderer.invoke('net:snapshot'),

  /* 应用 */
  quit: () => ipcRenderer.invoke('app:quit'),

  /* 事件 */
  on: (channel, handler) => {
    if (!EVENTS.has(channel)) return () => {};
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});
