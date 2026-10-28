// schedulers.mjs —— 把桥接里的两个调度器搬进插件
//
//   L5 自主探索：到点自己醒，在允许目录里逛，汇报主人
//   任务队列：有未完成任务就定时续跑（用 tasks.js 的 pickNext）
//
// 数据源和桥接完全一致（同一个 capabilities.json / tasks/*.json / settings.json），
// 所以切换前后状态是连续的。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const HOME = os.homedir();
const CAP_FILE = path.join(HOME, '.dsh', 'qq-personal', 'capabilities.json');
const SETTINGS_FILE = path.join(HOME, '.dsh', 'qq-personal', 'settings.json');
const L5_RUNS = path.join(HOME, '.dsh', 'qq-native', 'state', 'l5-runs.jsonl');
const TASKS_MOD = path.join(HOME, '.dsh', 'plugins', 'dsh-qq-personal', 'lib', 'tasks.js');

function readJson(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return null; }
}

export function readCaps() {
  const j = readJson(CAP_FILE) || {};
  const l5 = j.l5 && typeof j.l5 === 'object' ? j.l5 : {};
  return {
    desktop: j.desktop === true,
    fullRead: j.fullRead === true,
    explore: j.explore === true,
    autonomous: ['readonly', 'full'].includes(j.autonomous) ? j.autonomous : 'off',
    panic: Number(j.panic) || 0,
    l5: {
      times: Array.isArray(l5.times) ? l5.times.map(String) : [],
      maxRunsPerDay: Math.max(1, Number(l5.maxRunsPerDay) || 3),
      maxSteps: Math.max(3, Number(l5.maxSteps) || 12),
      dirs: Array.isArray(l5.dirs) ? l5.dirs.map(String).filter(Boolean) : [],
      longTask: l5.longTask === true,
    },
  };
}

export function readSettings() {
  const j = readJson(SETTINGS_FILE) || {};
  return { workMode: j.workMode === true, ownerQQ: Number(j.ownerQQ) || 0 };
}

function l5RunsToday() {
  try {
    const today = new Date().toDateString();
    let n = 0;
    for (const line of fs.readFileSync(L5_RUNS, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j && j.kind === 'start' && new Date(j.at).toDateString() === today) n++;
      } catch { /* ignore */ }
    }
    return n;
  } catch { return 0; }
}

