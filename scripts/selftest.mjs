// 无界面自检：跑 release 二进制的一次自检模式，把结果打到终端。
// 只在临时目录里造文件，绝不碰用户桌面上的真实文件。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(root, 'src-tauri/target/release/fy-desktop.exe');

if (!existsSync(exe)) {
  console.error(`找不到 ${exe}\n先跑 npm run selftest（它会先编译），或直接 npm run build`);
  process.exit(1);
}

const child = spawn(exe, [], {
  env: { ...process.env, FY_SELFTEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let pass = 0;
let fail = 0;

child.stdout.on('data', (b) => {
  for (const line of b.toString().split('\n')) {
    if (!line.trim()) continue;
    // 自检日志里带对勾/叉号的行才是断言结果，其余是启动噪声
    if (line.includes('✓')) pass++;
    if (line.includes('✗')) fail++;
    if (/selftest|✓|✗|autostart|weather|monitor/.test(line)) console.log(line);
  }
});

child.stderr.on('data', (b) => process.stderr.write(b));

child.on('exit', (code) => {
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(code === 0 && fail === 0 ? 0 : 1);
});
