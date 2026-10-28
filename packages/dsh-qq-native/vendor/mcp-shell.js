#!/usr/bin/env node
// mcp-shell.js —— L4「探索模式」的执行工具（命令 + 文件读写）
//
// 唯一的闸门：~/.dsh/qq-personal/capabilities.json 里 explore === true
//   · 关着 → 所有调用直接拒绝，并提示"只有主人能开"
//   · 开着 → 执行，但仍有危险命令拦截 + 全程日志
//
// 工具：
//   shell_run(command, timeoutMs?)   跑一条 PowerShell 命令，返回 stdout+stderr
//   file_write(path, content)        写文本文件（覆盖）
//   file_append(path, content)       追加
//   shell_which(name)                查命令/程序是否存在（探索用）
//
// 日志：~/.dsh/qq-personal/explore.log（时间、命令、退出码、输出前 500 字）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CAP_FILE = path.join(os.homedir(), '.dsh', 'qq-personal', 'capabilities.json');
const LOG_FILE = path.join(os.homedir(), '.dsh', 'qq-native', 'state', 'explore.log');
const MAX_OUTPUT = 8000;
const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT = 120000;

function readShellCaps() {
  try {
    let raw = fs.readFileSync(CAP_FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    return {
      explore: j?.explore === true,
      panic: Number(j?.panic) || 0,
      autonomous: ['readonly', 'full'].includes(j?.autonomous) ? j.autonomous : 'off',
    };
  } catch {
    return { explore: false, panic: 0, autonomous: 'off' };
  }
}
function exploreOn() {
  const c = readShellCaps();
  return c.explore === true && !c.panic;
}

function logLine(kind, text, extra = {}) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), kind, text: String(text).slice(0, 2000), ...extra });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    // 日志上限 2MB：超了砍掉前一半
    const st = fs.statSync(LOG_FILE);
    if (st.size > 2 * 1024 * 1024) {
      const all = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/);
      fs.writeFileSync(LOG_FILE, all.slice(Math.floor(all.length / 2)).join('\n'), 'utf8');
    }
  } catch { /* 日志失败不影响执行 */ }
}

// 危险命令：默认拒绝（不是安全边界，是"别一键把电脑搞坏"）
const DENY_PATTERNS = [
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bbcdedit\b/i,
  /\bcipher\s+\/w/i,
  /\bvssadmin\b/i,
  /\breagentc\b/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
  /\breg\s+delete\b/i,
  /\bregedit\b/i,
  /\bnet\s+user\s+\S+\s+\S+/i,
  /\bnet\s+localgroup\b/i,
  /\btakeown\b/i,
  /\bicacls\b/i,
  /\bRemove-Item\b[^\n]*-Recurse[^\n]*(-Force)?\s+[A-Za-z]:\\(Windows|Program Files|Users)$/i,
  /\brm\s+-rf\s+\/(\s|$)/i,
  /\bdel\s+\/[sfq]+\s+[a-z]:\\\s*$/i,
  /\bcertutil\b[^\n]*-urlcache/i,
  /\bInvoke-WebRequest\b[^\n]*\|\s*iex/i,
  /\biex\b/i,
];

function checkDanger(cmd) {
  for (const re of DENY_PATTERNS) if (re.test(cmd)) return `命中危险命令规则（${re.source.slice(0, 40)}…），已拒绝。真的要做请主人手动执行。`;
  return null;
}

function runPowerShell(command, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = Math.min(MAX_TIMEOUT, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT));
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (error && !stdout ? String(error.message ?? '') : ''),
          killed: Boolean(error && error.killed),
        });
      }
    );
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: String(err?.message ?? err), killed: false }));
  });
}

function clip(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_OUTPUT) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_OUTPUT) + `\n…（输出过长，已截断；原长 ${s.length} 字符）`, truncated: true };
}

const server = new McpServer({ name: 'shell', version: '1.0.0' });

// L5 只读模式下禁止的写操作命令（近似判断：宁可拒错，不放过）
const WRITE_CMD_RE = /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|del\s|rd\s|mkdir\s|rmdir\s|taskkill|Stop-Process|Start-Process|Invoke-WebRequest\s+[^\n]*-OutFile|git\s+(commit|push|reset|checkout)|npm\s+(install|i\s)|pip\s+install|winget\s+install|choco\s+install)\b/i;
const WRITE_REDIRECT_RE = /(^|[^>])>(>|\s|$)/;

