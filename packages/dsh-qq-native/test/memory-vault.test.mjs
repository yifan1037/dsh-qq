// 记忆总库：所有操作全存档（临时目录隔离）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vault-test-'));
process.env.QQ_MEMORY_DIR = TMP;

const V = await import('../vendor/memory-vault.js');
const { MemoryStore } = await import('../vendor/memory-store.js');

test('空总库：读取为空、统计为 0', () => {
  assert.deepEqual(V.vaultRead(), []);
  const s = V.vaultStats();
  assert.equal(s.events, 0);
  assert.equal(s.file, V.vaultFile());
});

test('append：写入一条 add 事件', () => {
  const rec = V.vaultAppend({ op: 'add', origin: 'test', memory: { id: 'm1', text: '主人喜欢下雨天', tags: ['偏好'], weight: 4, kind: '偏好' } });
  assert.equal(rec.op, 'add');
  assert.equal(rec.text, '主人喜欢下雨天');
  const rows = V.vaultRead();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].origin, 'test');
  assert.ok(rows[0].hash);
});

test('append：空文本不写', () => {
  assert.equal(V.vaultAppend({ memory: { text: '   ' } }), null);
});

test('MemoryStore.add 会写总库（含去重场景）', () => {
  MemoryStore.add({ text: '他在学数学分析', tags: ['学习'], weight: 4, kind: '事实', source: 'test' });
  const first = V.vaultRead({ limit: 10 });
  assert.ok(first.some((r) => r.text.includes('数学分析')));
  // 重复加一次 → 工作库去重，但总库仍记录一次（deduped=true）
  MemoryStore.add({ text: '他在学数学分析', tags: ['学习'], weight: 4, kind: '事实', source: 'test' });
  const after = V.vaultRead({ limit: 10 });
  const hits = after.filter((r) => r.text.includes('数学分析'));
  assert.equal(hits.length, 2, '两次 add 都应留档');
  assert.ok(hits.some((r) => r.deduped === true), '应有一条标记为去重');
});

test('forget 也会留档（可找回）', () => {
  const r = MemoryStore.add({ text: '要被删掉的记忆', tags: [], weight: 3, kind: '事件', source: 'test' });
  const id = r.memory?.id || r.memory?.text;
  const list = MemoryStore.list({ limit: 50 }).memories;
  const target = list.find((m) => m.text === '要被删掉的记忆');
  assert.ok(target, '工作库应能找到');
  MemoryStore.forget(target.id);
  const vault = V.vaultRead({ limit: 20 });
  assert.ok(vault.some((x) => x.op === 'forget' && x.text === '要被删掉的记忆'), '删除动作应留档');
});

test('vaultSearch：可搜到已删除的记忆', () => {
  const hits = V.vaultSearch({ query: '要被删掉', limit: 5 });
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.op === 'forget'));
});

test('vaultStats：事件数与来源统计', () => {
  const s = V.vaultStats();
  assert.ok(s.events >= 4);
  assert.ok(s.byOp.add >= 2);
  assert.ok(s.byOrigin.mcp >= 1);
  assert.ok(s.sizeKB > 0);
});
