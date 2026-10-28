// screenwatch.mjs —— 持续看屏幕（**只读**：只截图，绝不移动鼠标/点击/打字）
//
// 设计目标：
//   · 定时截图 → 算指纹 → 只有画面变了才处理（省 token / 省 IO）
//   · 只读：本模块没有任何输入注入代码
//   · 可随时关：config.screenWatch.enabled / 或 STOP 文件
//   · 产物：~/.dsh/qq-native/screen/latest.png + screen/watch.jsonl（变化记录）
//
// 注意：截图用 PowerShell + System.Drawing.CopyFromScreen（Windows 自带，无依赖）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const DIR = () => path.join(os.homedir(), '.dsh', 'qq-native', 'screen');
const LATEST = () => path.join(DIR(), 'latest.png');
const LOG = () => path.join(DIR(), 'watch.jsonl');

// 找可用的 PowerShell（子进程 PATH 里可能没有 pwsh）
const POWERSHELL = (() => {
  const candidates = [
    'C:/Program Files/PowerShell/7/pwsh.exe',
    'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* next */ } }
  return 'powershell.exe';
})();

/** 截一张全屏 PNG，返回 { file, bytes, width, height, hash } */
export async function captureScreen({ timeoutMs = 20000 } = {}) {
  const dir = DIR();
  fs.mkdirSync(dir, { recursive: true });
  const file = LATEST();
  const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ($b.Width.ToString() + 'x' + $b.Height.ToString())
`;
  const out = await new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 300)));
      else resolve(String(stdout).trim());
    });
  });
  const buf = fs.readFileSync(file);
  const [w, h] = String(out).split('x').map((n) => Number(n) || 0);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  return { file, bytes: buf.length, width: w, height: h, hash };
}

function appendLog(entry) {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.appendFileSync(LOG(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR(), 'state.json'), 'utf8'));
  } catch { return { lastHash: '', lastAt: 0, changes: 0, lastChangeAt: 0 }; }
}

function writeState(s) {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.writeFileSync(path.join(DIR(), 'state.json'), JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/**
 * 启动持续看屏幕。
 *   enabled(): 返回 false 就暂停（例如 STOP 文件存在）
 *   onChange(shot): 画面变化时回调（后续接"让她看一眼"）
 */
export function startScreenWatch({ intervalMs = 60 * 1000, enabled = () => true, onChange = async () => {}, log = () => {} } = {}) {
  let timer = null;
  let busy = false;

  const tick = async () => {
    if (busy) return;
    if (!enabled()) return;
    busy = true;
    try {
      const shot = await captureScreen();
      const st = readState();
      const changed = shot.hash !== st.lastHash;
      const next = {
        lastHash: shot.hash,
        lastAt: Date.now(),
        changes: st.changes + (changed ? 1 : 0),
        lastChangeAt: changed ? Date.now() : st.lastChangeAt,
      };
      writeState(next);
      if (changed) {
        appendLog({ type: 'change', hash: shot.hash, bytes: shot.bytes, size: shot.width + 'x' + shot.height });
        log(`[screen] 画面变化（${shot.width}x${shot.height}，${Math.round(shot.bytes / 1024)} KB）`);
        await onChange(shot);
      }
    } catch (error) {
      log('[screen] 截图失败：' + (error?.message ?? error));
    } finally {
      busy = false;
    }
  };

  timer = setInterval(tick, Math.max(15000, Number(intervalMs) || 60000));
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

/** 追加一条观察（眼睛看到的描述） */
export function appendObservation({ text, hash, source = 'eyes' } = {}) {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.appendFileSync(path.join(DIR(), 'observations.jsonl'), JSON.stringify({ at: Date.now(), hash, source, text: String(text).slice(0, 800) }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** 读最近的观察（注入聊天 prompt 用） */
export function readObservations({ limit = 2, maxAgeMs = 30 * 60 * 1000 } = {}) {
  try {
    const lines = fs.readFileSync(path.join(DIR(), 'observations.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const now = Date.now();
    return lines.slice(-limit * 3)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o) => o && now - Number(o.at) < maxAgeMs)
      .slice(-limit);
  } catch { return []; }
}

/** 读最近的变化记录（管理台/调试用） */
export function readScreenStatus({ limit = 20 } = {}) {
  const st = readState();
  let lines = [];
  try {
    lines = fs.readFileSync(LOG(), 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit);
  } catch { /* none */ }
  return {
    enabled: fs.existsSync(path.join(DIR(), 'enabled')),
    lastHash: st.lastHash,
    lastAt: st.lastAt,
    changes: st.changes,
    lastChangeAt: st.lastChangeAt,
    recent: lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean),
    latestFile: LATEST(),
    latestExists: fs.existsSync(LATEST()),
  };
}
