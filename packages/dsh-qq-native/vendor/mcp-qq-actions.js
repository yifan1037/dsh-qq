#!/usr/bin/env node
// mcp-qq-actions.js —— QQ 动作 MCP server（P2：让 agent 能做"用户在 QQ 上能做的操作"）
//
// 直连 SnowLuma OneBot v11（读 ~/.dsh/qq-native/config.json 发现端点/token），
// 不需要经过插件进程；但每个危险动作都受：
//   · capabilities.json 的 panic（紧急停止）
//   · config.actions.enabled 的层级开关（message/media/group/admin/destructive）
//   · 审计日志 ~/.dsh/qq-native/state/actions.jsonl
//
// 工具一览（★ = 破坏性/需显式开关）：
//   只读查询：qq_get_friend_list / qq_get_group_list / qq_get_group_members / qq_get_msg
//   轻动作： qq_send_like / qq_mark_read / qq_recall
//   媒体：   qq_upload_private_file / qq_upload_group_file
//   群管理★： qq_set_group_card / qq_group_ban / qq_group_kick
//   请求★：  qq_handle_friend_request / qq_handle_group_request
//
// 环境变量：QQ_NATIVE_CONFIG（默认 ~/.dsh/qq-native/config.json）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { discoverSnowLuma } from '../lib/snowluma.mjs';

const CONFIG_FILE = process.env.QQ_NATIVE_CONFIG || path.join(os.homedir(), '.dsh', 'qq-native', 'config.json');
const CAP_FILE = path.join(os.homedir(), '.dsh', 'qq-personal', 'capabilities.json');
const AUDIT = path.join(os.homedir(), '.dsh', 'qq-native', 'state', 'actions.jsonl');

function readJson(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return null; }
}

function config() { return readJson(CONFIG_FILE) || {}; }
function caps() { return readJson(CAP_FILE) || {}; }

function enabledTiers() {
  const c = config();
  const a = c.actions && c.actions.enabled ? c.actions.enabled : {};
  return { message: a.message !== false, media: a.media !== false, group: a.group === true, admin: a.admin === true, destructive: a.destructive === true };
}

function audit(tool, detail, ok, error) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), action: tool, detail, ok, error }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

function snowluma() {
  const c = config();
  const dir = String(c.snowlumaDir || '').replace(/[\\/]+$/, '');
  const httpPort = Number(c.httpPort) || 3010;
  const wsPort = Number(c.wsPort) || 3011;
  // 复用插件里的发现逻辑（HTTP/WS 两个 token 不同，这里只要 HTTP）
  const found = discoverSnowLuma({ dir, httpPort, wsPort });
  if (found.httpUrl) return { baseUrl: found.httpUrl, token: found.httpToken, uin: found.uin, wsPort };
  // 兜底：只用 HTTP 端口匹配（不要求 WS）
  const fallback = discoverSnowLuma({ dir, httpPort });
  return { baseUrl: fallback.httpUrl || ('http://127.0.0.1:' + httpPort), token: fallback.httpToken || '', uin: fallback.uin || '', wsPort };
}

const sl = snowluma();

async function call(action, params = {}, tier = 'message', detail = {}) {
  const t = enabledTiers();
  if (Number(caps().panic) || 0) return { ok: false, error: '紧急停止中（主人关了所有电脑能力）' };
  if (!t[tier]) return { ok: false, error: '动作层级 ' + tier + ' 没开：让主人在 QQ 管理台「权限」页打开' };
  try {
    const res = await fetch(sl.baseUrl + '/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sl.token ? { authorization: 'Bearer ' + sl.token } : {}) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    const bad = json?.status === 'failed' || (json?.retcode !== undefined && json.retcode !== 0);
    audit(action, detail, !bad, bad ? JSON.stringify(json).slice(0, 200) : undefined);
    if (bad) return { ok: false, error: 'OneBot 返回失败：' + JSON.stringify(json).slice(0, 300) };
    return { ok: true, data: json?.data ?? json };
  } catch (error) {
    audit(action, detail, false, String(error?.message ?? error));
    return { ok: false, error: '调用失败：' + (error?.message ?? error) };
  }
}

const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });
const fail = (s) => ({ content: [{ type: 'text', text: '失败：' + String(s) }], isError: true });

