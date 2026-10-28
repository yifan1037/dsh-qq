/**
 * dsh-qq-personal — DSH host plugin for a QQ personal-account bridge.
 *
 * What it owns
 * ------------
 * DSH already speaks to QQ through `qq-bridge` (a separate Node process, legacy:
 * SnowLuma OneBot v11 WebSocket on one side, the DSH HTTP/RPC API on the other).
 * That process is battle-tested but it is a daemon the user has to remember to
 * start, and its three user-facing knobs — the group whitelist, the
 * chat/closed-agent mode, and the persona card — live in three different files.
 *
 * This plugin makes those knobs first-class DSH plugin settings and owns the
 * bridge lifecycle:
 *
 *   ~/.dsh/qq-personal/settings.json   <- the only file a user edits
 *        mode / ownerQQ / allowPrivate / allowGroups / agentPreset / persona
 *                 |
 *                 v  (applied on load and whenever the file changes)
 *   <bridge>/config.json          (allow lists, owner, preset, session cwd)
 *   <bridge>/state/mode.json      ({ mode, closedAgentPreset })
 *   <bridge>/roles/<name>.md      (persona card text)
 *   <bridge>/state/current-role.json ({ role, mode: "active" })
 *   <bridge>/config.json dsh.baseUrl <- the live DSH web port, discovered
 *                 |
 *                 v
 *   node <bridge>/src/bridge.js  (child process, restarted on crash,
 *                                  stopped when this plugin is disposed)
 *
 * The plugin registers no agent tools on purpose: a host-plane row that
 * registers tools fights the web surface's per-session preset composition (the
 * documented failure is `tool "x" is already registered`). Its only jobs are
 * configuration, port discovery and process supervision.
 *
 * @module dsh-qq-personal
 */

'use strict';

const { spawn, execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watchFile, unwatchFile, writeFileSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const net = require('node:net');

const { startConsole } = require('./console.cjs');

const name = 'dsh-qq-personal';

/** No required services: `ctx.logger` and `ctx.effect` are both optional here. */
const inject = [];

const DEFAULTS = {
  enabled: true,
  bridgeDir: '',
  nodePath: '',
  settingsPath: '',
  autoStart: true,
  consolePort: 3101,
};

const PREFERRED_PERSONA = '';
const LEAN_PERSONA = '';

/**
 * The user-edited settings file, with defaults that match this machine.
 *
 */
function defaultSettings() {
  const persona = existsSync(PREFERRED_PERSONA)
    ? { name: '助手', file: PREFERRED_PERSONA, fullFile: PREFERRED_PERSONA, text: '' }
    : { name: '', file: '', fullFile: '', text: '' };
  return {
    version: 1,
    mode: 'chat',
    ownerQQ: 10001,
    allowPrivate: [10001],
    allowGroups: [],
    agentPreset: 'qq-chat',
    workMode: false,
    sessionCwd: '',
    roleMaxInjectChars: 20000,
      // 电脑操作总开关（QQ 管理台 → 高级）：关闭时 computer/computer_batch 不可用
      desktopTools: false,
    // ── 省 token：QQ 上下文裁剪（移植自 QQ Agent token-saver）──
    contextPerMessageChars: 400,   // 单条上下文最多多少字（0=不限）
    contextKeepRecent: 12,         // 只保留最近几条完整内容（0=用 bridge 的 contextWindow）
    contextDigestChars: 300,       // 更早消息压摘要的字符预算（0=不摘要）
    reasoningEffort: 'high',
    model: 'deepseek-flash',
      // 左侧栏「SnowLuma」按钮用的安装目录（含 node.exe 与 index.mjs）
      snowlumaDir: '<path>',
    // 群聊响应档位（QQ Agent 语义，0~100）：
    //   0-10 仅 @ / 叫名字 / 引用机器人   10-20 再加关键词
    //   20-90 再加随机接话（概率线性）    90-100 白名单群内全响应
    groupTierSlider: 95,
    groupTierOverrides: {},
    groupMuted: [],
    tierKeywords: ['助手', 'deepseek', 'ds', '在吗'],
    persona,
    notes: {
      mode: 'chat = 白名单群/私聊安全聊天；closed-agent = 仅 owner 私聊，使用 DSH 默认 preset（完整工具）',
      allowGroups: '群号写在这里才会接群消息',
      groupTierSlider: 'QQ Agent 响应档位：0-10 仅@、10-20 +关键词、20-90 +概率、90-100 全响应；groupTierOverrides 按群覆盖',
      persona: 'persona.file = 每条消息注入的人格卡；persona.fullFile = 完整卡',
      reasoningEffort: 'high = 更聪明但更费思考 token',
      contextPerMessageChars: '省 token：单条 QQ 消息进上下文时的字符上限（0=不限）',
      contextKeepRecent: '省 token：只保留最近几条完整上下文，更早的压成一行摘要',
      contextDigestChars: '省 token：更早消息摘要的字符预算（0=不生成摘要，直接丢弃）',
      desktopTools: '是否允许 QQ 会话调用电脑操作（computer / computer_batch）；关闭更省 token，重启 DSH 后工具描述彻底消失',
    },
  };
}

/** QQ Agent 的响应档位换算（与 qq-bridge/src/chat-gate.mjs 保持一致）。 */
function sliderToTier(pos) {
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return { tier: 4, randomPercent: 100 };
  const p = Math.min(100, Math.max(0, raw));
  if (p <= 10) return { tier: 1, randomPercent: 0 };
  if (p <= 20) return { tier: 2, randomPercent: 0 };
  if (p <= 90) return { tier: 3, randomPercent: Math.round(((p - 20) / 70) * 1000) / 10 };
  return { tier: 4, randomPercent: 100 };
}

/** Build the per-group response gate file the bridge consults. */
function buildChatGate(settings) {
  const clampPos = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback;
  };
  const defaultSliderPos = clampPos(settings.groupTierSlider, 95);
  const overrides = settings.groupTierOverrides && typeof settings.groupTierOverrides === 'object'
    ? settings.groupTierOverrides
    : {};
  const muted = new Set(Array.isArray(settings.groupMuted) ? settings.groupMuted.map(String) : []);
  const keywords = Array.isArray(settings.tierKeywords)
    ? settings.tierKeywords.map((k) => String(k).trim()).filter((k) => k.length > 0)
    : [];
  const groups = {};
  for (const groupId of Array.isArray(settings.allowGroups) ? settings.allowGroups : []) {
    const id = String(groupId);
    const sliderPos = clampPos(overrides[id], defaultSliderPos);
    groups[id] = {
      sliderPos,
      tier: sliderToTier(sliderPos).tier,
      randomPercent: sliderToTier(sliderPos).randomPercent,
      keywords,
      muted: muted.has(id),
    };
  }
  return {
    version: 1,
    defaultSliderPos,
    keywords,
    // 人格名也算“叫到它”：QQ Agent 的 1 档除了 @ 也认名字。
    aliases: typeof settings.persona?.name === 'string' && settings.persona.name.trim().length > 0
      ? [settings.persona.name.trim()]
      : [],
    groups,
  };
}


