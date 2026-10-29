// snowluma.js —— 直连 SnowLuma（OneBot v11）的连接层
//
// 关键经验（2026-10-27 实测）：
//   · SnowLuma 的 HTTP 服务（3010）和 WS 服务（3011）用的是**两个不同的 accessToken**
//   · bridge 的 config.json 里存的是 HTTP token；WS token 要从 SnowLuma 自己的
//     config/onebot_<uin>.json 里读
//   · 用错 token 的表现是「rejected unauthorized WebSocket upgrade」，很难看出是 token 问题
//
// 本模块负责：找 token、连 WS、发 HTTP 请求、断线重连。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ── 从 SnowLuma 目录自动发现端点与 token ── */
export function discoverSnowLuma({ dir, httpPort, wsPort } = {}) {
  const slDir = dir || path.join(os.homedir(), '.dsh', 'qq-personal', 'snowluma');
  const cfgDir = path.join(slDir, 'config');
  const result = { dir: slDir, httpUrl: null, wsUrl: null, httpToken: '', wsToken: '', uin: null };
  let files = [];
  try { files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f)); } catch { return result; }
  for (const f of files) {
    try {
      let raw = fs.readFileSync(path.join(cfgDir, f), 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const j = JSON.parse(raw);
      const http = (j.networks?.httpServers ?? [])[0] ?? null;
      const ws = (j.networks?.wsServers ?? []).filter((x) => x && x.role !== 'API')[0] ?? null;
      if (!http && !ws) continue;
      const hp = Number(http?.port) || 0;
      const wp = Number(ws?.port) || 0;
      if (httpPort && hp !== Number(httpPort)) continue;
      if (wsPort && wp !== Number(wsPort)) continue;
      result.uin = String(f.match(/^onebot_(\d+)\.json$/)?.[1] ?? '');
      result.httpUrl = http ? `http://${http.host || '127.0.0.1'}:${hp}` : null;
      result.wsUrl = ws ? `ws://${ws.host || '127.0.0.1'}:${wp}` : null;
      result.httpToken = String(http?.accessToken ?? '');
      result.wsToken = String(ws?.accessToken ?? '');
      return result;
    } catch { /* 跳过坏文件 */ }
  }
  return result;
}

/* ── OneBot HTTP API 客户端（发消息用） ── */
export class OneBotHttp {
  constructor({ baseUrl, accessToken }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = String(accessToken || '');
  }

  async call(action, params = {}) {
    if (!this.baseUrl) throw new Error('没有 SnowLuma HTTP 地址');
    const r = await fetch(`${this.baseUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(params),
    });
    if (!r.ok) throw new Error(`OneBot HTTP ${r.status} ${r.statusText}`);
    const j = await r.json();
    if (j && j.status === 'failed') throw new Error(j.message || j.wording || 'OneBot 调用失败');
    return j?.data ?? j;
  }

  sendPrivate(userId, message) { return this.call('send_private_msg', { user_id: userId, message }); }
  sendGroup(groupId, message) { return this.call('send_group_msg', { group_id: groupId, message }); }
  /** 发消息段数组（图/表情/引用/@/文件） */
  sendSegments(kind, id, message) {
    return kind === 'group'
      ? this.call('send_group_msg', { group_id: Number(id), message })
      : this.call('send_private_msg', { user_id: Number(id), message });
  }
  /** 撤回 */
  deleteMsg(messageId) { return this.call('delete_msg', { message_id: messageId }); }
  /** 拍一拍 */
  friendPoke(userId) { return this.call('friend_poke', { user_id: Number(userId) }); }
  groupPoke(groupId, userId) { return this.call('group_poke', { group_id: Number(groupId), user_id: Number(userId) }); }
  getLoginInfo() { return this.call('get_login_info', {}); }
}

/* ── 极简 OneBot WS 客户端（不依赖 @snowluma/sdk，直接 Node 内置 WebSocket） ── */
//
// Node 24 内置的 WebSocket 不支持自定义 handshake 头，所以 token 走 query：
// SnowLuma 接受 `?access_token=...`（实测有效）。
export class OneBotWS {
  constructor({ url, accessToken, onEvent, log = console.log, reconnect = true, reconnectDelayMs = 3000 }) {
    this.url = String(url || '');
    this.token = String(accessToken || '');
    this.onEvent = onEvent || (() => {});
    this.log = log;
    this.reconnect = reconnect;
    this.reconnectDelayMs = reconnectDelayMs;
    this.sock = null;
    this.closedByUser = false;
    this.ready = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.url) return reject(new Error('没有 SnowLuma WS 地址'));
      const sep = this.url.includes('?') ? '&' : '?';
      const url = this.token ? `${this.url}${sep}access_token=${encodeURIComponent(this.token)}` : this.url;
      let sock;
      try { sock = new WebSocket(url); } catch (error) { return reject(error); }
      this.sock = sock;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; try { sock.close(); } catch { /* ignore */ } reject(new Error('WS 连接超时')); }
      }, 8000);
      sock.addEventListener('open', () => {
        clearTimeout(timer);
        this.ready = true;
        if (!settled) { settled = true; resolve(this); }
        this.log('[ws] 已连接 ' + this.url);
      });
      sock.addEventListener('message', (ev) => {
        let data;
        try { data = JSON.parse(String(ev.data)); } catch { return; }
        try { this.onEvent(data); } catch (error) { this.log('[ws] 事件处理出错: ' + (error?.message ?? error)); }
      });
      sock.addEventListener('close', (ev) => {
        this.ready = false;
        clearTimeout(timer);
        const wasOpen = settled;
        if (!settled) { settled = true; reject(new Error('WS 被关闭 ' + (ev?.code ?? '') + ' ' + (ev?.reason ?? ''))); }
        if (this.closedByUser) return;
        // 首次连接失败同样重连（SnowLuma 可能比 DSH 后启动）
        this.log('[ws] ' + (wasOpen ? '连接断开' : '连接失败') + '（' + (ev?.code ?? '?') + '），' + Math.round(this.reconnectDelayMs / 1000) + 's 后重连');
        if (this.reconnect) setTimeout(() => this.connect().catch(() => {}), this.reconnectDelayMs);
      });
      sock.addEventListener('error', () => { /* close 事件里统一处理 */ });
    });
  }

  get connected() { return this.ready === true; }

  close() {
    this.closedByUser = true;
    this.ready = false;
    try { this.sock?.close(); } catch { /* ignore */ }
  }
}
