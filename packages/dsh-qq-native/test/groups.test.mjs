// 群聊策略：白名单 / @ / 关键词 / 档位 / 冷却（纯逻辑 + 临时 HOME）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-groups-test-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { groupsConfig, decideGroupReply, gateGroupRate, buildGroupPromptBlock } = await import('../lib/groups.mjs');

const baseCfg = (over = {}) => ({
  groups: {
    enabled: true,
    allow: ['20001'],
    defaultTier: 20,
    keywords: ['小助手'],
    cooldownSeconds: 0,
    maxPerHour: 2,
    ...over,
  },
});

test('groupsConfig：默认值与裁剪', () => {
  const g = groupsConfig({});
  assert.equal(g.enabled, false);
  assert.equal(g.defaultTier, 0);
  assert.equal(g.cooldownSeconds, 20);
  assert.deepEqual(g.allow, []);
  const clamped = groupsConfig({ groups: { defaultTier: 999 } });
  assert.equal(clamped.defaultTier, 100);
});

test('未启用 / 白名单为空 / 群不在白名单 → 不回', () => {
  assert.equal(decideGroupReply({ cfg: {}, groupId: 20001, botQQ: 1 }).reply, false);
  assert.equal(decideGroupReply({ cfg: { groups: { enabled: true } }, groupId: 20001, botQQ: 1 }).reason, 'allow-empty');
  assert.equal(decideGroupReply({ cfg: baseCfg(), groupId: 29999, botQQ: 1 }).reason, 'not-allowed');
});

test('@ 她 → 档位 0 也回', () => {
  const cfg = baseCfg({ defaultTier: 0 });
  const r = decideGroupReply({ cfg, groupId: 20001, botQQ: 1, segments: [{ type: 'at', qq: '1' }], text: '' });
  assert.equal(r.reply, true);
  assert.equal(r.reason, 'at');
});

test('关键词：档位 ≥10 生效', () => {
  const cfg = baseCfg({ defaultTier: 10 });
  const hit = decideGroupReply({ cfg, groupId: 20001, botQQ: 1, segments: [], text: '小助手在吗' });
  assert.equal(hit.reply, true);
  assert.match(hit.reason, /keyword/);
  // 档位 0 时关键词不触发
  const low = baseCfg({ defaultTier: 0 });
  assert.equal(decideGroupReply({ cfg: low, groupId: 20001, botQQ: 1, segments: [], text: '小助手在吗' }).reply, false);
});

test('档位 100 → 必回（概率 1）', () => {
  const cfg = baseCfg({ defaultTier: 100, keywords: [] });
  const r = decideGroupReply({ cfg, groupId: 20001, botQQ: 1, segments: [], text: '随便说点什么' });
  assert.equal(r.reply, true);
  assert.equal(r.reason, 'random');
});

test('每群档位覆盖 defaultTier', () => {
  const cfg = baseCfg({ defaultTier: 0, tiers: { '20001': 100 }, keywords: [] });
  assert.equal(decideGroupReply({ cfg, groupId: 20001, botQQ: 1, segments: [], text: 'hi' }).reply, true);
});

test('冷却：间隔内拒绝，超时后放行', () => {
  const first = gateGroupRate({ groupId: 30001, cooldownSeconds: 60, maxPerHour: 10 });
  assert.equal(first.ok, true);
  const second = gateGroupRate({ groupId: 30001, cooldownSeconds: 60, maxPerHour: 10 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'cooldown');
  const noCooldown = gateGroupRate({ groupId: 30002, cooldownSeconds: 0, maxPerHour: 10 });
  assert.equal(noCooldown.ok, true);
});

test('每小时上限', () => {
  const opt = { groupId: 30003, cooldownSeconds: 0, maxPerHour: 2 };
  assert.equal(gateGroupRate(opt).ok, true);
  assert.equal(gateGroupRate(opt).ok, true);
  const third = gateGroupRate(opt);
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'hourly-cap');
});

test('群聊 prompt 片段包含发送者与内容', () => {
  const s = buildGroupPromptBlock({ groupId: 20001, senderName: '小明', senderId: 10002, text: '在吗', atMe: true });
  assert.match(s, /群号：20001/);
  assert.match(s, /小明（10002）/);
  assert.match(s, /@ 了你/);
  assert.match(s, /他说：在吗/);
});