function gate() {
  const caps = readShellCaps();
  if (caps.panic) {
    return {
      content: [{ type: 'text', text: '⛔ 紧急停止中：所有电脑操作被禁用。要恢复请主人在管理台「权限」页点「解除紧急停止」。' }],
      isError: true,
    };
  }
  if (!caps.explore) {
    return {
      content: [{
        type: 'text',
        text: '探索模式没开。\n说明：她的电脑执行权限由主人在 QQ 管理台「权限」页手动开启（L4）。\n如果确实需要，让主人去打开，或者先申请 L2/L3。',
      }],
      isError: true,
    };
  }
  return null;
}

server.tool(
  'shell_run',
  '在电脑上执行一条 PowerShell 命令并返回输出（仅当「探索模式」由主人开启时可用）。适合查看文件、跑脚本、查系统信息。危险命令（格式化/关机/改注册表等）会被拒绝。',
  {
    command: z.string().describe('要执行的 PowerShell 命令'),
    timeoutMs: z.number().optional().describe('超时毫秒，默认 30000，上限 120000'),
  },
  async ({ command, timeoutMs }) => {
    const blocked = gate();
    if (blocked) return blocked;
    const cmd = String(command ?? '').trim();
    if (!cmd) return { content: [{ type: 'text', text: '命令为空' }], isError: true };
    if (readShellCaps().autonomous === 'readonly' && (WRITE_CMD_RE.test(cmd) || WRITE_REDIRECT_RE.test(cmd.replace(/^\s*#.*$/gm, '')))) {
      logLine('run-denied', cmd, { reason: 'l5 readonly' });
      return { content: [{ type: 'text', text: '现在处于「自主探索·只读」模式：只能看，不能写/改/删/装。要动手请主人把 L5 调到全自主。' }], isError: true };
    }
    const danger = checkDanger(cmd);
    if (danger) {
      logLine('run-denied', cmd, { reason: danger });
      return { content: [{ type: 'text', text: danger }], isError: true };
    }
    const r = await runPowerShell(cmd, timeoutMs);
    logLine('run', cmd, { code: r.code, timeout: r.killed });
    const out = clip(`exit=${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`.trim());
    return { content: [{ type: 'text', text: out.text }], isError: r.code !== 0 };
  }
);

server.tool(
  'file_write',
  '写文本文件（覆盖已有内容；仅探索模式开启时可用）。目录不存在会自动创建。',
  {
    path: z.string().describe('文件绝对路径'),
    content: z.string().describe('要写入的文本'),
  },
  async ({ path: filePath, content }) => {
    const blocked = gate();
    if (blocked) return blocked;
    if (readShellCaps().autonomous === 'readonly') {
      logLine('write-denied', String(filePath), { reason: 'l5 readonly' });
      return { content: [{ type: 'text', text: '现在处于「自主探索·只读」模式，不能写文件。要写请主人把 L5 调到全自主，或手动开 L4。' }], isError: true };
    }
    try {
      const abs = path.resolve(String(filePath));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content ?? ''), 'utf8');
      logLine('write', abs, { bytes: Buffer.byteLength(String(content ?? ''), 'utf8') });
      return { content: [{ type: 'text', text: `已写入 ${abs}（${Buffer.byteLength(String(content ?? ''), 'utf8')} 字节）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'file_append',
  '往文件末尾追加文本（文件不存在则创建；仅探索模式开启时可用）。',
  {
    path: z.string().describe('文件绝对路径'),
    content: z.string().describe('要追加的文本'),
  },
  async ({ path: filePath, content }) => {
    const blocked = gate();
    if (blocked) return blocked;
    if (readShellCaps().autonomous === 'readonly') {
      logLine('append-denied', String(filePath), { reason: 'l5 readonly' });
      return { content: [{ type: 'text', text: '现在处于「自主探索·只读」模式，不能写文件。' }], isError: true };
    }
    try {
      const abs = path.resolve(String(filePath));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, String(content ?? ''), 'utf8');
      logLine('append', abs, { bytes: Buffer.byteLength(String(content ?? ''), 'utf8') });
      return { content: [{ type: 'text', text: `已追加到 ${abs}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `追加失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'shell_which',
  '查一个命令/程序是否存在、在哪（探索用；仅探索模式开启时可用）。',
  { name: z.string().describe('命令或程序名，例如 git、python、code') },
  async ({ name }) => {
    const blocked = gate();
    if (blocked) return blocked;
    const target = String(name ?? '').trim();
    if (!target) return { content: [{ type: 'text', text: '名称为空' }], isError: true };
    const r = await runPowerShell(`$c = Get-Command '${target.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; if ($c) { $c | Select-Object -First 3 | ForEach-Object { $_.Source } } else { 'not found' }`, 10000);
    return { content: [{ type: 'text', text: clip(r.stdout || r.stderr).text }] };
  }
);

await server.connect(new StdioServerTransport());
