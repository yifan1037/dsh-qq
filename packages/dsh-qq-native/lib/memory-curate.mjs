// memory-curate.mjs —— 记忆整理器：让记忆对 agent 更好读
//
// 做四件事：
//   1. 去重：正文归一化后相同的，只留权重最高/最新的那条（合并 tags）
//   2. 分组：按 kind 分组，组内按 权重↓ / 时间↓ 排序
//   3. 归档：weight<=1 且超过 90 天的，挪到 memories-archived.jsonl（不删）
//   4. 生成索引：~/.dsh/qq-memory/INDEX.md（人和 agent 都能直接读）+ index.json
//
// 幂等：内容没变化就不重写主库。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MEM_DIR = () => path.join(os.homedir(), '.dsh', 'qq-memory');
const MEM_FILE = () => path.join(MEM_DIR(), 'memories.jsonl');
const MEM_ARCHIVE = () => path.join(MEM_DIR(), 'memories-archived.jsonl');
const MEM_INDEX_MD = () => path.join(MEM_DIR(), 'INDEX.md');
const MEM_INDEX_JSON = () => path.join(MEM_DIR(), 'index.json');

const KIND_ORDER = ['事实', '偏好', '计划', '关系', '事件', '标签'];

function readAllMemories() {
  let raw = '';
  try { raw = fs.readFileSync(MEM_FILE(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.text) out.push(r);
    } catch { /* skip bad line */ }
  }
  return out;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/[，。！？、,.!?；;：:"'`]/g, '');

const fmtDate = (at) => {
  const d = new Date(Number(at) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

/** 整理记忆库；返回统计 */
export function curateMemory({ archiveDays = 90, log = () => {} } = {}) {
  const dir = MEM_DIR();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  const all = readAllMemories();
  if (!all.length) {
    try { fs.writeFileSync(MEM_INDEX_MD(), '# 记忆库\n\n（还没有记忆）\n', 'utf8'); } catch { /* ignore */ }
    return { total: 0, kept: 0, merged: 0, archived: 0 };
  }

  const now = Date.now();
  const byNorm = new Map();
  const archived = [];
  let merged = 0;

  for (const rec of all) {
    const ageDays = (now - (Number(rec.at) || 0)) / 86400000;
    const w = Number(rec.weight) || 3;
    if (w <= 1 && ageDays > archiveDays) { archived.push(rec); continue; }

    const key = norm(rec.text);
    const prev = byNorm.get(key);
    if (!prev) { byNorm.set(key, { ...rec, tags: [...(rec.tags || [])] }); continue; }

    merged += 1;
    const prevWeight = Number(prev.weight) || 0;
    const keep = prevWeight >= w ? prev : { ...rec, tags: [...(rec.tags || [])] };
    const other = keep === prev ? rec : prev;
    keep.tags = [...new Set([...(keep.tags || []), ...(other.tags || [])])].slice(0, 12);
    keep.uses = (Number(keep.uses) || 0) + (Number(other.uses) || 0);
    byNorm.set(key, keep);
  }

  const kept = [...byNorm.values()].sort(
    (a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0) || (Number(b.at) || 0) - (Number(a.at) || 0)
  );

  const sig = (rows) => rows.map((r) => r.id + ':' + (r.weight || 0) + ':' + (r.tags || []).join(',')).join('|');
  const changed = merged > 0 || archived.length > 0 || sig(all) !== sig(kept);

  if (changed) {
    try {
      fs.copyFileSync(MEM_FILE(), MEM_FILE() + '.bak-curate-' + Date.now());
      fs.writeFileSync(MEM_FILE(), kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      if (archived.length) {
        fs.appendFileSync(MEM_ARCHIVE(), archived.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      }
    } catch (error) {
      log('[memory] 写回失败：' + (error?.message ?? error));
    }
  }

  // 生成索引
  const groups = new Map();
  for (const r of kept) {
    const k = KIND_ORDER.includes(r.kind) ? r.kind : '其它';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const order = [
    ...KIND_ORDER.filter((k) => groups.has(k)),
    ...[...groups.keys()].filter((k) => !KIND_ORDER.includes(k)),
  ];

  const md = [];
  md.push('# 记忆库索引');
  md.push('');
  md.push('> 自动生成，勿手改。共 ' + kept.length + ' 条（本次合并重复 ' + merged + ' 条，归档 ' + archived.length + ' 条）。');
  md.push('');
  for (const k of order) {
    md.push('## ' + k + '（' + groups.get(k).length + '）');
    for (const r of groups.get(k)) {
      const tags = (r.tags || []).length ? ' [' + (r.tags || []).join('][') + ']' : '';
      const star = '★'.repeat(Math.max(1, Math.min(5, Number(r.weight) || 3)));
      md.push('- ' + star + ' ' + fmtDate(r.at) + ' ' + String(r.text).replace(/\s+/g, ' ').slice(0, 200) + tags);
    }
    md.push('');
  }

  try { fs.writeFileSync(MEM_INDEX_MD(), md.join('\n'), 'utf8'); } catch { /* ignore */ }
  try {
    fs.writeFileSync(MEM_INDEX_JSON(), JSON.stringify({
      generatedAt: new Date().toISOString(),
      total: all.length,
      kept: kept.length,
      merged,
      archived: archived.length,
      groups: Object.fromEntries(order.map((k) => [k, groups.get(k).length])),
      items: kept.map((r) => ({ id: r.id, at: r.at, kind: r.kind, weight: r.weight, tags: r.tags || [], text: String(r.text).slice(0, 300) })),
    }, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }

  log(`[memory] 整理完成：${all.length} → ${kept.length} 条（合并 ${merged}，归档 ${archived.length}）`);
  return { total: all.length, kept: kept.length, merged, archived: archived.length };
}

/** 读记忆索引（给 prompt 注入用），太长就截断 */
export function readMemoryIndex({ maxChars = 1200 } = {}) {
  try {
    const md = fs.readFileSync(MEM_INDEX_MD(), 'utf8').trim();
    if (!md) return '';
    if (md.length <= maxChars) return md;
    return md.slice(0, maxChars) + '\n…（更多条目用 memory_search 查）';
  } catch {
    return '';
  }
}
