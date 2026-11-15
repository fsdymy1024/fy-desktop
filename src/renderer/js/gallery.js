/**
 * 组件库。
 * 只做一件事：把 REGISTRY 里的组件列出来，点一下就加到桌面。
 */

import { REGISTRY, ORDER } from './widgets.js';

const MATERIALS = [
  ['glass', '玻璃'],
  ['dusk', '暮色'],
  ['solid', '石墨']
];

export function openGallery(host, opts) {
  const { cfg, onAdd, onClose, onChange } = opts;

  const mat = cfg.material || 'glass';
  const seg = MATERIALS.map(
    ([k, label]) =>
      `<button class="ebtn ${k === mat ? 'primary' : ''}" data-mat="${k}">${label}</button>`
  ).join('');

  const cards = ORDER.map((kind) => {
    const w = REGISTRY[kind];
    return `<div class="gcard" data-kind="${kind}">
        <div class="gprev">${w.preview()}</div>
        <div class="gname">${w.name}<span class="gadd">＋ 添加</span></div>
        <div class="gdesc">${w.desc}</div>
      </div>`;
  }).join('');

  host.innerHTML = `
    <div class="gal">
      <div class="gal-head">
        <div>
          <h2>组件库</h2>
          <p>点一下加到桌面；编辑模式里可拖动位置、切换小/中/大、移除</p>
        </div>
        <span class="spacer"></span>
        <div style="display:flex;gap:4px;align-items:center">
          <span style="font-size:9.5px;color:rgba(26,22,19,.45);margin-right:2px">材质</span>
          ${seg}
        </div>
        <button class="gal-close" title="关闭 (Esc)">
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
        </button>
      </div>
      <div class="gal-grid">${cards}</div>
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

    const matBtn = e.target.closest('[data-mat]');
    if (matBtn) {
      onChange?.({ material: matBtn.dataset.mat });
      host.querySelectorAll('[data-mat]').forEach((b) => {
        b.classList.toggle('primary', b.dataset.mat === matBtn.dataset.mat);
      });
      return;
    }

    const card = e.target.closest('.gcard');
    if (card) onAdd?.(card.dataset.kind);
  };

  return { close };
}
