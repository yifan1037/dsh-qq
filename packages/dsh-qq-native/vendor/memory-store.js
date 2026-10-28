// memory-store.js —— 独立记忆库的存储层（和 agent 自带记忆完全分开）
//
// 位置：~/.dsh/qq-memory/memories.jsonl（可用 QQ_MEMORY_DIR 改目录）
// 一条记忆 = 一行 JSON：
//   { id, at, text, tags, weight(1-5), kind, source, uses, lastUsedAt }
//
// 设计原则：
//   · 只存"值得记"的东西，不存寒暄；
//   · 检索靠 关键词 + 标签 + 权重 + 新鲜度 打分，不依赖模型；
//   · 删除要显式（memory_forget）或走 memory_compact 的保守规则，绝不静默丢重要内容。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const MAX_MEMORIES = 5000;          // 超过这个数才考虑自动清理（几乎不会到）
const STALE_DAYS = 180;             // 「旧」的判定：半年没被用过
const STALE_WEIGHT = 3;             // 低于这个权重的才算「不重要」

export function storeDir() {
  const env = process.env.QQ_MEMORY_DIR;
  if (env && env.trim()) return env.trim();
  return path.join(os.homedir(), '.dsh', 'qq-memory');
}

export function storeFile() {
  return path.join(storeDir(), 'memories.jsonl');
}

function ensureDir() {
  const d = storeDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function readAll() {
  const f = storeFile();
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j.text === 'string' && j.text.trim()) out.push(normalize(j));
    } catch { /* 跳过坏行，不让一条脏数据毁掉整个库 */ }
  }
  return out;
}

function normalize(raw) {
  return {
    id: String(raw.id ?? crypto.randomUUID()),
    at: Number(raw.at) || Date.now(),
    text: String(raw.text).trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : [],
    weight: clampInt(raw.weight, 1, 5, 3),
    kind: String(raw.kind ?? '事件').slice(0, 12),
    source: String(raw.source ?? '').slice(0, 60),
    uses: Number(raw.uses) || 0,
    lastUsedAt: Number(raw.lastUsedAt) || 0,
  };
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function writeAll(list) {
  ensureDir();
  const f = storeFile();
  const tmp = f + '.tmp';
  const body = list.map((m) => JSON.stringify(m)).join('\n') + (list.length ? '\n' : '');
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, f);
}

/* ── 检索：CJK 二元组 + ASCII 词，纯本地打分 ── */
function terms(text) {
  const s = String(text ?? '').toLowerCase();
  const set = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) ?? []) set.add(w);
  const cjk = [...s].filter((ch) => /[\u4e00-\u9fff]/.test(ch));
  for (let i = 0; i + 1 < cjk.length; i++) set.add(cjk[i] + cjk[i + 1]);
  return set;
}

function scoreOf(m, queryTerms, now, tagTerms) {
  let score = 0;
  if (queryTerms && queryTerms.size) {
    const body = terms(m.text);
    const tagSet = terms(m.tags.join(' '));
    for (const t of queryTerms) {
      if (tagSet.has(t)) score += 2;
      else if (body.has(t)) score += 1;
    }
    if (score === 0) return -1;             // 查询时：完全对不上就不返回
  }
  if (tagTerms && tagTerms.size) {
    const tagSet = terms(m.tags.join(' '));
    let hit = 0;
    for (const t of tagTerms) if (tagSet.has(t)) hit++;
    if (hit === 0) return -1;
    score += hit * 3;
  }
  score += m.weight * 0.6;
  const ageDays = Math.max(0, (now - m.at) / 86400000);
  score += Math.max(0, 1.2 - ageDays / 120);        // 越新越加分，120 天后归零
  score += Math.min(1.0, m.uses * 0.15);            // 被用过越多次越容易被再想起
  return score;
}

