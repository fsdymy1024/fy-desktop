/**
 * 截图 / 自检专用逻辑（FY_SHOT、FY_UI）。
 *
 * 这些分支以前直接写在 `boot()` 里：30 多个 `if (b.uitest === …)` 夹在启动编排
 * 中间，加上一个 130 行的 `dumpLayout` 探针。正式包虽然靠环境变量关着，但代码
 * 一直在，读启动流程时全是噪声。
 *
 * 现在整块搬到这里，由 main.js 在 `S.shotMode || S.uitest` 时动态 import：
 * 正常运行一行都不会执行，也不会被打包进首屏解析路径。
 *
 * 约定：这里只做「点一下/等一等/量一量/落盘」，不改业务逻辑。
 */

import { invoke, dbg } from './bridge.js';

const $ = (s, r = document) => r.querySelector(s);
const dpr = () => window.devicePixelRatio || 1;

/** 等收纳面板真的渲染出来（要等桌面扫描返回，可能要几秒） */
function waitPanel(cb, tries = 80) {
  const panel = $('#organizer');
  if (panel?.querySelector('.org-head')) return cb(panel);
  if (tries > 0) setTimeout(() => waitPanel(cb, tries - 1), 150);
}

/** 在首张卡片上派发一次右键，等价于用户点右键 */
function openFirstCardMenu() {
  const el = document.querySelector('#stage .card');
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: Math.round(r.left + 46),
      clientY: Math.round(r.top + 40)
    })
  );
}

/** 把布局与各类探针落盘成同名 .json，方便无人值守核对 */
function dumpLayout(S) {
  const json = JSON.stringify(
    {
      inner: [innerWidth, innerHeight],
      dpr: dpr(),
      scale: S.scale,
      design: S.design,
      widgets: [...document.querySelectorAll('#stage .card')].map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return [el.dataset.kind, el.dataset.size, el.dataset.material || '',
          Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height),
          cs.backgroundColor, cs.color];
      }),
      organizer: (() => {
        const r = $('#organizer').getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      })(),
      // 收纳格子：必须是正方形、每排最多 7 个。这些数只能量出来，看不准
      org: (() => {
        const el = $('#organizer');
        const grid = el.querySelector('.shelf:not(.folded) .cells');
        const kids = grid ? [...grid.children] : [];
        const top = kids[0]?.offsetTop;
        const first = kids[0]?.getBoundingClientRect();
        return {
          w: Math.round(el.getBoundingClientRect().width),
          cols: kids.filter((k) => k.offsetTop === top).length,
          cell: first ? [Math.round(first.width), Math.round(first.height)] : null,
          shelves: el.querySelectorAll('.shelf').length,
          foldedShelves: el.querySelectorAll('.shelf.folded').length,
          foldedCfg: (S.cfg.organizer.folded || []).length
        };
      })(),
      foldProbe: S.foldProbe || null,
      menuProbe: S.menuProbe || null,
      menuLate: S.menuLate || null,
      glass: document.body.dataset.glass === '1',
      // 材质的三个来源必须一致：DOM 属性（CSS 用）、内存配置、磁盘配置
      mat: {
        attr: document.body.dataset.material,
        cfg: S.cfg.material,
        tone: document.body.dataset.tone || '',
        shot: !!S.shot,
        glassErr: S.glassErr || '',
        fill: (() => {
          const s = document.querySelector('#stage .surface');
          return s ? getComputedStyle(s).backgroundColor : '';
        })()
      },
      // 日历卡与时钟卡在最小尺寸下的内部盒子：核对内容是「刚好塞下」还是「溢出被裁」
      probe: (() => {
        const out = {};
        for (const kind of ['calendar', 'clock']) {
          const card = document.querySelector(`#stage .card[data-kind="${kind}"]`);
          if (!card) continue;
          const body = card.querySelector('.body');
          const box = (sel) => {
            const el = card.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
          };
          out[kind] = {
            body: box('.body'),
            bodyScroll: [body?.clientWidth, body?.clientHeight, body?.scrollWidth, body?.scrollHeight],
            grid: box('.cd-grid'),
            week: box('.cd-week'),
            side: box('.ck-side'),
            dial: box('.ck-dial')
          };
        }
        return out;
      })(),
      net: (() => {
        const card = document.querySelector('#stage .card[data-kind="network"]');
        if (!card) return null;
        const box = (sel) => {
          const el = card.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
        };
        return {
          top: box('.net-top'),
          mid: box('.net-mid'),
          main: box('.net-main'),
          num: box('.net-num b'),
          spark: box('.net-spark'),
          foot: box('.net-foot'),
          text: card.querySelector('.down')?.textContent,
          bodyH: card.querySelector('.body')?.clientHeight
        };
      })(),
      counters: S.counters || {},
      // 弹层调试：菜单到底有没有渲染出来（FY_UI=menu 时靠这个判断）
      menu: {
        hidden: $('#menu')?.hidden,
        items: $('#menu')?.querySelectorAll('button').length || 0,
        text: $('#menu')?.innerText?.slice(0, 200) || ''
      },
      // 组件库 / 关于 / 天气弹层都在控制中心（独立窗口）里，主窗口只留全局材质
      floats: { body: document.body.dataset.material },
      probe: { tray: S.trayProbe || null },
      err: S.err || '',
      bridge: dbg,
      shot: !!S.shot
    },
    null,
    1
  );
  invoke('dev_dump', { json }).catch(() => {});
}

