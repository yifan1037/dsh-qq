# dsh-qq

> ⚠️ **非官方项目**。与 DeepSeek、腾讯、SnowLuma 均无隶属关系。
> 用个人 QQ 号做自动化**可能违反腾讯用户协议**，使用者自行承担风险（含账号被限制/封禁）。

**给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）加一条 QQ 通道。**

插件内直连 OneBot v11 协议端（SnowLuma / NapCat 等），**不需要独立的桥接进程**，也**不新建一个 bot**——她用的还是你原来那条会话。

```
QQ ⇄ SnowLuma（OneBot v11：HTTP 3010 / WS 3011）
        ⇅
   dsh-qq-native（DSH 插件内）
        ⇅
   DSH 会话（复用已有对话，不换脑子）
```

---

## 主要特色

| 特色 | 说明 |
|---|---|
| **复用旧会话** | 接上你已有的 DSH 对话（哪怕 20 万 token 的历史），不失忆、不重开 |
| **零额外进程** | 没有 bridge 守护进程，少一个故障点、少一套配置 |
| **记忆与会话分离** | 印象 + 记忆库是文件，独立于会话存在 → 换会话也不失忆 |
| **会整理自己的记忆** | 自动去重 / 按类别分组 / 生成 `INDEX.md`，agent 一读就懂全貌 |
| **像人一样说话** | 连发多条合并成一次回复；回复自动拆 2–3 个气泡；可 `[SILENT]` 不说话 |
| **有自己的时间** | L5 自主探索、任务续跑、主动找话题、**爱好时间**（自己写随笔，再反哺聊天） |
| **只读屏幕感知** | 定时截图 + 画面变化检测，配独立「眼睛」会话描述屏幕；**不做任何输入注入** |
| **管理台** | 总览/人设/日志/成本/会话/记忆/权限/探索/任务，十个页面，一处配置 |
| **权限分层** | L2 电脑操作 / L3 全盘只读 / L4 探索 / L5 自主探索 / 工作模式 / 紧急停止，默认全关 |

---

## 0.2.0 新增（2026-10-29）

| 能力 | 说明 |
|---|---|
| 群聊 | 白名单 + @/关键词/概率档位 + 冷却 + 每小时上限 |
| 收图 | 图片落盘 → prompt 给路径 → `read_image` 读（仅媒体目录） |
| 动作层 | 五层权限 + 审计 + 限流；30 个 `mcp-qq-actions` 工具覆盖好友/群/文件/公告/申请处理 |
| 人设自述层 | 她能自己改（≤4KB/天 1 次），带备份、审计、回滚，底座不动 |
| 记忆总库 | 所有记忆操作永久留档，删掉的也能找回（`memory_vault`） |
| 发言决策 | 该不该说、说几条、要不要引用（不再按档位硬触发） |
| 管理台 | 自述层 / 群聊配置 / 动作审计 / 记忆总库 四个新页面 |
## 为什么还要做一个 QQ 机器人？

GitHub 上 QQ + LLM 的项目很多，但大多解决的是另一个问题。

