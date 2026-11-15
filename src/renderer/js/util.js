/** 小工具：转义、取整、格式化、走势线生成 */

export const pad2 = (n) => String(n).padStart(2, '0');

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** 速率：B/s → 人类可读，宽度控制在 4 字符内 */
export function speed(bytes) {
  const b = Math.max(0, bytes || 0);
  if (b < 1024) return { v: b < 10 ? b.toFixed(1) : String(Math.round(b)), u: 'B/s' };
  if (b < 1024 * 1024) return { v: (b / 1024).toFixed(b < 10240 ? 1 : 0), u: 'KB/s' };
  if (b < 1024 * 1024 * 1024) return { v: (b / 1048576).toFixed(b < 10485760 ? 1 : 0), u: 'MB/s' };
  return { v: (b / 1073741824).toFixed(2), u: 'GB/s' };
}

/** 走势图：fixedMax 给了就用固定量程，否则自适应并留 12% 顶部余量 */
export function spark(values, w, h, pad = 2, fixedMax = 0) {
  const vals = (values || []).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return { line: '', area: '' };
  const max = Math.max(fixedMax, Math.max(...vals) * 1.12, 1);
  const stepX = (w - pad * 2) / (vals.length - 1);
  const y = (v) => h - pad - (clamp(v, 0, max) / max) * (h - pad * 2);
  const pts = vals.map((v, i) => [pad + i * stepX, y(v)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${(pad + (vals.length - 1) * stepX).toFixed(1)},${h - pad} L${pad},${h - pad} Z`;
  return { line, area };
}

/** 天气图标：一套极简线性 SVG，避免引图标库 */
export function wxIcon(kind, size = 14) {
  const s = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"`;
  const sun = `<circle cx="12" cy="12" r="4.2" fill="#f7b955" stroke="#eda03a"/><g stroke="#eda03a"><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></g>`;
  const cloud = (fill = '#fff') =>
    `<path d="M7.2 18.4a3.3 3.3 0 0 1 .3-6.6 4.9 4.9 0 0 1 9.2 1.1 2.8 2.8 0 0 1 .2 5.5z" fill="${fill}" stroke="#9aa2a8" stroke-width="1.3"/>`;
  switch (kind) {
    case 'sun':
      return `<svg ${s}>${sun}</svg>`;
    case 'partly':
      return `<svg ${s}><circle cx="8.6" cy="8.6" r="3" fill="#f7b955" stroke="#eda03a"/><path d="M8 18.4a3 3 0 0 1 .3-6 4.5 4.5 0 0 1 8.5 1 2.6 2.6 0 0 1 .2 5z" fill="#fff" stroke="#9aa2a8" stroke-width="1.3"/></svg>`;
    case 'rain':
      return `<svg ${s}>${cloud()}<g stroke="#4d9bd6"><path d="M9.4 20.2l-.7 1.6M13 20.2l-.7 1.6M16.6 20.2l-.7 1.6"/></g></svg>`;
    case 'snow':
      return `<svg ${s}>${cloud()}<g stroke="#7fb6dd"><path d="M9.6 20.4v1.8M8.8 21.3h1.6M13.4 20.4v1.8M12.6 21.3h1.6"/></g></svg>`;
    case 'fog':
      return `<svg ${s}>${cloud()}<g stroke="#9aa2a8"><path d="M6 21h12"/></g></svg>`;
    case 'thunder':
      return `<svg ${s}>${cloud()}<path d="M12.6 18.6l-2 4h3l-1.2 2.4" stroke="#f0a53d" fill="none"/></svg>`;
    default:
      return `<svg ${s}>${cloud()}</svg>`;
  }
}

export const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