/**
 * @param {object} S   main.js 的全局状态
 * @param {object} api main.js 暴露的界面动作
 */
export function installDebug(S, api) {
  const { setEdit, loadGlass } = api;
  const dump = () => dumpLayout(S);
  const uitest = S.uitest || '';

  if (S.shotMode) {
    // 等玻璃底图就绪再落盘，否则 json 里 glass 永远是 false
    // 两拍：400ms 那次拿布局与底图状态，6s 那次带上真实的指标/天气值
    // （第一拍太早，counters 全是 0，看不出「数据到底有没有到」）
    loadGlass().then(() => {
      setTimeout(dump, 400);
      setTimeout(dump, 6000);
    });
  }

  // 天气地区 / 分组命名 / 组件库 / 关于已经搬进控制中心（独立窗口），
  // 对应的 FY_UI 探针一并移除，避免继续依赖已删除的浮层 DOM。

  // FY_UI=edit：进编辑模式，用来核对虚线框、参考线这些只在编辑态出现的东西
  if (uitest === 'edit') setTimeout(() => setEdit(true), 400);

  // FY_UI=orgfold：进编辑态再点一次「全部折叠/展开」，核对按钮图标与整列分组是否真的收起
  if (uitest === 'orgfold') {
    setTimeout(() => {
      setEdit(true);
      waitPanel((panel) => {
        const btn = panel.querySelector('[data-act="fold-all"]');
        S.foldProbe = { found: !!btn, before: (S.cfg.organizer.folded || []).length };
        btn?.click();
        S.foldProbe.after = (S.cfg.organizer.folded || []).length;
        S.foldProbe.shelves = panel.querySelectorAll('.shelf.folded').length;
        setTimeout(() => dump(), 200);
      });
    }, 400);
  }

  // FY_UI=orgmenu：在面板里右键，核对菜单项与组件右键菜单的结构一致（无尺寸/布局项）
  if (uitest === 'orgmenu') {
    setTimeout(
      () =>
        waitPanel((panel) => {
          const head = panel.querySelector('.shelves') || panel;
          const r = head.getBoundingClientRect();
          head.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 120, clientY: r.top + 80 })
          );
          setTimeout(() => {
            S.menuLate = { hidden: $('#menu').hidden };
          }, 5000);
          setTimeout(() => {
            const m = $('#menu');
            S.menuProbe = {
              hidden: m.hidden,
              items: [...m.querySelectorAll('button')].map((b) => b.textContent.trim()),
              rect: (() => {
                const q = m.getBoundingClientRect();
                return [Math.round(q.left), Math.round(q.top), Math.round(q.width), Math.round(q.height)];
              })()
            };
            dump();
          }, 300);
        }),
      400
    );
  }

  // FY_UI=menu：在首张卡片上弹右键菜单；menusize：点一下换档
  if (uitest === 'menu') setTimeout(() => openFirstCardMenu(), 500);

  if (uitest === 'menusize') {
    setTimeout(() => {
      openFirstCardMenu();
      setTimeout(() => document.querySelector('#menu button')?.click(), 600);
    }, 500);
  }

  // 托盘菜单探针由 main.js 里的 trayMenuProbe 自己跑（它要复用闭包内的状态）
  return { dump };
}
