'use strict';

/**
 * 默认布局
 * ------------------------------------------------------------------
 * 设计稿基于 1440×900 的舞台，但用户屏幕千差万别。
 * 这里按工作区尺寸重新摆一遍：左列固定宽度靠左，收纳面板贴右侧，
 * 高度不够时从下往上收，保证每个组件都落在屏幕内。
 */

const MARGIN = 48;
const COL_W = 352;
const SMALL = 168;
const ORG_W = 756;

function defaults(width, height) {
  const w = Math.max(1024, width);
  const h = Math.max(600, height);

  const orgW = Math.min(ORG_W, Math.max(420, w - COL_W - MARGIN * 3));
  const orgX = Math.max(MARGIN + COL_W + MARGIN, w - MARGIN - orgW);
  const colX = MARGIN;

  const weatherH = 150;
  const clockH = 168;
  const systemH = 150;
  const networkH = 150;
  const notesH = 112;
  const gap = 16;

  let y = MARGIN;
  const weather = { x: colX, y, w: COL_W, h: weatherH };
  y += weatherH + gap;

  const clock = { x: colX, y, w: SMALL, h: clockH };
  const calendar = { x: colX + SMALL + gap, y, w: SMALL, h: clockH };
  y += clockH + gap;

  const system = { x: colX, y, w: COL_W, h: systemH };
  y += systemH + gap;

  const network = { x: colX, y, w: COL_W, h: networkH };
  y += networkH + gap;

  // 备注贴着底部，但至少要留 MARGIN
  const notesY = Math.min(y, h - MARGIN - notesH);
  const notes = { x: colX, y: Math.max(MARGIN, notesY), w: COL_W, h: notesH };

  return {
    weather,
    clock,
    calendar,
    system,
    network,
    notes,
    organizer: { x: orgX, y: MARGIN, w: orgW, h: 0 }
  };
}

module.exports = { defaults };
