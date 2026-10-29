#!/usr/bin/env node
// mcp-tasks.js —— 任务队列 MCP server（给 QQ agent 用）
//
// 存储：~/.dsh/qq-personal/tasks/<id>.json（和插件共用同一份）
// 闸门：只有在「工作模式」打开、且没有紧急停止时才可用（否则一律拒绝）
//
// 工具：
//   task_create(title, goal, steps?, maxRounds?, dirs?)  建任务
//   task_list(status?)                                    看任务
//   task_get(id)                                          看单个任务（含步骤/进度）
//   task_update(id, progress?, stepDone?, stepAdd?, status?) 更新进度
//   task_done(id, result, failed?)                        完成/失败
//   task_cancel(id, note?)                                取消

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const TASKS_PATH = process.env.DSH_QQ_TASKS_MODULE || require('node:path').join(require('node:os').homedir(), '.dsh', 'plugins', 'dsh-qq-personal', 'lib', 'tasks.js');
const TASKS = require(TASKS_PATH);

const SETTINGS_FILE = path.join(os.homedir(), '.dsh', 'qq-personal', 'settings.json');
const CAP_FILE = path.join(os.homedir(), '.dsh', 'qq-personal', 'capabilities.json');

function readJson(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function gate() {
  const settings = readJson(SETTINGS_FILE) || {};
  const caps = readJson(CAP_FILE) || {};
  if (Number(caps.panic) > 0) {
    return { content: [{ type: 'text', text: '⛔ 紧急停止中：任务工具全部禁用。要恢复请主人在管理台解除。' }], isError: true };
  }
  if (settings.workMode !== true) {
    return { content: [{ type: 'text', text: '工作模式没开：任务队列只在工作模式下可用。让主人在 QQ 管理台「权限」页打开「工作模式」。' }], isError: true };
  }
  return null;
}

function fmtTask(t, withDetail = false) {
  const st = { pending: '待开始', running: '进行中', paused: '暂停', done: '完成', failed: '失败', cancelled: '取消' }[t.status] || t.status;
  const done = t.steps.filter((s) => s.done).length;
  const lines = [
    `#${t.id} ${t.title}`,
    `状态：${st} · 轮次 ${t.rounds}/${t.maxRounds} · 步骤 ${done}/${t.steps.length}`,
  ];
  if (t.goal) lines.push(`目标：${t.goal}`);
  if (withDetail && t.steps.length) {
    lines.push('步骤：');
    for (const s of t.steps) lines.push(`  ${s.done ? '✅' : '⬜'} ${s.n}. ${s.text}`);
  }
  if (withDetail && t.progress.length) {
    lines.push('最近进度：');
    for (const p of t.progress.slice(-6)) lines.push(`  · ${new Date(p.at).toLocaleString('zh-CN', { hour12: false })} ${p.text}`);
  }
  if (t.result) lines.push(`结果：${t.result}`);
  return lines.join('\n');
}

const server = new McpServer({ name: 'tasks', version: '1.0.0' });

server.tool(
  'task_create',
  '建一个任务（长任务用：它会跨多轮推进）。写清目标、拆成 3-8 个步骤；之后每轮用 task_update 更新进度。',
  {
    title: z.string().describe('任务标题，短一点'),
    goal: z.string().describe('目标：要达成什么（越具体越好，含目录/文件）'),
    steps: z.array(z.string()).optional().describe('步骤清单（建议 3-8 步）'),
    maxRounds: z.number().optional().describe('最多推进几轮，默认 12'),
    dirs: z.array(z.string()).optional().describe('涉及目录（需要动手的路径）'),
  },
  async ({ title, goal, steps, maxRounds, dirs }) => {
    const blocked = gate();
    if (blocked) return blocked;
    try {
      const t = TASKS.create({ title, goal, steps, maxRounds, dirs });
      return { content: [{ type: 'text', text: `已建任务：\n${fmtTask(t, true)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `建任务失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'task_list',
  '列任务（默认全部；可只看 active=待开始+进行中）。',
  { status: z.string().optional().describe('pending / running / paused / done / failed / cancelled / active') },
  async ({ status }) => {
    const blocked = gate();
    if (blocked) return blocked;
    const filter = status === 'active' ? { activeOnly: true } : status ? { status } : {};
    const list = TASKS.list(filter);
    if (!list.length) return { content: [{ type: 'text', text: '没有任务。' }] };
    return { content: [{ type: 'text', text: list.map((t) => fmtTask(t)).join('\n\n') }] };
  }
);

server.tool(
  'task_get',
  '看一个任务的完整内容（步骤、最近进度、结果）。继续干活前先看它，不要重复已完成的部分。',
  { id: z.string().describe('任务 id，例如 t1a2b3c') },
  async ({ id }) => {
    const blocked = gate();
    if (blocked) return blocked;
    const t = TASKS.get(id);
    if (!t) return { content: [{ type: 'text', text: `没有任务 ${id}` }], isError: true };
    return { content: [{ type: 'text', text: fmtTask(t, true) }] };
  }
);

server.tool(
  'task_update',
  '更新任务进度：写一句进度、勾掉一个步骤、追加步骤、或改状态。每轮干完都该更新一次。',
  {
    id: z.string().describe('任务 id'),
    progress: z.string().optional().describe('本轮做了什么（一句话）'),
    stepDone: z.number().optional().describe('把第几步勾掉（步骤编号 n）'),
    stepAdd: z.array(z.string()).optional().describe('追加步骤'),
    status: z.enum(['pending', 'running', 'paused']).optional().describe('改状态（done/failed 用 task_done）'),
  },
  async ({ id, progress, stepDone, stepAdd, status }) => {
    const blocked = gate();
    if (blocked) return blocked;
    try {
      const t = TASKS.update(id, { progress, stepDone, addSteps: stepAdd, status });
      return { content: [{ type: 'text', text: `已更新：\n${fmtTask(t, true)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `更新失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'task_done',
  '任务完成（或判定失败）。写一句结果；成功后这个任务不会再被调度。',
  {
    id: z.string().describe('任务 id'),
    result: z.string().describe('结果：做完了什么、文件在哪、还有什么没做'),
    failed: z.boolean().optional().describe('true = 判定失败/做不下去'),
  },
  async ({ id, result, failed }) => {
    const blocked = gate();
    if (blocked) return blocked;
    try {
      const t = TASKS.finish(id, result, { failed: failed === true });
      return { content: [{ type: 'text', text: `任务已${failed ? '标记失败' : '完成'}：\n${fmtTask(t, true)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `操作失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'task_cancel',
  '取消一个任务（不想做了/建错了）。',
  { id: z.string().describe('任务 id'), note: z.string().optional().describe('取消原因') },
  async ({ id, note }) => {
    const blocked = gate();
    if (blocked) return blocked;
    try {
      const t = TASKS.cancel(id, note);
      return { content: [{ type: 'text', text: `已取消：\n${fmtTask(t)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `取消失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
