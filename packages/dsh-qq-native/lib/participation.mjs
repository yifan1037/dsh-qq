// participation.mjs —— 发言决策：像群友一样判断「该不该说、说几条、要不要引用」
//
// 输入：最近的对话、刚落进来的消息、配置
// 输出：{ speak, bubbles, quote, reason }
//
// 设计原则：这里只做「话术结构」的决策，不改她说什么。
//   · 该不该说 → 避免复读、避免插话过多
//   · 说几条   → 群聊 1 条为主，私聊 1-3 条
//   · 引不引用 → 话题跳回旧消息、或同时回应多人时才引用
//
// 被 scheduler/runner 共用；纯函数，方便单测。

import os from 'node:os';
import path from 'node:path';

export function participationConfig(cfg = {}) {
  const p = cfg.participation && typeof cfg.participation === 'object' ? cfg.participation : {};
  return {
    enabled: p.enabled !== false,
    groupBubbles: clampInt(p.groupBubbles ?? 1, 1, 3),
    privateBubbles: clampInt(p.privateBubbles ?? 3, 1, 3),
    quietAfterReplyMs: Number(p.quietAfterReplyMs) || 15000, // 刚回过又马上被 @，先沉默
    burstWindowMs: Number(p.burstWindowMs) || 120000,       // 连发窗口
    burstThreshold: Number(p.burstThreshold) || 3,          // 窗口内超过这么多条 → 只回 1 条
    quoteBias: p.quoteBias === true,
  };
}

function clampInt(v, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

const QUESTION = /[?？]|吗|呢|怎么|为什么|咋|啥|多少|哪里|谁|能不能|可不可以|是不是/;
const CALL = /在吗|在不在|小助手|帮忙看|看下|看一下|你觉得|你说/;

/**
 * 判断这一轮怎么回。
 * @param {object} args
 *   cfg        插件配置
 *   isGroup    是否群聊
 *   text       这一轮要回的内容（合并后的）
 *   recent     最近对话 [{from:'owner'|'me', text, at}]
 *   atMe       群里是否 @ 了她
 *   now        时间戳（测试用）
 * @returns {{ speak: boolean, bubbles: number, quote: boolean, reason: string }}
 */
export function decideParticipation({ cfg = {}, isGroup = false, text = '', recent = [], atMe = false, now = Date.now() } = {}) {
  const c = participationConfig(cfg);
  const plain = String(text || '').trim();

  if (!c.enabled) return { speak: true, bubbles: isGroup ? c.groupBubbles : c.privateBubbles, quote: false, reason: 'disabled' };
  if (!plain) {
    // 纯图片/文件：值得看一眼再回
    return { speak: true, bubbles: 1, quote: false, reason: 'media-only' };
  }

  const rows = Array.isArray(recent) ? recent.filter((r) => r && r.at) : [];
  const lastMine = [...rows].reverse().find((r) => r.from === 'me');

  // 1) 刚回过、又不是被点名 → 先安静（群聊尤其重要）
  if (isGroup && !atMe && lastMine && now - Number(lastMine.at || 0) < c.quietAfterReplyMs) {
    return { speak: false, bubbles: 0, quote: false, reason: 'just-replied' };
  }

  // 2) 连发爆发：同一个窗口里消息很多 → 只回一条，别再刷屏
  const burst = rows.filter((r) => now - Number(r.at || 0) < c.burstWindowMs).length;
  const bursting = burst >= c.burstThreshold;

  // 3) 被叫到 / 疑问句 → 一定要回
  const called = atMe || CALL.test(plain);
  const asked = QUESTION.test(plain);

  let bubbles = isGroup ? c.groupBubbles : c.privateBubbles;
  let reason = 'normal';
  if (bursting) { bubbles = 1; reason = 'burst'; }
  else if (asked) { bubbles = isGroup ? 1 : Math.min(bubbles, 2); reason = 'question'; }
  else if (called) { reason = 'called'; }

  // 4) 引用：话题跳回去、或配置偏好引用
  const quote = c.quoteBias || (asked && rows.length > 6);

  return { speak: true, bubbles, quote: Boolean(quote), reason };
}

/** 把决策变成 prompt 里的一句提示 */
export function buildParticipationHint(decision, { isGroup = false } = {}) {
  if (!decision || !decision.speak) return '';
  const parts = [];
  if (decision.bubbles <= 1) parts.push('这轮回 1 条就够，别拆太多。');
  else parts.push('最多回 ' + decision.bubbles + ' 条，每条短一点。');
  if (decision.quote) parts.push('如果需要指明在回哪句话，可以用 [引用:消息ID]。');
  if (decision.reason === 'burst') parts.push('他刚才连着发了好几条，挑最要紧的回应。');
  if (isGroup) parts.push('你在群里，别抢话，一句自然的接住就行。');
  return parts.length ? '【这一轮怎么回】' + parts.join(' ') + '\n' : '';
}

/** 从最近对话里推断"她上次说过什么"（给主动找话题用） */
export function lastSpoken(recent = []) {
  const rows = Array.isArray(recent) ? recent.filter((r) => r && r.from === 'me') : [];
  return rows.length ? String(rows[rows.length - 1].text || '') : '';
}

/** 状态文件路径（其它模块/管理台可能要用） */
export function participationStateDir() {
  return path.join(os.homedir(), '.dsh', 'qq-native', 'state');
}
