'use strict';

/**
 * 配置持久化
 * 位置：%APPDATA%/fy-desktop/config.json
 * 原则：只做浅合并 + 布局校验，坏掉的字段回退到默认值，不让配置损坏拖垮启动。
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const CONFIG_VERSION = 1;

const DEFAULT_LAYOUT = {
  weather:   { x: 44,  y: 44,  w: 352, h: 150 },
  clock:     { x: 44,  y: 210, w: 168, h: 168 },
  calendar:  { x: 228, y: 210, w: 168, h: 168 },
  system:    { x: 44,  y: 394, w: 352, h: 150 },
  network:   { x: 44,  y: 560, w: 352, h: 150 },
  notes:     { x: 44,  y: 726, w: 352, h: 112 },
  organizer: { x: 640, y: 44,  w: 756, h: 0 }
};

const DEFAULTS = {
  version: CONFIG_VERSION,
  material: 'follow',
  editMode: false,
  widgets: {
    weather:   { visible: true, city: '上海', lat: 31.2304, lon: 121.4737 },
    clock:     { visible: true, style: 'analog' },
    calendar:  { visible: true },
    system:    { visible: true },
    network:   { visible: true, host: '223.5.5.5', port: 443 },
    notes:     { visible: true, items: [
      { text: '把桌面快捷方式收进格子', done: true },
      { text: '调整天气组件位置', done: true },
      { text: '给「设计素材」换个暮色材质', done: false }
    ] }
  },
  layout: DEFAULT_LAYOUT,
  layoutAuto: true,
  organizer: {
    visible: true,
    columns: 8,
    collapsed: [],
    groups: [
      { id: 'dev',     name: '开发工具', color: '#2b7de9' },
      { id: 'design',  name: '设计素材', color: '#8a5cf5' },
      { id: 'docs',    name: '常用文档', color: '#ef8b21' },
      { id: 'archive', name: '归档',     color: '#8d9aa6', folded: true }
    ],
    // 快捷方式 -> 分组 id；未记录的进「待整理」
    assignments: {},
    autoAssigned: false, // 首次扫描时按关键词自动归类一次
    tidyDir: '' // 空 = 桌面下 fy-desktop 收纳区
  }
};

let cache = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function mergeLayout(saved) {
  const out = clone(DEFAULT_LAYOUT);
  if (!saved || typeof saved !== 'object') return out;
  for (const key of Object.keys(out)) {
    const s = saved[key];
    if (!s) continue;
    for (const dim of ['x', 'y', 'w', 'h']) {
      if (Number.isFinite(s[dim])) out[key][dim] = s[dim];
    }
  }
  return out;
}

function sanitize(raw) {
  const base = clone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return base;

  base.material = ['follow', 'dusk', 'tone'].includes(raw.material) ? raw.material : base.material;
  base.editMode = Boolean(raw.editMode);
  base.layout = mergeLayout(raw.layout);
  base.layoutAuto = raw.layoutAuto !== false;

  if (raw.widgets && typeof raw.widgets === 'object') {
    for (const key of Object.keys(base.widgets)) {
      const w = raw.widgets[key];
      if (w && typeof w === 'object') Object.assign(base.widgets[key], w);
    }
  }

  if (raw.organizer && typeof raw.organizer === 'object') {
    const o = raw.organizer;
    if (Array.isArray(o.groups) && o.groups.length) base.organizer.groups = o.groups;
    if (o.assignments && typeof o.assignments === 'object') base.organizer.assignments = o.assignments;
    if (Array.isArray(o.collapsed)) base.organizer.collapsed = o.collapsed.filter(x => typeof x === 'string');
    if (Number.isFinite(o.columns)) base.organizer.columns = Math.min(12, Math.max(4, o.columns));
    if (typeof o.tidyDir === 'string') base.organizer.tidyDir = o.tidyDir;
    base.organizer.autoAssigned = o.autoAssigned === true;
    base.organizer.visible = o.visible !== false;
  }

  base.version = CONFIG_VERSION;
  return base;
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    cache = sanitize(raw);
  } catch {
    cache = clone(DEFAULTS);
  }
  return cache;
}

let writeTimer = null;
function save() {
  if (!cache) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] 写入配置失败:', err.message);
    }
  }, 120);
}

/** 同步落盘，退出前调用 */
function flush() {
  clearTimeout(writeTimer);
  if (!cache) return;
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function patch(partial) {
  const cur = load();
  if (partial.material) cur.material = partial.material;
  if (typeof partial.editMode === 'boolean') cur.editMode = partial.editMode;
  if (partial.widgets) {
    for (const [k, v] of Object.entries(partial.widgets)) {
      if (cur.widgets[k]) Object.assign(cur.widgets[k], v);
    }
  }
  if (partial.layout) {
    for (const [k, v] of Object.entries(partial.layout)) {
      if (!cur.layout[k]) cur.layout[k] = { x: 0, y: 0, w: 200, h: 120 };
      Object.assign(cur.layout[k], v);
    }
  }
  if (typeof partial.layoutAuto === 'boolean') cur.layoutAuto = partial.layoutAuto;
  if (partial.organizer) Object.assign(cur.organizer, partial.organizer);
  save();
  return cur;
}

module.exports = { load, patch, flush, save, configPath, DEFAULTS };
