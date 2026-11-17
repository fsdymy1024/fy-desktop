/**
 * 关于 fy-desktop。
 *
 * 一页放三件事：版本号、检查更新、自动更新开关。
 * 更新源是 GitHub Releases（fsdymy1024/fy-desktop）——仓库还没建 / 还没发版本时
 * 后端会带回一条 error，这里照实显示，不要假装「已是最新」。
 */

import { invoke, listen } from './bridge.js';
import { makeDraggable, closeOnBackdrop } from './floatwin.js';

const REPO = 'https://github.com/fsdymy1024/fy-desktop';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 把 markdown 压成能看的纯文本：去掉标题井号、加粗星号、图片语法 */
function plain(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]+/g, '')
    .replace(/\r/g, '')
    .trim()
    .slice(0, 600);
}

function sizeText(n) {
  if (!n) return '';
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`;
}

export function openAbout(host, opts) {
  const { version, cfg, onClose, onAutoUpdate } = opts;

  host.innerHTML = `
    <div class="ab">
      <div class="ab-head">
        <div class="ab-logo">fy</div>
        <div class="ab-id">
          <h2>fy-desktop <em>v${esc(version)}</em></h2>
          <p>Windows 桌面玻璃小组件 + 快捷方式收纳</p>
        </div>
        <button class="ab-close" title="关闭 (Esc)">
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>
        </button>
      </div>
      <div class="ab-body">
        <div class="ab-row"><span>当前版本</span><b>v${esc(version)}</b></div>
        <div class="ab-row"><span>更新源</span><a data-act="repo">https://github.com/fsdymy1024/fy-desktop</a></div>
        <div class="ab-row"><span>安装位置</span><a data-act="conf">打开配置与日志目录</a></div>

        <div class="ab-sec">
          <div class="ab-sec-head">
            <b>更新</b>
            <button class="abbtn" data-act="check">检查更新</button>
          </div>
          <div class="ab-upd" data-slot="upd">启动时会自动检查（可在下面关掉）</div>
        </div>

        <div class="ab-sec">
          <label class="ab-switch">
            <input type="checkbox" data-act="auto" ${cfg.auto_update === false ? '' : 'checked'}>
            <i></i><span>自动更新</span><em>启动后检查新版本，发现时提示</em>
          </label>
        </div>
      </div>
      <div class="ab-foot">MIT License · 数据只存在本机，不上传任何内容</div>
    </div>`;

  host.hidden = false;

  const disposeDrag = makeDraggable(
    host.querySelector('.ab'),
    host.querySelector('.ab-head'),
    'about'
  );

  const slot = host.querySelector('[data-slot="upd"]');
  const checkBtn = host.querySelector('[data-act="check"]');
  const autoBox = host.querySelector('[data-act="auto"]');
  let found = null;

  const close = () => {
    disposeBackdrop();
    disposeDrag();
    host.hidden = true;
    host.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };

  // 点窗口外的桌面即关闭：打开期间整窗接管鼠标，不关就等于把桌面锁死
  const disposeBackdrop = closeOnBackdrop(host, close);
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  /** @param {'idle'|'busy'|'ok'|'new'|'fail'} state */
  const setState = (html) => {
    slot.innerHTML = html;
  };

  async function check() {
    checkBtn.disabled = true;
    checkBtn.textContent = '检查中…';
    setState('正在连接 GitHub…');
    try {
      const u = await invoke('check_update');
      if (u.error) {
        found = null;
        setState(`<span class="bad">检查失败：${esc(u.error)}</span>`);
        return;
      }
      if (!u.has_update) {
        found = null;
        setState(
          `<span class="ok">已是最新版本</span> · 最新发布 v${esc(u.latest || version)}` +
            (u.published ? ` · ${esc(u.published)}` : '')
        );
        return;
      }
      found = u;
      const notes = plain(u.notes);
      setState(`
        <span class="new">发现新版本 v${esc(u.latest)}${u.published ? ` · ${esc(u.published)}` : ''}</span>
        ${notes ? `<span class="notes">${esc(notes)}</span>` : ''}
        <span class="acts">
          ${
            u.asset
              ? `<button class="abbtn primary" data-act="install">下载并安装${u.size ? ` · ${sizeText(u.size)}` : ''}</button>`
              : ''
          }
          <button class="abbtn" data-act="page">发布页</button>
        </span>`);
    } catch (e) {
      setState(`<span class="bad">检查失败：${esc(e?.message || e)}</span>`);
    } finally {
      checkBtn.disabled = false;
      checkBtn.textContent = '检查更新';
    }
  }

  async function install() {
    if (!found) return;
    const btn = slot.querySelector('[data-act="install"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '正在下载…';
    }

    // 后端流式下载，每 120ms 推一次已下载字节数——慢网下没有进度会像卡死
    const un = await listen('update:download', ({ payload }) => {
      const p = payload || {};
      const pct = p.total ? Math.min(100, Math.round((p.downloaded / p.total) * 100)) : 0;
      const right = p.total
        ? `${pct}% · ${sizeText(p.downloaded)} / ${sizeText(p.total)}`
        : sizeText(p.downloaded);
      setState(`
        <span class="ok">正在下载 v${esc(found.latest)}</span>
        <i class="dl-bar"><b style="width:${p.done ? 100 : pct}%"></b></i>
        <span class="dl-note">${right}</span>`);
    }).catch(() => null);

    try {
      setState(`正在下载 v${esc(found.latest)} 安装包…`);
      const path = await invoke('download_update', { asset: found.asset, version: found.latest });
      setState('下载完成，正在启动安装程序…程序会自动退出，装完再打开即可。');
      await invoke('install_update', { path });
    } catch (e) {
      setState(
        `<span class="bad">更新失败：${esc(e?.message || e)}</span>
         <span class="acts"><button class="abbtn" data-act="page">改为手动下载</button></span>`
      );
    } finally {
      un?.();
    }
  }

  host.onclick = (e) => {
    if (e.target === host) return;
    if (e.target.closest('.ab-close')) return close();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'check') return check();
    if (act === 'install') return install();
    if (act === 'page') {
      const url = found?.page || `${REPO}/releases`;
      return invoke('open_url', { url }).catch(() => {});
    }
    if (act === 'repo') return invoke('open_url', { url: REPO }).catch(() => {});
    if (act === 'conf') return invoke('open_config_dir').catch(() => {});
  };

  autoBox.onchange = () => {
    const on = !!autoBox.checked;
    invoke('set_auto_update', { on }).catch(() => {});
    onAutoUpdate?.(on);
  };

  return { close };
}

/** 自动检查发现新版本时，页面里用一句 toast 提醒（不弹窗、不抢焦点） */
export function updateHint(u) {
  return `发现新版本 v${u.latest}：右键托盘图标 → 关于 fy-desktop 可更新`;
}
