// tasks.js —— 任务队列的存储层（一个任务一个 JSON 文件）
//
// 位置：~/.dsh/qq-personal/tasks/<id>.json
//
// 任务结构：
//   { id, title, goal, status, createdAt, updatedAt,
//     steps: [{ n, text, done }], progress: [{ at, text }],
//     rounds, maxRounds, lastRunAt, result, dirs }
//
// status: pending（待开始）| running（进行中）| paused（暂停）| done | failed | cancelled
//
// 为什么一个任务一个文件：好编辑、好备份、砸了不影响别的任务；列表时全量读，几十个任务没压力。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TASKS_DIR = path.join(os.homedir(), '.dsh', 'qq-personal', 'tasks');
const STATUSES = ['pending', 'running', 'paused', 'done', 'failed', 'cancelled'];
const MAX_STEPS = 40;
const MAX_ROUNDS_DEFAULT = 12;

function ensureDir() {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  return TASKS_DIR;
}

function fileOf(id) {
  return path.join(TASKS_DIR, String(id).replace(/[^\w-]/g, '') + '.json');
}

function sanitizeSteps(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((s, i) => {
      if (typeof s === 'string') return { n: i + 1, text: s.trim().slice(0, 300), done: false };
      if (s && typeof s === 'object') return { n: i + 1, text: String(s.text ?? '').trim().slice(0, 300), done: s.done === true };
      return null;
    })
    .filter((s) => s && s.text)
    .slice(0, MAX_STEPS);
}

function normalize(raw) {
  const j = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(j.id || ''),
    title: String(j.title || '未命名任务').slice(0, 120),
    goal: String(j.goal || '').slice(0, 2000),
    status: STATUSES.includes(j.status) ? j.status : 'pending',
    createdAt: Number(j.createdAt) || Date.now(),
    updatedAt: Number(j.updatedAt) || Date.now(),
    steps: sanitizeSteps(j.steps),
    progress: Array.isArray(j.progress) ? j.progress.filter((p) => p && p.text).slice(-100).map((p) => ({ at: Number(p.at) || Date.now(), text: String(p.text).slice(0, 500) })) : [],
    rounds: Number(j.rounds) || 0,
    maxRounds: Math.max(1, Math.min(60, Number(j.maxRounds) || MAX_ROUNDS_DEFAULT)),
    lastRunAt: Number(j.lastRunAt) || 0,
    result: j.result ? String(j.result).slice(0, 2000) : '',
    dirs: Array.isArray(j.dirs) ? j.dirs.map(String).filter(Boolean).slice(0, 10) : [],
  };
}

function write(task) {
  ensureDir();
  const t = { ...task, updatedAt: Date.now() };
  const f = fileOf(t.id);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
  return t;
}

