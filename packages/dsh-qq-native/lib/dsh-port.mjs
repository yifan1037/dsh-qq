// dsh-port.js —— 找到本机 DSH 的 web 端口
//
// 不能写死：DSH 每次启动端口可能变。做法和 dsh-qq-personal 一样：
//   netstat 找 127.0.0.1 监听端口 → 过滤出 DeepSeek Harness 进程的 → 探 /（200/401 都是它）

import { execFileSync } from 'node:child_process';

export async function discoverDshPort(log = () => {}, excludePorts = []) {
  const exclude = new Set(excludePorts.map(Number).filter((n) => Number.isInteger(n) && n > 0));
  let listeners = [];
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    listeners = out
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].startsWith('127.0.0.1:'))
      .map((cols) => ({ port: Number(cols[1].split(':').pop()), pid: Number(cols[4]) }))
      .filter((e) => Number.isInteger(e.port) && Number.isInteger(e.pid) && !exclude.has(e.port));
  } catch (error) {
    log(`netstat 失败：${error?.message ?? error}`);
    return null;
  }

  const dshPids = new Set();
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    for (const line of out.split(/\r?\n/)) {
      const m = /^"DeepSeek Harness\.exe","(\d+)"/.exec(line.trim());
      if (m) dshPids.add(Number(m[1]));
    }
  } catch { /* 拿不到进程列表就用全部监听端口 */ }

  const candidates = listeners.filter((e) => dshPids.size === 0 || dshPids.has(e.pid));
  for (const c of candidates) {
    try {
      const r = await fetch(`http://127.0.0.1:${c.port}/`, { redirect: 'manual' });
      if (r.status === 200 || r.status === 401) return c.port;
    } catch { /* 不是 web 端口 */ }
  }
  log(`没找到 DSH 端口（候选：${candidates.map((c) => c.port).join(', ') || '无'}）`);
  return null;
}
