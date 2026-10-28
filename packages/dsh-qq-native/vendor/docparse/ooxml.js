/**
 * Office Open XML 文本抽取：.docx / .xlsx / .pptx
 * 思路：它们都是 zip + XML，用正则做「够用的结构化抽取」，不引入 XML 依赖。
 * 取舍：只取正文文本（含表格、脚注），不做样式/图片/批注/修订痕迹还原。
 */
import { readZip } from './zip.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 反转义 XML 实体（含数字实体）。 */
export function unescapeXml(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return ENT[g.toLowerCase()] ?? m;
  });
}

const tidy = (s) => s
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/* ------------------------------------------------------------------ docx */

/**
 * 从 word/document.xml 这类 XML 里抽正文文本。
 * 处理：<w:t> 文本、<w:tab> 制表、<w:br> 换行、段落结束换行、表格单元格用制表符分隔。
 */
function docxXmlToText(xml) {
  let s = xml;
  // 丢掉修订删除的文本与域代码，避免混入“改前”内容
  s = s.replace(/<w:delText[\s\S]*?<\/w:delText>/g, '');
  s = s.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '');
  s = s.replace(/<w:del\b[\s\S]*?<\/w:del>/g, '');
  // 结构标记 → 控制字符
  s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t');
  s = s.replace(/<w:br\b[^>]*\/?>/g, '\n');
  s = s.replace(/<w:cr\b[^>]*\/?>/g, '\n');
  s = s.replace(/<\/w:tc>/g, '\t');
  s = s.replace(/<\/w:tr>/g, '\n');
  s = s.replace(/<\/w:p>/g, '\n');
  s = s.replace(/<w:t\b[^>]*>/g, '');
  // 其余标签一律去掉
  s = s.replace(/<[^>]+>/g, '');
  s = unescapeXml(s);
  // 行内以制表符结尾时收掉多余空白
  s = s.split('\n').map((line) => line.replace(/\t+$/, '')).join('\n');
  return tidy(s);
}

export function docxToText(buf) {
  const zip = readZip(buf);
  const main = zip.get('word/document.xml');
  if (!main) throw new Error('不是有效的 .docx（缺少 word/document.xml）');
  const parts = [docxXmlToText(main.toString('utf8'))];

  for (const extra of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const b = zip.get(extra);
    if (b) {
      const t = docxXmlToText(b.toString('utf8'));
      if (t) parts.push(extra.includes('foot') ? `\n[脚注]\n${t}` : `\n[尾注]\n${t}`);
    }
  }
  return { text: tidy(parts.filter(Boolean).join('\n')), kind: 'docx' };
}

/* ------------------------------------------------------------------ xlsx */

function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.match(/<si\b[\s\S]*?<\/si>/g) || []) {
    const texts = [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
    out.push(texts.join(''));
  }
  return out;
}

function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function xlsxToText(buf, { maxRowsPerSheet = 3000 } = {}) {
  const zip = readZip(buf);
  const shared = sharedStrings(zip.get('xl/sharedStrings.xml')?.toString('utf8'));

  // 表名：workbook.xml 的顺序 + 对应 rels 目标
  const names = [];
  const wb = zip.get('xl/workbook.xml')?.toString('utf8') || '';
  for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\/?>/g)) names.push(unescapeXml(m[1]));

  const sheetFiles = [...zip.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));

  const chunks = [];
  sheetFiles.forEach((file, si) => {
    const xml = zip.get(file).toString('utf8');
    const label = names[si] || `Sheet${si + 1}`;
    const lines = [];
    const rows = xml.match(/<row\b[\s\S]*?<\/row>/g) || [];
    for (const row of rows.slice(0, maxRowsPerSheet)) {
      const cells = [];
      for (const c of row.match(/<c\b[\s\S]*?(?:\/>|<\/c>)/g) || []) {
        const ref = /\br="([^"]+)"/.exec(c)?.[1] || '';
        const type = /\bt="([^"]+)"/.exec(c)?.[1] || '';
        let val = '';
        if (type === 'inlineStr') {
          val = [...c.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
        } else {
          const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(c)?.[1];
          if (v != null) val = type === 's' ? (shared[Number(v)] ?? '') : unescapeXml(v);
        }
        const idx = colToIndex(ref);
        while (cells.length < idx) cells.push('');
        cells[idx] = val.replace(/[\t\n]+/g, ' ');
      }
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line.trim()) lines.push(line);
    }
    chunks.push(`# ${label}\n${lines.join('\n')}`);
  });

  const text = tidy(chunks.join('\n\n'));
  if (!text) throw new Error('这个 .xlsx 里没抽到文本');
  return { text, kind: 'xlsx' };
}

/* ------------------------------------------------------------------ pptx */

export function pptxToText(buf) {
  const zip = readZip(buf);
  const files = [...zip.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  if (!files.length) throw new Error('不是有效的 .pptx（没找到幻灯片）');

  const chunks = files.map((f, i) => {
    const xml = zip.get(f).toString('utf8');
    const lines = [];
    for (const p of xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) || []) {
      const t = [...p.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1])).join('');
      if (t.trim()) lines.push(t.trim());
    }
    return `# 第 ${i + 1} 页\n${lines.join('\n')}`;
  });

  const text = tidy(chunks.join('\n\n'));
  if (!text) throw new Error('这个 .pptx 里没抽到文本');
  return { text, kind: 'pptx' };
}