const server = new McpServer({ name: 'qq-actions', version: '1.0.0' });

/* ── 只读查询 ─────────────────────────────────────── */
server.tool('qq_get_friend_list', '拉取 QQ 好友列表（只读）。', {}, async () => {
  const r = await call('get_friend_list', {}, 'message', {});
  if (!r.ok) return fail(r.error);
  const list = Array.isArray(r.data) ? r.data : [];
  return text('好友 ' + list.length + ' 个：\n' + list.slice(0, 100).map((f) => '· ' + (f.remark || f.nickname) + '（' + f.user_id + '）').join('\n'));
});

server.tool('qq_get_group_list', '拉取 QQ 群列表（只读）。', {}, async () => {
  const r = await call('get_group_list', {}, 'message', {});
  if (!r.ok) return fail(r.error);
  const list = Array.isArray(r.data) ? r.data : [];
  return text('群 ' + list.length + ' 个：\n' + list.slice(0, 100).map((g) => '· ' + g.group_name + '（' + g.group_id + '）').join('\n'));
});

server.tool('qq_get_group_members', '拉取某个群的成员列表（只读）。', { group_id: z.number().describe('群号') }, async ({ group_id }) => {
  const r = await call('get_group_member_list', { group_id }, 'message', { group_id });
  if (!r.ok) return fail(r.error);
  const list = Array.isArray(r.data) ? r.data : [];
  return text('群 ' + group_id + ' 共 ' + list.length + ' 人：\n' + list.slice(0, 200).map((m) => '· ' + (m.card || m.nickname) + '（' + m.user_id + '）' + (m.role === 'owner' ? ' [群主]' : m.role === 'admin' ? ' [管理]' : '')).join('\n'));
});

server.tool('qq_get_msg', '按 message_id 取回一条消息（只读，用于看引用/图片）。', { message_id: z.union([z.number(), z.string()]).describe('消息 id') }, async ({ message_id }) => {
  const r = await call('get_msg', { message_id }, 'message', { message_id });
  if (!r.ok) return fail(r.error);
  return text(JSON.stringify(r.data).slice(0, 2000));
});

/* ── 轻动作 ───────────────────────────────────────── */
server.tool('qq_send_like', '给某人点赞（默认 10 次）。', { user_id: z.number(), times: z.number().optional() }, async ({ user_id, times }) => {
  const r = await call('send_like', { user_id, times: times || 10 }, 'media', { user_id, times });
  return r.ok ? text('已点赞') : fail(r.error);
});

server.tool('qq_mark_read', '把某条私聊消息标为已读。', { user_id: z.number(), message_id: z.union([z.number(), z.string()]) }, async ({ user_id, message_id }) => {
  const r = await call('mark_msg_as_read', { user_id, message_id }, 'message', { user_id });
  return r.ok ? text('已标记已读') : fail(r.error);
});

server.tool('qq_recall', '撤回一条自己发的消息。', { message_id: z.union([z.number(), z.string()]) }, async ({ message_id }) => {
  const r = await call('delete_msg', { message_id }, 'media', { message_id });
  return r.ok ? text('已撤回') : fail(r.error);
});

/* ── 媒体 ─────────────────────────────────────────── */
server.tool('qq_upload_private_file', '给某人发本地文件。', { user_id: z.number(), file: z.string().describe('本地绝对路径'), name: z.string().optional() }, async ({ user_id, file, name }) => {
  const r = await call('upload_private_file', { user_id, file, name: name || path.basename(file) }, 'media', { user_id, file });
  return r.ok ? text('已发送文件') : fail(r.error);
});

server.tool('qq_upload_group_file', '往群里发本地文件。', { group_id: z.number(), file: z.string(), name: z.string().optional() }, async ({ group_id, file, name }) => {
  const r = await call('upload_group_file', { group_id, file, name: name || path.basename(file) }, 'group', { group_id, file });
  return r.ok ? text('已发送群文件') : fail(r.error);
});

