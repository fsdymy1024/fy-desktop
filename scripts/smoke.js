/**
 * 数据层冒烟测试
 * ------------------------------------------------------------------
 * 在 Electron 环境里直接调用各 service，验证扫描 / 指标 / 网络三条链路。
 * 使用独立的临时配置目录，既不影响用户真实配置，也能验证「首次运行自动归类」。
 * 除读取桌面列表外不触碰任何用户文件。
 */

const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

// 必须在 ready 之前切换，否则 store 会落到真实配置目录
app.setPath('userData', path.join(os.tmpdir(), 'fy-desktop-smoke'));

app.whenReady().then(async () => {
  const shortcuts = require('../src/main/services/shortcuts');
  const sys = require('../src/main/services/system');
  const { NetworkMonitor } = require('../src/main/services/network');

  const items = shortcuts.scan();
  console.log(`[scan] ${items.length} 项`);
  console.log(`[scan] 前 3 项: ${items.slice(0, 3).map(i => `${i.name}(${i.kind})`).join(' | ')}`);

  shortcuts.autoAssign();
  const g = shortcuts.grouped();
  console.log(`[group] ${g.groups.map(x => `${x.name}:${x.items.length}`).join('  ')}`);
  console.log(`[plan] 待收纳 ${shortcuts.planTidy().length} 个文件（只统计，不移动）`);

  const s = await sys.snapshot();
  console.log(`[system] cpu=${s.cpu}% mem=${s.mem}% disk=${s.disk}% cores=${s.cores}`);

  const net = new NetworkMonitor({ interval: 500 });
  await net.sample();
  await new Promise(r => setTimeout(r, 1100));
  const snap = await net.sample();
  console.log(`[net] link=${snap.link.type}/${snap.link.name} ip=${snap.ip || '-'} latency=${snap.latency}ms down=${Math.round(snap.down)}B/s`);
  console.log(`[net] history points=${snap.downHistory.length}`);

  app.quit();
});
