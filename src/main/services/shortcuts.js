'use strict';

/**
 * 桌面快捷方式
 * ------------------------------------------------------------------
 * 只做两件事：把桌面看清楚、把桌面收干净。
 *
 * 扫描：用户桌面 + 公共桌面（C:\Users\Public\Desktop）的顶层条目。
 *       .lnk 不解析目标（解析需要原生 COM），用文件名 + 类型配色替代图标，跟设计稿一致。
 *
 * 整理：默认「虚拟分组」——只记录归属，不动用户文件。
 *       只有显式调用 tidy() 才会把散落的快捷方式移动到一个收纳目录，
 *       移动前返回计划给 UI 二次确认，移动后写 _manifest.json 支持一键还原。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app, shell } = require('electron');

const IGNORE = new Set(['desktop.ini', '.ds_store', 'thumbs.db']);
const TIDY_NAME = 'fy-desktop 收纳区';
const MANIFEST = '_manifest.json';

function desktopDirs() {
  const dirs = [];
  try { dirs.push(app.getPath('desktop')); } catch { /* ignore */ }
  const pub = `C:\\Users\\Public\\Desktop`;
  if (fs.existsSync(pub) && !dirs.includes(pub)) dirs.push(pub);
  return dirs;
}

function tidyDir() {
  const cfg = require('../store').load();
  return cfg.organizer.tidyDir || path.join(desktopDirs()[0] || os.homedir(), TIDY_NAME);
}

function kindOf(entry) {
  if (entry.isDirectory()) return 'folder';
  const ext = path.extname(entry.name).toLowerCase();
  if (ext === '.lnk') return 'shortcut';
  if (ext === '.url') return 'link';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return 'image';
  if (['.doc', '.docx', '.pdf', '.txt', '.md'].includes(ext)) return 'doc';
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'sheet';
  if (['.ppt', '.pptx'].includes(ext)) return 'slide';
  if (['.zip', '.rar', '.7z', '.exe', '.msi'].includes(ext)) return 'archive';
  if (['.mp3', '.wav', '.m4a', '.mp4', '.mov'].includes(ext)) return 'media';
  return 'file';
}

const EXT_BADGE = {
  '.docx': 'W', '.doc': 'W', '.xlsx': 'X', '.xls': 'X', '.csv': 'X',
  '.pptx': 'P', '.ppt': 'P', '.pdf': 'PDF', '.txt': 'TXT', '.md': 'MD'
};

