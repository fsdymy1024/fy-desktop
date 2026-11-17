/**
 * 兜底错误屏。
 *
 * 如果 main.js 这个模块本身加载失败（语法错误、资源 404），全局的 boot().catch
 * 也不会执行，页面就是彻底空白。后端看门狗会在 4.5s 强制显示窗口，这里 5s 后
 * 把页面换成可读的提示，让「什么都没有」变成「能看出哪里错了」。
 *
 * 为什么单独一个文件：tauri.conf.json 现在开了最小 CSP（script-src 'self'），
 * index.html 里的内联 <script> 会被直接拦掉。放成外部脚本既能被执行，
 * 也不用为了这段兜底去开 'unsafe-inline'。
 */
setTimeout(function () {
  if (document.body.dataset.ready === '1') return;
  document.body.innerHTML =
    '<div style="position:fixed;inset:0;display:grid;place-items:center;' +
    'background:rgba(20,14,10,.92);color:#ffd9c7;font:12.5px/1.8 ui-monospace,Consolas,monospace;padding:40px">' +
    '<div style="max-width:680px">' +
    '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:10px">渲染层没有启动</div>' +
    '<p>窗口已经显示出来了，但 main.js 没有跑完（通常是模块加载失败）。</p>' +
    '<p>排查：右键托盘图标 → 设置文件…，或直接看 <code>%APPDATA%\\com.fy.desktop\\config.json</code>。</p>' +
    '<p>也可以在命令行运行安装目录下的 fy-desktop.exe 看 stderr 输出。</p>' +
    '</div></div>';
}, 5000);
