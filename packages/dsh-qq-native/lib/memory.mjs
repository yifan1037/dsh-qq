// memory.mjs —— 记忆注入：印象（social-v2）+ 记忆库（memories.jsonl）+ 最近对话
//
// 三个来源，全部只读，缺哪个都不报错：
//   1. 印象：qq-bridge/state/social-v2.json → conversations[key].memberImpressions
//   2. 记忆库：~/.dsh/qq-memory/memories.jsonl → weight >= 4 的最近几条
//   3. 最近对话：由插件自己的环形缓冲提供（传入）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { curateMemory, readMemoryIndex } from './memory-curate.mjs';
import { readObservations } from './screenwatch.mjs';
import { vaultAppend } from '../vendor/memory-vault.js';
import { readHobbyNotes } from './hobbies.mjs';
export { curateMemory, readMemoryIndex };

function readJson(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* 印象：把所有 memberImpressions 的 traits 拼成短标签列表 */
export function readImpressions({ bridgeDir = '', key = '', limit = 12 } = {}) {
  if (!key) return [];
  // 优先新数据目录，回退到旧 bridge 目录
  const candidates = [
    path.join(os.homedir(), '.dsh', 'qq-native', 'data', 'social-v2.json'),
    path.join(bridgeDir, 'state', 'social-v2.json'),
  ];
  const file = candidates.find((p) => fs.existsSync(p)) || candidates[1];
  const j = readJson(file);
  const conv = j?.conversations?.[key];
  if (!conv) return [];
  const out = [];
  const imp = conv.memberImpressions ?? {};
  for (const [name, val] of Object.entries(imp)) {
    for (const tr of val?.traits ?? []) {
      const s = String(tr).trim();
      if (s) out.push(`${name}：${s}`);
    }
  }
  return out.slice(0, limit);
}

/* 记忆库：weight >= minWeight 的最近 limit 条（跳过"标签"类，避免和印象重复） */
export function readMemoryLibrary({ minWeight = 4, limit = 3 } = {}) {
  const file = path.join(os.homedir(), '.dsh', 'qq-memory', 'memories.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (!m || !m.text) continue;
    if (m.kind === '标签') continue;
    if (Number(m.weight) < minWeight) continue;
    rows.push(m);
  }
  rows.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return rows.slice(0, limit).map((m) => {
    const d = new Date(Number(m.at) || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${String(m.text).replace(/\s+/g, ' ').slice(0, 70)}`;
  });
}

/* 记忆块：拼成注入用的短文本（约 200-400 字） */
export function buildMemoryBlock({ bridgeDir, key, recent = [], maxImpressions = 8, maxMemories = 3 } = {}) {
  const impressions = readImpressions({ bridgeDir, key, limit: maxImpressions });
  const indexMd = readMemoryIndex({ maxChars: 900 });
  const lines = [];
  if (impressions.length) {
    lines.push('【你记得关于主人的事】');
    for (const t of impressions) lines.push('· ' + t);
  }
  if (indexMd) {
    lines.push('【记忆库（已整理，可用 memory_search 查详情）】');
    lines.push(indexMd);
  }
  const hobbyNotes = readHobbyNotes({ limit: 2 });
  if (hobbyNotes.length) {
    lines.push('【你自己最近琢磨的事（不是他问的，是你自己的事）】');
    for (const o of hobbyNotes) lines.push('· ' + String(o.text).replace(/\s+/g, ' ').slice(0, 140));
  }
  const seen = readObservations({ limit: 2 });
  if (seen.length) {
    lines.push('【你最近瞄了一眼屏幕（不是他说的，只是你看到的）】');
    for (const o of seen) lines.push('· ' + String(o.text).replace(/\s+/g, ' ').slice(0, 160));
  }
  if (recent.length) {
    lines.push('【刚才的对话】');
    for (const m of recent.slice(-6)) lines.push(`· ${m.from === 'me' ? '我' : '主人'}：${String(m.text).slice(0, 60)}`);
  }
  return lines.length ? lines.join('\n') + '\n\n' : '';
}

/* 人设卡：只读第一份可用的（roles/<name>.md 或 personas/friend-style.md） */
export function readPersona({ bridgeDir, maxChars = 17000 } = {}) {
  const candidates = [
    path.join(os.homedir(), '.dsh', 'qq-native', 'data', 'persona.md'),
    path.join(os.homedir(), '.dsh', 'qq-personal', 'personas', 'friend-style.md'),
  ];
  for (const f of candidates) {
    try {
      const text = fs.readFileSync(f, 'utf8').trim();
      if (!text) continue;
      return text.length > maxChars ? text.slice(0, maxChars) : text;
    } catch { /* next */ }
  }
  return '';
}

/* 写一条记忆进记忆库（和 MCP 记忆库同一个文件：~/.dsh/qq-memory/memories.jsonl） */
export function appendMemory({ text, weight = 3, tags = [], kind = '事件', source = 'qq-native' } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return null;
  const file = path.join(os.homedir(), '.dsh', 'qq-memory', 'memories.jsonl');
  const rec = {
    id: 'm' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6),
    at: Date.now(),
    text: body.slice(0, 4000),
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean).slice(0, 12) : [],
    weight: Math.max(1, Math.min(5, Number(weight) || 3)),
    kind: String(kind || '事件').slice(0, 12),
    source: String(source || 'qq-native').slice(0, 60),
    uses: 0,
    lastUsedAt: 0,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    try { vaultAppend({ op: 'add', origin: 'plugin', memory: rec }); } catch { /* ignore */ }
    return rec;
  } catch {
    return null;
  }
}
