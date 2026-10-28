// dsh-agent.js —— 在插件里跟 DSH 的 agent 会话对话
//
// 做的事：
//   1. 发现 DSH web 端口
//   2. 借 qq-bridge 的 dsh-client（已被验证的协议实现）建会话
//   3. prompt 一句 → 等 turn/end → 拿最终文本
//
// 为什么还用 loopback HTTP 而不是 ctx API：
//   DSH 的插件 ctx 里有 sessionController（create/prompt），但「等回合结束拿文本」
//   需要订阅 session 事件，当前版本没找到稳定的进程内订阅入口；
//   loopback HTTP 协议是桥接跑了几个月验证过的，先用它把链路跑通。
//   TODO(第 3 步)：换成 ctx.sessionController + ctx.on('session/event')，去掉 HTTP。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { discoverDshPort } from './dsh-port.mjs';

// 仅在「新建会话」时当工作区用；复用旧会话时完全不碰它。
const WORKDIR = path.join(os.homedir(), '.dsh', 'qq-native', 'agent-workdir');

export async function createDshAgent({ bridgeDir = '', vendorDir = '', preset = 'qq-chat-v2', log = () => {}, resumeSessionId = '' } = {}) {
  // vendor 优先按本模块位置解析（包自带），不依赖任何本机绝对路径
  if (!vendorDir) vendorDir = fileURLToPath(new URL('./vendor', import.meta.url));
  const port = await discoverDshPort(log, [3100, 3101, 3010, 3011, 3110]);
  if (!port) throw new Error('找不到 DSH web 端口');

  // 优先用 vendor 里自带的 dsh-client（不再依赖 qq-bridge 目录）
  let clientPath = path.join(vendorDir, 'dsh-client.js');
  if (!fs.existsSync(clientPath) && bridgeDir) clientPath = path.join(bridgeDir, 'src', 'dsh-client.js');
  if (!fs.existsSync(clientPath)) throw new Error('找不到 dsh-client：' + clientPath);
  const mod = await import(pathToFileURL(clientPath).href);
  const { NodeApiClient, unwrap } = mod;

  const api = new NodeApiClient(`http://127.0.0.1:${port}`, undefined, { token: '', tokenExplicit: false });
  await api.settings.describe({}); // 触发鉴权握手（失败会抛）

  let sessionId = '';
  // 复用已有会话（上次运行留下的），失败再建新的
  if (resumeSessionId) {
    try {
      const list = unwrap(await api.sessions.list({}), 'sessions.list');
      const sessions = list?.items ?? list?.sessions ?? (Array.isArray(list) ? list : []);
      const hit = Array.isArray(sessions) ? sessions.find((s) => (s?.sessionId ?? s?.id) === resumeSessionId) : null;
      if (hit) {
        sessionId = resumeSessionId;
        log('复用已有会话：' + sessionId);
      }
    } catch (error) {
      log('复用会话失败，改为新建：' + (error?.message ?? error));
    }
  }
  if (!sessionId) {
    // 只在「真需要新建会话」时才用工作区（平时都复用旧会话，不需要）
    fs.mkdirSync(WORKDIR, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: WORKDIR }), 'workspace.create');
    const wsId = wsValue?.workspace?.workspaceId;
    const params = { workspaceId: wsId, agentPreset: preset };
    const created = unwrap(await api.sessions.create(params), 'sessions.create');
    sessionId = created.sessionId;
  }
  api.events.follow(sessionId);
  log(`会话已建立：${sessionId}（preset=${preset}）`);

  const waiters = []; // 先进先出：每轮一个 waiter
  let eventsSeen = 0;

  // ⚠️ 实测（2026-10-27）：这条事件流里**没有 turn/start**（只有 step/start→assistant/message→turn/end），
  // 所以不能用 createTurnCollector（它靠 turn/start 建回合）。这里自己累积文本。
  let pendingText = '';
  const dispatch = (frame) => {
    if (frame.sessionId !== sessionId) return;
    const ev = frame.event;
    eventsSeen += 1;
    if (!ev || typeof ev.type !== 'string') return;
    if (ev.type === 'turn/start') { pendingText = ''; return; }
    if (ev.type === 'assistant/message') {
      for (const block of ev.data?.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') pendingText += block.text;
      }
      return;
    }
    if (ev.type === 'turn/end') {
      const text = pendingText;
      pendingText = '';
      const w = waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        const kind = ev.data?.reason?.kind ?? ev.data?.reason ?? 'completed';
        if (kind === 'completed') w.resolve(text);
        else w.reject(new Error(`回合异常结束：${kind}`));
      }
    }
  };

  (async () => {
    for (;;) {
      try {
        for await (const envelope of api.events.mux({})) {
          const frame = envelope?.payload;
          if (frame?.type === 'session/event') dispatch(frame);
        }
      } catch (error) {
        log(`事件流断开：${error?.message ?? error}，3 秒后重连`);
      }
      await new Promise((r) => setTimeout(r, 3000));
      try { api.events.follow(sessionId); } catch { /* ignore */ }
    }
  })();

  async function ask(text, { timeoutMs = 240000 } = {}) {
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`等待回复超时（收到 ${eventsSeen} 个事件）`));
      }, timeoutMs);
      waiters.push({ resolve, reject, timer });
    });
    const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] });
    if (accepted?.result && accepted.result.ok === false) {
      throw new Error(`prompt 被拒绝：${accepted.result.error?.code} ${accepted.result.error?.message}`);
    }
    return await answer;
  }

  return { sessionId, ask, port, close: () => { try { api.events.mux?.close?.(); } catch { /* ignore */ } } };
}

