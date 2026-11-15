'use strict';

/**
 * 网络采集
 * ------------------------------------------------------------------
 * 目标：给「网络」小组件提供真实数据，而不是假动画。
 *
 * 三项能力，都不依赖原生模块：
 *  1. 上下行速率  —— netstat -e 累计字节数做差分（Windows 自带，跨语言版本可解析）
 *  2. 网络延迟    —— 对指定地址做 TCP 握手计时（免 ICMP 管理员权限）
 *  3. 链路信息    —— netsh wlan show interfaces 取 SSID / 信号，os.networkInterfaces 取本地 IPv4
 *
 * 设计取舍：
 *  - 采样周期默认 2s，速率做 EMA 平滑，避免数字疯狂跳动；
 *  - netsh / netstat 是子进程，必须缓存与串行化，不能每次渲染都拉一次；
 *  - 任何一项失败都只让对应字段为 null，绝不让整个组件崩掉。
 */

const os = require('node:os');
const net = require('node:net');
const { execFile } = require('node:child_process');

const HISTORY = 24; // 保留 24 个采样点（约 48s）

class NetworkMonitor {
  constructor(options = {}) {
    this.host = options.host || '223.5.5.5';
    this.port = options.port || 443;
    this.interval = options.interval || 2000;

    this.timer = null;
    this.busy = false;

    this.prev = null;          // { rx, tx, at }
    this.speed = { down: 0, up: 0 };
    this.latency = null;
    this.latencyHistory = [];
    this.speedHistory = [];
    this.wlan = null;
    this.wlanAt = 0;
    this.lastError = null;
  }

  /* ---------------- 累计字节 ---------------- */

  readCounters() {
    return new Promise((resolve) => {
      execFile('netstat', ['-e'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        // 本地化输出差异大，只认「标签 + 两个整数」的第一个数据行（首行即字节）
        const lines = String(stdout).split(/\r?\n/);
        for (const line of lines) {
          const m = line.match(/^\s*([^\d]+?)\s+(\d+)\s+(\d+)\s*$/);
          if (!m) continue;
          const label = m[1].trim();
          if (!label) continue;
          if (/字节|Bytes/i.test(label)) return resolve({ rx: +m[2], tx: +m[3] });
        }
        for (const line of lines) {
          const m = line.match(/^\s*([^\d]+?)\s+(\d+)\s+(\d+)\s*$/);
          if (m) return resolve({ rx: +m[2], tx: +m[3] });
        }
        resolve(null);
      });
    });
  }

  /* ---------------- 延迟 ---------------- */

  probeLatency(host = this.host, port = this.port, timeout = 1400) {
    return new Promise((resolve) => {
      const started = process.hrtime.bigint();
      const socket = new net.Socket();
      let done = false;

      const finish = (value) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(timeout);
      socket.once('connect', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        finish(Math.max(1, Math.round(ms)));
      });
      socket.once('timeout', () => finish(null));
      socket.once('error', () => finish(null));
      socket.connect(port, host);
    });
  }

  /* ---------------- 链路信息 ---------------- */

  readWlan() {
    return new Promise((resolve) => {
      execFile('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const text = String(stdout);
        // 未连接时输出「没有无线接口」之类，直接判定非 Wi-Fi
        if (!/SSID/i.test(text)) return resolve(null);

        const pick = (re) => {
          const m = text.match(re);
          return m ? m[1].trim() : '';
        };
        const ssid = pick(/^\s*SSID\s*:\s*(.+)$/m);
        const state = pick(/^\s*(?:状态|State)\s*:\s*(.+)$/m);
        const signal = pick(/^\s*(?:信号|Signal)\s*:\s*(\d+)%/m);
        const radio = pick(/^\s*(?:无线电类型|Radio type)\s*:\s*(.+)$/m);
        const band = pick(/^\s*(?:频带|Band)\s*:\s*(.+)$/m);
        const rxRate = pick(/^\s*(?:接收速率|Receive rate)[^:]*:\s*(\d+)/m);

        if (!ssid) return resolve(null);
        resolve({
          ssid,
          state: state || '已连接',
          signal: signal ? Number(signal) : null,
          radio: radio || '',
          band: band || '',
          rate: rxRate ? Number(rxRate) : null
        });
      });
    });
  }

  readIpv4() {
    const ifaces = os.networkInterfaces();
    const candidates = [];
    for (const [name, list] of Object.entries(ifaces)) {
      for (const item of list || []) {
        if (item.family !== 'IPv4' || item.internal) continue;
        candidates.push({ name, address: item.address, mac: item.mac });
      }
    }
    // 优先私有网段（真实局域网），跳过虚拟网卡常见的 169.254
    const real = candidates.filter(c => !c.address.startsWith('169.254.'));
    const pick = (real.length ? real : candidates)[0] || null;
    return pick;
  }

  /* ---------------- 采样 ---------------- */

  async sample() {
    if (this.busy) return this.snapshot();
    this.busy = true;

    try {
      const [counters, latency] = await Promise.all([
        this.readCounters(),
        this.probeLatency()
      ]);

      const now = Date.now();
      if (counters && this.prev) {
        const dt = (now - this.prev.at) / 1000;
        if (dt > 0.2) {
          const down = Math.max(0, (counters.rx - this.prev.rx) / dt);
          const up = Math.max(0, (counters.tx - this.prev.tx) / dt);
          // EMA，α=0.45，既跟得上又不会抖
          const a = 0.45;
          this.speed.down = this.speed.down * (1 - a) + down * a;
          this.speed.up = this.speed.up * (1 - a) + up * a;
        }
        // 只有算得出真实速率时才入历史，首帧的 0 不入库，避免曲线开头一段假 0
        this.speedHistory.push(Math.round(this.speed.down));
        if (this.speedHistory.length > HISTORY) this.speedHistory.shift();
      }
      if (counters) this.prev = { rx: counters.rx, tx: counters.tx, at: now };

      this.latency = latency;
      if (latency != null) {
        this.latencyHistory.push(latency);
        if (this.latencyHistory.length > HISTORY) this.latencyHistory.shift();
      }


      if (now - this.wlanAt > 12000) {
        this.wlanAt = now;
        this.wlan = await this.readWlan();
      }

      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
    } finally {
      this.busy = false;
    }

    return this.snapshot();
  }

  snapshot() {
    const ip = this.readIpv4();
    const wired = !this.wlan;
    return {
      down: this.speed.down,
      up: this.speed.up,
      latency: this.latency,
      online: this.latency != null,
      // 链路
      link: this.wlan
        ? { type: 'wifi', name: this.wlan.ssid, signal: this.wlan.signal, band: this.wlan.band, rate: this.wlan.rate }
        : { type: wired ? 'ethernet' : 'unknown', name: wired ? '以太网' : '未连接', signal: null, band: '', rate: null },
      ip: ip ? ip.address : null,
      adapter: ip ? ip.name : null,
      host: this.host,
      downHistory: this.speedHistory.slice(-HISTORY),
      latencyHistory: this.latencyHistory.slice(-12),
      updatedAt: Date.now()
    };
  }

  start(onTick) {
    this.stop();
    this.timer = setInterval(async () => {
      const snap = await this.sample();
      if (typeof onTick === 'function') onTick(snap);
    }, this.interval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { NetworkMonitor };
