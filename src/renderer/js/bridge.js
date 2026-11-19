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

/** 启动期专用 invoke。
 *
 *  后端在 `setup()` 里才 `app.manage(AppState)`，而 WebView2 可能在 setup 还没跑完
 *  时就已经把页面加载完并发出 `boot` —— 此时命令会以
 *  「state not managed for field `state`」被拒。这是纯粹的时序竞争：
 *  重试一次就好了，但一次都不重试的后果是整层渲染失败，
 *  用户看到的是空桌面 + 「渲染层没有启动」，且不会自愈。
 *
 *  只对「状态还没注册」这一类错误重试，其它错误立刻抛出，不会把真错误藏起来。 */
export async function invokeRetry(name, args, tries = 10, delay = 100) {
  for (let i = 0; ; i++) {
    try {
      return await invoke(name, args);
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (i + 1 >= tries || !/not managed/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

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

/** 给另一个窗口发事件（托盘菜单小窗 → 主窗口这种跨窗口协作）。
 *  目标窗口的 label 见 tauri.conf.json：main / hub / traypop。 */
export const emitTo = (label, name, payload) => T.event.emitTo(label, name, payload);

/** 退订本模块登记过的全部事件。幂等。 */
export function unlistenAll() {
  for (const p of SUBS.splice(0)) {
    p.then((un) => un()).catch(() => {});
  }
}
