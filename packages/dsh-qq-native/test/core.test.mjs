// 核心逻辑单测（不联网、不碰真实数据）
// 运行：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 把 USERPROFILE/HOME 指到临时目录，隔离所有落盘
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-test-'));
const ORIG = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;
process.on('exit', () => {
  if (ORIG.USERPROFILE !== undefined) process.env.USERPROFILE = ORIG.USERPROFILE;
  if (ORIG.HOME !== undefined) process.env.HOME = ORIG.HOME;
});

const { createBatcher, extractMemoryLines } = await import('../lib/wake.mjs');
const { curateMemory, readMemoryIndex } = await import('../lib/memory-curate.mjs');
const { readHobbies, addHobby, pickHobby, appendHobbyLog, readHobbyNotes } = await import('../lib/hobbies.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── wake：合并 ────────────────────────────────────────────────
test('合并窗口：连发多条只 flush 一次', async () => {
  const batches = [];
  const b = createBatcher({ windowMs: 120, onFlush: async (text, meta) => { batches.push({ text, meta }); }, log: () => {} });
  b.push('一', { msgId: 'a' });
  b.push('二', { msgId: 'b' });
  b.push('三', { msgId: 'c' });
  await sleep(300);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].text, '一\n二\n三');
  assert.equal(batches[0].meta.count, 3);
});

test('去重：同一 message_id 只入队一次', async () => {
  const batches = [];
  const b = createBatcher({ windowMs: 60, onFlush: async (t) => { batches.push(t); }, log: () => {} });
  assert.equal(b.push('你好', { msgId: 'x' }), 'queued');
  assert.equal(b.push('你好', { msgId: 'x' }), 'duplicate');
  await sleep(350);
  assert.equal(batches.length, 1);
});

test('潜水：sleep 期间只收不回', async () => {
  const batches = [];
  const b = createBatcher({ windowMs: 60, onFlush: async (t) => { batches.push(t); }, log: () => {} });
  b.sleep(500);
  assert.equal(b.push('潜水中', { msgId: 's1' }), 'sleeping');
  await sleep(200);
  assert.equal(batches.length, 0);
  b.wake();
  b.push('醒了', { msgId: 's2' });
  await sleep(200);
  assert.deepEqual(batches, ['醒了']);
});

test('「记：」行不进正文，单独抽出', () => {
  const r = extractMemoryLines('好呀\n记：他今天体测过了\n晚安');
  assert.equal(r.text, '好呀\n晚安');
  assert.deepEqual(r.facts, ['他今天体测过了']);
});

// ── memory-curate：去重 / 归档 / 索引 ─────────────────────────
test('记忆整理：去重 + 归档 + 生成索引', () => {
  const dir = path.join(TMP, '.dsh', 'qq-memory');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const old = now - 200 * 86400000;
  const rows = [
    { id: 'm1', at: now, text: '主人喜欢下雨天', tags: ['偏好'], weight: 4, kind: '偏好' },
    { id: 'm2', at: now - 1000, text: '主人喜欢下雨天 ', tags: ['天气'], weight: 3, kind: '偏好' }, // 重复
    { id: 'm3', at: old, text: '很久以前的一条', tags: [], weight: 1, kind: '事件' }, // 低权重 + 旧 → 归档
    { id: 'm4', at: now, text: '他在学数学分析', tags: ['学习'], weight: 5, kind: '事实' },
  ];
  fs.writeFileSync(path.join(dir, 'memories.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const res = curateMemory({ log: () => {} });
  assert.equal(res.total, 4);
  assert.equal(res.kept, 2, '重复合并 1 条、归档 1 条后应剩 2 条');
  assert.ok(fs.existsSync(path.join(dir, 'memories-archived.jsonl')), '应有归档文件');

  const idx = readMemoryIndex({ maxChars: 4000 });
  assert.match(idx, /记忆库索引/);
  assert.match(idx, /主人喜欢下雨天/);
  assert.match(idx, /数学分析/);
});

// ── hobbies：种子 / 添加 / 挑选 / 随笔 ────────────────────────
test('爱好：种子生成、去重添加、随笔记录', () => {
  const h = readHobbies();
  assert.ok(h.items.length >= 3, '应有种子爱好');

  const added = addHobby({ name: '看云', why: '发呆' });
  assert.ok(added);
  assert.equal(addHobby({ name: '看云' }), null, '重复添加应返回 null');

  const picked = pickHobby();
  assert.ok(picked && picked.name, '能挑出一个爱好');

  appendHobbyLog({ hobby: picked.name, text: '今天想了很多' });
  const notes = readHobbyNotes({ limit: 3 });
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /今天想了很多/);
});
