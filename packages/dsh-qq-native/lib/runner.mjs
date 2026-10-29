// index.js —— dsh-qq-native：插件内直连 SnowLuma（不走独立 bridge 进程）
//
// 第 1 步（当前）：只连接 + 观察事件，**不回复、不发送**（observeOnly=true），
//                这样可以和现有 bridge 同时跑，互不干扰。
//
// 配置：~/.dsh/qq-native/config.json
//   {
//     "snowlumaDir": "D:/.../snowluma-v1.14.19-...",   // 自动找 token 用
//     "httpPort": 3010,
//     "wsPort": 3011,
//     "ownerQQ": 10001,
//     "observeOnly": true,
//     "logEvents": true
//   }
//
// 后续步骤：
//   第 2 步：唤醒/发送/记忆移植（observeOnly=false 才真的回消息）
//   第 3 步：管理台接口接上（沿用现有 /api/* 契约）
//   第 4 步：停掉 bridge，验证
//   第 5 步：删 bridge 依赖

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverSnowLuma, OneBotHttp, OneBotWS } from './snowluma.mjs';
import { createDshAgent } from './dsh-agent.mjs';
import { buildMemoryBlock, readPersona, appendMemory, curateMemory } from './memory.mjs';
import { createBatcher, extractMemoryLines, extractMedia } from './wake.mjs';
import { createActions } from './actions.mjs';
import { downloadImages, pruneMedia, mediaDir } from './media.mjs';
import { fromOneBot, toPlainText, imagesOf } from './onebot-segments.mjs';
import { decideGroupReply, gateGroupRate, buildGroupPromptBlock, groupsConfig } from './groups.mjs';
import { startSchedulers } from './schedulers.mjs';
import { startStats } from './stats.mjs';
import { buildSelfBlock, extractSelfNote, writeSelf, readSelf, selfHash, rollbackSelf, changes as personaChanges } from './persona-self.mjs';
import { buildReplyPrompt } from './reply-prompt.mjs';
import { decideParticipation, buildParticipationHint } from './participation.mjs';
import { readState, writeState, pushRecent } from './state.mjs';
import { createEyes } from './eyes.mjs';
import { pickHobby, appendHobbyLog, readHobbyNotes } from './hobbies.mjs';
import { startScreenWatch, appendObservation } from './screenwatch.mjs';

const LOG_FILE = path.join(os.homedir(), '.dsh', 'qq-native', 'plugin.log');
function fileLog(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + String(msg) + '\n', 'utf8');
  } catch { /* ignore */ }
}

export const name = 'qq-native';
fileLog('[module] qq-native 模块被加载');

const CONFIG_FILE = path.join(os.homedir(), '.dsh', 'qq-native', 'config.json');

const DEFAULTS = {
  snowlumaDir: '',
  httpPort: 3010,
  wsPort: 3011,
  ownerQQ: 0,
  observeOnly: true,
  logEvents: true,
  // 第 2 步：真的回复。默认关（避免和现有 bridge 双回）
  enableReply: false,
  // 只有以这个前缀开头的消息才由本插件回（双跑时用来安全测试；空串=全部回）
  triggerPrefix: '/n ',
  preset: 'qq-chat-v2',
  bridgeDir: '<本机路径>',
};

