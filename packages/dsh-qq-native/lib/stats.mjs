// stats.mjs —— 接管成本/会话统计（写回桥接的 token-usage.jsonl，管理台成本页照常可用）
//
// 做法：
//   1. 每 5 分钟从 DSH 的 sessions.list 抓一次各会话的累计 tokenUsage
//   2. 和上次快照比较，算出「增量」
//   3. 按桥接原来的格式追加一条 k='turn' 记录：
//        { k:'turn', t, sid, key, model, provider, b:{ cacheMiss, cacheHit, cacheWrite, output } }
//      （成本页只累加 k==='turn'，所以这样它不用改）
//
// 快照存在 ~/.dsh/qq-native/stats-snapshot.json

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();
const SNAPSHOT = path.join(HOME, '.dsh', 'qq-native', 'stats-snapshot.json');
const USAGE_FILE = path.join(HOME, '.dsh', 'qq-native', 'state', 'token-usage.jsonl');

function readJson(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return null; }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/* 拉一次 DSH 的会话统计 */
export async function fetchSessions({ bridgeDir, vendorDir, dshPort } = {}) {
  let clientPath = path.join(String(vendorDir || ''), 'dsh-client.js');
  if (!vendorDir || !fs.existsSync(clientPath)) clientPath = path.join(bridgeDir, 'src', 'dsh-client.js');
  const mod = await import(pathToFileURL(clientPath).href);
  const { NodeApiClient, unwrap } = mod;
  const api = new NodeApiClient(`http://127.0.0.1:${dshPort}`, undefined, { token: '', tokenExplicit: false });
  await api.settings.describe({});
  const v = unwrap(await api.sessions.list({}), 'sessions.list');
  return v?.items ?? [];
}

/* 抓一次并写增量；返回本次写入的条数 */
export async function collectOnce({ bridgeDir, dshPort, key = '', sidFilter = '', model = 'deepseek-flash', provider = 'deepseek-account', log = () => {} } = {}) {
  let items;
  try {
    items = await fetchSessions({ bridgeDir, dshPort });
  } catch (error) {
    log('[stats] 拉会话统计失败：' + (error?.message ?? error));
    return 0;
  }

  const prev = readJson(SNAPSHOT) || { sessions: {}, at: 0 };
  const next = { sessions: {}, at: Date.now() };
  const rows = [];

  for (const s of items) {
    const sid = s.sessionId ?? s.id;
    if (!sid) continue;
    const u = s?.projections?.values?.tokenUsage;
    if (!u) continue;
    const cur = {
      miss: Number(u.uncachedInputTokens) || 0,
      hit: Number(u.cacheReadTokens) || 0,
      write: Number(u.cacheWriteTokens) || 0,
      out: Number(u.outputTokens) || 0,
    };
    const before = prev.sessions[sid] || { miss: 0, hit: 0, write: 0, out: 0 };
    const d = {
      miss: cur.miss - before.miss,
      hit: cur.hit - before.hit,
      write: cur.write - before.write,
      out: cur.out - before.out,
    };
    next.sessions[sid] = cur;
    // 只记我们自己那条会话的增量（其它会话属于主会话/子代理，不该算到 QQ 头上）
    if (key && s?.projections?.values?.title && !String(sid).includes(key)) {
      // key 用于过滤；没匹配到就跳过（调用方可以把 key 留空 = 全记）
    }
    if (d.miss + d.hit + d.write + d.out <= 0) continue;
    if (sidFilter && sid !== sidFilter) continue;
    rows.push({
      k: 'turn',
      t: Date.now(),
      sid,
      key: key || sid,
      model,
      provider,
      b: { cacheMiss: d.miss, cacheHit: d.hit, cacheWrite: d.write, output: d.out },
      src: 'qq-native',
    });
  }

  writeJson(SNAPSHOT, next);
  if (!rows.length) return 0;
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.appendFileSync(USAGE_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } catch (error) {
    log('[stats] 写用量失败：' + (error?.message ?? error));
    return 0;
  }
  log(`[stats] 记录 ${rows.length} 条用量增量`);
  return rows.length;
}

/* 定时采集；返回停止函数 */
export function startStats({ bridgeDir, dshPort, sessionId, key = '', log = () => {}, intervalMs = 5 * 60 * 1000 } = {}) {
  let timer = null;
  const tick = async () => {
    try {
      await collectOnce({ bridgeDir, dshPort, key: key || '', sidFilter: sessionId || '', log });
    } catch (error) {
      log('[stats] 采集异常：' + (error?.message ?? error));
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
