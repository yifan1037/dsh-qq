// onebot-segments.mjs —— OneBot v11 消息段编解码
//
// 统一内部表示（数组，顺序即消息顺序）：
//   { type: 'text',  text }
//   { type: 'image', file, subType? }          file: 路径 / URL / base64://
//   { type: 'face',  id }                       QQ 小黄脸
//   { type: 'at',    qq }                       qq='all' 表示 @全体
//   { type: 'reply', id }                       引用某条消息
//   { type: 'record', file }                    语音
//   { type: 'file',  file, name? }              文件
//   { type: 'poke',  qq }                       拍一拍（非标准段，内部动作）
//
// 收：OneBot 段数组 / CQ 码字符串 → 内部表示
// 发：内部表示 → OneBot 段数组 / CQ 码字符串

/** CQ 码转义（OneBot 规范） */
export function escapeCq(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

export function unescapeCq(text) {
  return String(text ?? '')
    .replace(/&#44;/g, ',')
    .replace(/&#93;/g, ']')
    .replace(/&#91;/g, '[')
    .replace(/&amp;/g, '&');
}

/** 内部段 → CQ 码字符串（发消息用字符串形式的协议端也可以） */
export function toCqCode(segments) {
  const parts = [];
  for (const seg of normalize(segments)) {
    if (seg.type === 'text') { parts.push(escapeCq(seg.text)); continue; }
    if (seg.type === 'at') { parts.push(`[CQ:at,qq=${seg.qq}]`); continue; }
    if (seg.type === 'reply') { parts.push(`[CQ:reply,id=${seg.id}]`); continue; }
    if (seg.type === 'face') { parts.push(`[CQ:face,id=${seg.id}]`); continue; }
    if (seg.type === 'image') {
      const extra = seg.subType ? `,sub_type=${seg.subType}` : '';
      parts.push(`[CQ:image,file=${escapeCq(seg.file)}${extra}]`);
      continue;
    }
    if (seg.type === 'record') { parts.push(`[CQ:record,file=${escapeCq(seg.file)}]`); continue; }
    if (seg.type === 'file') { parts.push(`[CQ:file,file=${escapeCq(seg.file)}${seg.name ? `,name=${escapeCq(seg.name)}` : ''}]`); continue; }
    // 未知类型丢弃，避免把非法段发给协议端
  }
  return parts.join('');
}

/** CQ 码字符串 → 内部段数组 */
export function fromCqCode(text) {
  const out = [];
  const src = String(text ?? '');
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) {
      const t = unescapeCq(src.slice(last, m.index));
      if (t) out.push({ type: 'text', text: t });
    }
    out.push(cqSegToInternal(m[1], parseParams(m[2])));
    last = re.lastIndex;
  }
  if (last < src.length) {
    const t = unescapeCq(src.slice(last));
    if (t) out.push({ type: 'text', text: t });
  }
  return out;
}

/** OneBot 段数组 → 内部段数组 */
export function fromOneBot(segments) {
  const out = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text') {
      const t = String(seg.data?.text ?? '');
      if (t) out.push({ type: 'text', text: t });
      continue;
    }
    out.push(cqSegToInternal(seg.type, seg.data || {}));
  }
  return out;
}

/** 内部段数组 → OneBot 段数组 */
export function toOneBot(segments) {
  const out = [];
  for (const seg of normalize(segments)) {
    if (seg.type === 'text') { out.push({ type: 'text', data: { text: seg.text } }); continue; }
    if (seg.type === 'at') { out.push({ type: 'at', data: { qq: String(seg.qq) } }); continue; }
    if (seg.type === 'reply') { out.push({ type: 'reply', data: { id: String(seg.id) } }); continue; }
    if (seg.type === 'face') { out.push({ type: 'face', data: { id: String(seg.id) } }); continue; }
    if (seg.type === 'image') { out.push({ type: 'image', data: { file: seg.file, ...(seg.subType ? { sub_type: seg.subType } : {}) } }); continue; }
    if (seg.type === 'record') { out.push({ type: 'record', data: { file: seg.file } }); continue; }
    if (seg.type === 'file') { out.push({ type: 'file', data: { file: seg.file, ...(seg.name ? { name: seg.name } : {}) } }); continue; }
  }
  return out;
}

