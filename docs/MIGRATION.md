# 从 qq-bridge 迁移

如果你之前用的是独立 `qq-bridge` 进程，按这个顺序迁过来。

## 一、概念对应

| 旧（bridge） | 新（插件） |
|---|---|
| `qq-bridge` 进程 | 不需要了（插件进程内直连） |
| `qq-bridge/config.json` | `~/.dsh/qq-native/config.json` |
| `qq-bridge/state/social-v2.json`（印象） | `~/.dsh/qq-native/data/social-v2.json` |
| `qq-bridge/roles/<名字>.md`（人设） | `~/.dsh/qq-native/data/persona.md` |
| `qq-bridge/state/sessions.json` | `~/.dsh/qq-native/state/sessions.json` |
| `qq-bridge/state/token-usage.jsonl` | `~/.dsh/qq-native/state/token-usage.jsonl` |
| `qq-bridge` 控制台 3100 | 不需要了 |
| 管理台 3101 | 保留（`dsh-qq-personal`） |
| 桥接的 `qq_*` MCP 工具 | 移除；改为插件自动发送 |
| 桥接的 L5/任务调度器 | 搬进插件 `lib/schedulers.mjs` |
| 群聊 / 多模态 | **暂不支持** |

## 二、迁移步骤

### 1. 停桥接

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'bridge\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

并把管理台插件设置里的 `autoStart` 关掉（`~/.dsh/qq-personal/settings.json`）。

### 2. 搬数据

```powershell
$new = "$env:USERPROFILE\.dsh\qq-native"
New-Item -ItemType Directory "$new\data","$new\state" -Force

# 人设（把 <名字> 换成你的文件名）
Copy-Item "<bridge>/roles/<名字>.md" "$new\data\persona.md"

# 印象
Copy-Item "<bridge>/state/social-v2.json" "$new\data\social-v2.json"

# 会话 id（想接着旧对话就用这个）
Copy-Item "<bridge>/state/sessions.json" "$new\state\sessions.json"

# 成本历史
Copy-Item "<bridge>/state/token-usage.jsonl" "$new\state\token-usage.jsonl"
```

### 3. 写新配置

复制 `examples/config.example.json` 到 `~/.dsh/qq-native/config.json`，至少填：

```json
{
  "snowlumaDir": "你的 SnowLuma 目录",
  "ownerQQ": 你的QQ号,
  "triggerPrefix": "",
  "reuseBridgeSession": true
}
```

`reuseBridgeSession: true` + `state/sessions.json` 存在 → 她直接接着旧对话。

### 4. 装插件 + 重启 DSH

- profile 的 `package.json`：加 `link:` 依赖 + `dsh.profile.bundles` 追加 `dsh-qq-native`
- 重启 DSH
- 看 `~/.dsh/qq-native/plugin.log`：

```
[module] index.js 被加载
[apply] runner 已启动
[ws] 已连接
```

### 5. 验证

| 检查 | 命令/位置 |
|---|---|
| QQ 能收 | 发一句，`plugin.log` 有「收到消息」 |
| QQ 能回 | 有「已回复」且手机看到 |
| 记忆还在 | 管理台「记忆」页有旧条目 |
| 人设在用 | 管理台「人设」页显示你的卡 |
| 旧对话接上 | 管理台「原生链路」页显示旧的 session id |

## 三、双跑过渡（可选）

如果你想先并行验证再切：

| 阶段 | 配置 | 行为 |
|---|---|---|
| 观察 | `observeOnly: true` | 只记日志不回 |
| 只回测试前缀 | `triggerPrefix: "/n"` | 桥接回所有消息，插件只回 `/n` 开头的 |
| 切换 | `triggerPrefix: ""` + 桥接停 | 插件接管全部 |

⚠️ **同一会话不能被两个进程同时投消息**（会抢答）。所以最后一步必须停桥接。

## 四、回滚

`packages/dsh-qq-native/ROLLBACK.md`（或仓库根 `ROLLBACK.md`）：

1. 插件配置改回 `triggerPrefix: "/n"`、`reuseBridgeSession: false`
2. 管理台 `autoStart: true`
3. 重启 DSH → 桥接被拉起
4. 删 `~/.dsh/qq-native/state.json`（避免插件继续占用旧会话）

## 五、迁移后变化（预期内）

| 变化 | 说明 |
|---|---|
| 群聊没了 | 插件未实现 |
| 图片/表情/语音没了 | 原依赖桥接工具 |
| 引用/拍一拍没了 | 同上 |
| 成本统计有延迟 | 5 分钟一次增量 |
| 回复可能更慢 | 首次带人设卡；之后正常 |
