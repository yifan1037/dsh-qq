#!/usr/bin/env node
// sanitize.mjs —— 开源前脱敏扫描
//
// 用法：
//   node scripts/sanitize.mjs [目录，默认 packages]
//
// 规则分两类：
//   fail：发现即 exit 1（CI 会挂），因为这类东西不该出现在公开仓库
//   warn：只提示（例如"看起来像版本号的具体路径"）
//
// 设计原则：宁可误报，不可漏报。误报可以加白名单，漏报就是隐私泄露。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(process.cwd(), 'packages');

const FAIL = [
  { name: '本机绝对路径', re: /C:[\\/]Users[\\/][^\s'"`)]+/g, why: '暴露本机用户名/目录结构' },
  { name: 'Linux 主目录绝对路径', re: /\/home\/[A-Za-z0-9._-]+\//g, why: '暴露本机用户名' },
  { name: '真实 QQ 号（示例）', re: /\b36736366\b/g, why: '作者/用户的真实 QQ' },
  { name: '机器人 QQ 号（示例）', re: /\b2234200275\b/g, why: '设备/账号标识' },
  { name: '私人角色名', re: /小鲸鱼/g, why: '私人人设' },
  { name: '硬编码 token', re: /(access_token|consoleToken|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}/g, why: '泄露凭据' },
  { name: 'SnowLuma 具体版本路径', re: /snowluma-v\d+\.\d+\.\d+-\d{6,}/g, why: '本机安装路径' },
  { name: '私人聊天记录路径', re: /QQ Agent 时期的完整聊天|qq-agent-history\.md/g, why: '指向私人数据' },
];

const WARN = [
  { name: '疑似中文私人称呼', re: /叶榕|主人[（(]真实/g, why: '可能含私人关系称呼' },
  { name: '本机桥接目录名', re: /qq-bridge-archived-\d+/g, why: '本机归档路径' },
  { name: '绝对 Windows 盘符路径', re: /\b[A-Z]:[\\/](?!Users)[^\s'"`)]+/g, why: '可能暴露本机目录布局' },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'state', 'screen', 'backup-edits']);
const SKIP_FILE = /\.(png|jpg|jpeg|gif|webp|zip|pdf|docx|xlsx|pptx|log|jsonl)$/i;

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

const isPlaceholder = (s) => String(s).includes('<');
const hits = { fail: [], warn: [] };

for (const file of walk(ROOT)) {
  if (SKIP_FILE.test(file)) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  for (const rule of FAIL) {
    const m = text.match(rule.re);
    const real = m ? m.filter((x) => !isPlaceholder(x)) : [];
    if (real.length) hits.fail.push({ file, rule: rule.name, why: rule.why, sample: [...new Set(real.map((s) => s.slice(0, 60)))].slice(0, 3) });
  }
  for (const rule of WARN) {
    const m = text.match(rule.re);
    if (m) hits.warn.push({ file, rule: rule.name, why: rule.why, sample: [...new Set(m.map((s) => s.slice(0, 60)))].slice(0, 3) });
  }
}

const rel = (f) => path.relative(process.cwd(), f) || f;

if (hits.warn.length) {
  console.log('\n⚠️  警告（不阻塞）');
  for (const h of hits.warn) console.log(`  ${rel(h.file)} [${h.rule}] ${h.why}\n    ${h.sample.join(' | ')}`);
}

if (hits.fail.length) {
  console.log('\n❌ 必须修复（会让 CI 失败）');
  for (const h of hits.fail) console.log(`  ${rel(h.file)} [${h.rule}] ${h.why}\n    ${h.sample.join(' | ')}`);
  console.log(`\n结果：${hits.fail.length} 个文件含敏感内容，${hits.warn.length} 个警告`);
  process.exit(1);
}

console.log(`\n✅ 脱敏检查通过（扫描目录：${rel(ROOT)}，警告 ${hits.warn.length} 条）`);
