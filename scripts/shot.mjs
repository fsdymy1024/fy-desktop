/**
 * 截图自检
 * 用真实 Electron 窗口渲染一次并落盘，用来在没有人盯着的情况下验证 UI。
 * 用法：npm run shot [输出路径]
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, unlinkSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const out = resolve(process.argv[2] || resolve(root, 'docs', 'app-preview.png'));

if (existsSync(out)) unlinkSync(out);

const electron = resolve(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env, FY_SHOT: out, FY_DEMO_BG: '1' };
// 宿主若以 Electron 运行，ELECTRON_RUN_AS_NODE 会把它当 Node 跑，必须摘掉
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true
});

child.on('exit', (code) => {
  if (existsSync(out)) {
    console.log(`\n[shot] ok → ${out}`);
    process.exit(0);
  }
  console.error(`\n[shot] 没有生成截图，exit=${code}`);
  process.exit(1);
});