/** 纯文本视图（给日志/摘要/记忆用） */
export function toPlainText(segments) {
  return normalize(segments).map((s) => {
    if (s.type === 'text') return s.text;
    if (s.type === 'at') return s.qq === 'all' ? '@全体' : `@${s.qq}`;
    if (s.type === 'image') return '[图片]';
    if (s.type === 'face') return '[表情]';
    if (s.type === 'record') return '[语音]';
    if (s.type === 'file') return `[文件:${s.name || s.file}]`;
    if (s.type === 'reply') return '';
    if (s.type === 'poke') return '[拍一拍]';
    return '';
  }).join('').trim();
}

/** 内部段数组清洗：合并相邻 text、丢弃空段、限制数量 */
export function normalize(segments, { maxSegments = 60 } = {}) {
  const out = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text') {
      const t = String(seg.text ?? '');
      if (!t) continue;
      const prev = out[out.length - 1];
      if (prev && prev.type === 'text') { prev.text += t; continue; }
      out.push({ type: 'text', text: t });
      continue;
    }
    if (seg.type === 'at') {
      if (seg.qq === undefined || seg.qq === null || seg.qq === '') continue;
      out.push({ type: 'at', qq: String(seg.qq) });
      continue;
    }
    if (seg.type === 'reply') {
      if (!seg.id) continue;
      out.push({ type: 'reply', id: String(seg.id) });
      continue;
    }
    if (seg.type === 'face') {
      if (!seg.id) continue;
      out.push({ type: 'face', id: String(seg.id) });
      continue;
    }
    if (seg.type === 'image' || seg.type === 'record' || seg.type === 'file') {
      if (!seg.file) continue;
      out.push({ type: seg.type, file: String(seg.file), ...(seg.name ? { name: String(seg.name) } : {}), ...(seg.subType ? { subType: String(seg.subType) } : {}) });
      continue;
    }
    if (seg.type === 'poke') {
      out.push({ type: 'poke', qq: String(seg.qq ?? '') });
      continue;
    }
  }
  return out.slice(0, maxSegments);
}

/** 取消息里第一条引用 id（回复用） */
export function firstReplyId(segments) {
  for (const s of segments || []) if (s.type === 'reply' && s.id) return String(s.id);
  return '';
}

/** 取消息里的图片段 */
export function imagesOf(segments) {
  return (segments || []).filter((s) => s.type === 'image' && s.file);
}

function parseParams(str) {
  const data = {};
  for (const kv of String(str || '').split(',').slice(1)) {
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    data[kv.slice(0, i)] = unescapeCq(kv.slice(i + 1));
  }
  return data;
}

function cqSegToInternal(type, data) {
  if (type === 'at') return { type: 'at', qq: String(data.qq ?? '') };
  if (type === 'reply') return { type: 'reply', id: String(data.id ?? '') };
  if (type === 'face') return { type: 'face', id: String(data.id ?? '') };
  if (type === 'image') return { type: 'image', file: String(data.file ?? ''), ...(data.sub_type ? { subType: String(data.sub_type) } : {}) };
  if (type === 'record') return { type: 'record', file: String(data.file ?? '') };
  if (type === 'file') return { type: 'file', file: String(data.file ?? ''), ...(data.name ? { name: String(data.name) } : {}) };
  // 未知段：保留成图片式占位，避免信息丢失导致文本错位
  if (type === 'mface' || type === 'dice' || type === 'rps') return { type: 'face', id: type };
  return { type: 'text', text: `[${type}]` };
}