/** 扫描桌面顶层条目 */
function scan() {
  const items = [];
  const seen = new Set();
  const tidy = tidyDir();

  for (const dir of desktopDirs()) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (IGNORE.has(name.toLowerCase())) continue;
      if (name.startsWith('.')) continue;
      if (name === TIDY_NAME) continue;

      const full = path.join(dir, name);
      if (full === tidy) continue;
      if (seen.has(full)) continue;
      seen.add(full);

      const ext = path.extname(name).toLowerCase();
      items.push({
        path: full,
        name,
        base: ext ? name.slice(0, -ext.length) : name,
        ext: ext.replace('.', ''),
        badge: EXT_BADGE[ext] || '',
        initial: (name.replace(/\.[^.]+$/, '').trim().charAt(0) || '·').toUpperCase(),
        kind: kindOf(entry),
        dir,
        size: 0
      });
    }
  }

  items.sort((a, b) => {
    if (a.kind === 'folder' && b.kind !== 'folder') return -1;
    if (b.kind === 'folder' && a.kind !== 'folder') return 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return items;
}

/**
 * 首次运行按名称关键词自动归类一次，避免一上来几十个图标全堆在「待整理」。
 * 只写归属记录，不动文件；用户随时可以右键改。
 */
function autoAssign() {
  const store = require('../store');
  const cfg = store.load();
  if (cfg.organizer.autoAssigned) return false;

  const map = {};
  for (const item of scan()) {
    const n = item.name.toLowerCase();
    let gid = null;
    if (/(code|git|docker|postman|dbeaver|terminal|shell|cmd|python|node|idea|webstorm|navicat|xshell|winscp|putty|fiddler)/.test(n)) gid = 'dev';
    else if (/(photoshop|illustrator|figma|sketch|premiere|blender|canva|affinity|axure)/.test(n)) gid = 'design';
    else if (['doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'md', 'txt'].includes(item.ext)) gid = 'docs';
    if (gid) map[item.path] = gid;
  }

  store.patch({ organizer: { assignments: map, autoAssigned: true } });
  return true;
}

/** 生成分组视图：已归类的进对应组，其余进「待整理」 */
function grouped() {
  const cfg = require('../store').load();
  const items = scan();
  const map = cfg.organizer.assignments || {};

  const groups = cfg.organizer.groups.map(g => ({
    id: g.id,
    name: g.name,
    color: g.color,
    folded: Boolean(g.folded),
    items: []
  }));
  const byId = new Map(groups.map(g => [g.id, g]));
  const loose = [];

  for (const item of items) {
    const gid = map[item.path];
    const target = gid && byId.get(gid);
    if (target) target.items.push(item);
    else loose.push(item);
  }

  // 保留空分组：归档这类格子空着也应该是可见的目标位
  const result = groups;
  result.push({
    id: '__inbox__',
    name: '待整理',
    color: '#9aa5ad',
    folded: false,
    inbox: true,
    items: loose
  });

  return { groups: result, total: items.length, loose: loose.length };
}

/** 打开 / 定位 */
async function open(target) {
  const err = await shell.openPath(target);
  return { ok: !err, error: err || null };
}

function reveal(target) {
  shell.showItemInFolder(target);
  return { ok: true };
}

/** 归属：group 传 null 表示取消归类 */
function assign(target, groupId) {
  const store = require('../store');
  const cfg = store.load();
  const next = { ...cfg.organizer.assignments };
  if (!groupId) delete next[target];
  else next[target] = groupId;
  store.patch({ organizer: { assignments: next } });
  return { ok: true };
}

/* ---------------- 整理 / 还原 ---------------- */

function planTidy() {
  const items = scan().filter(i => i.kind !== 'folder'); // 只动文件，不动文件夹
  return items.map(i => ({ path: i.path, name: i.name, kind: i.kind }));
}

async function tidy() {
  const dir = tidyDir();
  const plan = planTidy();
  await fsp.mkdir(dir, { recursive: true });

  const manifestPath = path.join(dir, MANIFEST);
  let manifest = [];
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (!Array.isArray(manifest)) manifest = [];
  } catch { manifest = []; }

  const moved = [];
  for (const item of plan) {
    try {
      let target = path.join(dir, item.name);
      let n = 1;
      while (fs.existsSync(target)) {
        const ext = path.extname(item.name);
        target = path.join(dir, `${path.basename(item.name, ext)} (${n++})${ext}`);
      }
      await fsp.rename(item.path, target);
      manifest.push({ name: path.basename(target), from: item.path, at: new Date().toISOString() });
      moved.push({ from: item.path, to: target });
    } catch (err) {
      moved.push({ from: item.path, error: err.message });
    }
  }

  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { ok: true, dir, moved: moved.filter(m => !m.error), failed: moved.filter(m => m.error) };
}

async function restore() {
  const dir = tidyDir();
  const manifestPath = path.join(dir, MANIFEST);
  let manifest = [];
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    return { ok: false, error: '找不到收纳记录' };
  }

  const done = [];
  const failed = [];
  const left = [];

  for (const entry of manifest) {
    const src = path.join(dir, entry.name);
    if (!fs.existsSync(src)) continue;
    try {
      await fsp.mkdir(path.dirname(entry.from), { recursive: true });
      await fsp.rename(src, entry.from);
      done.push(entry.from);
    } catch (err) {
      failed.push({ path: src, error: err.message });
      left.push(entry);
    }
  }

  await fsp.writeFile(manifestPath, JSON.stringify(left, null, 2), 'utf8');
  return { ok: true, restored: done.length, failed };
}

module.exports = {
  scan, grouped, open, reveal, assign, tidy, planTidy, restore,
  autoAssign, tidyDir, desktopDirs
};
