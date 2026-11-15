/**
 * 浮层：右键菜单 + 确认框
 * 桌面常驻应用里，原生菜单会失焦闪烁，所以用页面内浮层。
 */

import { $, esc } from './util.js';

let ctxEl = null;

export function closeCtx() {
  if (ctxEl) {
    ctxEl.classList.remove('open');
    ctxEl.innerHTML = '';
    ctxEl = null;
  }
}

/**
 * @param {{label?:string, items:Array<{label?:string, sep?:boolean, hint?:string, danger?:boolean, onClick?:Function}>}} spec
 */
export function openCtx(x, y, spec) {
  closeCtx();
  const el = $('#ctx');
  const rows = [];

  if (spec.title) rows.push(`<div class="label">${esc(spec.title)}</div>`);

  for (const item of spec.items) {
    if (item.sep) { rows.push('<div class="sep"></div>'); continue; }
    if (item.label && !item.onClick) { rows.push(`<div class="label">${esc(item.label)}</div>`); continue; }
    rows.push(`<div class="item" data-act="${rows.length}">
      <span>${esc(item.label)}</span>
      ${item.hint ? `<span class="sub">${esc(item.hint)}</span>` : ''}
    </div>`);
  }

  el.innerHTML = rows.join('');
  el.style.left = '0px';
  el.style.top = '0px';
  el.classList.add('open');

  // 拿到尺寸后夹到视口内
  const rect = el.getBoundingClientRect();
  const left = Math.min(x, innerWidth - rect.width - 8);
  const top = Math.min(y, innerHeight - rect.height - 8);
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;

  // 绑定动作（只对可点击项）
  let idx = 0;
  const clickable = [];
  for (const item of spec.items) {
    if (item.sep || (item.label && !item.onClick)) continue;
    clickable.push(item);
  }
  el.querySelectorAll('.item').forEach((node, i) => {
    node.addEventListener('click', () => {
      closeCtx();
      clickable[i]?.onClick?.();
    });
  });

  ctxEl = el;
  return el;
}

document.addEventListener('mousedown', (e) => {
  if (ctxEl && !e.target.closest('#ctx')) closeCtx();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtx();
});
window.addEventListener('blur', closeCtx);

/* ------------------------------------------------------------------ */

/**
 * 确认框
 * @param {{title:string, desc?:string, list?:string[], okText?:string, danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmBox(opts) {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modalTitle').textContent = opts.title || '确认';
    $('#modalDesc').textContent = opts.desc || '';
    $('#modalList').innerHTML = (opts.list || []).map(t => `<div><code>${esc(t)}</code></div>`).join('');
    $('#modalList').style.display = (opts.list && opts.list.length) ? 'block' : 'none';

    const ok = $('#modalOk');
    ok.textContent = opts.okText || '确定';
    ok.classList.toggle('danger', Boolean(opts.danger));

    const done = (value) => {
      modal.classList.remove('open');
      ok.removeEventListener('click', onOk);
      $('#modalCancel').removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => { if (e.key === 'Escape') done(false); };

    ok.addEventListener('click', onOk);
    $('#modalCancel').addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);

    modal.classList.add('open');
  });
}
