# dsh-qq-personal

> ⚠️ **非官方项目**。与 DeepSeek、腾讯、SnowLuma 均无隶属关系。
> 用个人 QQ 号做自动化**可能违反腾讯用户协议**，使用者自行承担风险（含账号被限制/封禁）。

一个让 AI 通过 QQ 与你聊天的 DSH 插件：

- 私聊聊天（可切换群聊白名单）
- 记忆：印象标签 + 独立记忆库（按需检索）
- 权限：L2 电脑操作 / L3 全盘只读 / L4 探索 / L5 自主探索 / 工作模式
- 任务队列：长任务跨轮推进
- 可视化面板：总览、人设、成本、会话、记忆、权限、探索、任务

## 组成

| 包 | 作用 |
|---|---|
| `packages/dsh-qq-personal` | DSH 主机插件（控制台、桥接管理、权限、任务） |
| `packages/qq-agent-presets` | 三个 agent preset（聊天 / 三代仿真 / 工作模式）+ 工具白名单守卫 |

`qq-bridge` 是第三方 fork，见 [FORK_NOTES.md](FORK_NOTES.md)。

## 前置要求

1. [DeepSeek Harness](https://github.com/deepseek-ai)（带插件系统）
2. **自行安装** SnowLuma（本仓库不包含，EULA 禁止再分发）
3. Node.js 22+

## 快速开始

```bash
# 1. 复制示例配置
cp config.example.json <你的 bridge>/config.json
cp settings.example.json ~/.dsh/qq-personal/settings.json

# 2. 填 token / 账号 / SnowLuma 目录
# 3. 把插件 link 进 profile
cd ~/.dsh/profiles/desktop
pnpm add link:<本仓库>/packages/dsh-qq-personal
pnpm add link:<本仓库>/packages/qq-agent-presets

# 4. 重启 DSH
```

## 安全

- 默认所有能力关闭（L2/L3/L4/L5/工作模式）
- 管理台有「紧急停止」，一键关掉所有电脑能力
- 危险命令有拦截；所有执行记录写入日志

## 隐私

本仓库**不含**任何角色卡、聊天记录、记忆库、token。`state/`、`roles/`、`config.json`、`settings.json` 都在 .gitignore 里。

## License

MIT（本仓库原创部分）。`qq-bridge`、`SnowLuma`、`@deepseek-ai/*` 遵循各自许可。
