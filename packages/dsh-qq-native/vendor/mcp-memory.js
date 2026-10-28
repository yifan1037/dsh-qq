#!/usr/bin/env node
// mcp-memory.js —— 独立记忆库 MCP server（和 agent 自带记忆无关）
//
// 记忆存在 ~/.dsh/qq-memory/memories.jsonl，一个文件、一行一条，随时能备份/迁移/人肉查看。
//
// 工具：
//   memory_add(text, weight?, tags?, kind?, source?)      存一条
//   memory_search(query?, tags?, kind?, sinceDays?, limit?) 按关键词/标签/时间捞
//   memory_list(kind?, limit?)                            按时间倒序列出
//   memory_update(id, ...)                                改一条
//   memory_forget(id)                                     删一条
//   memory_stats()                                        看规模
//   memory_compact(maxCount?)                             保守清理（低权重+半年没用）
//
// 环境变量：QQ_MEMORY_DIR 可改存储目录（默认 ~/.dsh/qq-memory）

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryStore, storeFile } from './memory-store.js';

const server = new McpServer({ name: 'memory', version: '1.0.0' });

function fmt(m, showScore = false) {
  const when = new Date(m.at).toLocaleString('zh-CN', { hour12: false });
  const tags = m.tags.length ? ` [${m.tags.join('/')}]` : '';
  const score = showScore && m.score !== undefined ? ` (相关度 ${m.score})` : '';
  return `· ${when} · ${m.kind} · 权重${m.weight}${tags}${score}\n  id=${m.id}\n  ${m.text}`;
}

server.tool(
  'memory_add',
  '往独立记忆库存一条记忆。存"值得记"的东西：他的状态、约定、在意的事、发生过的事；寒暄和废话不用存。',
  {
    text: z.string().describe('记忆内容，用完整句子写清楚（含日期/人名等细节），不超过 4000 字'),
    weight: z.number().optional().describe('重要度 1-5：5=极其重要（不能忘）、3=一般、1=琐碎。默认 3'),
    tags: z.array(z.string()).optional().describe('标签，方便以后按标签捞，例如 ["情绪","考试"]'),
    kind: z.string().optional().describe('类型：事件（默认）/ 标签 / 事实 / 摘要 / 引用'),
    source: z.string().optional().describe('来源会话，例如 private:10001'),
  },
  async ({ text, weight, tags, kind, source }) => {
    try {
      const r = MemoryStore.add({ text, weight, tags, kind, source });
      return {
        content: [{
          type: 'text',
          text: r.deduped
            ? `已合并到已有记忆（相似内容不重复存）：\n${fmt(r.memory)}`
            : `已存入记忆库（当前 ${MemoryStore.stats().count} 条）：\n${fmt(r.memory)}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `存入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'memory_search',
  '在记忆库里检索。可以用关键词、标签、时间范围；返回按相关度排序的记忆（会自动记录"被想起"的次数）。',
  {
    query: z.string().optional().describe('要搜的内容，例如"考试""她说难过""约定"'),
    tags: z.array(z.string()).optional().describe('按标签过滤，例如 ["情绪"]'),
    kind: z.string().optional().describe('只看某类型：事件/标签/事实/摘要/引用'),
    sinceDays: z.number().optional().describe('只看最近多少天'),
    limit: z.number().optional().describe('最多返回几条，默认 10'),
  },
  async ({ query, tags, kind, sinceDays, limit }) => {
    try {
      const r = MemoryStore.search({ query, tags, kind, sinceDays, limit });
      if (!r.returned) return { content: [{ type: 'text', text: '记忆库里没找到相关的内容。' }] };
      return {
        content: [{
          type: 'text',
          text: `命中 ${r.total} 条，返回 ${r.returned} 条：\n\n${r.memories.map((m) => fmt(m, true)).join('\n\n')}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `检索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'memory_list',
  '按时间倒序列出记忆库里的记忆（不做相关度排序，就是看最近存了什么）。',
  {
    kind: z.string().optional().describe('只看某类型：事件/标签/事实/摘要/引用'),
    limit: z.number().optional().describe('最多返回几条，默认 20'),
  },
  async ({ kind, limit }) => {
    try {
      const r = MemoryStore.list({ kind, limit });
      if (!r.memories.length) return { content: [{ type: 'text', text: '记忆库还是空的。' }] };
      return {
        content: [{
          type: 'text',
          text: `共 ${r.total} 条，按时间倒序显示 ${r.memories.length} 条：\n\n${r.memories.map((m) => fmt(m)).join('\n\n')}`,
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'memory_update',
  '修改一条已存在的记忆（内容、权重、标签、类型都可以改）。id 从 memory_search / memory_list 的结果里拿。',
  {
    id: z.string().describe('记忆 id'),
    text: z.string().optional().describe('新的内容'),
    weight: z.number().optional().describe('新的重要度 1-5'),
    tags: z.array(z.string()).optional().describe('新的标签（整体替换）'),
    kind: z.string().optional().describe('新的类型'),
  },
  async ({ id, text, weight, tags, kind }) => {
    try {
      const r = MemoryStore.update(id, { text, weight, tags, kind });
      return { content: [{ type: 'text', text: `已更新：\n${fmt(r.memory)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `更新失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'memory_forget',
  '从记忆库里删掉一条记忆（想不起来/记错了/过时了）。id 从搜索结果里拿。',
  { id: z.string().describe('要删除的记忆 id') },
  async ({ id }) => {
    try {
      const r = MemoryStore.forget(id);
      return { content: [{ type: 'text', text: `已删除：\n${fmt(r.removed)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'memory_stats',
  '看记忆库的规模：总数、按类型/权重分布、最早/最新时间、文件位置与大小。',
  {},
  async () => {
    try {
      const s = MemoryStore.stats();
      const kindLines = Object.entries(s.byKind).map(([k, v]) => `${k}: ${v}`).join('，') || '（空）';
      const weightLines = Object.entries(s.byWeight).sort((a, b) => Number(b[0]) - Number(a[0])).map(([k, v]) => `权重${k}: ${v}`).join('，') || '（空）';
      return {
        content: [{
          type: 'text',
          text: [
            `记忆库：${s.count} 条`,
            `类型分布：${kindLines}`,
            `权重分布：${weightLines}`,
            `时间范围：${s.oldest ?? '—'} → ${s.newest ?? '—'}`,
            `文件：${s.file}（${s.sizeKB} KB）`,
          ].join('\n'),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'memory_compact',
  '保守清理记忆库：只在总数超过上限时，删掉「低权重（1-2）+ 半年没被用过」的旧记忆。重要内容不会被删。',
  { maxCount: z.number().optional().describe('上限条数，默认 5000') },
  async ({ maxCount }) => {
    try {
      const r = MemoryStore.compact({ maxCount: maxCount || 5000 });
      return { content: [{ type: 'text', text: r.note ? r.note : `清理完成：删除 ${r.removed} 条，保留 ${r.kept} 条。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `清理失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
