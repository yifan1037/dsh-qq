#!/usr/bin/env node
// mcp-files.js —— 本地文档读取 MCP server（给 DSH 的 QQ 会话用）
//
// 工具：
//   read_local_document(path, maxChars?)  读本地 docx/xlsx/pptx/pdf/txt/md/csv/json/log 等
//   list_local_dir(path?)                 列目录（看桌面上有什么）
//
// 安全（默认收紧，可用环境变量放宽）：
//   · 只允许读 Desktop / Documents / Downloads / deepseek-harness 工作区
//   · 拒绝凭据类文件（.credentials.yaml、id_rsa、*.pem、Cookies、Login Data、config.json…）
//   · 单文件 ≤ 50MB，返回文本默认 ≤ 20000 字符（超出截断并标注）
//   · QQ_FILES_ROOTS 可追加允许目录（分号分隔），QQ_FILES_DENY 可追加拒绝正则（分号分隔）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { docxToText, xlsxToText, pptxToText } from './docparse/ooxml.js';
import { pdfToText } from './docparse/pdf.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_CHARS_DEFAULT = 20000;
const MAX_CHARS_LIMIT = 120000;

const DENY_PATTERNS = [
  /\.credentials\.ya?ml$/i,
  /(^|[\\/])id_rsa/i,
  /(^|[\\/])id_ed25519/i,
  /\.pem$/i, /\.pfx$/i, /\.p12$/i, /\.key$/i,
  /(^|[\\/])cookies?$/i,
  /login data$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])config\.json$/i,   // 桥接/QQ Agent 的 config.json 里有 token
  /(^|[\\/])\.env(\.|$)/i,
];

function roots() {
  const home = os.homedir();
  const list = [
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents', 'deepseek-harness'),
  ];
  // [patch] L3 全盘只读：管理台「权限」页打开后，额外允许各盘符根（只读）。
  try {
    let raw = fs.readFileSync(path.join(home, '.dsh', 'qq-personal', 'capabilities.json'), 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    if (JSON.parse(raw)?.fullRead === true) {
      for (const drive of ['C:', 'D:', 'E:', 'F:']) {
        const root = drive + path.sep;
        if (fs.existsSync(root)) list.push(root);
      }
    }
  } catch { /* 没开就没开 */ }
  const extra = process.env.QQ_FILES_ROOTS;
  if (extra) for (const p of extra.split(';')) if (p.trim()) list.push(p.trim());
  return [...new Set(list.map((r) => path.resolve(r)).filter((r) => fs.existsSync(r)))];
}

function denyPatterns() {
  const extra = process.env.QQ_FILES_DENY;
  const list = [...DENY_PATTERNS];
  if (extra) for (const p of extra.split(';')) if (p.trim()) { try { list.push(new RegExp(p.trim(), 'i')); } catch { /* ignore bad regex */ } }
  return list;
}

function resolveSafe(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('缺少 path 参数');
  const abs = path.resolve(raw);
  if (denyPatterns().some((re) => re.test(abs))) {
    throw new Error('这个路径属于敏感文件/配置（可能含凭据），已拒绝读取。');
  }
  const rs = roots();
  const ok = rs.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!ok) throw new Error(`路径不在允许范围内。允许的目录：${rs.join(' ; ')}`);
  return abs;
}

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

function decodeText(buf) {
  const utf8 = stripBom(buf.toString('utf8'));
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf-8' };
  for (const enc of ['gbk', 'latin1']) {
    try { const t = stripBom(new TextDecoder(enc).decode(buf)); if (!t.includes('\uFFFD')) return { text: t, encoding: enc }; } catch { /* ignore */ }
  }
  return { text: utf8, encoding: 'utf-8(有损)' };
}

function extOf(p) { return path.extname(p).toLowerCase(); }

