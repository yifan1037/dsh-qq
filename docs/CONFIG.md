# 配置说明

配置文件位置：`~/.dsh/qq-native/config.json`
示例见 [`packages/dsh-qq-native/examples/config.example.json`](../packages/dsh-qq-native/examples/config.example.json)。

## 连接

| 键 | 默认 | 说明 |
|---|---|---|
| `snowlumaDir` | `""` | SnowLuma 安装目录；填了会自动读它的 HTTP/WS token |
| `httpPort` | `3010` | OneBot HTTP 端口（发消息用） |
| `wsPort` | `3011` | OneBot WS 端口（收事件用） |
| `ownerQQ` | `0` | **必填**：只回复这个 QQ 号（私聊） |

> HTTP 和 WS 通常是**两个不同的 token**。插件从 `snowlumaDir` 的配置里分别读取。

## 聊天

| 键 | 默认 | 说明 |
|---|---|---|
| `enableReply` | `true` | 总开关；`false` = 只看不回（观察模式） |
| `observeOnly` | `false` | 同上，调试用 |
| `triggerPrefix` | `""` | `""` = 所有私聊；`"/n"` = 只回带前缀的（双跑测试用） |
| `batchWindowMs` | `1600` | 连发合并窗口；再来一条会重排，但总等待 ≤ 6s |
| `preset` | `"qq-chat-v2"` | 聊天预设；工作模式下自动切 `qq-work` |
| `reuseBridgeSession` | `false` | `true` = 从 `state/sessions.json` 读旧会话 id 并接上 |
| `vendorDir` | `""` | 留空 = 用包内 `vendor/` |
| `bridgeDir` | `""` | 可选：旧 qq-bridge 目录（仅 vendor 缺失时兜底） |

## 后台任务

| 键 | 默认 | 说明 |
|---|---|---|
| `schedulerIntervalMs` | `60000` | 调度器检查间隔 |
| `statsIntervalMs` | `300000` | 成本统计间隔 |
| `proactive.enabled` | `true` | 主动找话题 |
| `proactive.idleMinutes` | `240` | 空闲多久才主动 |
| `proactive.maxPerDay` | `3` | 每天上限 |
| `proactive.hours` | `[9,23]` | 只在白天 |
| `hobby.enabled` | `true` | 爱好时间 |
| `hobby.maxPerDay` | `2` | 每天上限 |
| `hobby.hours` | `[10,22]` | 允许时段 |
| `screenWatch.enabled` | `false` | 屏幕监控（只读） |
| `screenWatch.everyMinutes` | `5` | 截图间隔 |
| `screenWatch.comment` | `false` | 看到变化时是否主动发一句 |

## 权限（不在 config.json，在别处）

权限状态在 `~/.dsh/qq-personal/capabilities.json`，由管理台「权限」页读写：

| 键 | 含义 |
|---|---|
| `desktop` | L2 电脑操作（截图/鼠标键盘） |
| `fullRead` | L3 全盘只读（读任意位置的文档） |
| `explore` | L4 探索模式（执行命令、写文件） |
| `autonomous` | L5 自主探索：`off` / `readonly` / `full` |
| `l5.times` | 每天探索时间点，如 `["21:00"]` |
| `l5.dirs` | 允许探索的目录 |
| `l5.maxRunsPerDay` | 每天最多跑几次 |
| `panic` | 紧急停止标志（非 0 = 全停） |

工作模式在 `~/.dsh/qq-personal/settings.json` 的 `workMode`。

## 数据落盘

见 [ARCHITECTURE.md](ARCHITECTURE.md#状态文件)。

## 环境变量（测试/调试）

| 变量 | 作用 |
|---|---|
| `QQ_NATIVE_SELFTEST=1` | 连上后 3 秒模拟一条消息，走完整链路（会真发到 owner QQ） |
| `QQ_NATIVE_SELFTEST=2` | 模拟两条（间隔 700ms），验证合并 |
| `QQ_NATIVE_SCHED_DEBUG=1` | 每分钟打印调度条件 |
| `QQ_NATIVE_L5_FORCE=1` | 忽略时间/额度强制触发 L5 |
| `QQ_NATIVE_HOBBY_FORCE=1` | 忽略时段/次数强制触发爱好时间 |
| `DSH_QQ_TASKS_MODULE` | 指定 `tasks.js` 路径（vendor 的 mcp-tasks 用） |

## 配置生效时机

| 配置 | 何时生效 |
|---|---|
| 屏幕监控开关 | **20 秒内**自动同步（插件轮询配置文件） |
| 其它 config.json 项 | 重启 DSH |
| capabilities / settings | 下次读取即生效（插件按需读文件） |

## 群聊（0.2.0 起）

```jsonc
"groups": {
  "enabled": false,          // 总开关
  "allow": [],               // 群号白名单；空 = 全部拒绝
  "defaultTier": 20,         // 0-10 仅@、10-20 +关键词、20-90 +概率、90-100 全响应
  "keywords": [],
  "cooldownSeconds": 20,     // 同群冷却
  "maxPerHour": 30,
  "tiers": {}                // 按群覆盖档位：{"123456": 100}
}
```

## 发言决策（0.2.0 起）

```jsonc
"participation": {
  "enabled": true,
  "groupBubbles": 1,         // 群聊最多几条
  "privateBubbles": 3,
  "quietAfterReplyMs": 15000,
  "burstWindowMs": 120000,
  "burstThreshold": 3,
  "quoteBias": false
}
```

## 动作层（0.2.0 起）

```jsonc
"actions": {
  "enabled": { "message": true, "media": true, "group": true, "admin": false, "destructive": false },
  "rateLimit": { "userPerMinute": 20, "groupPerMinute": 10 },
  "audit": true
}
```

`admin`（群管理/申请处理）与 `destructive`（踢人/退群/删好友/改资料）默认关闭。

## 人设自述层

- 底座：`~/.dsh/qq-native/data/persona.md`（只读）
- 自述：`~/.dsh/qq-native/data/persona-self.md`（她可写，≤4KB，每天 1 次，自动备份）
- 审计：`~/.dsh/qq-native/state/persona-changes.jsonl`
- 管理台：人设页 → 自述层（编辑/回滚/历史）

## 记忆总库

- 路径：`~/.dsh/qq-memory/all-memories.jsonl`（可用 `QQ_MEMORY_DIR` 改）
- 每次 add/update/forget 追加一行，永不修改、永不删除
- 工具：`memory_vault(query?)`
