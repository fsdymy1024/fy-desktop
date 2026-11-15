/**
 * 组件库。
 *
 * 按尺寸档位分组（小 / 中 / 大），每一格是「某个组件 × 某一档」——
 * 因为同一个组件在小号和大号里显示的内容并不一样（小号砍掉次要信息），
 * 只写组件名会让人点完才发现不是想要的。
 *
 * 面板与预览的配色跟随材质：`[data-mat]` 一换，CSS 变量整体跟着走，
 * 所以「石墨」下打开的窗口是深灰底、预览也是深灰卡片，不会跳出一块白板。
 */

import { REGISTRY, ORDER, SIZE_LABEL, dimsOf } from './widgets.js';

const MATERIALS = [
  ['glass', '玻璃'],
  ['dusk', '暮色'],
  ['solid', '石墨']
];

/** 每档的一句话说明，写在分组标题右边 */
const SIZE_NOTE = {
  s: '只留最要紧的',
  m: '内容完整',
  l: '排版更舒展'
};

const SIZE_ORDER = ['s', 'm', 'l'];

export function openGallery(host, opts) {
  const { cfg, onAdd, onClose, onChange } = opts;

  let mat = MATERIALS.some(([k]) => k === cfg.material) ? cfg.material : 'glass';

  const seg = MATERIALS.map(
    ([k, label]) =>
      `<button class="matbtn" data-mat="${k}" aria-pressed="${k === mat}"><i></i>${label}</button>`
  ).join('');

  const sections = SIZE_ORDER.map((size) => {
    const kinds = ORDER.filter((k) => (REGISTRY[k].sizes || []).includes(size));
    if (!kinds.length) return '';
    const [w, h] = dimsOf(size);
    const cards = kinds
      .map((kind) => {
        const d = REGISTRY[kind];
        return `<div class="gcard" data-kind="${kind}" data-size="${size}">
            <div class="gprev"><div class="sk">${d.preview(size)}</div></div>
            <div class="gname">${d.name}<span class="gadd">＋ 添加</span></div>
            <div class="gdesc">${d.desc}</div>
          </div>`;
      })
      .join('');
    return `<section class="gsec" data-size="${size}">
        <div class="gsec-head">
          <b>${SIZE_LABEL[size]}</b>
          <span>${w}×${h}</span>
          <em>${SIZE_NOTE[size]}</em>
        </div>
        <div class="gal-grid">${cards}</div>
      </section>`;
  }).join('');

  host.innerHTML = `
    <div class="gal" data-mat="${mat}">
      <div class="gal-head">
        <div>
          <h2>添加组件</h2>
          <p>点一下按这一档加到桌面；右键卡片可换尺寸、调整布局、移除</p>
        </div>
        <span class="spacer"></span>
        <div class="matseg">
          <span class="matseg-lab">材质</span>
          ${seg}
        </div>
        <button class="gal-close" title="关闭 (Esc)">
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
        </button>
      </div>
      <div class="gal-body">${sections}</div>
    </div>`;

  host.hidden = false;

  const close = () => {
    host.hidden = true;
    host.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  host.onclick = (e) => {
    if (e.target === host) return close();
    if (e.target.closest('.gal-close')) return close();

    // 只认材质按钮：`.gal` 自己也带 data-mat（给 CSS 用），
    // 用 [data-mat] 会把「点卡片」误判成「点材质」，添加永远不生效。
    const matBtn = e.target.closest('.matbtn');
    if (matBtn) {
      mat = matBtn.dataset.mat;
      // 面板底色、预览、按钮选中态都靠这一个属性传达
      host.querySelector('.gal')?.setAttribute('data-mat', mat);
      host.querySelectorAll('.matbtn').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.mat === mat));
      });
      onChange?.({ material: mat });
      return;
    }

    const card = e.target.closest('.gcard');
    // 把当前选中的材质一起交给添加逻辑：新卡记住这个材质，不回头改全局里
    // 已经存在的卡片（v0.9 修正「选材质却改了所有卡」的反向联动）。
    if (card) onAdd?.(card.dataset.kind, card.dataset.size, mat);
  };

  return { close };
}
