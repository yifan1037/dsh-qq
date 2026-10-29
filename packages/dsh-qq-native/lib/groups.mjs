// groups.mjs —— 群聊策略：白名单 + @/关键词触发 + 档位 + 冷却
//
// 设计目标：群聊不能变成复读机。
//   1. 白名单：只有配置里的群才接（allow 为空 = 全部拒绝）
//   2. 触发：@她 / 关键词 / 概率（按档位 0-100）
//   3. 冷却：同一个群 N 秒内只回一次
//   4. 记忆：群聊不进她的私聊记忆（除非 @ 她且内容值得记，由模型自己决定）
//
// 配置示例：
//   "groups": {
//     "enabled": true,
//     "allow": [123456789],
//     "defaultTier": 20,          // 0-10 仅@、10-20 +关键词、20-90 +概率、90-100 全响应
//     "keywords": ["小助手", "deepseek"],
//     "cooldownSeconds": 20,
//     "maxPerHour": 30
//   }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR = () => path.join(os.homedir(), '.dsh', 'qq-native', 'state');
const STATE_FILE = () => path.join(STATE_DIR(), 'groups.json');

export function groupsConfig(cfg = {}) {
  const g = cfg.groups && typeof cfg.groups === 'object' ? cfg.groups : {};
  return {
    enabled: g.enabled === true,
    allow: Array.isArray(g.allow) ? g.allow.map(String) : [],
    defaultTier: Math.max(0, Math.min(100, Number(g.defaultTier) || 0)),
    tiers: (g.tiers && typeof g.tiers === 'object') ? g.tiers : {},
    keywords: Array.isArray(g.keywords) ? g.keywords.map(String).filter(Boolean) : [],
    cooldownSeconds: Math.max(0, Number(g.cooldownSeconds) || 20),
    maxPerHour: Math.max(1, Number(g.maxPerHour) || 30),
  };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return { groups: {} }; }
}

function writeState(s) {
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/**
 * 判定这条群消息要不要回。
 * @param {object} args
 *   cfg       插件配置
 *   groupId   群号
 *   botQQ     机器人自己的 QQ（判断 @ 是否指向自己）
 *   segments  内部消息段
 *   text      纯文本
 * @returns {{ reply: boolean, reason: string, tier: number }}
 */
export function decideGroupReply({ cfg = {}, groupId, botQQ, segments = [], text = '' } = {}) {
  const g = groupsConfig(cfg);
  const gid = String(groupId);
  if (!g.enabled) return { reply: false, reason: 'groups-disabled', tier: 0 };
  if (!g.allow.length) return { reply: false, reason: 'allow-empty', tier: 0 };
  if (!g.allow.includes(gid)) return { reply: false, reason: 'not-allowed', tier: 0 };

  const tier = Number(g.tiers[gid] ?? g.defaultTier) || 0;

  // 1) 被 @：档位 0 也响应
  const atMe = segments.some((s) => s.type === 'at' && (String(s.qq) === String(botQQ) || s.qq === 'all'));
  if (atMe) return { reply: true, reason: 'at', tier };

  // 2) 关键词：档位 ≥10
  if (tier >= 10 && g.keywords.length) {
    const t = String(text || '');
    const hit = g.keywords.find((k) => t.includes(k));
    if (hit) return { reply: true, reason: 'keyword:' + hit, tier };
  }

  // 3) 概率：档位 20-100
  if (tier >= 20) {
    const p = Math.min(1, (tier - 20) / 80); // 20→0, 100→1
    if (Math.random() < p) return { reply: true, reason: 'random', tier };
  }

  return { reply: false, reason: 'tier', tier };
}

/** 冷却与频率检查（会写状态） */
export function gateGroupRate({ groupId, cooldownSeconds = 20, maxPerHour = 30 } = {}) {
  const now = Date.now();
  const st = readState();
  const g = st.groups[String(groupId)] || { lastReplyAt: 0, hourStart: 0, hourCount: 0 };

  if (now - Number(g.lastReplyAt || 0) < cooldownSeconds * 1000) {
    return { ok: false, reason: 'cooldown', waitSec: Math.ceil((cooldownSeconds * 1000 - (now - g.lastReplyAt)) / 1000) };
  }
  if (now - Number(g.hourStart || 0) > 3600 * 1000) { g.hourStart = now; g.hourCount = 0; }
  if (Number(g.hourCount) >= maxPerHour) return { ok: false, reason: 'hourly-cap' };

  g.lastReplyAt = now;
  g.hourCount = Number(g.hourCount) + 1;
  st.groups[String(groupId)] = g;
  writeState(st);
  return { ok: true };
}

/** 群聊 prompt 片段（告诉她这是群、谁说的、要不要 @） */
export function buildGroupPromptBlock({ groupId, senderName, senderId, text, atMe = false } = {}) {
  return [
    '【QQ 群聊】',
    `群号：${groupId}`,
    `说话的人：${senderName || '群友'}（${senderId}）${atMe ? '，并且 @ 了你' : ''}`,
    `他说：${text}`,
    '要求：像群里的一员那样自然接话，简短一点（1-2 句）；不要复述群号；不要叫"群友"这个词；不需要 @ 回去除非必要。',
  ].join('\n');
}
