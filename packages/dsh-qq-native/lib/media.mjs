// media.mjs —— 媒体落地：把 QQ 消息里的图片/文件下载到本地，交给 agent 用 read_image 看
//
// 为什么需要：这个 DSH 版本的 session/prompt 不接受图片内容块（实测被网关拒绝），
// 所以走「下载到本地 → prompt 告诉路径 → agent 调 read_image 工具看」这条路。
//
// 安全：所有媒体只写 ~/.dsh/qq-native/media/，守卫只允许 read_image 读这个目录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MEDIA_DIR = () => path.join(os.homedir(), '.dsh', 'qq-native', 'media');

export function mediaDir() {
  const d = MEDIA_DIR();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function extOf(file) {
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(file || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}

function safeName(seed, ext) {
  const h = crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 16);
  return h + (ext || '.png');
}

/**
 * 把 OneBot 图片段落成本地文件。
 * 支持：http(s) URL、base64://、本地绝对路径、file://
 * 返回本地路径；失败返回 ''。
 */
export async function downloadImage(seg, { log = () => {} } = {}) {
  const file = String(seg?.file ?? '').trim();
  if (!file) return '';
  try {
    const dir = mediaDir();
    const name = safeName(file, extOf(file));

    if (file.startsWith('base64://')) {
      const out = path.join(dir, name);
      fs.writeFileSync(out, Buffer.from(file.slice('base64://'.length), 'base64'));
      return out;
    }
    if (file.startsWith('file://')) {
      const src = decodeURIComponent(file.slice('file://'.length));
      const out = path.join(dir, name);
      if (fs.existsSync(src)) { fs.copyFileSync(src, out); return out; }
      return '';
    }
    if (/^https?:\/\//i.test(file)) {
      const res = await fetch(file, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { log(`[media] 下载失败 HTTP ${res.status}`); return ''; }
      const buf = Buffer.from(await res.arrayBuffer());
      const out = path.join(dir, name + (extOf(file) ? '' : '.png'));
      fs.writeFileSync(out, buf);
      return out;
    }
    // 本地绝对路径（测试/本地图片）
    if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('/')) {
      if (!fs.existsSync(file)) return '';
      const out = path.join(dir, name);
      fs.copyFileSync(file, out);
      return out;
    }
    log('[media] 不认识的图片地址：' + file.slice(0, 80));
    return '';
  } catch (error) {
    log('[media] 下载异常：' + (error?.message ?? error));
    return '';
  }
}

/** 批量落图，返回本地路径数组 */
export async function downloadImages(segs, { log = () => {}, limit = 4 } = {}) {
  const out = [];
  for (const s of (segs || []).slice(0, limit)) {
    const p = await downloadImage(s, { log });
    if (p) out.push(p);
  }
  return out;
}

/** 清理旧媒体（默认保留 3 天） */
export function pruneMedia({ days = 3 } = {}) {
  try {
    const dir = MEDIA_DIR();
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - days * 86400000;
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); n += 1; }
      } catch { /* ignore */ }
    }
    return n;
  } catch { return 0; }
}
