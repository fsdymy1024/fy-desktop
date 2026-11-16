/**
 * 浮层窗口的通用拖动。
 *
 * 三个窗口（组件库 / 关于 / 弹窗）都用 flex/grid 居中，所以用 transform 的
 * translate 做偏移，不动布局、不影响居中基准；位置按 storageKey 记在
 * localStorage，关掉再开还在上次拖到的地方（不做配置持久化，避免污染 config.json）。
 *
 * 只从标题栏起拖，且跳过按钮 / 输入框 / 链接——材质按钮、关闭按钮、搜索框
 * 都要能正常点，不能被拖动手势吃掉。
 */

const INTERACTIVE = 'button, a, input, textarea, select, label, [data-act], [data-nodrag]';

export function makeDraggable(panel, handle, key) {
  if (!panel || !handle) return () => {};

  const store = `fy.float.${key}`;
  let x = 0;
  let y = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(store) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      x = saved.x;
      y = saved.y;
    }
  } catch (_) {
    // localStorage 被禁或值坏了，就从居中开始
  }

  const apply = () => {
    panel.style.transform = `translate(${x}px, ${y}px)`;
  };
  apply();

  const onDown = (e) => {
    if (e.button !== 0 || e.target.closest(INTERACTIVE)) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = x;
    const oy = y;
    e.preventDefault();

    const prevSel = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    const onMove = (ev) => {
      // 宽松地限制在视口内：面板居中，偏移不超过半屏就不会整块飞出去
      const limX = Math.max(120, window.innerWidth / 2 - 80);
      const limY = Math.max(120, window.innerHeight / 2 - 60);
      x = Math.max(-limX, Math.min(limX, ox + ev.clientX - sx));
      y = Math.max(-limY, Math.min(limY, oy + ev.clientY - sy));
      apply();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevSel;
      try {
        localStorage.setItem(store, JSON.stringify({ x, y }));
      } catch (_) {
        // 记不住就算了，本次拖动仍然有效
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  handle.addEventListener('mousedown', onDown);
  return () => handle.removeEventListener('mousedown', onDown);
}

/**
 * 点遮罩关闭浮层。
 *
 * 这三个窗口（组件库 / 关于 / 弹窗）打开时整窗接管鼠标，遮罩本身就在最外层，
 * 所以「点窗口外的桌面」在这里就是「点遮罩」——必须能关，否则用户会觉得
 * 桌面被一块透明板锁死（v0.9.8 之前就是这个体感）。
 *
 * 只认「按下的地方就是遮罩」的那一次点击：从面板里按下、拖到遮罩上松手
 * （拖标题栏、选文字都会这样）不算，避免误关。
 */
export function closeOnBackdrop(host, close) {
  let downOnMask = false;
  const onDown = (e) => {
    downOnMask = e.target === host;
  };
  const onClick = (e) => {
    const wasMask = downOnMask;
    downOnMask = false;
    if (wasMask && e.target === host) close();
  };
  host.addEventListener('mousedown', onDown);
  host.addEventListener('click', onClick);
  return () => {
    host.removeEventListener('mousedown', onDown);
    host.removeEventListener('click', onClick);
  };
}
