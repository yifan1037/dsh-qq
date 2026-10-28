/**
 * 纯 JS 的 PDF 文本抽取（无依赖，尽力而为）
 *
 * 核心改进（v2）：**按字体绑定 ToUnicode 映射**。
 * 一个 PDF 里每种字体有自己的字形→Unicode 表，混用会导致整篇串码；
 * 所以这里先解析对象，把字体资源名（F1/TT2…）各自对应的 CMap 建好，
 * 再在内容流里跟踪 `Tf` 操作符切换当前字体。
 *
 * 支持：文本型 PDF、FlateDecode、TrueType/Type0 的 ToUnicode、简单字体（直接 ASCII）。
 * 不支持：扫描件（无文本层，会明确报错）、加密 PDF（会明确报错）、内嵌字体的私有编码（无 ToUnicode 时只能退化）。
 */
import { inflateSync, inflateRawSync } from 'node:zlib';

function inflateMaybe(raw) {
  try { return inflateSync(raw); } catch { /* 试 raw */ }
  try { return inflateRawSync(raw); } catch { /* 放弃 */ }
  return null;
}

const hasFlate = (dict) => /\/FlateDecode/.test(dict);

/* ------------------------------------------------------------- 对象解析 */

/**
 * 扫描所有顶层对象：`N 0 obj ... endobj`，流对象按 /Length 或 endstream 切分。
 * @returns {Map<number, {dict:string, stream:Buffer|null, data:Buffer|null, text:string|null}>}
 */
function parseObjects(buf) {
  const latin = buf.toString('latin1');
  const objs = new Map();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;

  while ((m = re.exec(latin)) !== null) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endobjIdx = latin.indexOf('endobj', bodyStart);
    const streamIdx = latin.indexOf('stream', bodyStart);

    let dict, stream = null, data = null;

    if (streamIdx >= 0 && (endobjIdx < 0 || streamIdx < endobjIdx)) {
      dict = latin.slice(bodyStart, streamIdx).trim();
      let ds = streamIdx + 'stream'.length;
      if (latin[ds] === '\r') ds++;
      if (latin[ds] === '\n') ds++;

      let de = -1;
      // /Length 可能是直接数字，也可能是指向别的对象的间接引用（"9 0 R"）。
      // 间接引用时不能用它算边界，交给 endstream 搜索。
      const refM = /\/Length\s+(\d+)\s+\d+\s+R/.exec(dict);
      const numM = /\/Length\s+(\d+)/.exec(dict);
      if (numM && !refM) {
        const cand = ds + Number(numM[1]);
        if (cand <= buf.length && /^\s*endstream/.test(latin.slice(cand, cand + 24))) de = cand;
      }
      if (de < 0) {
        const es = latin.indexOf('endstream', ds);
        de = es < 0 ? Math.min(buf.length, ds) : es;
        while (de > ds && (buf[de - 1] === 0x0a || buf[de - 1] === 0x0d)) de--;
      }
      stream = buf.subarray(ds, de);
      data = /\/Filter/.test(dict) ? (hasFlate(dict) ? inflateMaybe(stream) : null) : Buffer.from(stream);
      // 让主循环跳过流内部，避免把二进制误当对象头
      re.lastIndex = Math.max(re.lastIndex, de);
    } else {
      dict = (endobjIdx < 0 ? latin.slice(bodyStart) : latin.slice(bodyStart, endobjIdx)).trim();
    }

    objs.set(num, { dict, stream, data, text: data ? data.toString('latin1') : null });
  }

  // 第二遍：解开「对象流」(ObjStm)。现代 PDF 常把字体字典、资源、目录压进对象流，
  // 只扫顶层 `N 0 obj` 会看不见它们（于是 /ToUnicode 也找不到，中文全成乱码）。
  for (const o of [...objs.values()]) {
    if (!/\/ObjStm/.test(o.dict) || !o.data) continue;
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1]);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1]);
    if (!Number.isFinite(n) || !Number.isFinite(first) || n <= 0) continue;

    const text = o.data.toString('latin1');
    const pairs = [...text.slice(0, first).matchAll(/(\d+)\s+(\d+)/g)]
      .slice(0, n)
      .map((x) => [Number(x[1]), Number(x[2])]);

    pairs.forEach(([onum, off], i) => {
      if (objs.has(onum)) return;                     // 顶层定义优先
      const start = first + off;
      const end = i + 1 < pairs.length ? first + pairs[i + 1][1] : text.length;
      const body = text.slice(start, end).trim();
      if (body) objs.set(onum, { dict: body, stream: null, data: null, text: null, inObjStm: true });
    });
  }

  return objs;
}

