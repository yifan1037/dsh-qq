# 架构

## 总览

```
QQ ←→ SnowLuma (OneBot v11: HTTP 3010 / WS 3011)
        ⇅
   dsh-qq-native（DSH 插件进程内）
     ├── lib/        transport + 会话 + 调度
     └── vendor/     DSH 客户端 + MCP 服务器（来自 qq-bridge，MIT）
        ⇅
   DSH 会话（复用已有会话，不新建）
```

一条消息的完整路径：

```
WS 事件 → 过滤(私聊/owner/去重) → 合并器(1.6s)
  → 读状态(最近对话) + 记忆索引 + 人设(仅首轮)
  → 拼 prompt → DSH 会话生成
  → 抽「记：」行写记忆库
  → 按换行/句号拆 ≤3 条 → HTTP 发送
```

## 模块职责

| 文件 | 职责 | 关键点 |
|---|---|---|
| `lib/index.js` | CJS 入口 | 只做转接 + 落盘加载痕迹；动态 import ESM 内核 |
| `lib/runner.mjs` | 主流程 | 事件过滤、合并器接线、prompt 组装、发送、调度启动 |
| `lib/snowluma.mjs` | OneBot 客户端 | 自动读 SnowLuma 配置拿 HTTP/WS token；WS 断线重连 |
| `lib/dsh-agent.mjs` | 建/复用 DSH 会话 | **自研回合收集**（该 DSH 构建不发 `turn/start`） |
| `lib/dsh-port.mjs` | DSH 端口探测 | netstat ∩ 进程名 + 探活 |
| `lib/wake.mjs` | 合并器 | 窗口/上限/去重/潜水/「记：」抽取 |
| `lib/memory.mjs` | 记忆 | 印象读取、记忆块构建、人设读取、写入入口 |
| `lib/memory-curate.mjs` | 记忆整理 | 去重/分组/归档 → `INDEX.md` + `index.json` |
| `lib/schedulers.mjs` | 调度 | L5 探索 / 任务续跑 / 主动找话题 / 爱好时间 |
| `lib/stats.mjs` | 成本 | 会话 token 增量 → `token-usage.jsonl` |
| `lib/state.mjs` | 小状态 | sessionId、最近对话、lastIncomingAt |
| `lib/eyes.mjs` | 眼睛 | 借 `computer-explore` 会话截图+描述（只读） |
| `lib/screenwatch.mjs` | 屏幕监控 | 定时截图 + 指纹变化检测 |
| `lib/hobbies.mjs` | 爱好 | 爱好清单 + 随笔本 + 挑选逻辑 |

## 关键设计取舍

### 1. CJS 入口 + ESM 内核

DSH 插件加载器对 CommonJS 最稳；内核用 `.mjs` 可自由 `import`。
`vendor/package.json` 声明 `type: module` 让 vendor 里的 `.js` 按 ESM 解析。

### 2. 不用 vendor 的回合收集

该 DSH 构建的事件流顺序是 `step/start → user/message → assistant/message → step/end → turn/end`，
**没有 `turn/start`**，依赖它建回合的收集器会永远等不到收尾。
所以自己实现：累积 assistant 文本 + `turn/end` 收尾 + FIFO 等待队列。

### 3. 记忆与会话分离

印象（`social-v2.json`）和记忆库（`memories.jsonl`）是**文件**，独立于会话。
所以"换会话"不等于"失忆"——接任何会话都记得住人。

### 4. 合并窗口有上限

每来一条消息重排定时器，但总等待不超过 6 秒，避免对方一直发导致永不回复。

### 5. 调度与聊天共用互斥锁

L5/任务/主动/爱好都会往同一个 DSH 会话投 prompt，并发会打架。
`busy` 标志让它们排队，同一时刻只做一件事。

### 6. 眼睛走独立会话

聊天 preset 没有截图/视觉能力；把 `computer-explore` 当"眼睛"单独开一条会话，
只截图不操作，结果以文本注入聊天 prompt——避免给聊天会话塞满桌面工具。

## 数据流（后台）

```
每 60s：L5(时间命中/目录/额度) → 任务(workMode/pickNext) → 主动(空闲/白天/次数) → 爱好(白天/次数)
每 5min：成本统计（token 增量）
每 20s：屏幕开关同步（管理台改配置 → 生效）
每 30min：记忆整理（也可在写入后立即触发）
```

## 状态文件

```
~/.dsh/qq-native/
├── config.json                    配置
├── state.json                     会话 id + 最近 20 句 + lastIncomingAt
├── plugin.log                     运行日志
├── data/persona.md                人设
├── data/social-v2.json            印象
├── data/hobbies.json              爱好
├── data/hobby-log.jsonl           爱好随笔
├── state/token-usage.jsonl        成本
├── state/l5-runs.jsonl            L5 记录
├── state/sessions.json            旧会话 id（接旧窗口用）
└── screen/                        截图表 + 观察记录
```

## 0.2.0 新增模块

| 模块 | 职责 |
|---|---|
| `lib/onebot-segments.mjs` | CQ 码 ⇄ 内部段 ⇄ OneBot 段；引用/图片/表情/拍一拍/文件 |
| `lib/actions.mjs` | 动作层：五层权限、审计、限流、panic 检查 |
| `lib/media.mjs` | 图片落盘（http/base64/本地）与清理 |
| `lib/groups.mjs` | 群聊策略：白名单/@/关键词/档位/冷却 |
| `lib/participation.mjs` | 发言决策：该不该说、几条、要不要引用 |
| `lib/persona-self.mjs` | 人设自述层：限长、频率、备份、审计、回滚 |
| `lib/reply-prompt.mjs` | prompt 组装（纯函数，可单测与 dry-run） |
| `vendor/memory-vault.js` | 记忆总库：所有操作永久留档 |
| `vendor/mcp-qq-actions.js` | QQ 动作 MCP server（30 个工具，直连 SnowLuma） |

### dry-run（离线验证）

```powershell
$env:QQ_NATIVE_DRYRUN = "1"
$env:QQ_NATIVE_FAKE_IMAGE = "C:\path\to\img.png"
```

只组装 prompt 并打印，不调模型、不发 QQ、不写记忆。