function appendL5(entry) {
  try {
    fs.mkdirSync(path.dirname(L5_RUNS), { recursive: true });
    fs.appendFileSync(L5_RUNS, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

let tasksModule = null;
function tasks() {
  if (tasksModule) return tasksModule;
  try { tasksModule = requireCjs(TASKS_MOD); } catch (error) { tasksModule = null; }
  return tasksModule;
}

/* L5 探索的提示词 */
export function buildExplorePrompt({ dirs, mode, maxSteps } = {}) {
  const modeText = mode === 'readonly' ? '只读（绝对不许写、改、删、装）' : '全自主（可以写，但别动系统文件和别人的东西）';
  const dirText = dirs && dirs.length ? dirs.map((d) => '· ' + d).join('\n') : '· （主人还没设允许目录——这次只能在记忆库里翻翻，不许碰文件）';
  return [
    '【自主探索】这是你自己定的探索时间，主人不在，你自己安排。',
    `模式：${modeText}`,
    '允许范围（只能在这里面活动）：',
    dirText,
    `步数上限：${maxSteps} 次动作。`,
    '你可以做的：在这些目录里看看有什么、读一读、整理结构；把值得记的发现存进记忆库（回复里单独一行写「记：xxx」）；',
    '最后给主人写一句简短的汇报：今天看了什么、发现了什么。',
    '不要做的：不动系统目录、不装东西、不删别人的文件、不外传资料。',
    '需要时可以用工具（mcp__shell__ 看目录、mcp__files__ 读文件、记忆库读写）；看完写一句给主人的汇报。',
    '注意：如果工具不可用（被权限拦），就只写一句汇报说明你看不到。',
  ].join('\n');
}

/* 任务续跑的提示词 */
export function buildTaskPrompt(task) {
  const steps = Array.isArray(task.steps) && task.steps.length
    ? task.steps.map((s) => `${s.done ? '✅' : '⬜'} ${s.n}. ${s.text}`).join('\n')
    : '（还没拆步骤）';
  const prog = Array.isArray(task.progress) && task.progress.length
    ? task.progress.slice(-5).map((p) => '· ' + p.text).join('\n')
    : '（还没有进度记录）';
  return [
    `【继续任务】#${task.id} ${task.title}`,
    `目标：${task.goal}`,
    `轮次：${task.rounds}/${task.maxRounds}`,
    '步骤：',
    steps,
    '最近进度：',
    prog,
    '要求：先看清做到哪一步，别重复已完成的部分；这一轮推进 1-3 步就够。',
    '需要时可以用工具（pwsh/读写文件/任务工具）；干完写一句：这一轮做了什么、下一步是什么。',
    '如果做不下去，就写「卡住：原因」。',
  ].join('\n');
}

/* 启动调度：每分钟检查一次；返回停止函数 */
export function startSchedulers({ getAgent, sendToOwner, log = () => {}, intervalMs = 60 * 1000, isBusy = () => false, setBusy = () => {}, proactive = null, readState = () => ({}), hobby = null, runHobby = null } = {}) {
  let lastHobbyDay = '';
  let hobbyCount = 0;
  let proactiveDay = new Date().toDateString();
  let proactiveCount = 0;
  let lastProactiveAt = 0;
  let lastL5Minute = ''; // 同一分钟只跑一次（否则每分钟的多次 tick 会连跑）

  async function runExplore(caps) {
    const key = 'private:' + (readSettings().ownerQQ || '');
    appendL5({ kind: 'start', key, mode: caps.autonomous, dirs: caps.l5.dirs });
    log(`[L5] 自主探索开始（${caps.autonomous}）`);
    const t0 = Date.now();
    try {
      const agent = await getAgent();
      const reply = (await agent.ask(buildExplorePrompt({ dirs: caps.l5.dirs, mode: caps.autonomous, maxSteps: caps.l5.maxSteps }), { timeoutMs: 240000 })).trim();
      const { text, facts } = splitFacts(reply);
      appendL5({ kind: 'finish', steps: 0, seconds: Math.round((Date.now() - t0) / 1000), result: text.slice(0, 300) });
      log(`[L5] 探索完成（${Math.round((Date.now() - t0) / 1000)}s），汇报 ${text.length} 字`);
      if (text) await sendToOwner(text);
      for (const f of facts) log(`[L5] 记忆：${f.slice(0, 40)}`);
    } catch (error) {
      appendL5({ kind: 'error', error: String(error?.message ?? error).slice(0, 300) });
      log(`[L5] 探索失败：${error?.message ?? error}`);
    }
  }

  async function runTask(tk) {
    const mod = tasks();
    log(`[tasks] 继续任务 #${tk.id} ${tk.title}（第 ${tk.rounds + 1}/${tk.maxRounds} 轮）`);
    mod.markRoundStart(tk.id);
    const t0 = Date.now();
    try {
      const agent = await getAgent();
      const reply = (await agent.ask(buildTaskPrompt(mod.get(tk.id) || tk), { timeoutMs: 300000 })).trim();
      const { text, facts } = splitFacts(reply);
      mod.update(tk.id, { progress: `第 ${tk.rounds + 1} 轮：${(text || '（无输出）').slice(0, 120)}` });
      log(`[tasks] #${tk.id} 第 ${tk.rounds + 1} 轮完成（${Math.round((Date.now() - t0) / 1000)}s）`);
      if (text) await sendToOwner(text);
      for (const f of facts) log(`[tasks] 记忆：${f.slice(0, 40)}`);
    } catch (error) {
      log(`[tasks] #${tk.id} 轮次失败：${error?.message ?? error}`);
    }
  }

  const timer = setInterval(async () => {
    if (isBusy()) return;
    try {
      const caps = readCaps();
      if (caps.panic) return;
      const settings = readSettings();
      const now = new Date();
      const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

      if (process.env.QQ_NATIVE_SCHED_DEBUG) log(`[sched] tick hhmm=${hhmm} explore=${caps.explore} auto=${caps.autonomous} dirs=${caps.l5.dirs.length} times=${caps.l5.times.join('/')} runs=${l5RunsToday()} workMode=${settings.workMode}`);

      // L5：到点 + 有目录 + 额度够
      const force = process.env.QQ_NATIVE_L5_FORCE === '1';
      const dueMinute = force || (caps.l5.times.includes(hhmm) && lastL5Minute !== hhmm);
      if (caps.explore && caps.autonomous !== 'off' && caps.l5.dirs.length && dueMinute && (force || l5RunsToday() < caps.l5.maxRunsPerDay)) {
        lastL5Minute = hhmm;
        setBusy(true);
        try { await runExplore(caps); } finally { setBusy(false); }
        return;
      }

      // 爱好时间：她自己的时间，自己琢磨点东西（结果只进小本子，不发 QQ）
      if (hobby && hobby.enabled && typeof runHobby === 'function') {
        const today = now.toDateString();
        if (lastHobbyDay !== today) { lastHobbyDay = today; hobbyCount = 0; }
        const [h1, h2] = Array.isArray(hobby.hours) && hobby.hours.length === 2 ? hobby.hours : [10, 22];
        const hr = now.getHours();
        const inHours = hr >= h1 && hr < h2;
        const cap = Number(hobby.maxPerDay) || 2;
        const force = process.env.QQ_NATIVE_HOBBY_FORCE === '1';
        if ((force || (inHours && hobbyCount < cap)) && !isBusy()) {
          hobbyCount += 1;
          setBusy(true);
          try { await runHobby(); } finally { setBusy(false); }
          return;
        }
      }

      // 主动找话题：他很久没说话时，主动说一句
      if (proactive && proactive.enabled) {
        const hour = now.getHours();
        const [h1, h2] = Array.isArray(proactive.hours) && proactive.hours.length === 2 ? proactive.hours : [9, 23];
        const inHours = hour >= h1 && hour < h2;
        if (proactiveDay !== now.toDateString()) { proactiveDay = now.toDateString(); proactiveCount = 0; }
        const st = readState();
        const lastIn = Number(st.lastIncomingAt) || 0;
        const idleMs = (Number(proactive.idleMinutes) || 240) * 60000;
        const caps2 = readCaps();
        if (inHours && !isBusy() && !caps2.panic && Date.now() - lastIn >= idleMs && lastProactiveAt < lastIn && proactiveCount < (Number(proactive.maxPerDay) || 3)) {
          setBusy(true);
          try {
            proactiveCount += 1;
            lastProactiveAt = Date.now();
            log(`[proactive] 主动找他说话（今天第 ${proactiveCount} 次）`);
            const agent = await getAgent();
            const prompt = [
              '【主动机会】主人已经很久没说话了。',
              '你可以主动冒个泡：问问他现在在干嘛、关心一下他的状态、说说你刚想到的事。',
              '直接写你要发的内容（1-2 句就够），不要调用工具，不要解释。',
              '如果觉得不该打扰，就只输出 [SILENT]。',
            ].join('\n');
            const reply = (await agent.ask(prompt, { timeoutMs: 180000 })).trim();
            if (reply && reply !== '[SILENT]') { await sendToOwner(reply); log('[proactive] 已发送'); }
            else log('[proactive] 她选择不打扰');
          } catch (error) { log('[proactive] 失败：' + (error?.message ?? error)); }
          finally { setBusy(false); }
          return;
        }
      }

      // 任务：工作模式 + 有该跑的任务
      if (settings.workMode) {
        const mod = tasks();
        if (mod) {
          const tk = mod.pickNext({ gapMs: 90 * 1000 });
          if (tk) {
            setBusy(true);
            try { await runTask(tk); } finally { setBusy(false); }
          }
        }
      }
    } catch (error) {
      log(`[sched] 调度出错：${error?.message ?? error}`);
    }
  }, intervalMs);
  timer.unref?.();
  if (process.env.QQ_NATIVE_SCHED_DEBUG) log(`[sched] 已启动 interval=${intervalMs}ms`);

  return () => clearInterval(timer);
}

function splitFacts(reply) {
  const facts = [];
  const kept = [];
  for (const line of String(reply ?? '').split(/\r?\n/)) {
    const m = /^\s*[【\[]?\s*(?:记|记住|记忆)\s*[:：]\s*(.+)$/.exec(line);
    if (m) facts.push(m[1].trim());
    else kept.push(line);
  }
  return { text: kept.join('\n').trim(), facts };
}
