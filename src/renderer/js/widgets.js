/**
 * 组件注册表。
 * 每个组件自己负责「画一次」和「数据来了怎么改」，主流程只管调度。
 * mount() 返回可选的 weather/metrics/tick 回调与 destroy()。
 */

import { esc, pad2, speed, spark, wxIcon, WEEK } from './util.js';

/** 预设尺寸（设计像素）。和后端 config.rs 的 dims() 是同一套数：
 *  小 102×102、中 210×102、大 210×126。
 *  宽高都是吸附网格（main.js 的 GRID = 6）的整数倍，且中/大宽度 = 两个小 + 一条缝：
 *  2 × 102 + 6 = 210，所以两张小卡并排正好和一张中卡同宽、同一条缝。
 *  尺寸不再靠拖拉，一律从这三档里选，组件之间才能对得齐。 */
export const S = 102;
/** 最小缝隙，同时也是吸附网格的步进（main.js 的 GRID） */
export const GAP = 6;
export const MW = 2 * S + GAP;
export const SIZE_DIMS = {
  s: [S, S],
  m: [MW, S],
  l: [MW, S + 24]
};
export const SIZE_LABEL = { s: '小', m: '中', l: '大' };
export const dimsOf = (size) => SIZE_DIMS[size] || SIZE_DIMS.m;

/**
 * 时钟是否显示秒。托盘菜单可切换，切换后下一次 tick 就生效——
 * 不重建组件，避免卡片闪一下。
 */
let SHOW_SECONDS = true;
export function setShowSeconds(on) {
  SHOW_SECONDS = !!on;
}
/** 秒的部分，不显示时为空串 */
const secSpan = (s) => (SHOW_SECONDS ? `<small>${pad2(s)}</small>` : '');

/** 表盘直径：跟着卡片内部可用尺寸走。
 *  以前在 mount 时算一次、且写死 140 上限，卡片放大后表盘不动，看起来像没生效。
 *  现在每次 tick 都对一次尺寸，拉角、换布局、首帧都能跟上。 */
const dialSize = (body) => {
  if (!body) return 120;
  // .body 上下 12px、左右 13px 的内边距要扣掉，否则表盘会顶到卡片边缘
  const h = body.clientHeight - 26;
  // 右边那块时间/日期是按内容占宽的、压不扁，以前按「宽度 × 0.56」估，
  // 卡片拉到最小时估多了，表盘就压到「22:40」上面。直接量它。
  const side = body.querySelector('.ck-side');
  const sideW = side ? side.offsetWidth : 88;
  const w = body.clientWidth - 26 - sideW - 14; // 内边距 + .ck 的 gap
  return Math.round(Math.max(64, Math.min(h, w, 320)));
};

