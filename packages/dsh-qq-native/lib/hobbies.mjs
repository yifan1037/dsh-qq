// hobbies.mjs —— 她自己的爱好：不是人设里的标签，而是会生长的小本子
//
// 结构：
//   ~/.dsh/qq-native/data/hobbies.json     爱好清单（带热度 level、笔记）
//   ~/.dsh/qq-native/data/hobby-log.jsonl  每天自己琢磨出来的东西
//
// 设计：
//   · 爱好由她自己挑（初始给几个种子），热度会随"最近做没做"衰减/升温
//   · 不需要主人触发，空闲时自己去做（调度器里的一条分支）
//   · 聊天时只注入最近两三条，让她能自然地说"我最近在看…"

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = () => path.join(os.homedir(), '.dsh', 'qq-native', 'data');
const FILE = () => path.join(DIR(), 'hobbies.json');
const LOG = () => path.join(DIR(), 'hobby-log.jsonl');

const SEEDS = [
  { name: '星露谷', why: '种地、钓鱼、养鸡、下矿，玩得慢', level: 5 },
  { name: '做饭/吃东西', why: '嘴馋，喜欢研究吃什么', level: 4 },
  { name: '看海和天气', why: '喜欢海和雨，觉得安静', level: 3 },
];

function readJson() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(obj) {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** 读爱好清单（没有就种下种子） */
export function readHobbies() {
  const j = readJson();
  if (j && Array.isArray(j.items) && j.items.length) return j;
  const now = Date.now();
  const seeded = {
    version: 1,
    createdAt: now,
    items: SEEDS.map((s, i) => ({
      id: 'h' + (i + 1),
      name: s.name,
      why: s.why,
      level: s.level,
      createdAt: now,
      lastAt: 0,
      notes: [],
    })),
  };
  writeJson(seeded);
  return seeded;
}

/** 记一条"今天琢磨出来的东西" */
export function appendHobbyLog({ hobby, text, source = 'hobby-time' }) {
  const body = String(text ?? '').trim();
  if (!body) return null;
  const rec = { at: Date.now(), hobby: String(hobby ?? ''), source, text: body.slice(0, 1200) };
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.appendFileSync(LOG(), JSON.stringify(rec) + '\n', 'utf8');
  } catch { return null; }
  // 顺手把这句记进对应爱好的 notes（最多留 20 条），并抬一点热度
  const j = readHobbies();
  const item = j.items.find((h) => h.name === rec.hobby) || j.items[0];
  if (item) {
    item.notes = [...(item.notes || []), new Date(rec.at).toISOString().slice(0, 10) + ' ' + body.slice(0, 120)].slice(-20);
    item.lastAt = rec.at;
    item.level = Math.min(5, (Number(item.level) || 3) + 0.2);
    writeJson(j);
  }
  return rec;
}

/** 今天已经"玩"过几次 */
export function hobbyRunsToday() {
  try {
    const today = new Date().toDateString();
    return fs.readFileSync(LOG(), 'utf8').trim().split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && new Date(r.at).toDateString() === today).length;
  } catch { return 0; }
}

/** 挑一个今天最该做的爱好：久没碰的优先 + 热度加权 */
export function pickHobby() {
  const j = readHobbies();
  const now = Date.now();
  const scored = j.items.map((h) => {
    const days = h.lastAt ? (now - h.lastAt) / 86400000 : 30;
    const score = (Number(h.level) || 3) * 1.5 + Math.min(30, days) * 0.5;
    return { h, score: score * (0.7 + Math.random() * 0.6) };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.h ?? j.items[0];
}

/** 读最近琢磨的东西（注入聊天用） */
export function readHobbyNotes({ limit = 3, maxAgeDays = 10 } = {}) {
  try {
    const lines = fs.readFileSync(LOG(), 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && Number(r.at) >= cutoff);
    return rows.slice(-limit).reverse();
  } catch { return []; }
}

/** 手动加一个爱好（管理台/她自己都能加） */
export function addHobby({ name, why = '' } = {}) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  const j = readHobbies();
  if (j.items.some((h) => h.name === n)) return null;
  const item = { id: 'h' + Date.now().toString(36), name: n, why: String(why).slice(0, 200), level: 3, createdAt: Date.now(), lastAt: 0, notes: [] };
  j.items.push(item);
  writeJson(j);
  return item;
}