/* ── 群管理（★ 需要 admin / destructive）──────────── */
server.tool('qq_set_group_card', '★改群名片（需 admin 权限）。', { group_id: z.number(), user_id: z.number(), card: z.string().describe('新群名片，空字符串表示清除') }, async ({ group_id, user_id, card }) => {
  const r = await call('set_group_card', { group_id, user_id, card }, 'admin', { group_id, user_id });
  return r.ok ? text('已修改群名片') : fail(r.error);
});

server.tool('qq_group_ban', '★禁言群成员（需 admin 权限；duration 秒，0=解除）。', { group_id: z.number(), user_id: z.number(), duration: z.number() }, async ({ group_id, user_id, duration }) => {
  const r = await call('set_group_ban', { group_id, user_id, duration }, 'admin', { group_id, user_id, duration });
  return r.ok ? text(duration > 0 ? '已禁言 ' + duration + ' 秒' : '已解除禁言') : fail(r.error);
});

server.tool('qq_group_kick', '★★踢人（需 destructive 权限，默认关闭；先跟主人确认再用）。', { group_id: z.number(), user_id: z.number(), reject_add_request: z.boolean().optional() }, async ({ group_id, user_id, reject_add_request }) => {
  const r = await call('set_group_kick', { group_id, user_id, reject_add_request: reject_add_request === true }, 'destructive', { group_id, user_id });
  return r.ok ? text('已踢出') : fail(r.error);
});

/* ── 请求处理（★ 需要 admin）──────────────────────── */
server.tool('qq_handle_friend_request', '★处理好友申请（需 admin 权限）。', { flag: z.string().describe('事件里的 flag'), approve: z.boolean(), remark: z.string().optional() }, async ({ flag, approve, remark }) => {
  const r = await call('set_friend_add_request', { flag, approve, remark: remark || '' }, 'admin', { flag, approve });
  return r.ok ? text(approve ? '已同意好友申请' : '已拒绝好友申请') : fail(r.error);
});

server.tool('qq_handle_group_request', '★处理入群申请/邀请（需 admin 权限）。', { flag: z.string(), sub_type: z.enum(['add', 'invite']).optional(), approve: z.boolean(), reason: z.string().optional() }, async ({ flag, sub_type, approve, reason }) => {
  const r = await call('set_group_add_request', { flag, sub_type: sub_type || 'add', approve, reason: reason || '' }, 'admin', { flag, approve });
  return r.ok ? text(approve ? '已同意入群申请' : '已拒绝入群申请') : fail(r.error);
});

/* ── 群信息 / 群文件 / 群公告（P2 第二批）──────────── */
server.tool('qq_get_group_info', '查一个群的资料（名称、人数、上限等）。', { group_id: z.number(), no_cache: z.boolean().optional() }, async ({ group_id, no_cache }) => {
  const r = await call('get_group_info', { group_id, no_cache: no_cache === true }, 'message', { group_id });
  if (!r.ok) return fail(r.error);
  const g = r.data || {};
  return text('群：' + (g.group_name || '?') + '（' + (g.group_id || group_id) + '）\n人数：' + (g.member_count || '?') + ' / ' + (g.max_member_count || '?') + '\n创建：' + (g.group_create_time ? new Date(g.group_create_time * 1000).toLocaleString('zh-CN', { hour12: false }) : '?') + '\n描述：' + (g.group_memo || g.group_desc || '（无）'));
});

server.tool('qq_get_group_member_info', '查某个群成员的资料（昵称、群名片、角色、入群时间）。', { group_id: z.number(), user_id: z.number(), no_cache: z.boolean().optional() }, async ({ group_id, user_id, no_cache }) => {
  const r = await call('get_group_member_info', { group_id, user_id, no_cache: no_cache === true }, 'message', { group_id, user_id });
  if (!r.ok) return fail(r.error);
  const m = r.data || {};
  return text(JSON.stringify({ nickname: m.nickname, card: m.card, role: m.role, join_time: m.join_time, last_sent_time: m.last_sent_time, level: m.level }, null, 2));
});

