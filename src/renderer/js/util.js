/**
 * 公共工具：DOM 选择、速率格式化、天气图标、Toast
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 字节/秒 → 便于阅读的数值与单位 */
export function speed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return { value: '0', unit: 'KB/s' };
  const kb = bytesPerSec / 1024;
  if (kb < 1) return { value: '0', unit: 'KB/s' };
  if (kb < 1000) return { value: String(Math.round(kb)), unit: 'KB/s' };
  const mb = kb / 1024;
  if (mb < 1000) return { value: mb < 10 ? mb.toFixed(1) : String(Math.round(mb)), unit: 'MB/s' };
  return { value: (mb / 1024).toFixed(2), unit: 'GB/s' };
}

/** 秒 → "3 分钟前" */
export function ago(ts) {
  if (!ts) return '--';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

const WX = {
  sun: '<circle cx="12" cy="12" r="4.3" fill="#f7b955"/><g stroke="#f0a53d" stroke-width="1.7" stroke-linecap="round"><path d="M12 3.2v1.8M12 19v1.8M3.2 12H5M19 12h1.8M5.8 5.8l1.3 1.3M16.9 16.9l1.3 1.3M5.8 18.2l1.3-1.3M16.9 7.1l1.3-1.3"/></g>',
  'sun-cloud': '<circle cx="9" cy="9" r="3.4" fill="#f7b955"/><g stroke="#f0a53d" stroke-width="1.5" stroke-linecap="round"><path d="M9 3.4v1.4M3.4 9h1.4M13.2 9h1.4M5.1 5.1l1 1M12.9 5.1l-1 1"/></g><path d="M10.6 19.6a3.2 3.2 0 0 1 .3-6.4 4.7 4.7 0 0 1 8.9 1.1 2.7 2.7 0 0 1-.4 5.3z" fill="#fff" stroke="#9fadb7" stroke-width="1.1"/>',
  cloud: '<path d="M6.4 18.6a4 4 0 0 1 .45-7.97 5.9 5.9 0 0 1 11.2 1.4 3.3 3.3 0 0 1-.5 6.57z" fill="#fff" stroke="#9fadb7" stroke-width="1.2"/>',
  rain: '<path d="M6.4 16.4a4 4 0 0 1 .45-7.97 5.9 5.9 0 0 1 11.2 1.4 3.3 3.3 0 0 1-.5 6.57z" fill="#fff" stroke="#9fadb7" stroke-width="1.2"/><g stroke="#5aa9e6" stroke-width="1.8" stroke-linecap="round"><path d="M9 19.6l-.9 2.2M12.4 19.6l-.9 2.2M15.8 19.6l-.9 2.2"/></g>',
  drizzle: '<path d="M6.4 16.4a4 4 0 0 1 .45-7.97 5.9 5.9 0 0 1 11.2 1.4 3.3 3.3 0 0 1-.5 6.57z" fill="#fff" stroke="#9fadb7" stroke-width="1.2"/><g stroke="#5aa9e6" stroke-width="1.8" stroke-linecap="round"><path d="M10.4 19.4l-.7 1.8M14.4 19.4l-.7 1.8"/></g>',
  snow: '<path d="M6.4 15.8a4 4 0 0 1 .45-7.97 5.9 5.9 0 0 1 11.2 1.4 3.3 3.3 0 0 1-.5 6.57z" fill="#fff" stroke="#9fadb7" stroke-width="1.2"/><g stroke="#7fb8e8" stroke-width="1.5" stroke-linecap="round"><path d="M9.4 19.4v2.4M8.2 20l2.4 1.2M10.6 20l-2.4 1.2M15.2 19.4v2.4M14 20l2.4 1.2M16.4 20l-2.4 1.2"/></g>',
  thunder: '<path d="M6.4 15.6a4 4 0 0 1 .45-7.97 5.9 5.9 0 0 1 11.2 1.4 3.3 3.3 0 0 1-.5 6.57z" fill="#fff" stroke="#9fadb7" stroke-width="1.2"/><path d="M12.6 16.4l-2.8 3.6h2.2l-1 2.6 3.6-3.8h-2.2z" fill="#f5b93d"/>',
  fog: '<g stroke="#9fadb7" stroke-width="1.6" stroke-linecap="round"><path d="M4.4 8.6h15.2M3.4 12.4h17.2M5.4 16.2h13.2M4.6 20h9.6"/></g>'
};

export function weatherIcon(kind) {
  const body = WX[kind] || WX.cloud;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="none">${body}</svg>`;
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
}

/** 简单的 html 转义，桌面文件名可能有尖括号 */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 折线 → SVG path */
export function polyline(values, width, height, pad = 2) {
  // 少于两个点不成线，返回空串让调用方跳过绘制，避免出现一条斜线
  if (!values || values.length < 2) return { line: '', area: '' };
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = height - pad - (v / max) * (height - pad * 2);
    return [x, y];
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return { line, area };
}
