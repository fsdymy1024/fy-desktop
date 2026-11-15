'use strict';

/**
 * 系统指标：CPU / 内存 / 磁盘
 * 全部来自 Node 内置能力，无原生依赖。
 * CPU 用两次采样的差值算占用率，避免 os.loadavg() 在 Windows 上恒为 0 的问题。
 */

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

let prev = sample();

function sample() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const k of Object.keys(cpu.times)) total += cpu.times[k];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function cpuPercent() {
  const now = sample();
  const dTotal = now.total - prev.total;
  const dIdle = now.idle - prev.idle;
  prev = now;
  if (dTotal <= 0) return 0;
  const pct = (1 - dIdle / dTotal) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/** 磁盘：优先取系统盘 */
async function diskPercent() {
  const root = path.parse(process.execPath).root || 'C:\\';
  try {
    const s = await fsp.statfs(root);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (!total) return 0;
    return Math.round(((total - free) / total) * 100);
  } catch {
    return 0;
  }
}

function memory() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    total,
    used: total - free,
    percent: Math.round(((total - free) / total) * 100)
  };
}

function uptimeHours() {
  return Math.round((os.uptime() / 3600) * 10) / 10;
}

async function snapshot() {
  const mem = memory();
  return {
    cpu: cpuPercent(),
    mem: mem.percent,
    memUsed: mem.used,
    memTotal: mem.total,
    disk: await diskPercent(),
    uptime: uptimeHours(),
    cores: os.cpus().length,
    host: os.hostname()
  };
}

module.exports = { snapshot };