| 维度 | 常见 QQ LLM 框架（AstrBot / LangBot / MaiBot / Estrella 等） | **dsh-qq** |
|---|---|---|
| 形态 | 独立服务，自带 WebUI | **DSH 插件**，跟随 DSH 生命周期 |
| 对话 | 新开一条属于 bot 的对话 | **复用你已有的 DSH 会话**（保持上下文连续） |
| 记忆 | 自建记忆库 | 和 DSH 记忆库 / 人设**同一批文件**，由插件整理 |
| 工具 | 框架内置 | 直接继承 DSH 的 MCP 工具（文件 / 记忆 / 命令 / 任务 / 联网） |
| 群聊 | 主打 | **不做**——专注私聊陪伴，把复杂度留给别人 |
| 多模态 | 普遍支持 | **暂不支持**（图片 / 语音 / 表情） |
| 与 [dsh-onebot-hub](https://github.com/Funny1Potato/dsh-onebot-hub) 的关系 | 它的取向是「把 QQ 变成 agent 的工具集」，假设下游有别的 bot | 我们的取向是「她自己就是那个 bot」，自己做回复策略 |

一句话：

> 别人做的是「QQ 机器人框架」；
> **dsh-qq 做的是「给已有的 DSH 会话开一扇 QQ 的窗」**——不换脑子、不失忆、不另起一个 bot。

---

## 仓库组成

| 包 | 版本 | 作用 |
|---|---|---|
| `packages/dsh-qq-native` | 0.1.0 | **核心插件**：OneBot 客户端、会话、合并/分条、记忆、调度、屏幕、爱好 |
| `packages/dsh-qq-personal` | 0.2.0 | 管理台：总览/人设/日志/成本/会话/记忆/权限/探索/任务 |
| `packages/qq-agent-presets` | 0.2.1 | 三个 agent preset（聊天 / 二代仿真 / 工作模式）+ 工具白名单守卫 |

`packages/dsh-qq-native/vendor/` 内含来自 `qq-bridge` 的 MIT 代码（DSH 客户端 + MCP 服务器），来源与许可见 [NOTICE](packages/dsh-qq-native/NOTICE)。

---

## 前置要求

1. **Windows 10/11**（核心聊天跨平台；屏幕监控与部分工具是 Windows 专用）
2. **Node.js ≥ 22**
3. **[DeepSeek Harness](https://github.com/deepseek-ai)**（带插件系统）
4. **自行安装 OneBot v11 协议端**：[SnowLuma](https://github.com/SnowLuma/SnowLuma) 或 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) —— 本仓库**不包含**，且不得随本仓库再分发

---

## 快速开始

```bash
# 1. 把这个仓库放到本地，链接插件进你的 DSH profile
cd ~/.dsh/profiles/desktop
pnpm add "link:<本仓库>/packages/dsh-qq-native"

# 2. 在 profile 的 package.json 里把 dsh-qq-native 加进 dsh.profile.bundles

# 3. 复制配置示例并填两个必填项
mkdir -p ~/.dsh/qq-native
cp <本仓库>/packages/dsh-qq-native/examples/config.example.json ~/.dsh/qq-native/config.json
#    snowlumaDir：你的协议端安装目录（自动读 token）
#    ownerQQ：你的 QQ 号（只回复这个号）

# 4. 重启 DSH，看日志
cat ~/.dsh/qq-native/plugin.log
#   [module] index.js 被加载
#   [apply] runner 已启动
#   [ws] 已连接
```

然后直接在 QQ 里发消息即可——**不需要任何前缀**。

可选能力（默认关）：`看屏幕` / `开屏幕监控` / `关屏幕监控` 三个 QQ 指令；
权限、记忆、任务、成本都在管理台（默认 `http://127.0.0.1:3101`）。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md) | **中文使用说明**：启动顺序、管理台各页、QQ 指令、权限、常见问题 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 数据流、模块职责、6 条关键设计取舍 |
| [docs/CONFIG.md](docs/CONFIG.md) | 每个配置项、权限文件、环境变量 |
| [docs/SECURITY.md](docs/SECURITY.md) | 威胁模型、五层权限、数据出站、已知风险 |
| [docs/MIGRATION.md](docs/MIGRATION.md) | 从 qq-bridge 迁过来 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 已完成 / 计划 / 不做的 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |

---

## 安全与隐私

- 默认**所有电脑能力关闭**，需要显式打开；管理台有「紧急停止」
- 屏幕监控**没有输入注入**，只能截图；看到敏感信息只做提示
- 本仓库**不含**任何人设卡、聊天记录、记忆库、token
- 所有私人数据都在 `~/.dsh/qq-native/` 和 `~/.dsh/qq-memory/`，不进仓库
- `scripts/sanitize.mjs` 在 CI 里跑，出现本机路径 / 真实 QQ 号 / 私人内容会让构建失败

---

## License

MIT（本仓库原创部分）。`vendor/` 下代码来自 `qq-bridge`（MIT，Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors），详见 [NOTICE](packages/dsh-qq-native/NOTICE)。
SnowLuma / NapCat / DSH 分别遵循各自许可。
