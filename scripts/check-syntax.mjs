// 语法检查：遍历 packages/ 下所有 js/mjs/cjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.argv[2] || 'packages';
let n = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
    if (!/\.(mjs|js|cjs)$/.test(e.name)) continue;
    execFileSync(process.execPath, ['--check', p]);
    n += 1;
  }
};
walk(path.resolve(ROOT));
console.log(`syntax ok (${n} files)`);
