// capabilities.js —— QQ agent 的「能力权限 + 自主探索（L5）」状态
//
// 位置：~/.dsh/qq-personal/capabilities.json
//
//   desktop      L2 电脑操作（截图/鼠标/键盘）
//   fullRead     L3 全盘只读
//   explore      L4 探索模式（命令执行 + 读写文件），只能管理员手动开
//   autonomous   L5 自主探索：'off' | 'readonly'（只读）| 'full'（可写）
//   l5           自主探索的设置 { times, maxRunsPerDay, maxSteps, dirs, longTask }
//   panic        紧急停止：>0 时所有能力立即失效（值是时间戳）
//   pending      她发起的能力申请
//   history      最近 50 次开关记录
//
// 谁能改：
//   · 管理员：管理台「权限」页 /「探索」页 / 紧急停止按钮
//   · agent：只能申请 desktop / fullRead；autonomous 与 panic 永远只能管理员改

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CAPABILITY_FILE = path.join(os.homedir(), '.dsh', 'qq-personal', 'capabilities.json');

const L5_DEFAULTS = {
  times: ['12:30', '21:00'],   // 每天自主探索的时间点
  maxRunsPerDay: 3,            // 一天最多自主探索几次
  maxSteps: 12,                // 每次探索里最多调几次工具
  dirs: [],                    // 允许探索的目录（空 = 不允许自主探索）
  longTask: false,             // L5-a：允许长任务（你指路后她可以连续干很多步）
};

const DEFAULTS = {
  desktop: false,
  fullRead: false,
  explore: false,
  autonomous: 'off',
  l5: { ...L5_DEFAULTS },
  panic: 0,
  pending: null,
  history: [],
};

function sanitizeTimes(v) {
  if (!Array.isArray(v)) return [...L5_DEFAULTS.times];
  const out = [];
  for (const t of v) {
    const s = String(t).trim();
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out.sort();
}

function sanitizeDirs(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const d of v) {
    const s = String(d).trim();
    if (!s) continue;
    const abs = path.resolve(s);
    if (!out.includes(abs)) out.push(abs);
  }
  return out.slice(0, 20);
}

