# dsh-qq-personal

DSH 宿主插件：把 qq-bridge（SnowLuma OneBot v11 ↔ DSH）变成「随 DSH 启停 + 可配置」的能力。

- **设置文件**：`%USERPROFILE%\.dsh\qq-personal\settings.json`（群聊白名单 / chat|closed-agent / 人设）
- **职责**：发现 DSH 随机 Web 端口、把设置写进 qq-bridge、拉起/重启/停止桥接进程、写日志
- **不注册任何 agent 工具**：避免与 web 端的 per-session preset 组合冲突（host-plane 只做生命周期）

安装：把本目录 junction 到 `~/.dsh/plugins/dsh-qq-personal`，在 profile `node_modules` 建同名 junction，并把
`dsh-qq-personal` 加进 profile `package.json` 的 `dsh.profile.bundles`；重启 DSH。

完整说明见 `<bridge>/README-LOCAL.md`。
