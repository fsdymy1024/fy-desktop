/**
 * 自检截图。
 *
 * 桌面常驻应用没法「打开页面看一眼」，所以让程序自己拍：
 * 启动 → 等数据齐 → 抓一张包含窗口的真实屏幕 → 退出。
 * 同时会在图片旁边落一份 .json，记录每个卡片的实际坐标。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.argv[2] || 'docs/app-preview.png');
mkdirSync(dirname(out), { recursive: true });

const exe = resolve(root, 'src-tauri', 'target', 'debug', 'fy-desktop.exe');
if (!existsSync(exe)) {
  console.error(`未找到可执行文件：${exe}\n先跑 npm run build:debug`);
  process.exit(1);
}

const env = {
  ...process.env,
  FY_SHOT: out,
  FY_SHOT_DELAY: process.env.FY_SHOT_DELAY || '7000'
};

spawn(exe, [], { cwd: root, env, stdio: 'inherit' })
  .on('exit', (code) => {
    console.log(`[shot] ${out}`);
    process.exit(code ?? 0);
  });
