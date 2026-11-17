/**
 * Tauri 桥。前端不打包，直接用全局 __TAURI__（tauri.conf 里开了 withGlobalTauri），
 * 只有这一个文件知道底层怎么调，其它模块只看到 invoke / listen。
 */

const T = window.__TAURI__;

if (!T) {
  // 窗口在 ui_ready 之前是隐藏的，这里必须把问题画出来，
  // 否则表现就是「程序启动了但桌面上什么都没有」，完全没法排查。
  document.body.innerHTML = `
    <div style="position:fixed;inset:0;display:grid;place-items:center;background:rgba(20,14,10,.92);color:#ffd9c7;
                font:13px/1.7 ui-monospace,Consolas,monospace;padding:40px;text-align:left">
      <div style="max-width:640px">
        <div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:10px">Tauri 运行环境没有注入</div>
        <div>window.__TAURI__ 不存在，前端拿不到任何数据。</div>
        <div style="margin-top:8px;color:#ffb08a">常见原因：CSP 拦掉了初始化脚本，或 withGlobalTauri 被关掉了。</div>
      </div>
    </div>`;
  throw new Error('__TAURI__ 未注入');
}

export const dbg = {
  hasEvent: typeof T.event?.listen === 'function',
  registered: [],
  failed: [],
  hits: 0
};

export const invoke = (...args) => T.core.invoke(...args);

/** 所有订阅返回的退订函数。页面被 WebView2 回收重建时会重新跑一遍模块，
 *  旧订阅还在的话同一个事件会回调两次（热区/指标都会重复处理），
 *  所以这里统一记账，pagehide 时一次性退订。 */
const SUBS = [];

export const listen = (name, cb) => {
  const p = T.event.listen(name, (e) => {
    dbg.hits++;
    try {
      cb(e);
    } catch (err) {
      dbg.failed.push(`${name} handler: ${err?.message || err}`);
    }
  });
  SUBS.push(p);
  p.then(() => dbg.registered.push(name)).catch((err) =>
    dbg.failed.push(`${name}: ${err?.message || err}`)
  );
  return p;
};

/** 退订本模块登记过的全部事件。幂等。 */
export function unlistenAll() {
  for (const p of SUBS.splice(0)) {
    p.then((un) => un()).catch(() => {});
  }
}