server.tool('qq_get_stranger_info', '查一个非好友的公开资料。', { user_id: z.number(), no_cache: z.boolean().optional() }, async ({ user_id, no_cache }) => {
  const r = await call('get_stranger_info', { user_id, no_cache: no_cache === true }, 'message', { user_id });
  if (!r.ok) return fail(r.error);
  const u = r.data || {};
  return text('昵称：' + (u.nickname || '?') + '\nQQ：' + (u.user_id || user_id) + '\n签名：' + (u.long_nick || u.remark || '（无）'));
});

server.tool('qq_get_group_notice', '拉取群公告列表（只读）。', { group_id: z.number() }, async ({ group_id }) => {
  const r = await call('_get_group_notice', { group_id }, 'message', { group_id });
  if (!r.ok) return fail(r.error);
  const list = Array.isArray(r.data) ? r.data : [];
  if (!list.length) return text('群 ' + group_id + ' 没有公告');
  return text('群公告 ' + list.length + ' 条：\n' + list.slice(0, 10).map((x, i) => '#' + (i + 1) + ' ' + (x.notice_id || '') + '\n' + String(x.message?.text || x.content || '').slice(0, 400)).join('\n---\n'));
});

server.tool('qq_send_group_notice', '★发群公告（需 admin 权限）。', { group_id: z.number(), content: z.string().describe('公告正文') }, async ({ group_id, content }) => {
  const r = await call('_send_group_notice', { group_id, content }, 'admin', { group_id });
  return r.ok ? text('已发布群公告') : fail(r.error);
});

server.tool('qq_get_group_files', '列群文件（根目录或指定文件夹，只读）。', { group_id: z.number(), folder: z.string().optional().describe('文件夹 id；留空为根目录') }, async ({ group_id, folder }) => {
  const action = folder ? 'get_group_files_by_folder' : 'get_group_root_files';
  const params = folder ? { group_id, folder_id: folder } : { group_id };
  const r = await call(action, params, 'message', { group_id, folder });
  if (!r.ok) return fail(r.error);
  const files = (r.data?.files || []).map((f) => '· ' + f.file_name + '（' + Math.round(Number(f.file_size || 0) / 1024) + ' KB）id=' + f.file_id);
  const folders = (r.data?.folders || []).map((f) => '📁 ' + f.folder_name + ' id=' + f.folder_id);
  return text([...folders, ...files].join('\n') || '（空）');
});

server.tool('qq_get_group_file_url', '取群文件的下载地址（只读）。', { group_id: z.number(), file_id: z.string(), busid: z.number().optional() }, async ({ group_id, file_id, busid }) => {
  const r = await call('get_group_file_url', { group_id, file_id, busid: busid || 0 }, 'message', { group_id, file_id });
  if (!r.ok) return fail(r.error);
  return text(String(r.data?.url || JSON.stringify(r.data)).slice(0, 500));
});

server.tool('qq_set_group_name', '★修改群名（需 admin 权限）。', { group_id: z.number(), group_name: z.string() }, async ({ group_id, group_name }) => {
  const r = await call('set_group_name', { group_id, group_name }, 'admin', { group_id });
  return r.ok ? text('已改群名为：' + group_name) : fail(r.error);
});

server.tool('qq_set_group_whole_ban', '★全员禁言开/关（需 admin 权限）。', { group_id: z.number(), enable: z.boolean() }, async ({ group_id, enable }) => {
  const r = await call('set_group_whole_ban', { group_id, enable }, 'admin', { group_id, enable });
  return r.ok ? text(enable ? '已开启全员禁言' : '已关闭全员禁言') : fail(r.error);
});

server.tool('qq_set_group_special_title', '★设置群成员专属头衔（需 admin 权限）。', { group_id: z.number(), user_id: z.number(), special_title: z.string() }, async ({ group_id, user_id, special_title }) => {
  const r = await call('set_group_special_title', { group_id, user_id, special_title }, 'admin', { group_id, user_id });
  return r.ok ? text('已设置头衔') : fail(r.error);
});

