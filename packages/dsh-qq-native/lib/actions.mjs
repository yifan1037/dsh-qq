// actions.mjs —— 动作层：权限分层 + 审计 + 限流 + 统一动作封装
//
// 「让 agent 能做用户能做的事」不等于「让它随便做」。这一层负责三件事：
//   1. 权限：每个动作属于一个等级（message/media/group/admin/destructive），默认只开 message/media
//   2. 审计：每个动作写 state/actions.jsonl（动作、参数摘要、结果、耗时）
//   3. 限流：按用户/群每分钟计数，防止刷屏与误操作放大
//
// 用法：
//   const actions = createActions({ http, cfg, log, capabilities: () => readCaps() });
//   await actions.sendPrivateText(userId, '你好');
//   await actions.sendPrivateSegments(userId, segments);
//   await actions.sendGroupSegments(groupId, segments);
//   await actions.deleteMsg(id);           // 需要 media 级
//   await actions.poke('private', userId); // 需要 media 级
//   if (actions.can('group')) …            // 群聊前先问一句
//
// 破坏性动作（踢人/禁言/删好友等）默认关闭，需要显式打开 admin/destructive 级别。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR = () => path.join(os.homedir(), '.dsh', 'qq-native', 'state');
const AUDIT = () => path.join(STATE_DIR(), 'actions.jsonl');

const TIERS = ['message', 'media', 'group', 'admin', 'destructive'];

function readJson(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return null; }
}

function defaultEnabled() {
  return { message: true, media: true, group: false, admin: false, destructive: false };
}

/** 从配置里取动作开关与限流参数 */
export function actionsConfig(cfg = {}) {
  const a = cfg.actions && typeof cfg.actions === 'object' ? cfg.actions : {};
  const enabled = { ...defaultEnabled(), ...(a.enabled || {}) };
  const rl = a.rateLimit || {};
  return {
    enabled,
    rateLimit: {
      userPerMinute: Number(rl.userPerMinute) || 20,
      groupPerMinute: Number(rl.groupPerMinute) || 10,
    },
    audit: a.audit !== false,
  };
}

/** 读权限文件（和插件其它地方同一份） */
export function readCapabilities() {
  const file = path.join(os.homedir(), '.dsh', 'qq-personal', 'capabilities.json');
  const j = readJson(file) || {};
  return { panic: Number(j.panic) || 0, desktop: j.desktop === true, explore: j.explore === true };
}

export function createActions({ http, cfg = {}, log = () => {}, capabilities = readCapabilities } = {}) {
  const conf = actionsConfig(cfg);
  const counters = new Map(); // key -> { minute, count }

  function audit(action, detail, result, startedAt) {
    if (!conf.audit) return;
    const rec = {
      at: new Date().toISOString(),
      action,
      detail: summarize(detail),
      ok: result?.ok !== false,
      ms: Date.now() - startedAt,
      error: result?.error ? String(result.error).slice(0, 200) : undefined,
    };
    try {
      fs.mkdirSync(STATE_DIR(), { recursive: true });
      fs.appendFileSync(AUDIT(), JSON.stringify(rec) + '\n', 'utf8');
    } catch { /* ignore */ }
  }

  function can(tier) {
    if (capabilities().panic) return false;
    return conf.enabled[tier] === true;
  }

  function rateOk(key, limit) {
    const minute = Math.floor(Date.now() / 60000);
    const cur = counters.get(key);
    if (!cur || cur.minute !== minute) { counters.set(key, { minute, count: 1 }); return true; }
    if (cur.count >= limit) return false;
    cur.count += 1;
    return true;
  }

  async function run(action, tier, detail, fn, rateKey = '') {
    const started = Date.now();
    if (!can(tier)) {
      audit(action, { ...detail, blocked: 'tier-off' }, { ok: false, error: 'tier off' }, started);
      log(`[action] 拒绝 ${action}（${tier} 未开启）`);
      return { ok: false, error: `动作 ${action} 未开启（需要 ${tier} 权限）` };
    }
    if (rateKey) {
      const isGroup = String(rateKey).startsWith('g:');
      const limit = isGroup ? conf.rateLimit.groupPerMinute : conf.rateLimit.userPerMinute;
      if (!rateOk(rateKey, limit)) {
        audit(action, { ...detail, blocked: 'rate' }, { ok: false, error: 'rate limited' }, started);
        log(`[action] 限流 ${action}（${rateKey}）`);
        return { ok: false, error: '太频繁了，等一会儿再发' };
      }
    }
    try {
      const r = await fn();
      const bad = r && (r.status === 'failed' || r.retcode === undefined ? false : r.retcode !== 0);
      audit(action, detail, { ok: !bad, error: bad ? JSON.stringify(r).slice(0, 200) : undefined }, started);
      return { ok: !bad, raw: r };
    } catch (error) {
      audit(action, detail, { ok: false, error: error?.message ?? error }, started);
      log(`[action] 失败 ${action}：${error?.message ?? error}`);
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  return {
    can,
    conf,
    async sendPrivateText(userId, text) {
      return run('send_private_text', 'message', { to: userId, text: String(text).slice(0, 200) },
        () => http.sendPrivate(Number(userId), text), 'u:' + userId);
    },
    async sendPrivateSegments(userId, segments) {
      return run('send_private_segments', 'media', { to: userId, segs: segments },
        () => http.sendSegments('private', Number(userId), segments), 'u:' + userId);
    },
    async sendGroupSegments(groupId, segments) {
      return run('send_group_segments', 'group', { to: groupId, segs: segments },
        () => http.sendSegments('group', Number(groupId), segments), 'g:' + groupId);
    },
    async deleteMsg(messageId) {
      return run('delete_msg', 'media', { id: messageId }, () => http.deleteMsg(messageId));
    },
    async poke(kind, id) {
      return run('poke', 'media', { kind, id },
        () => (kind === 'group' ? http.groupPoke(id, 0) : http.friendPoke(id)));
    },
    /** 读审计尾部（管理台用） */
    tail(limit = 50) {
      try {
        return fs.readFileSync(AUDIT(), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
      } catch { return []; }
    },
  };
}

function summarize(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail || {})) {
    if (k === 'segs' && Array.isArray(v)) out.segs = v.map((s) => s.type).join('+');
    else if (typeof v === 'string') out[k] = v.slice(0, 120);
    else out[k] = v;
  }
  return out;
}

export { TIERS };
