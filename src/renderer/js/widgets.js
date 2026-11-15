/**
 * 小组件渲染
 * 每个 init 函数自己管自己的 DOM 与定时器，main.js 只负责调用与布局。
 */

import { $, speed, weatherIcon, polyline, esc } from './util.js';

/* ============================================================
   时钟
   ============================================================ */
export function initClock() {
  const host = $('#clockFace');
  const S = 148;
  const C = S / 2;
  const NS = 'http://www.w3.org/2000/svg';

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${S} ${S}`);

  const add = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    svg.appendChild(el);
    return el;
  };

  // 60 格刻度
  for (let i = 0; i < 60; i++) {
    const a = ((i * 6 - 90) * Math.PI) / 180;
    const big = i % 5 === 0;
    const r1 = C - (big ? 9 : 6);
    const r2 = C - 3;
    add('line', {
      x1: C + Math.cos(a) * r1, y1: C + Math.sin(a) * r1,
      x2: C + Math.cos(a) * r2, y2: C + Math.sin(a) * r2,
      stroke: 'currentColor', 'stroke-width': big ? 1.8 : 1,
      'stroke-linecap': 'round', opacity: big ? 0.55 : 0.2
    });
  }

  // 12 个数字
  for (let n = 1; n <= 12; n++) {
    const a = ((n * 30 - 90) * Math.PI) / 180;
    const r = C - 22;
    const t = add('text', {
      x: C + Math.cos(a) * r, y: C + Math.sin(a) * r + 3.2,
      'text-anchor': 'middle', 'font-size': 8.5, 'font-weight': 500,
      fill: 'currentColor', opacity: 0.58, 'font-family': 'inherit'
    });
    t.textContent = n;
  }

  const makeHand = (len, w, color, opacity) => add('line', {
    x1: C, y1: C + 6, x2: C, y2: C - len,
    stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', opacity
  });

  const hourHand = makeHand(34, 4.6, 'currentColor', 0.88);
  const minHand = makeHand(46, 3, 'currentColor', 0.88);
  const secHand = makeHand(48, 1.1, '#e2622c', 1);
  add('circle', { cx: C, cy: C, r: 3, fill: '#e2622c' });
  add('circle', { cx: C, cy: C, r: 1.2, fill: '#fff' });

  host.appendChild(svg);

  const tick = () => {
    const now = new Date();
    const s = now.getSeconds();
    const m = now.getMinutes() + s / 60;
    const h = (now.getHours() % 12) + m / 60;
    hourHand.setAttribute('transform', `rotate(${h * 30} ${C} ${C})`);
    minHand.setAttribute('transform', `rotate(${m * 6} ${C} ${C})`);
    secHand.setAttribute('transform', `rotate(${s * 6} ${C} ${C})`);
  };
  tick();
  setInterval(tick, 1000);
}

/* ============================================================
   日历
   ============================================================ */
export function initCalendar() {
  const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  const tick = () => {
    const now = new Date();
    $('#calTop').textContent = WEEK[now.getDay()];
    $('#calDay').textContent = String(now.getDate());

    // ISO 周数
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((+d - +yearStart) / 86400000 + 1) / 7);
    $('#calBot').textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 · 第 ${week} 周`;
  };
  tick();
  setInterval(tick, 30000);
}

/* ============================================================
   天气
   ============================================================ */
export function initWeather() {
  const box = $('#w-weather');

  const paint = (data) => {
    if (!data || data.error) {
      box.classList.add('is-empty');
      $('#wxCity').textContent = '天气';
      $('#wxTemp').textContent = '--';
      $('#wxCond').innerHTML = '<span>暂时取不到</span>';
      $('#wxHilo').textContent = '点击重试';
      $('#wxHours').innerHTML = '';
      return;
    }
    box.classList.remove('is-empty');
    $('#wxCity').textContent = data.city;
    $('#wxTemp').textContent = `${data.temp}°`;
    $('#wxCond').innerHTML = `${weatherIcon(data.icon)}<span>${esc(data.cond)}</span>`;
    $('#wxHilo').textContent = `最高 ${data.high}° 最低 ${data.low}°`;

    $('#wxHours').innerHTML = (data.hours || []).map(h => `
      <div class="hr">
        <span>${esc(h.label)}</span>
        ${weatherIcon(h.icon)}
        <b>${h.temp}°</b>
      </div>`).join('');
  };

  const load = () => window.fy.weatherGet().then(paint).catch(() => paint(null));

  load();
  window.fy.on('weather:data', paint);

  // 取不到天气时，点一下重试
  box.addEventListener('click', () => {
    if (box.classList.contains('is-empty')) load();
  });
}

