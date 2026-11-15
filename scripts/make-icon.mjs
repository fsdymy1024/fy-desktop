/**
 * 生成应用图标（无第三方依赖，手写 PNG 编码）
 * 输出：assets/icon.png（512）、assets/tray.png（32）
 * 图形：暖橙渐变圆角方 + 白色 2×2 收纳格，与 UI 里的收纳面板 Logo 一致
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'assets');

/* ---------- CRC32 ---------- */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 绘制 ---------- */
function roundRectAlpha(x, y, w, h, r) {
  // 返回点 (x,y) 在圆角矩形内的覆盖率（0/1，坐标已归一化到 0..1）
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r ? 1 : 0;
}

function draw(size) {
  const SS = 4; // 超采样
  const S = size * SS;
  const buf = Buffer.alloc(size * size * 4);
  const r = 0.235 * S;
  const pad = 0.02 * S;
  const w = S - pad * 2;
  const h = S - pad * 2;

  // 收纳格：四块圆角方块
  const gap = 0.055 * S;
  const cell = (w - gap) / 2 - gap * 0.5;
  const boxes = [
    [pad + gap * 0.5, pad + gap * 0.5],
    [pad + gap * 0.5 + cell + gap, pad + gap * 0.5],
    [pad + gap * 0.5, pad + gap * 0.5 + cell + gap],
    [pad + gap * 0.5 + cell + gap, pad + gap * 0.5 + cell + gap]
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;
          if (!roundRectAlpha(px - pad, py - pad, w, h, r)) continue;

          // 背景渐变：#e2622c → #f0a35e，左上到右下
          const t = Math.min(1, Math.max(0, (px / S) * 0.55 + (py / S) * 0.45));
          let cr = 226 + (240 - 226) * t;
          let cg = 98 + (163 - 98) * t;
          let cb = 44 + (94 - 44) * t;

          // 顶部内高光
          const gloss = Math.max(0, 1 - py / (S * 0.45)) * 0.18;
          cr += (255 - cr) * gloss;
          cg += (255 - cg) * gloss;
          cb += (255 - cb) * gloss;

          // 白色格子
          for (const [bx, by] of boxes) {
            if (roundRectAlpha(px - bx, py - by, cell, cell, cell * 0.26)) {
              const k = 1;
              cr = cr + (255 - cr) * k;
              cg = cg + (255 - cg) * k;
              cb = cb + (255 - cb) * k;
              break;
            }
          }

          ar += cr; ag += cg; ab += cb; aa += 255;
        }
      }
      const n = SS * SS;
      const idx = (y * size + x) * 4;
      if (aa === 0) {
        buf[idx] = buf[idx + 1] = buf[idx + 2] = buf[idx + 3] = 0;
      } else {
        // 用覆盖率还原抗锯齿：aa 已经是 sum*255，直接平均
        buf[idx] = Math.round(ar / n);
        buf[idx + 1] = Math.round(ag / n);
        buf[idx + 2] = Math.round(ab / n);
        buf[idx + 3] = Math.round(aa / n);
      }
    }
  }
  return encodePNG(size, size, buf);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'icon.png'), draw(256));
writeFileSync(resolve(OUT, 'tray.png'), draw(32));
console.log('icon written to assets/icon.png & assets/tray.png');
