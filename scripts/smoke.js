/**
 * 数据层冒烟测试
 * 在 Electron 环境里直接调用各 service，验证扫描 / 指标 / 网络三条链路。
 * 不改动任何用户文件（只读桌面列表）。
 */

const { app } = require('electron');

app.whenReady().then(async () => {
  const shortcuts = require('../src/main/services/shortcuts');
  const sys = require('../src/main/services/system');
  const { NetworkMonitor } = require('../src/main/services/network');

  const items = shortcuts.scan();
  console.log(`[scan] ${items.length} 项`);
  console.log(`[scan] 前 3 项: ${items.slice(0, 3).map(i => `${i.name}(${i.kind})`).join(' | ')}`);

  const g = shortcuts.grouped();
  console.log(`[group] ${g.groups.map(x => `${x.name}:${x.items.length}`).join('  ')}`);
  console.log(`[plan] 待收纳 ${shortcuts.planTidy().length} 个文件（只统计，不移动）`);

  const s = await sys.snapshot();
  console.log(`[system] cpu=${s.cpu}% mem=${s.mem}% disk=${s.disk}% cores=${s.cores}`);

  const net = new NetworkMonitor({ interval: 500 });
  const first = await net.sample();
  await new Promise(r => setTimeout(r, 1100));
  const second = await net.sample();
  console.log(`[net] link=${second.link.type}/${second.link.name} ip=${second.ip || '-'} latency=${second.latency}ms down=${Math.round(second.down)}B/s`);
  console.log(`[net] history points=${second.downHistory.length}`);

  app.quit();
});
