// persona-self.mjs —— 人设自述层：她自己能写的那一层，底座不动
//
// 结构：
//   ~/.dsh/qq-native/data/persona.md        底座（你写，她只读）
//   ~/.dsh/qq-native/data/persona-self.md   自述（她可写，≤4KB）
//   ~/.dsh/qq-native/data/persona-self.bak-* 写入前备份
//   ~/.dsh/qq-native/state/persona-changes.jsonl 审计
//
// 四道闸：限长 4KB、每天最多 1 次、写前备份、审计可回滚。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = () => path.join(os.homedir(), '.dsh', 'qq-native', 'data');
const STATE = () => path.join(os.homedir(), '.dsh', 'qq-native', 'state');
const SELF = () => path.join(DATA(), 'persona-self.md');
const AUDIT = () => path.join(STATE(), 'persona-changes.jsonl');

export const MAX_CHARS = 4096;
export const DAILY_LIMIT = 1;

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* ignore */ }
}

/** 读她的自述；没有返回 '' */
export function readSelf() {
  try {
    return fs.readFileSync(SELF(), 'utf8').trim();
  } catch { return ''; }
}

/** 自述的指纹（用于判断"这轮要不要重新注入"） */
export function selfHash() {
  const t = readSelf();
  if (!t) return '';
  let h = 0;
  for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) | 0; }
  return t.length + ':' + (h >>> 0).toString(16);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function readAudit() {
  try {
    return fs.readFileSync(AUDIT(), 'utf8').trim().split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function appendAudit(rec) {
  ensureDir(STATE());
  try { fs.appendFileSync(AUDIT(), JSON.stringify(rec) + '\n', 'utf8'); } catch { /* ignore */ }
}

/** 今天改过几次 */
export function changesToday() {
  const d = todayKey();
  return readAudit().filter((r) => String(r.at || '').slice(0, 10) === d && r.action === 'write' && r.force !== true).length;
}

/**
 * 写自述。
 * @returns {{ ok: boolean, error?: string, chars?: number, backup?: string }}
 */
export function writeSelf({ text, reason = '', by = 'agent', force = false } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: '内容为空' };
  if (body.length > MAX_CHARS) {
    return { ok: false, error: `太长了（${body.length} 字，上限 ${MAX_CHARS}）——请压缩成要点` };
  }
  if (!force && changesToday() >= DAILY_LIMIT) {
    return { ok: false, error: `今天已经改过 ${DAILY_LIMIT} 次了，明天再说；想现在就改让主人说"强制改自述"` };
  }

  ensureDir(DATA());
  let backup = '';
  try {
    if (fs.existsSync(SELF())) {
      backup = SELF() + '.bak-' + Date.now();
      fs.copyFileSync(SELF(), backup);
    }
  } catch { /* ignore */ }

  try {
    fs.writeFileSync(SELF(), body + '\n', 'utf8');
  } catch (error) {
    return { ok: false, error: '写入失败：' + (error?.message ?? error) };
  }

  appendAudit({ at: new Date().toISOString(), action: 'write', by, force: force === true, reason: String(reason).slice(0, 300), chars: body.length, backup: backup ? path.basename(backup) : '' });
  return { ok: true, chars: body.length, backup };
}

/** 回滚到最近一次备份 */
export function rollbackSelf() {
  ensureDir(DATA());
  let files = [];
  try {
    files = fs.readdirSync(DATA()).filter((f) => f.startsWith('persona-self.md.bak-')).sort();
  } catch { /* ignore */ }
  if (!files.length) return { ok: false, error: '没有备份可回滚' };
  const latest = path.join(DATA(), files[files.length - 1]);
  try {
    fs.copyFileSync(latest, SELF());
    appendAudit({ at: new Date().toISOString(), action: 'rollback', by: 'owner', reason: 'rollback to ' + files[files.length - 1], chars: readSelf().length });
    return { ok: true, from: files[files.length - 1] };
  } catch (error) {
    return { ok: false, error: '回滚失败：' + (error?.message ?? error) };
  }
}

/** 变更历史 */
export function changes(limit = 20) {
  return readAudit().slice(-limit).reverse();
}

/** 从回复里抽「[自述: …]」行（要写进自述层，不发 QQ） */
export function extractSelfNote(reply) {
  const notes = [];
  const kept = [];
  for (const line of String(reply ?? '').split(/\r?\n/)) {
    const m = /^\s*[\[【]自述[：:]\s*([\s\S]*?)[\]】]\s*$/.exec(line);
    if (m) notes.push(m[1].trim());
    else kept.push(line);
  }
  return { text: kept.join('\n').trim(), notes };
}

/** 注入用的自述块（≤1200 字，太长截断） */
export function buildSelfBlock({ maxChars = 1200 } = {}) {
  const t = readSelf();
  if (!t) return '';
  const body = t.length <= maxChars ? t : t.slice(0, maxChars) + '…（自述过长，已截断）';
  return '【你自己的修订（你可以改，但底座优先）】\n' + body + '\n';
}