function readOne(id) {
  try {
    let raw = fs.readFileSync(fileOf(id), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

function list(filter = {}) {
  try {
    ensureDir();
    const out = [];
    for (const name of fs.readdirSync(TASKS_DIR)) {
      if (!name.endsWith('.json')) continue;
      const t = readOne(name.replace(/\.json$/, ''));
      if (!t) continue;
      if (filter.status && t.status !== filter.status) continue;
      if (filter.activeOnly && !['pending', 'running'].includes(t.status)) continue;
      out.push(t);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    const limit = Math.max(1, Math.min(200, Number(filter.limit) || 100));
    return out.slice(0, limit);
  } catch {
    return [];
  }
}

function create(input = {}) {
  const id = 't' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const task = normalize({
    id,
    title: input.title,
    goal: input.goal,
    status: 'pending',
    steps: input.steps,
    maxRounds: input.maxRounds,
    dirs: input.dirs,
  });
  if (!task.goal && !task.title) throw new Error('任务至少要有个标题或目标');
  write(task);
  return task;
}

function update(id, patch = {}) {
  const t = readOne(id);
  if (!t) throw new Error('没有这个任务：' + id);
  if (patch.title !== undefined) t.title = String(patch.title).slice(0, 120);
  if (patch.goal !== undefined) t.goal = String(patch.goal).slice(0, 2000);
  if (patch.maxRounds !== undefined) t.maxRounds = Math.max(1, Math.min(60, Number(patch.maxRounds) || t.maxRounds));
  if (patch.status !== undefined && STATUSES.includes(patch.status)) t.status = patch.status;
  if (patch.dirs !== undefined) t.dirs = Array.isArray(patch.dirs) ? patch.dirs.map(String).filter(Boolean).slice(0, 10) : t.dirs;
  if (patch.addSteps !== undefined) {
    const add = sanitizeSteps(patch.addSteps).map((s) => ({ ...s, n: t.steps.length + s.n }));
    t.steps = [...t.steps, ...add].slice(0, MAX_STEPS);
  }
  if (patch.stepDone !== undefined) {
    const idx = t.steps.findIndex((s) => s.n === Number(patch.stepDone));
    if (idx >= 0) t.steps[idx].done = true;
  }
  if (patch.progress !== undefined) {
    t.progress = [...t.progress, { at: Date.now(), text: String(patch.progress).slice(0, 500) }].slice(-100);
  }
  return write(t);
}

function finish(id, result, patch = {}) {
  const t = readOne(id);
  if (!t) throw new Error('没有这个任务：' + id);
  t.status = patch.failed ? 'failed' : 'done';
  t.result = String(result || '').slice(0, 2000);
  t.progress = [...t.progress, { at: Date.now(), text: (patch.failed ? '失败：' : '完成：') + t.result.slice(0, 200) }].slice(-100);
  return write(t);
}

function cancel(id, note = '') {
  const t = readOne(id);
  if (!t) throw new Error('没有这个任务：' + id);
  t.status = 'cancelled';
  t.progress = [...t.progress, { at: Date.now(), text: '取消：' + (note || '管理员取消') }].slice(-100);
  return write(t);
}

function pause(id, note = '') {
  const t = readOne(id);
  if (!t) throw new Error('没有这个任务：' + id);
  if (['done', 'cancelled', 'failed'].includes(t.status)) return t;
  t.status = 'paused';
  t.progress = [...t.progress, { at: Date.now(), text: '暂停：' + (note || '管理员暂停') }].slice(-100);
  return write(t);
}

function resume(id) {
  const t = readOne(id);
  if (!t) throw new Error('没有这个任务：' + id);
  if (['done', 'cancelled'].includes(t.status)) throw new Error('这个任务已经结束了，不能继续');
  t.status = 'running';
  t.progress = [...t.progress, { at: Date.now(), text: '恢复' }].slice(-100);
  return write(t);
}

// 调度器用：挑一个该跑的任务
function pickNext({ gapMs = 90 * 1000 } = {}) {
  const now = Date.now();
  const list1 = list({ limit: 100 });
  for (const t of list1) {
    if (!['pending', 'running'].includes(t.status)) continue;
    if (t.rounds >= t.maxRounds) continue;
    if (now - (t.lastRunAt || 0) < gapMs) continue;
    return t;
  }
  return null;
}

// 调度器用：标记这一轮开始了
function markRoundStart(id) {
  const t = readOne(id);
  if (!t) return null;
  t.status = 'running';
  t.rounds += 1;
  t.lastRunAt = Date.now();
  return write(t);
}

function stats() {
  const all = list({ limit: 200 });
  const by = {};
  for (const t of all) by[t.status] = (by[t.status] || 0) + 1;
  return { total: all.length, byStatus: by, active: all.filter((t) => ['pending', 'running'].includes(t.status)).length, dir: TASKS_DIR };
}

module.exports = { TASKS_DIR, STATUSES, list, get: readOne, create, update, finish, cancel, pause, resume, pickNext, markRoundStart, stats };
