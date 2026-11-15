/**
 * 统一的 Electron 启动器
 * 宿主环境（如 IDE）常带 ELECTRON_RUN_AS_NODE=1，会让 electron.exe 退化成 Node，
 * 这里统一摘掉再启动，保证 npm run smoke / shot 在任何终端都能跑。
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const args = process.argv.slice(2);

const electron = resolve(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

spawn(electron, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  .on('exit', code => process.exit(code ?? 0));