function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/** Random token for the local management console. */
function generateToken() {
  const { randomBytes } = require('node:crypto');
  return randomBytes(24).toString('hex');
}

/** Last `lines` lines of a text file (missing file => empty). */
function tailFile(file, lines) {
  try {
    const content = readFileSync(file, 'utf8');
    const all = content.split(/\r?\n/);
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  } catch {
    return '';
  }
}

/** Resolve true when something is listening on 127.0.0.1:port. */
function portOpen(port, timeoutMs = 400) {
  return new Promise((resolvePort) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open) => {
      socket.destroy();
      resolvePort(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Discover the DSH desktop web port.
 *
 * The desktop host binds a RANDOM loopback port per launch, so the bridge's
 * `dsh.baseUrl` cannot be hard-coded. Only one port is owned by a
 * `DeepSeek Harness` process and answers HTTP; an unauthenticated GET / answers
 * 401 because the web surface is cookie-guarded. We probe candidates rather than
 * trusting the first listener (a future host may open IPC ports too).
 *
 * @returns {Promise<number|null>}
 */
async function discoverDshPort(log, options = {}) {
  const exclude = new Set(
    (Array.isArray(options.excludePorts) ? options.excludePorts : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  );
  let listeners = [];
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    listeners = out
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].startsWith('127.0.0.1:'))
      .map((cols) => ({ port: Number(cols[1].split(':').pop()), pid: Number(cols[4]) }))
      .filter((entry) => Number.isInteger(entry.port) && Number.isInteger(entry.pid))
      // Ports we already know are OURS (the management console lives in the same
      // host process and answers 401 like the web surface does — without this
      // exclusion discovery picks the console and the bridge talks to itself).
      .filter((entry) => !exclude.has(entry.port));
  } catch (error) {
    log?.warn?.(`dsh-qq-personal: netstat failed: ${error.message}`);
    return null;
  }

  let dshPids = new Set();
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    for (const line of out.split(/\r?\n/)) {
      const match = /^"DeepSeek Harness\.exe","(\d+)"/.exec(line.trim());
      if (match) dshPids.add(Number(match[1]));
    }
  } catch (error) {
    log?.warn?.(`dsh-qq-personal: tasklist failed: ${error.message}`);
  }

  const candidates = listeners.filter((entry) => dshPids.size === 0 || dshPids.has(entry.pid));
  for (const candidate of candidates) {
    try {
      const response = await fetch(`http://127.0.0.1:${candidate.port}/`, { redirect: 'manual' });
      if (response.status === 200 || response.status === 401) return candidate.port;
    } catch {
      // not the web surface
    }
  }
  log?.warn?.(`dsh-qq-personal: no DSH web port found among ${candidates.map((c) => c.port).join(', ') || '(none)'}`);
  return null;
}