function dialSvg(size) {
  const c = size / 2;
  const r = c - 5;
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 * Math.PI) / 180;
    const major = i % 5 === 0;
    const inner = major ? r - 6.5 : r - 3;
    const x1 = (c + Math.sin(a) * r).toFixed(2);
    const y1 = (c - Math.cos(a) * r).toFixed(2);
    const x2 = (c + Math.sin(a) * inner).toFixed(2);
    const y2 = (c - Math.cos(a) * inner).toFixed(2);
    ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="${major ? 1.5 : 0.7}" opacity="${major ? 0.55 : 0.2}" stroke-linecap="round"/>`;
  }
  const hourHand = (r * 0.5).toFixed(1);
  const minHand = (r * 0.72).toFixed(1);
  const secHand = (r * 0.78).toFixed(1);
  return `
  <svg class="ck-dial" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${c}" cy="${c}" r="${r + 2.5}" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.14"/>
    ${ticks}
    <g class="h-hour">
      <line x1="${c}" y1="${c + 4}" x2="${c}" y2="${c - hourHand}" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" opacity="0.85"/>
    </g>
    <g class="h-min">
      <line x1="${c}" y1="${c + 5}" x2="${c}" y2="${c - minHand}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity="0.85"/>
    </g>
    <g class="h-sec">
      <line x1="${c}" y1="${c + 7}" x2="${c}" y2="${c - secHand}" stroke="#e2622c" stroke-width="1" stroke-linecap="round"/>
    </g>
    <circle cx="${c}" cy="${c}" r="2.4" fill="#e2622c"/>
  </svg>`;
}

export const REGISTRY = {
  /* ---------------- 天气 ---------------- */
  weather: {
    kind: 'weather',
    name: '天气',
    desc: '实时温度、天气状况与逐时预报',
    sizes: ['s', 'm'],
    def: 'm',
    preview: (size) =>
      size === 's' ? `<b>17°</b><span>多云</span>` : `<b>17°</b><span>多云 · 20°/15°</span>`,
    mount(body) {
      body.innerHTML = `
        <div class="wx-head"><span class="wx-city">天气</span><span class="wx-src"></span></div>
        <div class="wx-mid">
          <div class="wx-temp num">--<sup>°</sup></div>
          <div class="wx-meta">
            <div class="wx-cond">${wxIcon('cloud')}<span>获取中</span></div>
            <div class="wx-hilo">最高 -- · 最低 --</div>
          </div>
        </div>
        <div class="wx-hours"></div>`;

      const city = body.querySelector('.wx-city');
      const src = body.querySelector('.wx-src');
      const temp = body.querySelector('.wx-temp');
      const cond = body.querySelector('.wx-cond');
      const hilo = body.querySelector('.wx-hilo');
      const hours = body.querySelector('.wx-hours');

      const empty = (msg) => {
        city.textContent = '天气';
        temp.innerHTML = '--<sup>°</sup>';
        cond.innerHTML = `<span>${esc(msg)}</span>`;
        hilo.textContent = '检查网络后重试';
        hours.innerHTML = '';
      };

      return {
        weather(w) {
          if (!w) return empty('暂不可用');
          city.textContent = w.city || '天气';
          const card = body.closest('.card');
          if (card) card.title = w.admin ? `${w.admin}` : '';
          src.textContent = w.source === 'wttr.in' ? 'wttr' : '';
          temp.innerHTML = `${w.temp}<sup>°</sup>`;
          cond.innerHTML = `${wxIcon(w.icon)}<span>${esc(w.cond)}</span>`;
          hilo.textContent = `最高 ${w.high}° · 最低 ${w.low}°`;
          hours.innerHTML = (w.hours || [])
            .slice(0, 6)
            .map(
              (h) =>
                `<div class="h${h.tomorrow ? ' tmr' : ''}" title="${h.tomorrow ? '明天 ' : ''}${esc(h.label)}">` +
                `<span>${esc(h.label)}</span>${wxIcon(h.icon, 13)}<b>${h.temp}°</b></div>`
            )
            .join('');
        },
        weatherError() {
          empty('天气不可用');
        },
        onSizeChange() {},
      };
    }
  },

  /* ---------------- 模拟时钟 ---------------- */
  clock: {
    kind: 'clock',
    name: '模拟时钟',
    desc: '实时走针，附日期与本地时区',
    sizes: ['s', 'm'],
    def: 'm',
    preview: (size) =>
      size === 's' ? `<b>16:21</b><span>11月15日</span>` : `<b>16:21</b><span>模拟表盘</span>`,
    mount(body) {
      body.innerHTML = `<div class="ck"><div class="ck-dial-slot"></div>
        <div class="ck-side">
          <div class="ck-time num">--:--</div>
          <div class="ck-date"></div>
          <div class="ck-zone"><span class="dot" style="background:#35ab68"></span>本地时间</div>
        </div></div>`;
      const slot = body.querySelector('.ck-dial-slot');
      const time = body.querySelector('.ck-time');
      const date = body.querySelector('.ck-date');

      let size = 0;
      let hands = null;

      const build = () => {
        const s = Math.max(72, dialSize(body));
        if (Math.abs(s - size) < 4) return;
        size = s;
        slot.innerHTML = dialSvg(s);
        hands = {
          h: slot.querySelector('.h-hour'),
          m: slot.querySelector('.h-min'),
          s: slot.querySelector('.h-sec'),
          c: s / 2
        };
      };

      const tick = () => {
        const d = new Date();
        time.innerHTML = `${pad2(d.getHours())}:${pad2(d.getMinutes())}${secSpan(d.getSeconds())}`;
        date.textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;
        // 不能只在 mount 里画一次：那时卡片还没 place() 定尺寸，只能拿到 0，
        // 表盘会永远停在最小档。每秒对一次尺寸，拉角/换布局/首帧都自动跟上。
        build();
        if (!hands) return;
        const sec = d.getSeconds();
        const min = d.getMinutes() + sec / 60;
        const hour = (d.getHours() % 12) + min / 60;
        const { c } = hands;
        hands.h.setAttribute('transform', `rotate(${hour * 30} ${c} ${c})`);
        hands.m.setAttribute('transform', `rotate(${min * 6} ${c} ${c})`);
        hands.s.setAttribute('transform', `rotate(${sec * 6} ${c} ${c})`);
      };

      tick();
      // 首帧再补一次：mount 发生在 place() 之前，等布局落定才拿得到真实尺寸
      requestAnimationFrame(tick);
      const timer = setInterval(tick, 1000);
      return {
        tick,
        onSizeChange: () => {
          size = 0;
          build();
          tick();
        },
        destroy: () => clearInterval(timer)
      };
    }
  },

  /* ---------------- 数字时钟 ---------------- */
  digital: {
    kind: 'digital',
    name: '数字时钟',
    desc: '极简大字号时间',
    sizes: ['s', 'm'],
    def: 's',
    preview: () => `<b>16:21</b><span>11月15日</span>`,
    mount(body) {
      body.innerHTML = `<div class="dg"><div class="dg-time num"></div><div class="dg-date"></div></div>`;
      const t = body.querySelector('.dg-time');
      const d = body.querySelector('.dg-date');
      const tick = () => {
        const now = new Date();
        t.innerHTML = `${pad2(now.getHours())}:${pad2(now.getMinutes())}${secSpan(now.getSeconds())}`;
        d.textContent = `${now.getMonth() + 1}月${now.getDate()}日 周${WEEK[now.getDay()]}`;
      };
      tick();
      const timer = setInterval(tick, 1000);
      return { tick, destroy: () => clearInterval(timer) };
    }
  },

  /* ---------------- 日历 ---------------- */
  calendar: {
    kind: 'calendar',
    name: '日历',
    desc: '当月网格与今日高亮',
    sizes: ['m'],
    def: 'm',
    preview: () => `<b>15</b><span>11月 · 周日</span>`,
    mount(body) {
      body.innerHTML = `<div class="cd">
          <div class="cd-today"><div class="cd-day num"></div><div class="cd-mw"></div></div>
          <div class="cd-month"><div class="cd-week"></div><div class="cd-grid"></div></div>
        </div>`;
      const day = body.querySelector('.cd-day');
      const mw = body.querySelector('.cd-mw');
      const week = body.querySelector('.cd-week');
      const grid = body.querySelector('.cd-grid');

      // 周一开头，符合国内日历习惯
      week.innerHTML = ['一', '二', '三', '四', '五', '六', '日'].map((w) => `<span>${w}</span>`).join('');

      const paint = () => {
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth();
        const today = now.getDate();
        day.textContent = today;
        mw.textContent = `${m + 1}月 · 周${WEEK[now.getDay()]}`;

        const first = new Date(y, m, 1);
        const offset = (first.getDay() + 6) % 7;
        const days = new Date(y, m + 1, 0).getDate();
        const prevDays = new Date(y, m, 0).getDate();

        let html = '';
        for (let i = offset - 1; i >= 0; i--) html += `<span class="dim">${prevDays - i}</span>`;
        for (let d = 1; d <= days; d++) {
          html += `<span class="${d === today ? 'now' : ''}">${d}</span>`;
        }
        const tail = (7 - ((offset + days) % 7)) % 7;
        for (let d = 1; d <= tail; d++) html += `<span class="dim">${d}</span>`;
        grid.innerHTML = html;
      };

      paint();
      // 跨天时自动翻页
      const timer = setInterval(paint, 60_000);
      return { destroy: () => clearInterval(timer) };
    }
  },

  /* ---------------- 系统监视 ---------------- */
  system: {
    kind: 'system',
    name: '系统监视',
    desc: 'CPU / 内存 / 磁盘与 CPU 走势',
    sizes: ['s', 'm'],
    def: 'm',
    preview: () => `<b>12%</b><span>CPU · 内存 · 磁盘</span>`,
    mount(body) {
      body.innerHTML = `
        <div class="sys-rows">
          <div class="sys-row"><span>CPU</span><div class="bar cpu"><i style="width:0%"></i></div><b class="v-cpu">--</b></div>
          <div class="sys-row"><span>内存</span><div class="bar mem"><i style="width:0%"></i></div><b class="v-mem">--</b></div>
          <div class="sys-row"><span>磁盘</span><div class="bar disk"><i style="width:0%"></i></div><b class="v-disk">--</b></div>
        </div>
        <svg class="sys-spark" preserveAspectRatio="none"></svg>
        <div class="sys-foot"><span class="up">--</span><span class="cores"></span></div>`;

      const bar = (k) => body.querySelector(`.bar.${k} i`);
      const val = (k) => body.querySelector(`.v-${k}`);
      const svg = body.querySelector('.sys-spark');
      const up = body.querySelector('.up');
      const cores = body.querySelector('.cores');

      const hist = [];
      let seeded = false;

      const drawSpark = () => {
        const w = svg.clientWidth || 260;
        const h = svg.clientHeight || 30;
        const { line, area } = spark(hist, w, h, 1.5, 100);
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.innerHTML = `
          <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#3d8bf0" stop-opacity=".22"/>
            <stop offset="1" stop-color="#3d8bf0" stop-opacity="0"/>
          </linearGradient></defs>
          <path d="${area}" fill="url(#sg)"/>
          <path d="${line}" fill="none" stroke="#3d8bf0" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>`;
      };

      return {
        metrics(s) {
          if (!s) return;
          bar('cpu').style.width = `${s.cpu}%`;
          bar('mem').style.width = `${s.mem}%`;
          bar('disk').style.width = `${s.disk}%`;
          val('cpu').textContent = `${Math.round(s.cpu)}%`;
          val('mem').textContent = `${Math.round(s.mem)}%`;
          val('disk').textContent = `${Math.round(s.disk)}%`;
          up.textContent = `已运行 ${Math.floor(s.uptime / 3600)}h`;
          cores.textContent = `${s.cores} 核`;

          if (!seeded) {
            for (let i = 0; i < 10; i++) hist.push(s.cpu);
            seeded = true;
          }
          hist.push(s.cpu);
          if (hist.length > 40) hist.shift();
          drawSpark();
        },
        onSizeChange: drawSpark
      };
    }
  },

  /* ---------------- 网络 ---------------- */
  network: {
    kind: 'network',
    name: '网络',
    desc: '上下行速率、延迟、信号与 IP',
    sizes: ['s', 'm'],
    def: 'm',
    preview: (size) =>
      size === 's' ? `<b>12.4</b><span>MB/s</span>` : `<b>12.4</b><span>MB/s · 18ms</span>`,
    mount(body) {
      body.innerHTML = `
        <div class="net-top">
          <span>网络</span>
          <span class="net-on"><i></i>在线</span>
          <span class="net-link"><span class="txt">连接中</span></span>
        </div>
        <div class="net-mid">
          <div class="net-main">
            <div class="net-num"><b class="down">--</b><em class="downU">KB/s</em></div>
            <div class="net-up">↓ 上行 <b class="up">--</b><span class="upU">KB/s</span></div>
          </div>
          <svg class="net-spark" preserveAspectRatio="none"></svg>
        </div>
        <div class="net-foot">
          <span>延迟 <b class="lat">--</b> ms</span>
          <span class="sigwrap">信号 <span class="sig"><i></i><i></i><i></i><i></i></span></span>
          <span class="ip"></span>
        </div>`;

      const q = (s) => body.querySelector(s);
      const down = q('.down');
      const downU = q('.downU');
      const up = q('.up');
      const upU = q('.upU');
      const lat = q('.lat');
      const ip = q('.ip');
      const sparkEl = q('.net-spark');
      const link = q('.net-link .txt');
      const sigWrap = q('.sigwrap');
      const bars = body.querySelectorAll('.sig i');

      const drawSpark = (hist) => {
        const w = sparkEl.clientWidth || 92;
        const h = sparkEl.clientHeight || 38;
        const raw = (hist || []).slice(-16);
        // 采样点不够时用首个真实值向左补齐，曲线从平线开始长
        const vals = raw.length ? Array(Math.max(0, 16 - raw.length)).fill(raw[0]).concat(raw) : [];
        // 量程自适应：以前写死 32KB/s 上限，宽带一跑就顶到画布顶部，
        // 图变成一条贴着上沿的平线。宽度占 2/3 之后这个毛病更明显。
        const { line, area } = spark(vals, w, h, 2);
        sparkEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
        sparkEl.innerHTML = `
          <defs><linearGradient id="ng" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#3d8bf0" stop-opacity=".24"/>
            <stop offset="1" stop-color="#3d8bf0" stop-opacity="0"/>
          </linearGradient></defs>
          <path d="${area}" fill="url(#ng)"/>
          <path d="${line}" fill="none" stroke="#3d8bf0" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>`;
      };

      return {
        metrics(s) {
          if (!s) return;
          const d = speed(s.down);
          const u = speed(s.up);
          down.textContent = d.v;
          downU.textContent = d.u;
          up.textContent = u.v;
          upU.textContent = u.u;
          lat.textContent = s.latency ? String(s.latency) : '--';
          ip.textContent = s.ip || '';
          // 悬停能看到「这块 IP 属于哪块网卡」，排查多网卡时很有用
          ip.title = s.iface ? `${s.iface} · ${s.ip}` : s.ip || '';

          const l = s.link || {};
          link.textContent = l.kind === 'wifi' ? l.ssid || 'Wi-Fi' : l.kind === 'ethernet' ? '有线' : '未连接';
          if (l.kind === 'wifi' && Number.isFinite(l.signal)) {
            sigWrap.style.display = '';
            const on = Math.max(1, Math.ceil(l.signal / 25));
            bars.forEach((b, i) => b.classList.toggle('on', i < on));
          } else {
            // 有线上没有「信号」这个概念，整块隐藏比显示满格更诚实
            sigWrap.style.display = 'none';
          }
          drawSpark(s.down_history);
        },
        onSizeChange: () => drawSpark([])
      };
    }
  },

  /* ---------------- 备忘录 ---------------- */
  notes: {
    kind: 'notes',
    name: '备忘录',
    desc: '随手记两行，自动保存',
    sizes: ['m', 'l'],
    def: 'm',
    preview: () => `<b>…</b><span>随手记</span>`,
    mount(body, ctx) {
      body.innerHTML = `<div class="nt-head">备忘录</div>
        <textarea class="nt-area" placeholder="写点什么…" spellcheck="false"></textarea>`;
      const area = body.querySelector('.nt-area');
      const key = `fy.note.${ctx.id}`;
      area.value = localStorage.getItem(key) || '';
      let timer = 0;
      area.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => localStorage.setItem(key, area.value), 300);
      });
      return { destroy: () => clearTimeout(timer) };
    }
  }
};

export const ORDER = ['weather', 'clock', 'calendar', 'system', 'network', 'notes', 'digital'];
