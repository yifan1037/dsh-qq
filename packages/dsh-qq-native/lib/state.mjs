// state.mjs —— 插件的小状态文件（会话 id、最近对话缓冲）
//
// ~/.dsh/qq-native/state.json
//   { sessionId, sessionPreset, createdAt, lastIncomingAt, recent: [{from:'me'|'owner', text, at}] }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(os.homedir(), '.dsh', 'qq-native', 'state.json');
const MAX_RECENT = 20;

export function readState() {
  try {
    let raw = fs.readFileSync(FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    return {
      sessionId: typeof j.sessionId === 'string' ? j.sessionId : '',
      sessionPreset: typeof j.sessionPreset === 'string' ? j.sessionPreset : '',
      createdAt: Number(j.createdAt) || 0,
      lastIncomingAt: Number(j.lastIncomingAt) || 0,
      recent: Array.isArray(j.recent) ? j.recent.slice(-MAX_RECENT) : [],
    };
  } catch {
    return { sessionId: '', sessionPreset: '', createdAt: 0, lastIncomingAt: 0, recent: [] };
  }
}

export function writeState(next) {
  const cur = readState();
  const merged = {
    ...cur,
    ...next,
    recent: Array.isArray(next.recent) ? next.recent.slice(-MAX_RECENT) : cur.recent,
  };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
  return merged;
}

export function pushRecent(from, text) {
  const cur = readState();
  const recent = [...cur.recent, { from, text: String(text).slice(0, 200), at: Date.now() }].slice(-MAX_RECENT);
  return writeState({ recent, ...(from === 'owner' ? { lastIncomingAt: Date.now() } : {}) });
}