/** Resolve persona card text from settings.persona (`text` > `file` > 人设库 / roles 目录同名卡). */
function resolvePersonaText(persona, bridgeDir) {
  if (!persona || typeof persona !== 'object') return null;
  if (typeof persona.text === 'string' && persona.text.trim().length > 0) return persona.text.trim();
  const candidates = [];
  if (typeof persona.file === 'string' && persona.file.trim().length > 0) candidates.push(resolve(persona.file.trim()));
  const name = typeof persona.name === 'string' ? persona.name.trim() : '';
  if (name.length > 0) {
    if (bridgeDir) candidates.push(join(bridgeDir, 'roles', `${name}.md`));
    candidates.push(join(homedir(), '.dsh', 'qq-personal', 'personas', `${name}.md`));
  }
  for (const candidate of candidates) {
    try {
      const text = readFileSync(candidate, 'utf8').trim();
      if (text.length > 0) return text;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Sanitise a persona name into a Windows-safe roles/<name>.md base name. */
function safeRoleName(name, fallback) {
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 40);
  if (cleaned.length === 0 || reserved.test(cleaned) || cleaned.toUpperCase() === 'README') return fallback;
  return cleaned;
}

/**
 * Apply the user-facing settings onto the qq-bridge checkout.
 *
 * @param options.settings - parsed settings.json
 * @param options.bridgeDir - bridge checkout
 * @param options.dshPort - live DSH web port
 * @param options.log - logger
 * @returns {object} what was applied, for logging
 */
function applyToBridge({ settings, bridgeDir, dshPort, log }) {
  const configPath = join(bridgeDir, 'config.json');
  const examplePath = join(bridgeDir, 'config.example.json');
  if (!existsSync(configPath)) {
    if (!existsSync(examplePath)) throw new Error(`qq-bridge config missing: ${configPath}`);
    writeText(configPath, readFileSync(examplePath, 'utf8'));
    log?.info?.(`dsh-qq-personal: created <bridge>/config.json from config.example.json`);
  }

  const config = readJson(configPath, null);
  if (!config || typeof config !== 'object') throw new Error(`qq-bridge config is not valid JSON: ${configPath}`);

  if (dshPort) config.dsh = { ...(config.dsh ?? {}), baseUrl: `http://127.0.0.1:${dshPort}` };
  const EFFORTS = new Set(['off', 'low', 'medium', 'high', 'max']);
  const wantedEffort = settings.reasoningEffort;
  if (typeof wantedEffort === 'string' && EFFORTS.has(wantedEffort)) {
    config.dsh = { ...(config.dsh ?? {}), reasoningEffort: wantedEffort };
  }
  if (typeof settings.model === 'string' && settings.model.trim().length > 0) {
    config.dsh = { ...(config.dsh ?? {}), model: settings.model.trim() };
  }
  config.ownerQQ = Number.isFinite(Number(settings.ownerQQ)) && Number(settings.ownerQQ) > 0
    ? Number(settings.ownerQQ)
    : null;
  config.allow = {
    ...(config.allow ?? {}),
    private: Array.isArray(settings.allowPrivate) ? settings.allowPrivate.map(Number).filter(Number.isFinite) : [],
    groups: Array.isArray(settings.allowGroups) ? settings.allowGroups.map(Number).filter(Number.isFinite) : [],
  };
  config.deny = { ...(config.deny ?? {}), private: [], groups: [] };
  config.allowAllWhenEmpty = false;
  config.agentPreset = typeof settings.agentPreset === 'string' && settings.agentPreset.trim().length > 0
    ? settings.agentPreset.trim()
    : 'qq-chat';

    // [patch] 工作模式：切到 qq-work preset（挂 pwsh / fs / fs-search / todo）
    config.agentPresetV2 = settings.workMode === true ? 'qq-work' : 'qq-chat-v2';
  const roleMax = Number(settings.roleMaxInjectChars);
  config.role = {
    ...(config.role ?? {}),
    maxInjectChars: Number.isFinite(roleMax) ? Math.min(20000, Math.max(1000, Math.round(roleMax))) : 20000,
  };
  // ── 省 token：上下文裁剪参数下发到 bridge 的 social 段 ──
  const ctxKnobs = {
    contextPerMessageChars: Number(settings.contextPerMessageChars),
    contextKeepRecent: Number(settings.contextKeepRecent),
    contextDigestChars: Number(settings.contextDigestChars),
  };
  config.social = { ...(config.social ?? {}) };
  for (const [k, v] of Object.entries(ctxKnobs)) {
    if (Number.isFinite(v)) config.social[k] = Math.min(4000, Math.max(0, Math.round(v)));
  }
  if (typeof settings.sessionCwd === 'string' && settings.sessionCwd.trim().length > 0) {
    config.sessionCwd = settings.sessionCwd.trim();
  }
  // [patch] 控制台令牌同步：控制台（本插件 3101）用 settings.consoleToken 去查桥接，
  // 而桥接用自己的 config.consoleToken / state/console-token。两者不一致时控制台恒 401，
  // 页面就会一直显示「桥接未运行」，但桥接其实活着。以 settings 为唯一来源写进 config。
  const sharedConsoleToken = String(settings.consoleToken ?? '').trim();
  if (/^[A-Za-z0-9_-]{16,128}$/.test(sharedConsoleToken)) config.consoleToken = sharedConsoleToken;
  writeJson(configPath, config);

  // Mode: the bridge reads DSH settings first, then state/mode.json. There is no
  // qq-mode settings namespace in this setup, so mode.json is authoritative.
  // [patch] 支持二代仿真模式：此前只认 chat / closed-agent，DSH 重启会把 reserved2 改回 closed-agent。
  const MODE_INPUT_ALIASES = { chat: 'chat', 'closed-agent': 'closed-agent', reserved: 'reserved', reserved2: 'reserved2', simulation: 'reserved2' };
  const normalizeModeInput = (value) => (typeof value === 'string' && MODE_INPUT_ALIASES[value.trim()]) || 'chat';
  const mode = normalizeModeInput(settings.mode);
  writeJson(join(bridgeDir, 'state', 'mode.json'), { mode, closedAgentPreset: '' });

  // Persona: roles/<name>.md + state/current-role.json ({ role, mode: active }).
  // [patch] 省 token 模式已移除：人设卡固定使用用户选择的完整版。
  const effectivePersona = settings.persona;
  const personaText = resolvePersonaText(effectivePersona, bridgeDir);
  let roleApplied = null;
  if (personaText) {
    const roleName = safeRoleName(effectivePersona?.name, 'qq-persona');
    writeText(join(bridgeDir, 'roles', `${roleName}.md`), `${personaText}\n`);
    writeJson(join(bridgeDir, 'state', 'current-role.json'), { role: roleName, mode: 'active' });
    roleApplied = roleName;
  } else {
    writeJson(join(bridgeDir, 'state', 'current-role.json'), { role: null, mode: 'active' });
  }

  // Group response gate (QQ Agent tier semantics). The bridge reads this file on
  // every group message; without it the upstream behaviour (respond to every
  // whitelisted message) is unchanged.
  const chatGate = buildChatGate(settings);
  writeJson(join(bridgeDir, 'state', 'chat-gate.json'), chatGate);

  return {
    baseUrl: config.dsh?.baseUrl ?? null,
    mode,
    ownerQQ: config.ownerQQ,
    allowPrivate: config.allow.private,
    allowGroups: config.allow.groups,
    agentPreset: config.agentPreset,
    persona: roleApplied,
    reasoningEffort: config.dsh?.reasoningEffort ?? null,
    groupTiers: Object.fromEntries(Object.entries(chatGate.groups).map(([id, rule]) => [id, rule.tier])),
  };
}

/**
 * Mount the plugin.
 *
 * @param ctx - host registrant context (logger / effect / get are optional).
 * @param config - loader config from cordis.patch.yml.
 */
function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  const log = {
    info: (message) => ctx?.logger?.info?.(message),
    warn: (message) => ctx?.logger?.warn?.(message),
    error: (message) => ctx?.logger?.error?.(message),
  };

  if (cfg.enabled === false) {
    log.info('dsh-qq-personal: disabled by configuration');
    return;
  }

  const bridgeDir = resolve(String(cfg.bridgeDir ?? '').trim());
  const nodePath = resolve(String(cfg.nodePath ?? '').trim());
  if (!existsSync(join(bridgeDir, 'src', 'bridge.js'))) {
    throw new Error(`dsh-qq-personal: qq-bridge not found at ${bridgeDir} (expected src/bridge.js)`);
  }
  if (!existsSync(nodePath)) {
    throw new Error(`dsh-qq-personal: node runtime not found at ${nodePath}`);
  }

  const settingsPath = cfg.settingsPath && String(cfg.settingsPath).trim().length > 0
    ? resolve(String(cfg.settingsPath).trim())
    : join(homedir(), '.dsh', 'qq-personal', 'settings.json');

  if (!existsSync(settingsPath)) {
    writeJson(settingsPath, defaultSettings());
    log.info(`dsh-qq-personal: created ${settingsPath} with defaults — edit it to change group whitelist / mode / persona`);
  }

  const stateDir = join(homedir(), '.dsh', 'qq-personal');
  mkdirSync(stateDir, { recursive: true });

  // The management console requires a token: generate one on first use and keep
  // it in settings.json so the shortcut script can build the URL.
  let initialSettings = readJson(settingsPath, null) ?? defaultSettings();
  if (typeof initialSettings.consoleToken !== 'string' || initialSettings.consoleToken.length < 16) {
    initialSettings = { ...initialSettings, consoleToken: generateToken() };
    writeJson(settingsPath, initialSettings);
  }
  const consoleToken = initialSettings.consoleToken;
  let consolePort = Number(cfg.consolePort);
  if (!Number.isFinite(consolePort) || consolePort <= 0 || consolePort > 65535) consolePort = 3101;

  /** One child at a time, restarted on unexpected exit. */
  let child = null;
  let disposed = false;
  let restartTimer = null;
  let restartAttempts = 0;
  let lastApplied = null;
  let bridgeLog = null;
  let lastDshPort = null;
  let consoleServer = null;

  const bridgeLogFile = () => join(stateDir, `bridge-${new Date().toISOString().slice(0, 10)}.log`);

  const appendBridgeLog = (stream, chunk) => {
    const file = bridgeLogFile();
    if (!bridgeLog || bridgeLog !== file) bridgeLog = file;
    try {
      mkdirSync(stateDir, { recursive: true });
      require('node:fs').appendFileSync(file, chunk);
    } catch {
      // logging must never break supervision
    }
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      stream === 'err' ? log.warn(`[qq-bridge] ${line}`) : log.info(`[qq-bridge] ${line}`);
    }
  };

  const stopChild = () => {
    if (!child) return;
    const pid = child.pid;
    child = null;
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } catch {
      // already gone
    }
    // The bridge writes state/bridge.lock when it starts; a hard kill leaves it
    // behind. Remove it only when it still names the pid we just killed — the
    // next start must not trip over a stale lock.
    const lockFile = join(bridgeDir, 'state', 'bridge.lock');
    try {
      if (Number(readFileSync(lockFile, 'utf8').trim()) === pid) {
        require('node:fs').rmSync(lockFile, { force: true });
        log.info(`dsh-qq-personal: removed stale bridge lock for pid ${pid}`);
      }
    } catch {
      // no lock file
    }
  };

  /**
   * The bridge takes a single-instance lock in `state/bridge.lock` (the file
   * holds its pid). A bridge left over from an earlier manual start — or from a
   * previous DSH run — would otherwise make every child exit with code 2 and the
   * supervisor restart forever. This plugin owns the bridge, so a live lock
   * holder is stopped before the new instance starts.
   */
  const stopStaleBridge = () => {
    const lockFile = join(bridgeDir, 'state', 'bridge.lock');
    let pid = null;
    try {
      pid = Number(readFileSync(lockFile, 'utf8').trim());
    } catch {
      return;
    }
    if (!Number.isInteger(pid) || pid <= 0) return;
    let alive = false;
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      });
      alive = out.includes(`"${pid}"`);
    } catch {
      alive = false;
    }
    if (!alive) return;
    log.warn(`dsh-qq-personal: stopping stale qq-bridge pid ${pid} (lock file ${lockFile})`);
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    } catch (error) {
      log.warn(`dsh-qq-personal: could not stop stale bridge pid ${pid}: ${error.message}`);
    }
  };

  const startBridge = async (reason) => {
    if (disposed) return;
    restartTimer = null;

    let dshPort = null;
    try {
      dshPort = await discoverDshPort(log, { excludePorts: [consolePort] });
    } catch (error) {
      log.warn(`dsh-qq-personal: port discovery failed: ${error.message}`);
    }
    if (!dshPort) {
      log.warn('dsh-qq-personal: DSH web port not found yet; retrying in 5s');
      scheduleRestart('no-dsh-port', 5000);
      return;
    }

    lastDshPort = dshPort;

    let settings;
    try {
      settings = readJson(settingsPath, null);
      if (!settings || typeof settings !== 'object') throw new Error('settings file is not valid JSON');
      lastApplied = applyToBridge({ settings, bridgeDir, dshPort, log });
    } catch (error) {
      log.error(`dsh-qq-personal: cannot apply settings: ${error.message}`);
      scheduleRestart('bad-settings', 15000);
      return;
    }

    log.info(
      `dsh-qq-personal: starting bridge (${reason}) — mode=${lastApplied.mode} owner=${lastApplied.ownerQQ} ` +
        `private=[${lastApplied.allowPrivate.join(',')}] groups=[${lastApplied.allowGroups.join(',')}] ` +
        `persona=${lastApplied.persona ?? '(off)'} dsh=${lastApplied.baseUrl}`,
    );

    // [patch] SnowLuma 没起来就不启动桥接。
    // 原因：桥接比 SnowLuma 先启动时，OneBot WS 会连一次失败、之后不再恢复，
    // 表现为「消息到了 SnowLuma，但 agent 完全没反应」——直到手动重启桥接。
    const snowlumaPorts = (() => {
      try {
        const raw = readFileSync(join(bridgeDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
        const c = JSON.parse(raw)?.snowluma ?? {};
        const toPort = (u, fb) => { try { return Number(new URL(u).port) || fb; } catch { return fb; } };
        return { wsPort: toPort(String(c.wsUrl ?? 'ws://127.0.0.1:3011'), 3011), httpPort: toPort(String(c.httpUrl ?? 'http://127.0.0.1:3010'), 3010) };
      } catch { return null; }
    })();
    if (snowlumaPorts) {
      const [wsUp, httpUp] = await Promise.all([portOpen(snowlumaPorts.wsPort), portOpen(snowlumaPorts.httpPort)]);
      if (!wsUp && !httpUp) {
        log.info(`dsh-qq-personal: SnowLuma 未监听（${snowlumaPorts.wsPort}/${snowlumaPorts.httpPort}），等它起来再拉起桥接`);
        scheduleRestart('snowluma-down', 5000);
        return;
      }
    }
    stopStaleBridge();
    let spawnedChild = null;
    try {
      spawnedChild = spawn(nodePath, ['src/bridge.js'], {
        cwd: bridgeDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child = spawnedChild;
    } catch (error) {
      log.error(`dsh-qq-personal: spawn failed: ${error.message}`);
      scheduleRestart('spawn-failed', 10000);
      return;
    }

    spawnedChild.stdout?.on('data', (chunk) => appendBridgeLog('out', chunk));
    spawnedChild.stderr?.on('data', (chunk) => appendBridgeLog('err', chunk));
    spawnedChild.on('exit', (code, signal) => {
      log.warn(`dsh-qq-personal: bridge exited (code=${code} signal=${signal ?? 'none'})`);
      // [patch] 竞态修复：旧代码无条件 `child = null`。当旧实例的 exit 事件晚于新实例
      // 赋值（reconfigure / 重启重叠）时，会把**新**子进程的句柄清掉 —— 桥接明明活着，
      // 控制台却显示「桥接未运行」。只清理属于自己的那个句柄。
      if (child === spawnedChild) {
        child = null;
        if (!disposed) scheduleRestart('exited', 5000);
      }
    });
  };

  const scheduleRestart = (reason, delayMs) => {
    if (disposed || restartTimer) return;
    restartAttempts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startBridge(`restart:${reason}#${restartAttempts}`);
    }, delayMs);
    restartTimer.unref?.();
  };

  /** Re-apply settings and restart without waiting for a crash. */
  const reconfigure = (reason) => {
    if (disposed) return;
    log.info(`dsh-qq-personal: settings changed (${reason}); restarting bridge`);
    stopChild();
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    restartAttempts = 0;
    startBridge('reconfigure');
  };

  // Watch the settings file so editing it takes effect without restarting DSH.
  let lastMtime = 0;
  try {
    lastMtime = statSync(settingsPath).mtimeMs;
  } catch {
    // missing file: the initial start created it above
  }
  watchFile(settingsPath, { interval: 1000 }, (current) => {
    if (disposed) return;
    if (current.mtimeMs === lastMtime) return;
    lastMtime = current.mtimeMs;
    reconfigure('file-changed');
  });

  // [patch] SnowLuma 上线后自动拉起桥接；离线期间不跑，避免「连一次失败后静默失联」。
  {
    let snowlumaWasUp = null;
    const timer = setInterval(async () => {
      if (disposed) return;
      try {
        const raw = readFileSync(join(bridgeDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
        const c = JSON.parse(raw)?.snowluma ?? {};
        const toPort = (u, fb) => { try { return Number(new URL(u).port) || fb; } catch { return fb; } };
        const wsPort = toPort(String(c.wsUrl ?? 'ws://127.0.0.1:3011'), 3011);
        const httpPort = toPort(String(c.httpUrl ?? 'http://127.0.0.1:3010'), 3010);
        const [a, b] = await Promise.all([portOpen(wsPort), portOpen(httpPort)]);
        const up = a || b;
        if (up && snowlumaWasUp === false && !child) {
          log.info('dsh-qq-personal: SnowLuma 已上线，拉起桥接');
          startBridge('snowluma-up');
        }
        snowlumaWasUp = up;
      } catch { /* ignore */ }
    }, 15000);
    timer.unref?.();
  }

  if (cfg.autoStart !== false) {
    startBridge('plugin-load').catch((error) => log.error(`dsh-qq-personal: start failed: ${error.message}`));
  } else {
    log.info('dsh-qq-personal: autoStart=false; bridge not started');
  }

  // ---------------------------------------------------------------------------
  // Management console (separate window; see 打开QQ管理窗口.cmd)
  // ---------------------------------------------------------------------------
  const newestBridgeLogFile = () => {
    try {
      const files = readdirSync(stateDir)
        .filter((entry) => /^bridge-\d{4}-\d{2}-\d{2}\.log$/.test(entry))
        .sort();
      if (files.length > 0) return join(stateDir, files[files.length - 1]);
    } catch {
      // ignore
    }
    return bridgeLogFile();
  };

  const consoleState = async () => {
    const settings = readJson(settingsPath, null) ?? {};
    const bridgeConfig = readJson(join(bridgeDir, 'config.json'), {});
    const portFromUrl = (value, fallback) => {
      try {
        const parsedPort = Number(new URL(String(value ?? '')).port);
        return Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : fallback;
      } catch {
        return fallback;
      }
    };
    // OneBot endpoints live in the bridge config (the plugin does not own them)
    // and can differ from the historical 3000/3001 pair, so probe the configured
    // ports instead of assuming them.
    const wsPort = portFromUrl(bridgeConfig.snowluma?.wsUrl, 3001);
    const httpPort = portFromUrl(bridgeConfig.snowluma?.httpUrl, 3000);
    const [snowWs, snowHttp] = await Promise.all([portOpen(wsPort), portOpen(httpPort)]);
    const logFile = newestBridgeLogFile();
    // [patch] 状态判定加固：不再只看自己的子进程句柄。
    // 桥接一定占用控制台端口（绑不上会自己退出），所以「端口在听」等价于「桥接活着」；
    // 句柄因竞态丢失时（见 startBridge 的 exit 处理）这里也不会误报「未运行」。
    const bridgeConsolePort = Number(bridgeConfig.consolePort) || 3100;
    const bridgePortAlive = await portOpen(bridgeConsolePort);
    const lockPid = (() => {
      try {
        const value = Number(readFileSync(join(bridgeDir, 'state', 'bridge.lock'), 'utf8').trim());
        return Number.isInteger(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    })();
    return {
      settings,
      applied: lastApplied,
      bridge: {
        running: Boolean(child) || bridgePortAlive,
        pid: child?.pid ?? lockPid,
        portAlive: bridgePortAlive,
        logFile,
      },
      snowluma: { ws: snowWs, http: snowHttp, wsPort, httpPort },
      dshPort: lastDshPort,
      logFile,
    };
  };

  const saveSettingsFromConsole = async (next) => {
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('settings must be an object');
    const merged = { ...(readJson(settingsPath, null) ?? {}), ...next, consoleToken };
    writeJson(settingsPath, merged);
    try {
      lastMtime = statSync(settingsPath).mtimeMs;
    } catch {
      // ignore
    }
    reconfigure('console-save');
  };

  const restartFromConsole = async () => {
    stopChild();
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    restartAttempts = 0;
    await startBridge('console-restart');
  };

  const logTailForConsole = async (lines) => {
    const file = newestBridgeLogFile();
    return { text: tailFile(file, lines), file };
  };

  if (!disposed) {
    try {
      // ── 成本统计（成本面板用）──────────────────────────────────────────────
      // 数据源：state/token-usage.jsonl（桥接逐回合记账）+ 官方单价（元 / 百万 token）。
      // 只累计 k === 'turn' 的条目：base 是同回合的汇总行，一起加会翻倍。
      // ── 会话视图（仿 QQ Agent 的会话列表）──────────────────────────────
    // 数据源：token-usage.jsonl 按 key 聚合（只累计 k=turn，base 是汇总行会翻倍）、
    //        social-v2.json 的最后一条消息/未读、sessions.json 的模式与预设。
    const sessionsInfo = async () => {
      const PRICES = {
        'deepseek-flash': { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
        'deepseek-v4-flash': { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
        'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
      };
      let text = '';
      try { text = readFileSync(join(bridgeDir, 'state', 'token-usage.jsonl'), 'utf8'); }
      catch { return { error: '还没有用量记录（token-usage.jsonl 不存在）' }; }
      const agg = new Map();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (!j || j.k !== 'turn' || !j.key) continue;
        const p = PRICES[j.model] ?? PRICES['deepseek-flash'];
        const miss = Number(j.b?.cacheMiss) || 0;
        const hit = Number(j.b?.cacheHit) || 0;
        const out = Number(j.b?.output) || 0;
        const cost = (miss * p.cacheMiss + hit * p.cacheHit + out * p.output) / 1e6;
        const cur = agg.get(j.key) ?? { key: j.key, tokens: 0, cost: 0, turns: new Set(), lastAt: 0, miss: 0, hit: 0, out: 0 };
        cur.tokens += miss + hit + out;
        cur.cost += cost;
        cur.miss += miss; cur.hit += hit; cur.out += out;
        if (Number.isFinite(Number(j.turn))) cur.turns.add(Number(j.turn));
        cur.lastAt = Math.max(cur.lastAt, Number(j.t) || 0);
        agg.set(j.key, cur);
      }
      const readStateFile = (name, fallback) => {
        try { return JSON.parse(readFileSync(join(bridgeDir, 'state', name), 'utf8').replace(/^\uFEFF/, '')); }
        catch { return fallback; }
      };
      const social = readStateFile('social-v2.json', { conversations: {} });
      const sessions = readStateFile('sessions.json', { sessions: {}, sessionPolicies: {} });
      const list = [...agg.values()].map((a) => {
        const conv = social.conversations?.[a.key] ?? {};
        const recent = Array.isArray(conv.recentMessages) ? conv.recentMessages : [];
        const last = [...recent].reverse().find((m) => m && (m.text || m.plain)) ?? null;
        let policy = {};
        try { const v = JSON.parse(sessions.sessionPolicies?.[a.key] ?? 'null'); if (Array.isArray(v)) policy = { mode: v[0] || '', preset: v[1] || '' }; } catch {}
        const isPrivate = a.key.startsWith('private:');
        return {
          key: a.key,
          label: isPrivate ? `私聊 ${a.key.split(':')[1]}` : `群 ${a.key.split(':')[1]}`,
          tokens: a.tokens, cost: a.cost, rounds: a.turns.size,
          lastAt: a.lastAt || Number(conv.lastIncomingAt) || 0,
          summary: last ? String(last.text ?? last.plain ?? '').slice(0, 60) : '',
          unread: (conv.unread || []).length,
          mode: policy.mode || '', preset: policy.preset || '',
          sessionId: sessions.sessions?.[a.key] || '',
        };
      }).sort((x, y) => y.lastAt - x.lastAt);
      const total = list.reduce((s, x) => ({ tokens: s.tokens + x.tokens, cost: s.cost + x.cost, rounds: s.rounds + x.rounds }), { tokens: 0, cost: 0, rounds: 0 });
      return { list, total, note: '轮数 = 该会话里出现过的 turn 编号数；只统计桥接侧（DSH 桌面里的对话不计入）。' };
    };
    // ── 记忆库（独立存储，和 agent 印象分开）：管理台用 ─────────────────
    const loadMemoryStore = async () => {
      const file = join(bridgeDir, 'src', 'memory-store.js');
      const mod = await import('file:///' + file.replace(/\\/g, '/'));
      return mod.MemoryStore;
    };
    const memoryStats = async () => (await loadMemoryStore()).stats();
    const memoryList = async (q = {}) => (await loadMemoryStore()).list({ limit: Number(q.limit) || 50, kind: q.kind });
    const memorySearch = async (q = {}) => (await loadMemoryStore()).search({ query: q.query, tags: q.tags, kind: q.kind, sinceDays: q.sinceDays, limit: Number(q.limit) || 20 });
    const memoryAdd = async (body = {}) => (await loadMemoryStore()).add({ text: body.text, weight: body.weight, tags: body.tags, kind: body.kind, source: 'console' });
    const memoryUpdate = async (body = {}) => (await loadMemoryStore()).update(body.id, body);
    const memoryForget = async (body = {}) => (await loadMemoryStore()).forget(body.id);
    // ── 能力权限（L2 电脑操作 / L3 全盘只读 / L4 探索模式）──────────────
    const capsMod = async () => require(join(__dirname, 'capabilities.js'));
    const capabilityInfo = async () => {
      const m = await capsMod();
      return m.readCapabilities();
    };
    const capabilitySet = async (body = {}) => {
      const m = await capsMod();
      if (body.action === 'approve') return m.approvePending(body.by || 'admin');
      if (body.action === 'deny') return m.denyPending(body.by || 'admin');
      if (!body.name) throw new Error('缺少 name');
      return m.setCapability(body.name, body.value === true, body.by || 'admin', body.note || '');
    };
    const capabilityRequest = async (body = {}) => {
      const m = await capsMod();
      return m.requestCapability(body.name, body.note || '');
    };
    // ── L5 自主探索 + 紧急停止 + 探索记录 ────────────────────────────
    const l5Set = async (body = {}) => (await capsMod()).setL5Config(body.patch ?? body, body.by || 'console');
    const panicNow = async (body = {}) => (await capsMod()).panicOn(body.reason || '手动紧急停止', body.by || 'console');
    const panicReset = async () => (await capsMod()).panicOff('console');
    const exploreActivity = async () => {
      const dir = join(homedir(), '.dsh', 'qq-personal');
      const readLines = (name, max) => {
        try {
          const raw = readFileSync(join(dir, name), 'utf8');
          return raw.split(/\r?\n/).filter(Boolean).slice(-max).map((l) => { try { return JSON.parse(l); } catch { return { raw: l.slice(0, 300) }; } });
        } catch { return []; }
      };
      const caps = await (await capsMod()).readCapabilities();
      return {
        capabilities: caps,
        runs: readLines('l5-runs.jsonl', 120).reverse(),
        shellLog: readLines('explore.log', 120).reverse(),
      };
    };
    // ── 任务队列（跨轮长任务）────────────────────────────────────────
    const tasksMod = () => require(join(__dirname, 'tasks.js'));
    const tasksInfo = async () => {
      const m = tasksMod();
      return { stats: m.stats(), tasks: m.list({ limit: 100 }) };
    };
    const tasksAction = async (body = {}) => {
      const m = tasksMod();
      const id = String(body.id || '');
      if (body.action === 'pause') return m.pause(id, '管理台暂停');
      if (body.action === 'resume') return m.resume(id);
      if (body.action === 'cancel') return m.cancel(id, '管理台取消');
      throw new Error('未知动作：' + body.action);
    };
    const costInfo = async () => {
        const PRICES = {
          'deepseek-flash': { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
          'deepseek-v4-flash': { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
          'deepseek-v4-flash-vision-exp': { cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4 },
          'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
          'deepseek-pro': { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
        };
        let text = '';
        try {
          text = readFileSync(join(bridgeDir, 'state', 'token-usage.jsonl'), 'utf8');
        } catch {
          return { error: '还没有用量记录（<bridge>/state/token-usage.jsonl 不存在）' };
        }
        const dayKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const days = new Map();
        let last = null;
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          if (!j || j.k !== 'turn' || !j.b) continue;
          const p = PRICES[j.model] ?? PRICES['deepseek-flash'];
          const miss = Number(j.b.cacheMiss) || 0;
          const hit = Number(j.b.cacheHit) || 0;
          const out = Number(j.b.output) || 0;
          const wr = Number(j.b.cacheWrite) || 0;
          const cost = (miss * p.cacheMiss + hit * p.cacheHit + out * p.output + wr * p.cacheWrite) / 1e6;
          const when = new Date(Number(j.t) || Date.now());
          const key = dayKey(when);
          const cur = days.get(key) ?? { date: key, cost: 0, steps: 0, miss: 0, hit: 0, out: 0 };
          cur.cost += cost; cur.steps += 1; cur.miss += miss; cur.hit += hit; cur.out += out;
          days.set(key, cur);
          last = { cost, at: when.toISOString(), miss, hit, out, model: String(j.model ?? '') };
        }
        const list = [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
        const today = days.get(dayKey(new Date())) ?? { date: dayKey(new Date()), cost: 0, steps: 0, miss: 0, hit: 0, out: 0 };
        let balance = null;
        try {
          const u = JSON.parse(readFileSync(join(homedir(), '.dsh', '.dshw-usage.json'), 'utf8'));
          if (typeof u.lastBalance === 'number') balance = u.lastBalance;
        } catch { /* ignore */ }
        return {
          today: { ...today, avg: today.steps ? today.cost / today.steps : 0 },
          days: list.slice(0, 14),
          last,
          balance,
          note: '只统计 QQ 桥接的回合；DSH 桌面里的对话不计入（可看余额差额）。',
        };
      };

      consoleServer = startConsole({
        port: consolePort,
        token: consoleToken,
        getState: consoleState,
        saveSettings: saveSettingsFromConsole,
        restartBridge: restartFromConsole,
        logTail: logTailForConsole,
          costInfo,
          sessionsInfo,
          memoryStats,
          capabilityInfo,
          capabilitySet,
          l5Set,
          panicNow,
          panicReset,
          exploreActivity,
          tasksInfo,
          tasksAction,
          memoryList,
          memorySearch,
          memoryAdd,
          memoryUpdate,
          memoryForget,
        log: (message) => log.info(`dsh-qq-personal: ${message}`),
      });
    } catch (error) {
      log.warn(`dsh-qq-personal: management console failed to start: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
    // ── SnowLuma 面板路由（人类点击启动；不注册为 AI 工具） ─────────────────────────
    //
    // 与 src/mcp-host-server.js 的取舍不同：那边删掉 start/stop 是为了不让**模型**
    // 自主拉起/结束 SnowLuma（EULA §5.4 的「通过自动化脚本部署」）。这里是用户在
    // 面板上亲手点的按钮，等价于双击 launcher.bat，且不注册成 agent 工具。
    if (typeof ctx?.inject === 'function') {
      try {
        ctx.inject(['webServer'], (webCtx) => {
          const loopbackOnly = (req, res) => {
            const host = String(req.headers?.host ?? '');
            if (/^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?$/i.test(host)) return true;
            res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('loopback only');
            return false;
          };
          const sendJson = (res, status, obj) => {
            const payload = JSON.stringify(obj);
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': String(Buffer.byteLength(payload)),
            });
            res.end(payload);
          };
          const portsOf = () => {
            try {
              // 防御 BOM：PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，
              // 而 JSON.parse 拒绝带 BOM 的文本（会导致这里静默回退成默认端口 3000/3001）。
              const cfg = (() => {
                try {
                  let raw = readFileSync(join(bridgeDir, 'config.json'), 'utf8');
                  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
                  return JSON.parse(raw);
                } catch { return {}; }
              })() || {};
              const toPort = (u, fallback) => { try { return Number(new URL(u).port) || fallback; } catch { return fallback; } };
              return {
                httpPort: toPort(String(cfg?.snowluma?.httpUrl ?? 'http://127.0.0.1:3010'), 3010),
                wsPort: toPort(String(cfg?.snowluma?.wsUrl ?? 'ws://127.0.0.1:3011'), 3011),
              };
            } catch { return { httpPort: 3010, wsPort: 3011 }; }
          };
          const dirOf = () => {
            const now = readJson(settingsPath, null) ?? defaultSettings();
            return String(now?.snowlumaDir ?? '').trim();
          };
          const statusOf = async () => {
            const { httpPort, wsPort } = portsOf();
            const [http, ws] = await Promise.all([portOpen(httpPort), portOpen(wsPort)]);
            const dir = dirOf();
            const nodeExe = dir ? join(dir, 'node.exe') : '';
            const entry = dir ? join(dir, 'index.mjs') : '';

            // [patch] 登录前 3010/3011 不会监听，但进程其实已经起来了；不把 WebUI 端口算进来，
            // 侧栏按钮会以为"没启动"，点几次就开出多个实例。
            const webuiPort = (() => {
              try {
                const raw = readFileSync(join(dir, 'config', 'runtime.json'), 'utf8').replace(/^\uFEFF/, '');
                const n = Number(JSON.parse(raw)?.webuiPort);
                return Number.isFinite(n) && n > 0 ? n : 0;
              } catch { return 0; }
            })();
            const webuiOnline = webuiPort ? await portOpen(webuiPort) : false;
            return {
              running: http || ws || webuiOnline, httpPort, wsPort, http, ws, webuiPort, webuiOnline,
              dir, hasDir: !!(dir && existsSync(dir)),
              hasNode: !!(nodeExe && existsSync(nodeExe)),
              hasEntry: !!(entry && existsSync(entry)),
              webUi: webuiOnline ? 'http://127.0.0.1:' + webuiPort : (http ? 'http://127.0.0.1:' + httpPort : ''),
            };
          };
          try {
            const disposeStatus = webCtx.webServer.register({
              kind: 'exact',
              path: '/api/dsh-qq-personal/snowluma-status',
              handler: (req, res) => {
                if (!loopbackOnly(req, res)) return;
                statusOf().then((s) => sendJson(res, 200, s)).catch((e) => sendJson(res, 500, { error: String(e?.message ?? e) }));
              },
            });
            const disposeStart = webCtx.webServer.register({
              kind: 'exact',
              path: '/api/dsh-qq-personal/snowluma-start',
              handler: (req, res) => {
                if (!loopbackOnly(req, res)) return;
                if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }); res.end('POST only'); return; }
                (async () => {
                  const s = await statusOf();
                  if (s.running) { sendJson(res, 200, { ok: true, alreadyRunning: true, hint: (!s.http && !s.ws && s.webuiOnline) ? ('已在运行但还没登录：打开 ' + s.webUi + ' 扫码') : '', ...s }); return; }
                  if (!s.hasDir) { sendJson(res, 400, { ok: false, error: 'snowlumaDir 不存在：请在 ~/.dsh/qq-personal/settings.json 里改 snowlumaDir' }); return; }
                  if (!s.hasNode || !s.hasEntry) { sendJson(res, 400, { ok: false, error: '目录里缺少 node.exe 或 index.mjs' }); return; }
                  try {
                    const child = spawn(join(s.dir, 'node.exe'), ['index.mjs'], {
                      cwd: s.dir, detached: true, stdio: 'ignore', windowsHide: true,
                    });
                    child.unref();
                    log.info(`dsh-qq-personal: 用户从侧栏启动 SnowLuma（pid ${child.pid}）`);
                    sendJson(res, 200, { ok: true, started: true, pid: child.pid });
                  } catch (error) {
                    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
                  }
                })().catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }));
              },
            });
            if (typeof webCtx.effect === 'function') {
              webCtx.effect(() => () => { disposeStatus(); disposeStart(); }, 'dsh-qq-personal snowluma routes');
            }
          } catch (error) {
            log.warn(`dsh-qq-personal: snowluma route failed: ${error.message}`);
          }
        });
      } catch (error) {
        log.warn(`dsh-qq-personal: snowluma inject failed: ${error.message}`);
      }
    }

  // Same-origin bootstrap route for the left-sidebar entry (lib/client.js).
  // The web UI cannot read %USERPROFILE%, so it asks the host where the console
  // lives and which token to pass. Loopback-only; DSH's own browser auth runs
  // first for /api routes.
  // ---------------------------------------------------------------------------
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['webServer'], (webCtx) => {
        try {
          const disposeRoute = webCtx.webServer.register({
            kind: 'exact',
            path: '/api/dsh-qq-personal/console-info',
            handler: (req, res) => {
              const host = String(req.headers?.host ?? '');
              const loopback = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?$/i.test(host);
              if (!loopback) {
                res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('loopback only');
                return;
              }
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' });
                res.end('GET only');
                return;
              }
              const payload = JSON.stringify({
                url: `http://127.0.0.1:${consolePort}/?token=${encodeURIComponent(consoleToken)}`,
                port: consolePort,
              });
              res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': String(Buffer.byteLength(payload)),
              });
              res.end(req.method === 'HEAD' ? '' : payload);
            },
          });
          if (typeof webCtx.effect === 'function') {
            webCtx.effect(() => disposeRoute, 'dsh-qq-personal console info route');
          }
        } catch (error) {
          log.warn(`dsh-qq-personal: console info route failed: ${error.message}`);
        }
      });
    } catch (error) {
      log.warn(`dsh-qq-personal: webServer injection failed: ${error.message}`);
    }
  }

  const dispose = () => {
    log.info('dsh-qq-personal: disposing; stopping bridge');
    disposed = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    try {
      unwatchFile(settingsPath);
    } catch {
      // ignore
    }
    if (consoleServer) {
      consoleServer.close().catch(() => {});
      consoleServer = null;
    }
    stopChild();
    log.info('dsh-qq-personal: disposed; bridge stopped');
  };

  // Cordis disposes plugins through ctx.effect; fall back to process hooks when a
  // bare context is used (tests / debugging).
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-qq-personal.bridge-supervisor');
  } else {
    process.once('exit', dispose);
  }

  ctx.on?.('dispose', dispose);
}

module.exports = {
  name,
  inject,
  apply,
  // Exposed for tests/troubleshooting only; not part of the plugin contract.
  _internals: { discoverDshPort, applyToBridge },
};