server.tool('qq_send_forward', '发合并转发消息（把多条消息打包成一条）。', { message_type: z.enum(['private', 'group']), target_id: z.number(), messages: z.array(z.string()).describe('要转发的文本数组') }, async ({ message_type, target_id, messages }) => {
  const nodes = (messages || []).map((t) => ({ type: 'node', data: { name: 'DSH', uin: String(sl.uin || ''), content: [{ type: 'text', data: { text: String(t) } }] } }));
  const action = message_type === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg';
  const params = message_type === 'group' ? { group_id: target_id, messages: nodes } : { user_id: target_id, messages: nodes };
  const r = await call(action, params, message_type === 'group' ? 'group' : 'media', { target_id, count: nodes.length });
  return r.ok ? text('已发送合并转发（' + nodes.length + ' 条）') : fail(r.error);
});

server.tool('qq_set_group_leave', '★★退群（需 destructive 权限，默认关闭；先跟主人确认）。', { group_id: z.number(), is_dismiss: z.boolean().optional() }, async ({ group_id, is_dismiss }) => {
  const r = await call('set_group_leave', { group_id, is_dismiss: is_dismiss === true }, 'destructive', { group_id });
  return r.ok ? text('已退出群 ' + group_id) : fail(r.error);
});

server.tool('qq_delete_friend', '★★删除好友（需 destructive 权限，默认关闭；先跟主人确认）。', { user_id: z.number() }, async ({ user_id }) => {
  const r = await call('delete_friend', { user_id }, 'destructive', { user_id });
  return r.ok ? text('已删除好友 ' + user_id) : fail(r.error);
});

server.tool('qq_set_qq_profile', '★★修改机器人自己的 QQ 资料（需 destructive 权限，默认关闭）。', { nickname: z.string().optional(), personal_note: z.string().optional() }, async ({ nickname, personal_note }) => {
  const params = {};
  if (nickname) params.nickname = nickname;
  if (personal_note) params.personal_note = personal_note;
  const r = await call('set_qq_profile', params, 'destructive', {});
  return r.ok ? text('已更新资料') : fail(r.error);
});

server.tool('qq_get_group_history', '拉群聊历史消息（只读；用于回想群里之前聊了什么）。', { group_id: z.number(), count: z.number().optional().describe('条数，默认 20，上限 50') }, async ({ group_id, count }) => {
  const n = Math.max(1, Math.min(50, Number(count) || 20));
  const r = await call('get_group_msg_history', { group_id, count: n }, 'message', { group_id, count: n });
  if (!r.ok) return fail(r.error);
  const msgs = r.data?.messages || r.data || [];
  const lines = (Array.isArray(msgs) ? msgs : []).slice(-n).map((m) => {
    const who = m.sender?.card || m.sender?.nickname || m.user_id || '?';
    const txt = (m.message || []).map((s) => (s.type === 'text' ? s.data?.text : '[' + s.type + ']')).join('');
    return who + '：' + String(txt).slice(0, 120);
  });
  return text(lines.join('\n') || '（没有历史消息）');
});

server.tool('qq_get_private_history', '拉与某人的私聊历史（只读）。', { user_id: z.number(), count: z.number().optional() }, async ({ user_id, count }) => {
  const n = Math.max(1, Math.min(50, Number(count) || 20));
  const r = await call('get_friend_msg_history', { user_id, count: n }, 'message', { user_id, count: n });
  if (!r.ok) return fail(r.error);
  const msgs = r.data?.messages || r.data || [];
  const lines = (Array.isArray(msgs) ? msgs : []).slice(-n).map((m) => {
    const who = String(m.user_id) === String(sl.uin) ? '我' : (m.sender?.nickname || m.user_id);
    const txt = (m.message || []).map((s) => (s.type === 'text' ? s.data?.text : '[' + s.type + ']')).join('');
    return who + '：' + String(txt).slice(0, 120);
  });
  return text(lines.join('\n') || '（没有历史消息）');
});

await server.connect(new StdioServerTransport());