/* -------------------------------------------------------------- CMap 解析 */

function utf16beHexToStr(hex) {
  const h = hex.replace(/\s+/g, '');
  let s = '';
  for (let i = 0; i + 3 < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  if (h.length % 4 === 2) s += String.fromCharCode(parseInt(h.slice(-2), 16));
  return s;
}

/** 解析一段 ToUnicode CMap 文本。 */
function parseCMap(text) {
  const map = new Map();
  let bytesPerCode = null;

  for (const m of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    const first = /<([0-9a-fA-F]+)>/.exec(m[1]);
    if (first) bytesPerCode = Math.max(1, Math.ceil(first[1].length / 2));
  }
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(p[1], 16), utf16beHexToStr(p[2]));
    }
  }
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([\s\S]*?)\])/g)) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      if (r[4] !== undefined) {
        const items = [...r[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16beHexToStr(x[1]));
        items.forEach((s, i) => { if (lo + i <= hi) map.set(lo + i, s); });
      } else {
        const base = utf16beHexToStr(r[3]);
        const lastCode = base.length ? base.charCodeAt(base.length - 1) : 0;
        for (let c = lo; c <= hi && c - lo < 65536; c++) {
          map.set(c, base.slice(0, -1) + String.fromCharCode(lastCode + (c - lo)));
        }
      }
    }
  }
  return { map, bytesPerCode };
}

/* --------------------------------------------------- 字体资源 → CMap 表 */

/** 取一个 `<< ... >>` 字典的完整文本（从 start 处的 `<<` 起，返回含配对 >> 的子串）。 */
function sliceDict(latin, start) {
  let depth = 0, i = start;
  while (i < latin.length) {
    if (latin.startsWith('<<', i)) { depth++; i += 2; continue; }
    if (latin.startsWith('>>', i)) { depth--; i += 2; if (depth === 0) return latin.slice(start, i); continue; }
    i++;
  }
  return latin.slice(start);
}

/**
 * 从一段资源字典文本里解析 `/Font`，得到「字体资源名 → 字体对象号」。
 * 覆盖 `/Font << /F1 12 0 R >>` 与 `/Font 8 0 R` 两种写法。
 */