function parseDocument(abs) {
  const buf = fs.readFileSync(abs);
  const ext = extOf(abs);
  if (ext === '.pdf') {
    const r = pdfToText(buf);
    return { text: r.text, kind: 'pdf', meta: r.meta };
  }
  if (ext === '.docx') {
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('不是有效的 docx（ZIP 头缺失）');
    const r = docxToText(buf);
    return { text: r?.text ?? '', kind: 'docx', meta: r?.meta ?? null };
  }
  if (ext === '.xlsx') {
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('不是有效的 xlsx（ZIP 头缺失）');
    const r = xlsxToText(buf);
    return { text: r?.text ?? '', kind: 'xlsx', meta: r?.meta ?? null };
  }
  if (ext === '.pptx') {
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('不是有效的 pptx（ZIP 头缺失）');
    const r = pptxToText(buf);
    return { text: r?.text ?? '', kind: 'pptx', meta: r?.meta ?? null };
  }
  const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.ini', '.yml', '.yaml', '.xml', '.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.css', '.srt']);
  if (TEXT_EXT.has(ext) || ext === '') {
    const { text, encoding } = decodeText(buf);
    return { text, kind: 'text', meta: { encoding } };
  }
  if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
    throw new Error(`旧版 Office 格式（${ext}）不支持，请另存为 .docx/.xlsx/.pptx 再读。`);
  }
  throw new Error(`不认识的格式：${ext || '(无扩展名)'}。支持 pdf/docx/xlsx/pptx 与常见文本文件。`);
}

const server = new McpServer({ name: 'files', version: '1.0.0' });

server.tool(
  'read_local_document',
  '读取本机上的文档并返回文本。支持 pdf / docx / xlsx / pptx / txt / md / csv / json / log 等。'
    + '只能读 Desktop、Documents、Downloads 与 deepseek-harness 工作区内的文件；凭据类文件会被拒绝。',
  {
    path: z.string().describe('文件绝对路径，例如 C:\\Users\\<你>\\Documents\\报告.pdf'),
    maxChars: z.number().optional().describe('返回文本最多多少字符（默认 20000，上限 120000）'),
  },
  async ({ path: filePath, maxChars }) => {
    try {
      const abs = resolveSafe(filePath);
      const st = fs.statSync(abs);
      if (st.isDirectory()) throw new Error('这是一个目录，不是文件；要列目录请用 list_local_dir。');
      if (st.size > MAX_FILE_BYTES) throw new Error(`文件过大（${(st.size / 1048576).toFixed(1)} MB，上限 50 MB）。`);
      if (st.size === 0) throw new Error('文件是空的。');
      const parsed = parseDocument(abs);
      const cap = Math.min(MAX_CHARS_LIMIT, Math.max(500, Number(maxChars) || MAX_CHARS_DEFAULT));
      const text = String(parsed.text ?? '');
      const clipped = text.length > cap ? text.slice(0, cap) : text;
      const head = [
        `文件：${path.basename(abs)}`,
        `类型：${parsed.kind}  大小：${(st.size / 1024).toFixed(1)} KB  字符数：${text.length}`,
        parsed.meta ? `元信息：${JSON.stringify(parsed.meta)}` : '',
        text.length > cap ? `（内容过长，只返回前 ${cap} 字符，已省略 ${text.length - cap} 字符）` : '',
        '---',
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: `${head}\n${clipped}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'list_local_dir',
  '列出本机目录里的文件（名字、大小、修改时间），用于“看看我桌面上有什么”“找到那个文档”之类。只能列 Desktop、Documents、Downloads 与工作区。',
  {
    path: z.string().optional().describe('目录绝对路径；留空则列桌面'),
    limit: z.number().optional().describe('最多返回多少项（默认 60）'),
  },
  async ({ path: dirPath, limit }) => {
    try {
      const target = resolveSafe(dirPath && String(dirPath).trim() ? dirPath : path.join(os.homedir(), 'Desktop'));
      const st = fs.statSync(target);
      if (!st.isDirectory()) throw new Error('这不是目录；要读文件请用 read_local_document。');
      const max = Math.min(200, Math.max(5, Number(limit) || 60));
      const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, max);
      const lines = entries.map((e) => {
        const full = path.join(target, e.name);
        let size = '';
        try { if (e.isFile()) size = `${(fs.statSync(full).size / 1024).toFixed(1)} KB`; } catch { /* ignore */ }
        return `· ${e.name}${e.isDirectory() ? '/ (目录)' : ` (${size})`}`;
      });
      return {
        content: [{
          type: 'text',
          text: `目录：${target}\n共 ${entries.length} 项${entries.length >= max ? `（只显示前 ${max} 项）` : ''}\n${lines.join('\n') || '（空目录）'}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `列目录失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