export const MemoryStore = {
  add({ text, tags, weight, kind, source } = {}) {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('text 不能为空');
    if (body.length > 4000) throw new Error('单条记忆太长（上限 4000 字符）');
    ensureDir();
    const rec = normalize({ text: body, tags, weight, kind, source, at: Date.now() });
    // 去重：同一来源、文本高度接近的不重复存，只刷权重/时间
    const list = readAll();
    const dup = list.find((m) => m.source === rec.source && similar(m.text, rec.text) >= 0.85);
    if (dup) {
      dup.weight = Math.max(dup.weight, rec.weight);
      dup.at = rec.at;
      dup.tags = [...new Set([...dup.tags, ...rec.tags])].slice(0, 12);
      writeAll(list);
      return { ok: true, deduped: true, memory: dup };
    }
    list.push(rec);
    writeAll(list);
    return { ok: true, memory: rec };
  },

  search({ query, tags, limit = 10, sinceDays, kind } = {}) {
    const now = Date.now();
    const qTerms = query ? terms(query) : null;
    const tTerms = tags ? terms(Array.isArray(tags) ? tags.join(' ') : tags) : null;
    const max = clampInt(limit, 1, 50, 10);
    const since = sinceDays ? now - Number(sinceDays) * 86400000 : 0;
    const list = readAll().filter((m) => {
      if (since && m.at < since) return false;
      if (kind && m.kind !== kind) return false;
      return true;
    });
    const scored = [];
    for (const m of list) {
      const s = scoreOf(m, qTerms, now, tTerms);
      if (s >= 0) scored.push({ m, s });
    }
    scored.sort((a, b) => b.s - a.s);
    const picked = scored.slice(0, max);
    if (picked.length) {
      const ids = new Set(picked.map((p) => p.m.id));
      const all = readAll();
      let touched = false;
      for (const m of all) if (ids.has(m.id)) { m.uses += 1; m.lastUsedAt = now; touched = true; }
      if (touched) writeAll(all);
    }
    return { total: scored.length, returned: picked.length, memories: picked.map((p) => ({ ...p.m, score: Math.round(p.s * 100) / 100 })) };
  },

  list({ limit = 20, kind } = {}) {
    const max = clampInt(limit, 1, 200, 20);
    const all = readAll().filter((m) => !kind || m.kind === kind);
    all.sort((a, b) => b.at - a.at);
    return { total: all.length, memories: all.slice(0, max) };
  },

  update(id, patch = {}) {
    const all = readAll();
    const m = all.find((x) => x.id === id);
    if (!m) throw new Error('没有这条记忆（id 不对？先用 memory_search / memory_list 查）');
    if (patch.text !== undefined) {
      const t = String(patch.text).trim();
      if (!t) throw new Error('text 不能为空');
      m.text = t.slice(0, 4000);
    }
    if (patch.tags !== undefined) m.tags = (Array.isArray(patch.tags) ? patch.tags : [patch.tags]).map(String).filter(Boolean).slice(0, 12);
    if (patch.weight !== undefined) m.weight = clampInt(patch.weight, 1, 5, m.weight);
    if (patch.kind !== undefined) m.kind = String(patch.kind).slice(0, 12);
    writeAll(all);
    return { ok: true, memory: m };
  },

  forget(id) {
    const all = readAll();
    const idx = all.findIndex((x) => x.id === id);
    if (idx < 0) throw new Error('没有这条记忆');
    const [removed] = all.splice(idx, 1);
    writeAll(all);
    return { ok: true, removed };
  },

  stats() {
    const all = readAll();
    const byKind = {};
    const byWeight = {};
    for (const m of all) {
      byKind[m.kind] = (byKind[m.kind] || 0) + 1;
      byWeight[m.weight] = (byWeight[m.weight] || 0) + 1;
    }
    const f = storeFile();
    return {
      count: all.length,
      byKind,
      byWeight,
      oldest: all.length ? new Date(Math.min(...all.map((m) => m.at))).toISOString() : null,
      newest: all.length ? new Date(Math.max(...all.map((m) => m.at))).toISOString() : null,
      file: f,
      sizeKB: fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1024 * 10) / 10 : 0,
    };
  },

  // 保守清理：只删「低权重 + 半年没被用过 + 长期没被检索」的，且总数超过上限才动手
  compact({ maxCount = MAX_MEMORIES } = {}) {
    const all = readAll();
    const now = Date.now();
    const staleCut = now - STALE_DAYS * 86400000;
    const removable = all
      .filter((m) => m.weight < STALE_WEIGHT && m.uses === 0 && m.at < staleCut)
      .sort((a, b) => a.at - b.at);
    const need = Math.max(0, all.length - Number(maxCount || MAX_MEMORIES));
    const drop = removable.slice(0, need);
    if (!drop.length) return { ok: true, removed: 0, kept: all.length, note: `没到上限（${all.length}/${maxCount}），也没找到可安全删除的旧记忆` };
    const ids = new Set(drop.map((m) => m.id));
    const kept = all.filter((m) => !ids.has(m.id));
    writeAll(kept);
    return { ok: true, removed: drop.length, kept: kept.length, removedIds: [...ids] };
  },
};

/* 文本相似度（字符二元组 Jaccard），用于去重 */
function similar(a, b) {
  const A = terms(a), B = terms(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

export default MemoryStore;
