// 版本号三处必须一致：package.json / Cargo.toml / tauri.conf.json。
// 打安装包前跑一次，避免出现「exe 是 0.2.0、安装包叫 0.1.0」这种事故。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

const toml = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
const cargo = toml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];

const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;

const rows = [
  ['package.json', pkg],
  ['src-tauri/Cargo.toml', cargo],
  ['src-tauri/tauri.conf.json', conf],
];

for (const [file, v] of rows) {
  console.log(`${v === pkg ? '✓' : '✗'} ${file.padEnd(26)} ${v ?? '(未找到)'}`);
}

if (cargo !== pkg || conf !== pkg) {
  console.error(`\n版本号不一致，应为 ${pkg}`);
  process.exit(1);
}
console.log(`\n版本号一致：${pkg}`);
