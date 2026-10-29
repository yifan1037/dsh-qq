// 动作层：权限 / 审计 / 限流（假 http，临时 HOME）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-actions-test-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { createActions } = await import('../lib/actions.mjs');

function fakeHttp() {
  const calls = [];
  return {
    calls,
    sendPrivate: async (u, t) => { calls.push(['text', u, t]); return { retcode: 0 }; },
    sendSegments: async (k, id, s) => { calls.push([k, id, s.map((x) => x.type).join('+')]); return { retcode: 0 }; },
    deleteMsg: async (id) => { calls.push(['delete', id]); return { retcode: 0 }; },
    friendPoke: async (u) => { calls.push(['poke', u]); return { retcode: 0 }; },
    groupPoke: async (g, u) => { calls.push(['gpoke', g, u]); return { retcode: 0 }; },
  };
}

const caps = (over = {}) => () => ({ panic: 0, desktop: false, explore: false, ...over });

test('默认只开 message/media，群聊被拒', async () => {
  const http = fakeHttp();
  const a = createActions({ http, cfg: {}, log: () => {}, capabilities: caps() });
  assert.equal(a.can('message'), true);
  assert.equal(a.can('group'), false);

  const ok = await a.sendPrivateText(1, '你好');
  assert.equal(ok.ok, true);
  assert.deepEqual(http.calls.at(-1), ['text', 1, '你好']);

  const denied = await a.sendGroupSegments(2, [{ type: 'text', text: '群' }]);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /group/);
});

test('紧急停止时全部拒绝', async () => {
  const http = fakeHttp();
  const a = createActions({ http, cfg: {}, log: () => {}, capabilities: caps({ panic: 1 }) });
  const r = await a.sendPrivateText(1, 'hi');
  assert.equal(r.ok, false);
});

test('限流：超过每分钟上限后拒绝', async () => {
  const http = fakeHttp();
  const a = createActions({ http, cfg: { actions: { rateLimit: { userPerMinute: 3 } } }, log: () => {}, capabilities: caps() });
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await a.sendPrivateText(9, 'x' + i));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.match(results.at(-1).error, /频繁/);
});

test('审计：每次动作都落盘，参数被截断', async () => {
  const http = fakeHttp();
  const a = createActions({ http, cfg: {}, log: () => {}, capabilities: caps() });
  await a.sendPrivateText(1, 'x'.repeat(500));
  const auditFile = path.join(TMP, '.dsh', 'qq-native', 'state', 'actions.jsonl');
  assert.ok(fs.existsSync(auditFile), '审计文件应存在');
  const rows = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].action, 'send_private_text');
  assert.ok(rows[0].detail.text.length <= 120, '长文本应被截断');
});

test('开关可关闭某个层级', async () => {
  const http = fakeHttp();
  const a = createActions({ http, cfg: { actions: { enabled: { media: false } } }, log: () => {}, capabilities: caps() });
  const r = await a.sendPrivateSegments(1, [{ type: 'image', file: 'x.png' }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /media/);
  // 文字仍可用
  assert.equal((await a.sendPrivateText(1, 'hi')).ok, true);
});
