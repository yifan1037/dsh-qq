// 发言决策：该不该说 / 说几条 / 要不要引用（纯函数，无 IO）
import test from 'node:test';
import assert from 'node:assert/strict';

const P = await import('../lib/participation.mjs');

const NOW = 1_800_000_000_000;
const mk = (cfg = {}) => ({ participation: { enabled: true, ...cfg } });

test('配置默认值', () => {
  const c = P.participationConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.groupBubbles, 1);
  assert.equal(c.privateBubbles, 3);
  assert.equal(c.burstThreshold, 3);
});

test('关闭时永远允许，且条数取配置', () => {
  const d = P.decideParticipation({ cfg: { participation: { enabled: false } }, isGroup: true, text: 'hi' });
  assert.equal(d.speak, true);
  assert.equal(d.bubbles, 1);
});

test('纯媒体（空文本）也会回，但只回 1 条', () => {
  const d = P.decideParticipation({ cfg: mk(), text: '', isGroup: false, now: NOW });
  assert.equal(d.speak, true);
  assert.equal(d.bubbles, 1);
  assert.equal(d.reason, 'media-only');
});

test('群聊：刚回过且没被 @ → 沉默', () => {
  const recent = [{ from: 'me', text: '刚说过', at: NOW - 3000 }];
  const d = P.decideParticipation({ cfg: mk(), isGroup: true, text: '嗯', recent, atMe: false, now: NOW });
  assert.equal(d.speak, false);
  assert.equal(d.reason, 'just-replied');
});

test('群聊：刚回过但被 @ → 仍然要回', () => {
  const recent = [{ from: 'me', text: '刚说过', at: NOW - 3000 }];
  const d = P.decideParticipation({ cfg: mk(), isGroup: true, text: '在吗', recent, atMe: true, now: NOW });
  assert.equal(d.speak, true);
});

test('连发爆发 → 只回 1 条', () => {
  const recent = [
    { from: 'owner', text: 'a', at: NOW - 10000 },
    { from: 'owner', text: 'b', at: NOW - 8000 },
    { from: 'owner', text: 'c', at: NOW - 6000 },
    { from: 'owner', text: 'd', at: NOW - 4000 },
  ];
  const d = P.decideParticipation({ cfg: mk(), text: '在吗', recent, now: NOW });
  assert.equal(d.bubbles, 1);
  assert.equal(d.reason, 'burst');
});

test('私聊疑问句：最多 2 条', () => {
  const d = P.decideParticipation({ cfg: mk(), text: '你觉得这个怎么样？', now: NOW });
  assert.equal(d.speak, true);
  assert.equal(d.bubbles, 2);
  assert.equal(d.reason, 'question');
});

test('被叫到（在吗）即使不是问句也回', () => {
  const d = P.decideParticipation({ cfg: mk(), text: '小助手', now: NOW });
  assert.equal(d.speak, true);
  assert.equal(d.reason, 'called');
});

test('quoteBias 打开时总是建议引用', () => {
  const d = P.decideParticipation({ cfg: mk({ quoteBias: true }), text: '嗯', now: NOW });
  assert.equal(d.quote, true);
});

test('提示语：单条时不提分条，群聊加"别抢话"', () => {
  const h1 = P.buildParticipationHint({ speak: true, bubbles: 1, quote: false, reason: 'normal' });
  assert.match(h1, /1 条/);
  assert.ok(!h1.includes('最多回'));
  const h2 = P.buildParticipationHint({ speak: true, bubbles: 3, quote: true, reason: 'normal' }, { isGroup: true });
  assert.match(h2, /最多回 3 条/);
  assert.match(h2, /别抢话/);
  assert.equal(P.buildParticipationHint({ speak: false }), '');
});

test('lastSpoken：取她最近说过的一句', () => {
  const recent = [
    { from: 'owner', text: 'a' },
    { from: 'me', text: '我说的第一句' },
    { from: 'me', text: '我说的第二句' },
  ];
  assert.equal(P.lastSpoken(recent), '我说的第二句');
  assert.equal(P.lastSpoken([]), '');
});
