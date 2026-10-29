// memory-vault.js —— 记忆总库：所有记忆操作的完整存档（只增不删）
//
// 与 memories.jsonl 的区别：
//   memories.jsonl  工作库：会去重、会更新、会被整理/归档
//   all-memories.jsonl 总库：每次 add/update/forget 都追加一条，永不修改、永不删除
//
// 每条记录：
//   { at, op: 'add'|'update'|'forget', origin: 'mcp'|'plugin'|'import',
//     id, text, tags, weight, kind, source, deduped?, hash }
//
// 用途：记忆被整理/衰减/误删后，可以从总库把原文找回来。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function vaultDir() {
  return process.env.QQ_MEMORY_DIR
    ? String(process.env.QQ_MEMORY_DIR)
    : path.join(os.homedir(), '.dsh', 'qq-memory');
}

export function vaultFile() {
  return path.join(vaultDir(), 'all-memories.jsonl');
}

function ensureDir() {
  try { fs.mkdirSync(vaultDir(), { recursive: true }); } catch { /* ignore */ }
}

function hashOf(text) {
  return crypto.createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);
}

/** 追加一条存档事件；返回写入的记录 */
export function vaultAppend({ op = 'add', origin = 'unknown', memory = {}, deduped = false } = {}) {
  const m = memory || {};
  const body = String(m.text ?? '').trim();
  if (!body) return null;
  ensureDir();
  const rec = {
    at: new Date().toISOString(),
    op,
    origin,
    id: m.id ? String(m.id) : hashOf(body),
    text: body.slice(0, 4000),
    tags: Array.isArray(m.tags) ? m.tags.slice(0, 12) : [],
    weight: Number(m.weight) || 3,
    kind: String(m.kind || '事件').slice(0, 12),
    source: String(m.source || '').slice(0, 60),
    deduped: deduped === true,
    hash: hashOf(body),
  };
  try {
    fs.appendFileSync(vaultFile(), JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  } catch {
    return null;
  }
}

/** 读总库（默认最近 200 条） */
export function vaultRead({ limit = 200 } = {}) {
  try {
    const lines = fs.readFileSync(vaultFile(), 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return rows.slice(-limit).reverse();
  } catch {
    return [];
  }
}

/** 按文本关键词在总库里搜（含已被删除/归档的） */
export function vaultSearch({ query = '', limit = 20 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const rows = vaultRead({ limit: 5000 });
  const hit = q ? rows.filter((r) => String(r.text || '').toLowerCase().includes(q)) : rows;
  return hit.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
}

/** 总库统计 */
export function vaultStats() {
  const rows = vaultRead({ limit: 100000 });
  const byOp = {};
  const byOrigin = {};
  for (const r of rows) {
    byOp[r.op] = (byOp[r.op] || 0) + 1;
    byOrigin[r.origin] = (byOrigin[r.origin] || 0) + 1;
  }
  let size = 0;
  try { size = fs.statSync(vaultFile()).size; } catch { /* none */ }
  return {
    file: vaultFile(),
    events: rows.length,
    byOp,
    byOrigin,
    sizeKB: Math.round(size / 1024 * 10) / 10,
    latestAt: rows[0]?.at || '',
    oldestAt: rows[rows.length - 1]?.at || '',
  };
}