/* ============================================================
   系统监视
   ============================================================ */
export function initSystem() {
  const history = [];
  const MAX = 22;
  let seeded = false;

  const paint = (s) => {
    if (!s) return;
    $('#barCpu').style.width = `${s.cpu}%`;
    $('#barMem').style.width = `${s.mem}%`;
    $('#barDisk').style.width = `${s.disk}%`;
    $('#valCpu').textContent = `${s.cpu}%`;
    $('#valMem').textContent = `${s.mem}%`;
    $('#valDisk').textContent = `${s.disk}%`;
    $('#sysUp').textContent = `已运行 ${s.uptime}h · ${s.cores} 核`;

    // 首帧用当前值铺满，曲线从一条平线开始长，不至于先冒出一根斜线
    if (!seeded) {
      for (let i = 0; i < 8; i++) history.push(s.cpu);
      seeded = true;
    }
    history.push(s.cpu);
    if (history.length > MAX) history.shift();
    const { line, area } = polyline(history, 96, 44, 3);
    if (line) {
      $('#sparkLine').setAttribute('d', line);
      $('#sparkArea').setAttribute('d', area);
    }
  };

  window.fy.on('sys:tick', paint);
}

/* ============================================================
   网络
   ============================================================ */
export function initNetwork() {
  const paint = (n) => {
    if (!n) return;

    const down = speed(n.down);
    const up = speed(n.up);
    $('#netDown').textContent = down.value;
    $('#netDownUnit').textContent = down.unit;
    $('#netUp').textContent = up.value;
    $('#netUpUnit').textContent = up.unit;

    // 在线状态
    const state = $('#netState');
    state.classList.toggle('off', !n.online);
    $('#netStateText').textContent = n.online ? '在线' : '离线';

    // 链路名称
    if (n.link && n.link.name) {
      $('#netSsid').textContent = n.link.name;
      $('#netLink').title = `${n.link.type === 'wifi' ? 'Wi-Fi' : '有线'} · ${n.link.name}`;
    }

    // 延迟
    const ping = $('#netPing');
    if (n.latency == null) {
      ping.textContent = '--';
      ping.style.color = '';
    } else {
      ping.textContent = String(n.latency);
      ping.style.color = n.latency > 120 ? '#d9534f' : n.latency > 60 ? '#e08a2e' : '';
    }

    // 信号：有线不显示信号格
    const sig = n.link && Number.isFinite(n.link.signal) ? n.link.signal : null;
    const barBox = document.querySelector('#netSig');
    const bars = document.querySelectorAll('#netSig i');
    if (n.link && n.link.type === 'ethernet') {
      barBox.style.display = 'none';
      $('#netSigText').textContent = '有线';
    } else if (sig == null) {
      barBox.style.display = '';
      bars.forEach(b => b.classList.remove('on'));
      $('#netSigText').textContent = '--';
    } else {
      barBox.style.display = '';
      const on = Math.max(1, Math.ceil(sig / 25));
      bars.forEach((b, i) => b.classList.toggle('on', i < on));
      $('#netSigText').textContent = `${sig}%`;
    }

    // IP
    $('#netIp').textContent = n.ip || '无连接';

    // 吞吐走势
    const { line, area } = polyline((n.downHistory || []).slice(-16), 104, 42, 4);
    if (line) {
      $('#netLine').setAttribute('d', line);
      $('#netArea').setAttribute('d', area);
    }
  };

  window.fy.netSnapshot().then(paint);
  window.fy.on('net:tick', paint);
}

/* ============================================================
   备忘录
   ============================================================ */
export function initNotes(items) {
  const list = $('#noteList');
  let data = (items || []).slice(0, 3);

  const render = () => {
    list.innerHTML = data.map((it, i) => `
      <li class="${it.done ? 'done' : ''}" data-i="${i}">
        <i></i><span title="${esc(it.text)}">${esc(it.text)}</span>
      </li>`).join('');
  };

  list.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const i = Number(li.dataset.i);
    data[i].done = !data[i].done;
    render();
    window.fy.notesUpdate(data);
  });

  render();
}