function readCapabilities() {
  try {
    let raw = fs.readFileSync(CAPABILITY_FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    const l5 = j?.l5 && typeof j.l5 === 'object' ? j.l5 : {};
    return {
      desktop: j?.desktop === true,
      fullRead: j?.fullRead === true,
      explore: j?.explore === true,
      autonomous: ['readonly', 'full'].includes(j?.autonomous) ? j.autonomous : 'off',
      l5: {
        times: sanitizeTimes(l5.times),
        maxRunsPerDay: Number.isFinite(Number(l5.maxRunsPerDay)) ? Math.max(1, Math.min(12, Number(l5.maxRunsPerDay))) : L5_DEFAULTS.maxRunsPerDay,
        maxSteps: Number.isFinite(Number(l5.maxSteps)) ? Math.max(3, Math.min(60, Number(l5.maxSteps))) : L5_DEFAULTS.maxSteps,
        dirs: sanitizeDirs(l5.dirs),
        longTask: l5.longTask === true,
      },
      panic: Number(j?.panic) || 0,
      pending: j?.pending && typeof j.pending === 'object' ? j.pending : null,
      history: Array.isArray(j?.history) ? j.history.slice(-50) : [],
    };
  } catch {
    return { ...DEFAULTS, l5: { ...L5_DEFAULTS } };
  }
}

function writeCapabilities(next) {
  const cur = readCapabilities();
  const rawL5 = next.l5 && typeof next.l5 === 'object' ? { ...cur.l5, ...next.l5 } : cur.l5;
  const merged = {
    desktop: next.desktop === undefined ? cur.desktop : next.desktop === true,
    fullRead: next.fullRead === undefined ? cur.fullRead : next.fullRead === true,
    explore: next.explore === undefined ? cur.explore : next.explore === true,
    autonomous: next.autonomous === undefined ? cur.autonomous : (['readonly', 'full'].includes(next.autonomous) ? next.autonomous : 'off'),
    l5: {
      times: sanitizeTimes(rawL5.times),
      maxRunsPerDay: Math.max(1, Math.min(12, Number(rawL5.maxRunsPerDay) || L5_DEFAULTS.maxRunsPerDay)),
      maxSteps: Math.max(3, Math.min(60, Number(rawL5.maxSteps) || L5_DEFAULTS.maxSteps)),
      dirs: sanitizeDirs(rawL5.dirs),
      longTask: rawL5.longTask === true,
    },
    panic: next.panic === undefined ? cur.panic : Number(next.panic) || 0,
    pending: next.pending === undefined ? cur.pending : next.pending,
    history: Array.isArray(next.history) ? next.history.slice(-50) : cur.history,
  };
  fs.mkdirSync(path.dirname(CAPABILITY_FILE), { recursive: true });
  fs.writeFileSync(CAPABILITY_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

function pushHistory(list, entry) {
  const h = Array.isArray(list) ? list.slice() : [];
  h.push({ at: new Date().toISOString(), ...entry });
  return h.slice(-50);
}

function setCapability(name, value, by = 'admin', note = '') {
  if (!['desktop', 'fullRead', 'explore'].includes(name)) throw new Error('未知能力: ' + name);
  const cur = readCapabilities();
  const history = pushHistory(cur.history, { name, value: value === true, by: String(by || 'admin').slice(0, 40), note: String(note || '').slice(0, 200) });
  return writeCapabilities({ ...cur, [name]: value === true, history });
}

function setL5Config(patch = {}, by = 'admin') {
  const cur = readCapabilities();
  const next = { ...cur.l5, ...patch };
  const history = pushHistory(cur.history, {
    name: 'l5',
    value: (patch.autonomous ?? cur.autonomous) !== 'off',
    by: String(by || 'admin').slice(0, 40),
    note: JSON.stringify({ autonomous: patch.autonomous ?? cur.autonomous, times: next.times, maxRunsPerDay: next.maxRunsPerDay, dirs: next.dirs }).slice(0, 220),
  });
  return writeCapabilities({
    ...cur,
    autonomous: patch.autonomous === undefined ? cur.autonomous : patch.autonomous,
    l5: next,
    history,
  });
}

/* ── 紧急停止 ── */
function panicOn(reason = '手动紧急停止', by = 'admin') {
  const cur = readCapabilities();
  const history = pushHistory(cur.history, { name: 'panic', value: true, by: String(by).slice(0, 40), note: String(reason).slice(0, 200) });
  return writeCapabilities({
    ...cur,
    desktop: false,
    fullRead: false,
    explore: false,
    autonomous: 'off',
    panic: Date.now(),
    pending: null,
    history,
  });
}

function panicOff(by = 'admin') {
  const cur = readCapabilities();
  const history = pushHistory(cur.history, { name: 'panic', value: false, by: String(by).slice(0, 40), note: '解除紧急停止' });
  return writeCapabilities({ ...cur, panic: 0, history });
}

function isPanicked() {
  return (readCapabilities().panic || 0) > 0;
}

function capabilityOn(name) {
  try { return readCapabilities()[name] === true; } catch { return false; }
}

/* ── 她发起的能力申请（L2/L3）── */
function requestCapability(name, note = '') {
  if (!['desktop', 'fullRead', 'explore'].includes(name)) throw new Error('未知能力: ' + name);
  if (name === 'explore') throw new Error('探索模式（L4）不能由 agent 申请，只能管理员手动开启');
  const cur = readCapabilities();
  if (cur.panic) throw new Error('当前处于紧急停止状态，任何申请都不会被受理');
  if (cur[name] === true) return { ok: true, already: true, capabilities: cur };
  const pending = { name, at: new Date().toISOString(), note: String(note || '').slice(0, 300) };
  const history = pushHistory(cur.history, { name, value: false, by: 'agent-request', note: pending.note });
  return { ok: true, pending, capabilities: writeCapabilities({ ...cur, pending, history }) };
}

function approvePending(by = 'admin') {
  const cur = readCapabilities();
  if (!cur.pending || !cur.pending.name) throw new Error('没有待批准的申请');
  if (cur.panic) throw new Error('紧急停止状态下不能批准任何权限，先解除');
  const name = cur.pending.name;
  if (name === 'explore') throw new Error('探索模式不能通过批准接口开启');
  const history = pushHistory(cur.history, { name, value: true, by: String(by).slice(0, 40), note: '批准 agent 申请' });
  return writeCapabilities({ ...cur, [name]: true, pending: null, history });
}

function denyPending(by = 'admin') {
  const cur = readCapabilities();
  if (!cur.pending || !cur.pending.name) return { ok: true, capabilities: cur };
  const history = pushHistory(cur.history, { name: cur.pending.name, value: false, by: String(by).slice(0, 40), note: '拒绝 agent 申请' });
  return writeCapabilities({ ...cur, pending: null, history });
}

module.exports = {
  CAPABILITY_FILE,
  L5_DEFAULTS,
  readCapabilities,
  writeCapabilities,
  setCapability,
  setL5Config,
  requestCapability,
  approvePending,
  denyPending,
  panicOn,
  panicOff,
  isPanicked,
  capabilityOn,
};
