// 尺寸/网格常量两端一致性校验。
//
// 同一套设计尺寸在两处各写一份：
//   Rust   src-tauri/src/config.rs   GRID / S / MW
//   JS     src/renderer/js/widgets.js S / GAP / MW
// 改档位时很容易只改一边，表现是「后端按 210 排、前端按 216 裁」这种错位。
// 这里直接读源码里的常量做断言，接进 CI 当门禁（和 check-version 同一条思路）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const rs = readFileSync(join(root, 'src-tauri/src/config.rs'), 'utf8');
const js = readFileSync(join(root, 'src/renderer/js/widgets.js'), 'utf8');

/** 抓 `const NAME[: f64] = <表达式>;`，表达式里只允许数字/标识符/四则运算 */
function expr(text, name, env) {
  const m = text.match(
    new RegExp(`(?:const|let)\\s+${name}\\s*(?::\\s*f64)?\\s*=\\s*([^;\\n]+)`, 'm')
  );
  if (!m) return NaN;
  const rhs = m[1].trim();
  if (!/^[\w\s.()+*-]+$/.test(rhs)) return NaN;
  const sub = rhs.replace(/[A-Za-z_]\w*/g, (id) => (id in env ? String(env[id]) : 'NaN'));
  try {
    return Function(`'use strict';return (${sub});`)();
  } catch {
    return NaN;
  }
}

const rsEnv = { GRID: NaN, S: NaN };
rsEnv.GRID = expr(rs, 'GRID', rsEnv);
rsEnv.S = expr(rs, 'S', rsEnv);
const rsMW = expr(rs, 'MW', rsEnv);

const jsEnv = { GAP: NaN, S: NaN };
jsEnv.S = expr(js, 'S', jsEnv);
jsEnv.GAP = expr(js, 'GAP', jsEnv);
const jsMW = expr(js, 'MW', jsEnv);

const checks = [
  ['S（小号边长）', rsEnv.S, jsEnv.S],
  ['GRID / GAP（网格 = 最小缝隙）', rsEnv.GRID, jsEnv.GAP]
];

let bad = 0;
for (const [label, a, b] of checks) {
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(32)} rust=${a}  js=${b}`);
}

// MW = 2 × S + GRID 是两端的推导式，顺带核对推导式本身没被写成别的数
const derive = 2 * rsEnv.S + rsEnv.GRID;
for (const [label, v] of [
  ['rust MW == 2S+GRID', rsMW],
  ['js   MW == 2S+GAP', jsMW]
]) {
  const ok = Math.abs(v - derive) < 1e-9;
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(32)} ${v} (应为 ${derive})`);
}

if (bad) {
  console.error(`\n尺寸常量不一致：${bad} 项。改档位时请同时改 config.rs 与 widgets.js`);
  process.exit(1);
}
console.log('\n尺寸常量一致');
