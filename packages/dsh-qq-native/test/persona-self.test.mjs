// 人设自述层：限长 / 频率 / 备份 / 回滚 / 标记抽取（临时 HOME）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persona-test-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const P = await import('../lib/persona-self.mjs');

test('初始为空，hash 为空', () => {
  assert.equal(P.readSelf(), '');
  assert.equal(P.selfHash(), '');
  assert.equal(P.buildSelfBlock(), '');
});

test('写入成功 + 生成备份 + 审计', () => {
  const r = P.writeSelf({ text: '说话可以更放松一点', reason: '觉得自己太拘谨', force: true });
  assert.equal(r.ok, true);
  assert.equal(P.readSelf(), '说话可以更放松一点');
  const rows = P.changes(5);
  assert.ok(rows.some((x) => x.action === 'write' && x.reason.includes('拘谨')));
});

test('第二次写入会产生备份', () => {
  const r = P.writeSelf({ text: '说话可以更放松一点\n偶尔可以主动吐槽', reason: '再改一次', force: true });
  assert.equal(r.ok, true);
  assert.ok(r.backup && fs.existsSync(r.backup), '应产生备份文件');
  assert.match(P.readSelf(), /主动吐槽/);
});

test('超长拒绝', () => {
  const r = P.writeSelf({ text: 'x'.repeat(P.MAX_CHARS + 1), force: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /太长/);
});

test('空内容拒绝', () => {
  assert.equal(P.writeSelf({ text: '   ' }).ok, false);
});

test('每天限 1 次（非 force）', () => {
  const r1 = P.writeSelf({ text: '今天第一次', force: false });
  assert.equal(r1.ok, true);
  const r2 = P.writeSelf({ text: '今天第二次', force: false });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /今天已经改过/);
  // force 可以突破
  const r3 = P.writeSelf({ text: '强制再改', force: true });
  assert.equal(r3.ok, true);
});

test('回滚到最近备份', () => {
  const before = P.readSelf();
  P.writeSelf({ text: '会被回滚的内容', force: true });
  const r = P.rollbackSelf();
  assert.equal(r.ok, true);
  assert.equal(P.readSelf(), before);
  assert.ok(P.changes(3).some((x) => x.action === 'rollback'));
});

test('hash 随内容变化', () => {
  P.writeSelf({ text: 'AAA', force: true });
  const h1 = P.selfHash();
  P.writeSelf({ text: 'BBB', force: true });
  assert.notEqual(h1, P.selfHash());
});

test('extractSelfNote：抽出并剔除标记行', () => {
  const r = P.extractSelfNote('嗯…\n[自述: 我发现自己更喜欢夜里聊天]\n晚安');
  assert.deepEqual(r.notes, ['我发现自己更喜欢夜里聊天']);
  assert.equal(r.text, '嗯…\n晚安');
  const r2 = P.extractSelfNote('没有标记');
  assert.deepEqual(r2.notes, []);
  assert.equal(r2.text, '没有标记');
});