function readConfig() {
  try {
    let raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeDefaultConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    if (fs.existsSync(CONFIG_FILE)) return;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
}

export function start(ctx) {
  return startInner(ctx);
}

function startInner(ctx) {
  const log = (msg) => {
    try { console.log(`[qq-native] ${msg}`); } catch { /* ignore */ }
    fileLog(msg);
    try { ctx?.logger?.info?.(String(msg)); } catch { /* ignore */ }
  };

  const cfg = readConfig();
  writeDefaultConfig(cfg);
  log(`启动（配置：${CONFIG_FILE}）observeOnly=${cfg.observeOnly}`);

  const found = discoverSnowLuma({ dir: cfg.snowlumaDir || undefined, httpPort: cfg.httpPort, wsPort: cfg.wsPort });
  if (!found.wsUrl || !found.wsToken) {
    log('没找到 SnowLuma WS 端点或 token，插件待机（确认 SnowLuma 已启动并登录）');
    return () => {};
  }
  log(`发现 SnowLuma：uin=${found.uin} http=${found.httpUrl} ws=${found.wsUrl}`);

  const http = new OneBotHttp({ baseUrl: found.httpUrl, accessToken: found.httpToken });
  const stats = { events: 0, messages: 0, byType: {}, lastEventAt: 0, connectedAt: 0, replies: 0 };

  // 懒建 DSH 会话（第一次要回复时才建，建失败不影响接收）
  let agentPromise = null;
  let busy = false;
  function getAgent() {
    if (!agentPromise) {
      const st = readState();
      // 工作模式用 qq-work（有 pwsh/fs 工具），平时用聊天 preset
      let presetForSession = cfg.preset || 'qq-chat-v2';
      try {
        const settingsFile = path.join(os.homedir(), '.dsh', 'qq-personal', 'settings.json');
        const sj = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, ''));
        if (sj?.workMode === true) presetForSession = 'qq-work';
      } catch { /* ignore */ }
      let resumeId = st.sessionId;
      // [第 4 步准备] 接旧窗口：从桥接的 sessions.json 读它正在用的会话 id
      if (!resumeId && cfg.reuseBridgeSession === true) {
        try {
          const sessCandidates = [
            path.join(os.homedir(), '.dsh', 'qq-native', 'state', 'sessions.json'),
            path.join(cfg.bridgeDir, 'state', 'sessions.json'),
          ];
          const sessFile = sessCandidates.find((p) => fs.existsSync(p)) || sessCandidates[1];
          const j = JSON.parse(fs.readFileSync(sessFile, 'utf8').replace(/^\uFEFF/, ''));
          const key = 'private:' + (cfg.ownerQQ || '');
          const fromBridge = j?.sessions?.[key];
          if (fromBridge) { resumeId = fromBridge; log('接旧窗口：' + resumeId); }
        } catch (error) { log('读桥接会话失败：' + (error?.message ?? error)); }
      }
      agentPromise = createDshAgent({ bridgeDir: cfg.bridgeDir, preset: presetForSession, log, resumeSessionId: resumeId }).then((agent) => {
        writeState({ sessionId: agent.sessionId, sessionPreset: presetForSession, createdAt: Date.now() });
        // 成本统计：每 5 分钟把这条会话的 token 增量写回 token-usage.jsonl（管理台成本页用）
        try {
          if (!stopStats) stopStats = startStats({ bridgeDir: cfg.bridgeDir, dshPort: agent.port, sessionId: agent.sessionId, key: 'private:' + Number(cfg.ownerQQ), log, intervalMs: Number(cfg.statsIntervalMs) || 300000 });
        } catch (error) { log('统计启动失败：' + (error?.message ?? error)); }
        return agent;
      }).catch((error) => {
        log(`建 agent 失败：${error?.message ?? error}`);
        agentPromise = null;
        throw error;
      });
    }
    return agentPromise;
  }

  // 动作层：权限 + 审计 + 限流
  const actions = createActions({ http, cfg, log });
  const groupBatchers = new Map(); // 群聊单独排队，避免和私聊混批
  log('[actions] 动作层就绪（' + Object.entries(actions.conf.enabled).filter(([, v]) => v).map(([k]) => k).join('/') + '）');

  // 消息合并器：连发多条只醒一次
  let stopStats = null;

  // 启动时清理过期媒体（保留 3 天）
  try { const n = pruneMedia({ days: 3 }); if (n) log('[media] 清理过期图片 ' + n + ' 张'); } catch { /* ignore */ }

  // 启动时整理一次记忆（去重/分组/生成 INDEX.md）
  try { curateMemory({ log }); } catch (error) { log('记忆整理失败：' + (error?.message ?? error)); }

  // 忙的时候收到的消息不丢，先存着，等这轮回完再补
  const deferred = [];
  const batcher = createBatcher({
    windowMs: Number(cfg.batchWindowMs) || 1600,
    onFlush: async (text, meta) => {
      if (busy) { deferred.push({ text, meta }); log(`上一轮还没回完，这条先存着（排队 ${deferred.length}）`); return; }
      await handleReply(text, meta);
    },
    log,
  });

  // 调度器：L5 自主探索 + 任务续跑（和聊天共用 busy 互斥，避免抢同一条会话）
  const sendToOwner = async (text) => {
    const owner = Number(cfg.ownerQQ);
    if (!owner || !text) return { ok: false, sent: 0, failed: 0, reason: 'no-owner-or-text' };
    const bubbles = splitBubbles(String(text)).slice(0, 3);
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < bubbles.length; i++) {
      if (i > 0) await sleep(600 + Math.floor(Math.random() * 900));
      const r = await actions.sendPrivateText(owner, bubbles[i]);
      if (r?.ok) sent += 1; else failed += 1;
    }
    return { ok: sent > 0, sent, failed };
  };
  const stopSchedulers = startSchedulers({
    getAgent,
    sendToOwner,
    log,
    intervalMs: Number(cfg.schedulerIntervalMs) || 60000,
    isBusy: () => busy,
    setBusy: (v) => { busy = !!v; },
    proactive: cfg.proactive || null,
    readState,
    // 聊天活跃判定：有排队消息，或 3 分钟内有新消息 → 后台任务让路
    isChatActive: () => {
      try {
        if (batcher.pending > 0) return true;
        const st = readState();
        return Date.now() - (Number(st.lastIncomingAt) || 0) < 3 * 60 * 1000;
      } catch { return false; }
    },
    hobby: cfg.hobby || null,
    runHobby: async () => {
      const h = pickHobby();
      if (!h) return;
      log('[hobby] 爱好时间：' + h.name);
      const prompt = [
        '【你自己的时间】现在没有主人在等你回话，这是你自己的时间。',
        '你最近的爱好：' + h.name + (h.why ? '（' + h.why + '）' : ''),
        h.notes?.length ? '你之前记过的：\n' + h.notes.slice(-3).map((x) => '· ' + x).join('\n') : '',
        '你可以：用 mcp__web-search-safe__web_search 搜一个你好奇的点、或者就着这个爱好想一想。',
        '然后写 1-3 句你今天琢磨到的东西（第一人称、口语、像自言自语，别写成报告）。',
        '这些只会存进你自己的小本子，不会发到 QQ。',
        '如果今天没心情，只输出 [SILENT]。',
      ].filter(Boolean).join('\n');
      try {
        const agent = await getAgent();
        // dry-run：只组装并打印 prompt，不调模型、不发 QQ、不写记忆
        const reply = (await agent.ask(prompt, { timeoutMs: 240000 })).trim();
        if (!reply || reply === '[SILENT]') { log('[hobby] 今天没心情'); return; }
        appendHobbyLog({ hobby: h.name, text: reply });
        log('[hobby] 记下了：' + reply.slice(0, 50));
      } catch (error) { log('[hobby] 失败：' + (error?.message ?? error)); }
    },
  });



  // ── 眼睛与屏幕监控 ───────────────────────────────────────────────
  let stopScreenWatch = null;
  const eyes = createEyes({ createDshAgent, log });

  const screenCfg = () => (cfg.screenWatch && typeof cfg.screenWatch === 'object') ? cfg.screenWatch : { enabled: false, comment: false, everyMinutes: 5 };

  function saveScreenCfg(patch) {
    try {
      const file = path.join(os.homedir(), '.dsh', 'qq-native', 'config.json');
      const cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      cur.screenWatch = { ...screenCfg(), ...patch };
      fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n', 'utf8');
      Object.assign(cfg, { screenWatch: cur.screenWatch });
      return cur.screenWatch;
    } catch (error) {
      log('[screen] 保存开关失败：' + (error?.message ?? error));
      return screenCfg();
    }
  }

  async function watchOnce(reason = 'manual') {
    if (busy) return '';
    busy = true;
    try {
      const text = await eyes.look();
      if (text) {
        appendObservation({ text, hash: '', source: reason });
        log('[screen] 看到了：' + text.slice(0, 60));
      }
      return text;
    } finally {
      busy = false;
    }
  }

  function startWatch() {
    if (stopScreenWatch) return;
    const every = Math.max(1, Number(screenCfg().everyMinutes) || 5) * 60 * 1000;
    stopScreenWatch = startScreenWatch({
      intervalMs: every,
      enabled: () => Boolean(screenCfg().enabled),
      onChange: async () => { await watchOnce('change'); },
      log,
    });
    log('[screen] 屏幕监控已启动（每 ' + Math.round(every / 60000) + ' 分钟，只读）');
  }

  function stopWatch() {
    if (stopScreenWatch) { try { stopScreenWatch(); } catch { /* ignore */ } stopScreenWatch = null; log('[screen] 屏幕监控已停止'); }
  }

  // QQ 指令：看屏幕 / 开屏幕监控 / 关屏幕监控
  async function handleScreenCommand(raw) {
    const text = String(raw || '').trim();
    // 人设自述相关指令
    if (/^(看自述|看看自述)$/.test(text)) {
      const body = readSelf();
      await sendToOwner(body ? ('我的自述：\n' + body) : '我还没写自述');
      return true;
    }
    if (/^(回滚人设|恢复人设)$/.test(text)) {
      const r = rollbackSelf();
      await sendToOwner(r.ok ? ('已回滚到：' + r.from) : ('回滚失败：' + r.error));
      return true;
    }
    if (/^(强制改自述)$/.test(text)) {
      const r = writeSelf({ text: readSelf() || '（空）', reason: 'owner 强制重置额度', by: 'owner', force: true });
      await sendToOwner(r.ok ? '额度已重置，今天可以再改一次自述' : ('失败：' + r.error));
      return true;
    }
    if (!text) return false;
    const o = String(cfg.ownerQQ || '');
    const isOwner = (id) => String(id) === o;
    void isOwner;
    if (/^(看屏幕|看看屏幕|看看我屏幕|看一眼屏幕)$/.test(text)) {
      const seen = await watchOnce('ask');
      if (seen) await sendToOwner('我瞄了一眼：' + seen.replace(/\n+/g, ' '));
      else await sendToOwner('唔 我这边没看到画面 (｡•́︿•̀｡)');
      return true;
    }
    if (/^(开屏幕监控|开启屏幕监控|开始看屏幕)$/.test(text)) {
      saveScreenCfg({ enabled: true });
      startWatch();
      await sendToOwner('好 我开始看着屏幕了（只看看，不动手）');
      return true;
    }
    if (/^(关屏幕监控|关闭屏幕监控|别看屏幕了|停止看屏幕)$/.test(text)) {
      saveScreenCfg({ enabled: false });
      stopWatch();
      await sendToOwner('嗯 不看了');
      return true;
    }
    return false;
  }

  // 配置里如果已经开着，启动时自动开始
  if (screenCfg().enabled) startWatch();

  // 管理台改配置（文件）也要跟着生效：每 20 秒对一次
  const screenWatchSync = setInterval(() => {
    try {
      const file = path.join(os.homedir(), '.dsh', 'qq-native', 'config.json');
      const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const want = Boolean(j.screenWatch?.enabled);
      if (j.screenWatch) cfg.screenWatch = { ...(cfg.screenWatch || {}), ...j.screenWatch };
      if (want && !stopScreenWatch) startWatch();
      if (!want && stopScreenWatch) stopWatch();
    } catch { /* ignore */ }
  }, 20000);
  screenWatchSync.unref?.();

  // 分条策略：换行优先，太长或没有换行就按句号拆，最多 3 条
  function splitBubbles(text) {
    let parts = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1) {
      const m = String(text).split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
      if (m.length > 1) parts = m;
    }
    if (parts.length > 3) parts = [parts.slice(0, 2).join(' '), ...parts.slice(2)].slice(0, 3);
    return parts.slice(0, 3);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function textOf(ev) {
    return (ev?.message ?? []).map((s) => (s.type === 'text' ? String(s.data?.text ?? '') : '')).join('').trim();
  }

  // 回复链路：消息 → 记忆+人设 → DSH 生成 → 分条发出
  async function handleReply(text, meta = {}) {
    if (busy) { log('上一轮还没回完，跳过这条'); return; }
    busy = true;
    const t0 = Date.now();
    const isGroup = meta.kind === 'group';
    const userId = Number(meta.userId ?? cfg.ownerQQ);
    const key = isGroup ? 'group:' + (meta.groupId ?? '') : 'private:' + userId;
    if (meta.count > 1) log(`本轮合并了 ${meta.count} 条消息`);
    pushRecent('owner', text);
    try {
      const st = readState();
      const firstTime = !st.sessionId;
      const memory = buildMemoryBlock({ bridgeDir: cfg.bridgeDir, key, recent: readState().recent });
      const persona = firstTime ? readPersona({ bridgeDir: cfg.bridgeDir }) : '';
      const imageHint = (meta.imagePaths && meta.imagePaths.length)
        ? '【主人刚发了图片，已保存到本地】\n' + meta.imagePaths.map((p) => '· ' + p).join('\n') + '\n如果你有 read_image 工具，可以看一眼再回话；看不到就直说看不到。\n'
        : '';
      const groupBlock = isGroup
        ? buildGroupPromptBlock({ groupId: meta.groupId, senderName: meta.senderName, senderId: userId, text, atMe: meta.atMe })
        : '';
      // 自述层：首次或发生变化时注入
      const selfH = selfHash();
      const includeSelf = firstTime || (readState().lastSelfHash || '') !== selfH;
      const selfBlock = includeSelf ? buildSelfBlock() : '';
      if (includeSelf && selfH) { try { writeState({ lastSelfHash: selfH }); } catch { /* ignore */ } }

      // 发言决策：该不该说 / 说几条 / 要不要引用
      const participation = decideParticipation({ cfg, isGroup, text, atMe: meta.atMe === true, recent: readState().recent || [] });
      if (!participation.speak) { log('[participation] 这轮选择不接（' + participation.reason + '）'); return; }
      const participationHint = buildParticipationHint(participation, { isGroup });
      if (participation.reason !== 'normal' && participation.reason !== 'disabled') log('[participation] ' + participation.reason + ' → ' + participation.bubbles + ' 条');

      const prompt = buildReplyPrompt({ persona, selfBlock, imagePaths: meta.imagePaths || [], memory, groupBlock, text, isGroup, participationHint });
      // dry-run：只组装并打印 prompt，不调模型、不发 QQ、不写记忆
      if (process.env.QQ_NATIVE_DRYRUN === '1') {
        log('[dryrun] prompt ' + prompt.length + ' 字，含图片提示=' + /【主人刚发了图片/.test(prompt) + (isGroup ? '（群聊）' : '（私聊）'));
        log('[dryrun] 预览：' + prompt.replace(/\n+/g, ' ⏎ ').slice(0, 300));
        return;
      }
      const agent = await getAgent();
      const reply = (await agent.ask(prompt, { timeoutMs: 180000 })).trim();
      if (!reply) { log('DSH 回复为空，跳过发送'); return; }
      if (reply === '[SILENT]' || reply === '［SILENT］') { log('她选择不说话（[SILENT]）'); return; }
      // 「记：xxx」行不进 QQ，写进记忆库
      // 「[自述: …]」行写进自述层，不发 QQ
      let replyForMem = reply;
      try {
        const selfNote = extractSelfNote(reply);
        if (selfNote.notes.length) {
          replyForMem = selfNote.text;
          const body = readSelf();
          const merged = [body, ...selfNote.notes].filter(Boolean).join('\n');
          const r = writeSelf({ text: merged, reason: 'agent 自述', by: 'agent', force: false });
          if (r.ok) log('[persona] 自述已更新（' + r.chars + ' 字）');
          else log('[persona] 自述未更新：' + r.error);
        }
      } catch (error) { log('[persona] 自述处理失败：' + (error?.message ?? error)); }

      const mem = extractMemoryLines(replyForMem);
      for (const fact of mem.facts) {
        const rec = appendMemory({ text: fact, weight: 4, tags: ['native'], kind: '事件', source: 'qq-native' });
        if (rec) { log('已记入记忆库：' + fact.slice(0, 40)); try { curateMemory({ log }); } catch { /* ignore */ } }
      }
      const plain = mem.text.replace(/\*\*/g, '').replace(/^#+\s?/gm, '').trim();
      // 媒体标记：[图片:path] [表情:id] [引用:id] [拍一拍] [文件:path]
      const media = extractMedia(plain);
      const textOnly = media.text;
      if (!textOnly && !media.segments.length) { log('回复只有记忆行，没有要发的内容'); return; }

      const replySegs = media.segments.filter((s) => s.type === 'reply');
      const otherSegs = media.segments.filter((s) => s.type !== 'reply' && s.type !== 'poke');
      const pokes = media.segments.filter((s) => s.type === 'poke');
      const bubbles = textOnly ? splitBubbles(textOnly).slice(0, participation.bubbles || 3) : [];

      for (let i = 0; i < bubbles.length; i++) {
        if (i > 0) await sleep(600 + Math.floor(Math.random() * 900));
        const segs = [];
        if (i === 0) segs.push(...replySegs);
        segs.push({ type: 'text', text: bubbles[i] });
        // 发送失败重试一次（SnowLuma 抖动时常见）
        let sendRes = isGroup ? await actions.sendGroupSegments(Number(meta.groupId), segs) : await actions.sendPrivateSegments(userId, segs);
        if (!sendRes?.ok) {
          await sleep(1200);
          sendRes = isGroup ? await actions.sendGroupSegments(Number(meta.groupId), segs) : await actions.sendPrivateSegments(userId, segs);
        }
        if (!sendRes?.ok) { log('发送失败（重试后仍失败）：' + (sendRes?.error ?? '')); return; }
      }
      if (otherSegs.length) {
        if (bubbles.length) await sleep(400 + Math.floor(Math.random() * 600));
        if (isGroup) await actions.sendGroupSegments(Number(meta.groupId), otherSegs);
        else await actions.sendPrivateSegments(userId, otherSegs);
      }
      for (const p of pokes) {
        await actions.poke(isGroup ? 'group' : 'private', isGroup ? Number(meta.groupId) : userId);
      }
      pushRecent('me', bubbles.join(' / '));
      stats.replies += 1;
      log(`已回复（${((Date.now() - t0) / 1000).toFixed(1)}s，${plain.length} 字，${bubbles.length} 条）`);
    } catch (error) {
      log(`回复失败：${error?.message ?? error}`);
    } finally {
      busy = false;
      // 回完了：如果还有排队的消息，接着处理（一次一个，避免并发）
      if (deferred.length) {
        const next = deferred.shift();
        setTimeout(() => { if (!busy) void handleReply(next.text, next.meta); }, 300);
      }
    }
  }

  // 机器人自己的 QQ（判断群里 @ 是否指向自己）
  let botQQ = '';
  try {
    http.getLoginInfo().then((info) => {
      botQQ = String(info?.data?.user_id ?? info?.user_id ?? '');
      log('[groups] 机器人 QQ: ' + (botQQ || '(取不到)'));
    }).catch((error) => log('[groups] 取登录信息失败：' + (error?.message ?? error)));
  } catch (error) { log('[groups] 取登录信息失败：' + (error?.message ?? error)); }

  const ws = new OneBotWS({
    url: found.wsUrl,
    accessToken: found.wsToken,
    log,
    reconnect: true,
    onEvent: async (ev) => {
      stats.events += 1;
      stats.lastEventAt = Date.now();
      const key = `${ev?.post_type ?? '?'}/${ev?.meta_event_type ?? ev?.message_type ?? ev?.notice_type ?? ''}`;
      stats.byType[key] = (stats.byType[key] || 0) + 1;
      if (ev?.post_type === 'message') {
        stats.messages += 1;
        if (cfg.logEvents) {
          const text = (ev.message ?? []).map((s) => (s.type === 'text' ? String(s.data?.text ?? '') : `[${s.type}]`)).join('').slice(0, 80);
          log(`收到消息 ${ev.message_type} from ${ev.user_id ?? ev.group_id}: ${text}`);
        }
        // 第 2 步：满足条件才真的回复（默认关，避免和 bridge 双回）
        const fromOwner = cfg.ownerQQ ? String(ev.user_id) === String(cfg.ownerQQ) : false;
        // 解析段落：文本走 textOf，图片先落本地
        const segs = fromOneBot(ev.message);
        const text = textOf(ev);
        let imagePaths = [];
        const imgs = imagesOf(segs);
        if (imgs.length) {
          try {
            imagePaths = await downloadImages(imgs, { log });
            if (imagePaths.length) log('[media] 收到图片 ' + imagePaths.length + ' 张 → ' + imagePaths[0]);
          } catch (error) { log('[media] 落图失败：' + (error?.message ?? error)); }
        }
        const prefBase = cfg.triggerPrefix ? String(cfg.triggerPrefix).trim() : '';
        const prefixOk = prefBase ? (text === prefBase || text.startsWith(prefBase)) : true;
        const messageOk = ev.message_type === 'private' && fromOwner && text && prefixOk;

        // ── 群聊（P1）：白名单 → 触发判定 → 冷却 → 入群队列 ──
        if (ev.message_type === 'group') {
          const groupId = String(ev.group_id ?? '');
          const senderId = String(ev.user_id ?? '');
          const senderName = ev.sender?.card || ev.sender?.nickname || senderId;
          if (!botQQ || senderId !== botQQ) {
            const d = decideGroupReply({ cfg, groupId, botQQ, segments: segs, text });
            if (d.reply) {
              const gc = groupsConfig(cfg);
              const gate = gateGroupRate({ groupId, cooldownSeconds: gc.cooldownSeconds, maxPerHour: gc.maxPerHour });
              if (gate.ok) {
                const gb = groupBatchers.get(groupId) || batcher;
                const result = gb.push(text || '[图片]', {
                  kind: 'group', groupId, userId: Number(senderId), senderName,
                  msgId: ev.message_id ?? ev.message_seq ?? '', key: 'group:' + groupId, imagePaths,
                  atMe: d.reason === 'at',
                });
                log('群消息入队（' + result + '）群 ' + groupId + ' 来自 ' + senderName + '（' + d.reason + '）');
              } else {
                log('群消息跳过：' + gate.reason + (gate.waitSec ? '(' + gate.waitSec + 's)' : ''));
              }
            } else if (cfg.logEvents && groupsConfig(cfg).enabled) {
              log('群消息不接（' + d.reason + '）群 ' + groupId);
            }
          }
          return;
        }
        if (cfg.enableReply && messageOk) {
          const cleanBase = cfg.triggerPrefix ? String(cfg.triggerPrefix).trim() : '';
          let clean = cleanBase ? text.slice(cleanBase.length).trim() : text;
          if (!clean) clean = '（只发了测试前缀，没写内容——回一句自然的招呼就行）';
          if (await handleScreenCommand(clean)) return;
          const result = batcher.push(clean, { userId: Number(ev.user_id), msgId: ev.message_id ?? ev.message_seq ?? '', key, imagePaths });
          log(`消息入队（${result}）：${clean.slice(0, 40)}`);
        } else if (cfg.logEvents && stats.events <= 30) {
          log(`消息未触发回复（enableReply=${cfg.enableReply} 私聊=${ev.message_type === 'private'} 来自主人=${fromOwner} 前缀=${prefixOk}）`);
        }
      } else if (cfg.logEvents && stats.events <= 30) {
        log(`事件 ${key}`);
      }
    },
  });

  // WS 看门狗：每 30 秒检查一次，断了就重连（SnowLuma 可能比 DSH 后启动）
  const wsWatchdog = setInterval(() => {
    try {
      if (ws.connected) return;
      log('[ws] 看门狗：连接不在，尝试重连');
      ws.connect().catch((error) => log('[ws] 重连失败：' + (error?.message ?? error)));
    } catch (error) { log('[ws] 看门狗异常：' + (error?.message ?? error)); }
  }, 30000);
  wsWatchdog.unref?.();

  ws.connect().then(() => {
    stats.connectedAt = Date.now();
    log('WS 已连接');
    // 自测开关：QQ_NATIVE_SELFTEST=1 时，连上后自动走一遍完整回复链路（会真的发到 owner QQ）
    // dry-run 合成图片事件：QQ_NATIVE_DRYRUN=1 QQ_NATIVE_FAKE_IMAGE=<路径>
    if (process.env.QQ_NATIVE_DRYRUN === '1' && process.env.QQ_NATIVE_FAKE_IMAGE) {
      const fakePath = process.env.QQ_NATIVE_FAKE_IMAGE;
      setTimeout(() => {
        log('[dryrun] 合成一条带图片的私聊事件：' + fakePath);
        Promise.resolve(ws.onEvent({
          post_type: 'message', message_type: 'private', user_id: Number(cfg.ownerQQ), self_id: Number(botQQ) || Number(cfg.ownerQQ),
          message_id: 'fake-' + Date.now(),
          message: [
            { type: 'text', data: { text: '（离线测试）看看这张图' } },
            { type: 'image', data: { file: fakePath } },
          ],
        })).catch((error) => log('[dryrun] 合成事件失败：' + (error?.message ?? error)));
      }, 3000);
    }
    if (process.env.QQ_NATIVE_SELFTEST === '1' || process.env.QQ_NATIVE_SELFTEST === '2') {
      const two = process.env.QQ_NATIVE_SELFTEST === '2';
      setTimeout(() => {
        log('[selftest] 模拟收到消息' + (two ? '（两条，间隔 700ms）' : ''));
        const r1 = batcher.push('自测：我今天有点累', { userId: Number(cfg.ownerQQ), msgId: 'selftest-a-' + Date.now() });
        log('[selftest] 第一条入队：' + r1);
        if (two) {
          setTimeout(() => {
            const r2 = batcher.push('自测：还有数学作业没写', { userId: Number(cfg.ownerQQ), msgId: 'selftest-b-' + Date.now() });
            log('[selftest] 第二条入队：' + r2);
          }, 700);
        }
      }, 3000);
    }
  }).catch((error) => {
    log(`WS 连接失败：${error?.message ?? error}`);
  });

  // 每 5 分钟报一次存活
  const timer = setInterval(() => {
    const upMin = stats.connectedAt ? Math.round((Date.now() - stats.connectedAt) / 60000) : 0;
    log(`存活 ${upMin} 分钟 · 事件 ${stats.events} · 消息 ${stats.messages} · WS=${ws.ready ? '已连接' : '断开'}`);
  }, 5 * 60 * 1000);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    try { stopSchedulers?.(); } catch { /* ignore */ }
    try { stopStats?.(); } catch { /* ignore */ }
    try { stopScreenWatch?.(); } catch { /* ignore */ }
    ws.close();
    log('已停止');
  };
}