function fontNameToObj(dictText, objs) {
  const out = new Map();
  const take = (s) => {
    for (const m of s.matchAll(/\/([A-Za-z0-9#+._-]{1,32})\s+(\d+)\s+\d+\s+R/g)) out.set(m[1], Number(m[2]));
  };
  const inline = /\/Font\s*<</g;
  let m;
  while ((m = inline.exec(dictText)) !== null) take(sliceDict(dictText, m.index + m[0].length - 2));
  for (const m2 of dictText.matchAll(/\/Font\s+(\d+)\s+\d+\s+R/g)) {
    const o = objs.get(Number(m2[1]));
    if (o) take(o.dict);
  }
  return out;
}

/** 字体对象号 → { map, bytesPerCode }（没有 ToUnicode 就返回 null）。 */
function cmapOfFont(objNum, objs) {
  const o = objs.get(objNum);
  if (!o) return null;
  const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(o.dict);
  if (!ref) return null;
  const cm = objs.get(Number(ref[1]));
  if (!cm?.text) return null;
  const { map, bytesPerCode } = parseCMap(cm.text);
  return map.size ? { map, bytesPerCode } : null;
}

/** 把「字体名 → 对象号」变成「字体名 → CMap」。 */
function resolveFontCmaps(nameToObj, objs) {
  const m = new Map();
  for (const [name, num] of nameToObj) {
    const cm = cmapOfFont(num, objs);
    if (cm) m.set(name, cm);
  }
  return m;
}

/* ------------------------------------------------------------- 内容流解析 */

function parseLiteralString(src, start) {
  const bytes = [];
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const n = src[i + 1];
      if (n >= '0' && n <= '7') {
        let oct = ''; let j = i + 1;
        while (j < src.length && oct.length < 3 && src[j] >= '0' && src[j] <= '7') oct += src[j++];
        bytes.push(parseInt(oct, 8) & 0xff); i = j; continue;
      }
      const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (n in simple) { bytes.push(simple[n]); i += 2; continue; }
      if (n === '\n') { i += 2; continue; }
      if (n === '\r') { i += src[i + 2] === '\n' ? 3 : 2; continue; }
      bytes.push(n ? n.charCodeAt(0) : 92); i += 2; continue;
    }
    if (ch === ')') { i++; break; }
    bytes.push(ch.charCodeAt(0) & 0xff);
    i++;
  }
  return { bytes, next: i };
}

function decodeBytes(bytes, cm) {
  if (cm && cm.map.size) {
    const per = cm.bytesPerCode || (Math.max(...cm.map.keys()) > 0xff ? 2 : 1);
    let s = '';
    let hitCount = 0;
    for (let i = 0; i < bytes.length; i += per) {
      let code = 0;
      for (let k = 0; k < per; k++) code = (code << 8) | (bytes[i + k] ?? 0);
      const hit = cm.map.get(code);
      if (hit != null) { s += hit; hitCount++; }
    }
    if (hitCount) return s;
  }
  const allAscii = bytes.every((b) => b < 0x80);
  if (allAscii) return Buffer.from(bytes).toString('latin1');
  if (bytes.length % 2 === 0) {
    const guess = utf16beHexToStr(Buffer.from(bytes).toString('hex'));
    if (guess && !/[\u0000-\u0008\u000e-\u001f]/.test(guess)) return guess;
  }
  return Buffer.from(bytes).toString('latin1');
}

/** 从一段内容流里抽文本，按 Tf 切换字体映射。 */
function contentToText(content, fontCmaps, unionMap) {
  const src = content.toString('latin1');
  const out = [];
  const stack = [];
  // 初始字体未知：先用全局合并表，遇到 Tf 再切到本页对应字体的专属表
  let cm = unionMap ?? null;
  let i = 0;
  // 文本位置的纵坐标：只有换行才该断行，同一行的多个片段要接在一起。
  // （早先对每个 Td/TD/T* 都断行，导致一份 PPT 导出的 PDF 变成"一词一行"。）
  let curY = null;

  const decode = (bytes) => decodeBytes(bytes, cm ?? unionMap);

  const flushOp = (op, rawArgs) => {
    if (op === 'Tj' || op === "'" || op === '"') {
      const s = stack[stack.length - 1];
      if (typeof s === 'string') out.push(s);
      if (op === "'" || op === '"') out.push('\n');
    } else if (op === 'TJ') {
      const arr = stack[stack.length - 1];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string') out.push(item);
          else if (typeof item === 'number' && item < -180) out.push(' ');
        }
      }
    } else if (op === 'Td' || op === 'TD') {
      // Td/TD 的第二个参数是纵向位移：非 0 才算换行
      const m2 = /(-?[\d.]+)\s+(-?[\d.]+)\s*$/.exec(rawArgs);
      const ty = m2 ? parseFloat(m2[2]) : NaN;
      if (!Number.isFinite(ty) || ty !== 0) out.push('\n');
    } else if (op === 'Tm') {
      // Tm 的 f 分量是纵坐标：跨行才断
      const m2 = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/.exec(rawArgs);
      const f = m2 ? parseFloat(m2[6]) : NaN;
      if (Number.isFinite(f)) {
        if (curY !== null && Math.abs(f - curY) > 0.5) out.push('\n');
        curY = f;
      }
    } else if (op === 'T*') {
      out.push('\n');
    }
    // 注意：**不要**在 BT 重置 curY、也不要在 ET 断行。
    // 很多 PDF（PPT/设计工具导出）每个文字片段都是独立的 `BT … Tm … Tj ET`，
    // 在 ET 断行会让整篇变成"一词一行"；纵坐标要跨 BT 块比较才有意义。
    else if (op === 'Tf') {
      // 形如 `/F1 12 Tf`。rawArgs 是 Tf 之前的一小段，注意它本身不含 "Tf"，
      // 所以这里用「以数字结尾」来取字体名（早先写成要求结尾是 Tf，永远匹配不到）。
      const nm = /\/([A-Za-z0-9#+._-]{1,32})\s+[-+]?[\d.]+\s*$/.exec(rawArgs);
      if (nm) cm = fontCmaps?.get(nm[1]) ?? unionMap ?? null;
    }
    stack.length = 0;
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '(') {
      const { bytes, next } = parseLiteralString(src, i);
      stack.push(decode(bytes));
      i = next;
      continue;
    }
    if (ch === '<' && src[i + 1] !== '<') {
      const end = src.indexOf('>', i);
      if (end < 0) break;
      const hex = src.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
      const bytes = [];
      for (let k = 0; k + 1 < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
      if (hex.length % 2) bytes.push(parseInt(hex.slice(-1) + '0', 16));
      stack.push(decode(bytes));
      i = end + 1;
      continue;
    }
    if (ch === '[') {
      const arr = [];
      let j = i + 1;
      while (j < src.length && src[j] !== ']') {
        if (src[j] === '(') {
          const { bytes, next } = parseLiteralString(src, j);
          arr.push(decode(bytes)); j = next;
        } else if (src[j] === '<' && src[j + 1] !== '<') {
          const end = src.indexOf('>', j);
          if (end < 0) break;
          const hex = src.slice(j + 1, end).replace(/[^0-9a-fA-F]/g, '');
          const bytes = [];
          for (let k = 0; k + 1 < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
          arr.push(decode(bytes)); j = end + 1;
        } else {
          const num = /^-?\d+(\.\d+)?/.exec(src.slice(j));
          if (num) { arr.push(parseFloat(num[0])); j += num[0].length; } else j++;
        }
      }
      stack.push(arr);
      i = j + 1;
      continue;
    }
    if (ch === '%') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    const opMatch = /^[A-Za-z*'"]+/.exec(src.slice(i));
    if (opMatch) {
      const op = opMatch[0];
      const back = src.slice(Math.max(0, i - 80), i);
      flushOp(op, back);
      i += op.length;
      continue;
    }
    i++;
  }

  return out.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/* ------------------------------------------------------------- 质量评估 */

/** 判断抽出来的文本是否「像话」：字母/数字/CJK/常见标点的占比。 */
function textQuality(text) {
  if (!text) return 0;
  const good = (text.match(/[A-Za-z0-9\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\s.,;:!?'"()\-–—/\\%&*+=<>[\]{}@#$^_|~]/g) || []).length;
  return good / text.length;
}

/* ------------------------------------------------------------------ 对外 */

/** 供自测/排查用的内部函数出口（不参与运行逻辑）。 */
export const __internals = { parseObjects, fontNameToObj, resolveFontCmaps, contentToText, textQuality, parseCMap };

/**
 * 按「页」解析：每页用自己的资源字典里的字体表。
 * 这是关键——很多 PDF 里每种字体都是极小的子集（码位 1,2,3…），
 * 不同字体的同名资源（/F1…）在全局表里会互相覆盖，导致整篇串码。
 */
function extractPerPage(objs, latin, unionMap) {
  const pieces = [];
  let contentStreams = 0;
  let pagesUsed = 0;
  let fontsBound = 0;

  const pages = [];
  for (const [num, o] of objs) {
    if (/\/Type\s*\/Page(?!s)\b/.test(o.dict)) pages.push([num, o]);
  }

  for (const [, page] of pages) {
    // --- 资源字典 ---
    let resText = '';
    const resRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(page.dict);
    if (resRef) resText = objs.get(Number(resRef[1]))?.dict ?? '';
    else {
      const inline = /\/Resources\s*<</.exec(page.dict);
      if (inline) resText = sliceDict(page.dict, inline.index + inline[0].length - 2);
    }
    const pageFonts = resolveFontCmaps(fontNameToObj(resText || page.dict, objs), objs);
    fontsBound += pageFonts.size;

    // --- 内容流 ---
    const contentNums = [];
    const arrRef = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
    if (arrRef) {
      for (const m of arrRef[1].matchAll(/(\d+)\s+\d+\s+R/g)) contentNums.push(Number(m[1]));
    } else {
      const one = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(page.dict);
      if (one) contentNums.push(Number(one[1]));
    }

    if (!contentNums.length) continue;
    pagesUsed++;
    for (const cn of contentNums) {
      const co = objs.get(cn);
      if (!co || co.text == null) continue;
      contentStreams++;
      const srcBuf = co.data ?? Buffer.from(co.text, 'latin1');
      const t = contentToText(srcBuf, pageFonts, unionMap);
      if (t) pieces.push(t);
    }
  }

  return { pieces, contentStreams, pagesUsed, fontsBound, mode: 'per-page' };
}

/** 兜底：没有可识别的页对象时，扫全文件的内容流（字体表用全局合并）。 */
function extractGlobal(objs, unionMap) {
  const pieces = [];
  let contentStreams = 0;
  for (const o of objs.values()) {
    if (o.text == null) continue;
    if (/\/Subtype\s*\/(Image|XML|Metadata)/.test(o.dict)) continue;
    if (!/\bTj\b|\bTJ\b|\bTd\b|\bBT\b/.test(o.text)) continue;
    contentStreams++;
    const srcBuf = o.data ?? Buffer.from(o.text, 'latin1');
    const t = contentToText(srcBuf, null, unionMap);
    if (t) pieces.push(t);
  }
  return { pieces, contentStreams, pagesUsed: 0, fontsBound: unionMap.map.size, mode: 'global' };
}

export function pdfToText(buf) {
  if (/\/Encrypt\b/.test(buf.subarray(0, 8192).toString('latin1'))) {
    const e = new Error('这个 PDF 有加密（/Encrypt），无法抽取文本');
    e.code = 'PDF_ENCRYPTED';
    throw e;
  }

  const latin = buf.toString('latin1');
  const objs = parseObjects(buf);
  if (!objs.size) throw new Error('解析不出 PDF 对象（文件可能损坏）');

  // 全局合并映射（跨页兜底用）
  const unionMap = { map: new Map(), bytesPerCode: null };
  for (const o of objs.values()) {
    if (!/\/ToUnicode\s+\d+\s+\d+\s+R/.test(o.dict)) continue;
    const cm = cmapOfFont([...objs].find(([, x]) => x === o)?.[0], objs) ?? null;
    if (!cm) continue;
    for (const [k, v] of cm.map) if (!unionMap.map.has(k)) unionMap.map.set(k, v);
    if (unionMap.bytesPerCode == null && cm.bytesPerCode) unionMap.bytesPerCode = cm.bytesPerCode;
  }

  let r = extractPerPage(objs, latin, unionMap);
  if (!r.pieces.length) r = extractGlobal(objs, unionMap);

  const text = sanitizeText(r.pieces.join('\n\n'));

  if (!text) {
    const e = new Error('这个 PDF 没有可抽取的文本层（很可能是扫描件或纯图片 PDF），需要 OCR');
    e.code = 'PDF_NO_TEXT_LAYER';
    throw e;
  }

  const quality = textQuality(text);
  return {
    text,
    kind: 'pdf',
    meta: {
      mode: r.mode,
      pages: r.pagesUsed,
      contentStreams: r.contentStreams,
      fontsBound: r.fontsBound,
      cmapEntries: unionMap.map.size,
      quality: Number(quality.toFixed(2)),
      ...(quality < 0.8 ? { warn: '抽取质量偏低，可能是少见字体编码，请对内容保持怀疑' } : {}),
    },
  };
}

/**
 * 收尾清洗。
 * 为什么必须做：PDF 里常夹带 NUL 与控制字符（字体子集、符号字体残留），
 * 带着它们输出会让下游把整段文本当成**二进制**拒绝处理（实测：13 个 NUL 就触发）。
 * 私用区字符（U+E000–U+F8FF）一般是符号/项目符号，换成间隔号避免粘连词。
 */
export function sanitizeText(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\ue000-\uf8ff]+/g, '·')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
