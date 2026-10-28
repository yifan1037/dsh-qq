# dsh-qq-native 开源规划

> 目标：把「QQ 接入层」从私有玩具变成**别人能装、能改、能放心用**的开源插件。
> 本文是执行清单，不是愿景。

---

## 一、开源什么 / 不开源什么

| 开源 | 不开源（永不出库） |
|---|---|
| 插件代码 `lib/`（~1,300 行） | 人设卡（私人版角色卡，15k 字） |
| 管理台 `dsh-qq-personal`（可选独立包） | 印象库 `social-v2.json` |
| 预设与工具守卫 `qq-presets` | 记忆库 `memories.jsonl` |
| 文档、示例配置、脱敏脚本 | 会话记录、聊天历史、日志 |
| vendor 的 MCP 服务器（MIT 来源，保留版权头） | SnowLuma 本体（EULA 禁止分发） |
| 测试与 CI | QQ 号、token、目录路径 |

**判断标准**：只要包含"她是谁"或"你们聊过什么"的内容，一律不出库。

---

## 二、仓库形态

建议**单仓库多包**（monorepo，pnpm workspace）：

```
dsh-qq/
├── packages/
│   ├── dsh-qq-native/         核心插件（transport + 会话 + 调度）
│   │   ├── lib/
│   │   ├── vendor/            搬来的 MCP（保留 MIT 头 + NOTICE）
│   │   ├── package.json
│   │   └── README.md
│   ├── dsh-qq-console/        管理台（从 dsh-qq-personal 拆出，去掉桥接残留）
│   ├── qq-agent-presets/      预设 + 工具白名单守卫
│   └── shared/                共用：记忆库读写、路径约定
├── examples/
│   ├── config.example.json
│   ├── persona.example.md     示例人设（非私人版，通用助手语气）
│   └── preset/                示例 preset
├── scripts/
│   ├── sanitize.mjs           脱敏扫描（CI 里跑，发现即失败）
│   └── check-scope.mjs        检查是否误引用桥接/本地路径
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CONFIG.md
│   ├── SECURITY.md
│   ├── MIGRATION.md           从 qq-bridge 迁移过来的人看
│   └── ROADMAP.md
├── .github/workflows/ci.yml
├── LICENSE                     MIT
├── NOTICE                      第三方来源声明
└── README.md
```

**为什么先不动现有目录**：先在 `qq-personal-public/` 里继续沉淀，等 M2 文档齐了再一次性 `git init` 到新仓库，避免历史里带隐私（`git filter-repo` 清理很痛）。

---

## 三、脱敏清单（当前扫描结果）

已扫描 `qq-native`，需要处理：

| 类别 | 命中 | 处理方式 |
|---|---|---|
| 本地绝对路径 `C:/Users/Lenovo` | 10 处 | 改成 `os.homedir()` / 配置项，示例里用 `<you>` |
| SnowLuma 路径 | 62 处 | 改为配置项 `snowlumaDir`，示例留空 |
| QQ 号 `36736366` | 10 处 | 改配置 `ownerQQ`，默认 `0`；文档写"你的 QQ 号" |
| 用户名 `Lenovo` | 9 处 | 同上 |
| 角色名 `小鲸鱼` | 3 处 | 抽成配置 `persona.name`，默认 `助手` |
| token/密钥字样 | 26 处 | 确认全是"读取 token"的代码逻辑，非硬编码值（已核） |
| `.bak-*` 备份文件 | 30+ | **不进仓库**（`.gitignore` + 删本地） |

### 自动化脚本 `scripts/sanitize.mjs`

```js
// 规则表：正则 → 处理方式
const RULES = [
  { re: /C:[\\/]Users[\\/][^'"\s]+/g,   action: 'fail',  why: '本地绝对路径' },
  { re: /\b36736366\b/g,                action: 'fail',  why: '真实 QQ 号' },
  { re: /\b2234200275\b/g,              action: 'fail',  why: '机器人 QQ 号' },
  { re: /叶榕|小鲸鱼（私人版）|角色卡（自由版）/g, action: 'fail', why: '私人内容' },
  { re: /access_token\s*[:=]\s*['"][A-Za-z0-9]{10,}/g, action: 'fail', why: '硬编码 token' },
  { re: /snowluma-v\d+\.\d+\.\d+-\d+/g, action: 'warn',  why: '具体版本路径' },
];
```

CI 里跑：命中 `fail` 规则 → 构建失败。这样**从机制上防止再犯**。

---

## 四、许可与第三方

| 组件 | 来源 | 许可 | 处理 |
|---|---|---|---|
| 本插件代码 | 自己写 | **MIT** | 加 `LICENSE` |
| `vendor/dsh-client.js`、4 个 MCP、`docparse/` | 来自 `qq-bridge` | MIT，Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors | **保留文件头版权 + NOTICE 里列出来源仓库** |
| `dsh-computer-use-mode` | 第三方 | 跟随其许可 | 只作为可选依赖文档引用，不打包 |
| SnowLuma | 第三方 | EULA 禁止打包分发 | **文档说明"请自行安装"，绝不打包** |
| DSH | 第三方 | 跟随其许可 | 依赖声明，不打包 |

`NOTICE` 内容要点：

```
本仓库 vendor/ 下代码来自 qq-bridge（MIT）：
  Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors
  原项目：<链接>
本仓库不包含 SnowLuma（QQ 协议端），请自行安装并遵守其 EULA。
```

---

## 五、文档清单（M2 交付物）

| 文档 | 内容 | 读者 |
|---|---|---|
| `README.md` | 30 秒看懂：是什么、做什么、怎么装、有什么限制 | 路人 |
| `docs/ARCHITECTURE.md` | 数据流图、模块职责、关键设计取舍（CJS 入口/自研回合收集/记忆与会话分离） | 想改代码的人 |
| `docs/CONFIG.md` | 每个配置项：含义、默认值、示例 | 使用者 |
| `docs/SECURITY.md` | 权限模型（L2/L3/L4/L5）、紧急停止、数据落盘位置、隐私边界 | 谨慎的人 |
| `docs/MIGRATION.md` | 从 qq-bridge 迁过来：数据放哪、怎么接旧会话、怎么回滚 | 老用户 |
| `docs/ROADMAP.md` | 群聊/多模态/并发等下一步 | 贡献者 |
| `examples/persona.example.md` | 通用"助手"人设，**不是私人角色卡** | 新手 |
| `CONTRIBUTING.md` | 开发环境、跑测试、提交规范 | 贡献者 |

**README 里必须明确写的三件事**：
1. 这是**个人陪伴/自用**取向的项目，不是企业客服
2. 群聊和多模态**尚未实现**（避免期待落空）
3. 需要自己装 SnowLuma，且**自担腾讯 ToS 风险**

---

## 六、测试与 CI

| 层级 | 内容 | 现状 |
|---|---|---|
| 语法 | 全 `lib/` `node --check` | 手动，需进 CI |
| 单测 | `wake.mjs`（合并/去重/潜水）、`memory-curate.mjs`（去重/归档）、`hobbies.mjs`（挑选逻辑）、`screenwatch.mjs`（指纹） | 无，**最值得补** |
| 集成 | 假 OneBot 服务端 + 假 DSH API，跑一遍"收消息→回复" | 无，可用 mock 实现 |
| 脱敏 | `scripts/sanitize.mjs` | 待写 |
| CI 平台 | GitHub Actions，`windows-latest` + `ubuntu-latest`（语法/单测跨平台） | 待建 |

CI 目标：

```yaml
- run: pnpm -r node --check lib
- run: pnpm -r test        # node:test
- run: node scripts/sanitize.mjs
```

---

## 七、发布流程

| 步 | 动作 |
|---|---|
| 1 | 版本号 `0.1.0`（首个公开版） |
| 2 | `CHANGELOG.md` 用 Keep a Changelog 格式 |
| 3 | `git tag v0.1.0` → GitHub Release，附：安装步骤、已知限制、迁移说明 |
| 4 | 不发布到 npm（DSH 插件用 `link:` 安装为主）；如需 npm，名字用 `dsh-qq-native` |
| 5 | Release note 里写明：**不含 SnowLuma，不含人设卡，不含任何对话数据** |

---

## 八、风险与合规

| 风险 | 说明 | 缓解 |
|---|---|---|
| **腾讯 ToS** | 个人 QQ 自动化可能违反服务条款 | README 顶部显式声明「自担风险」；不提供绕过手段 |
| **SnowLuma EULA** | 禁止打包/再分发 | 只依赖，不打包；文档给官方获取方式 |
| **隐私泄露** | 记忆/人设/会话是私人的 | 示例用通用内容；`.gitignore` 排除数据目录；sanitize 脚本兜底 |
| **被当客服工具用** | 群聊/多账号需求会上来 | README 明确取向；issue 模板里说明范围 |
| **维护成本** | L5/任务/多模态都在演进 | ROADMAP 标优先级，不做"什么都要" |

---

## 九、里程碑

| 里程碑 | 内容 | 预计 |
|---|---|---|
| **M0** | 现有 `qq-personal-public/` 收拢成 monorepo 骨架 | 半天 |
| **M1** | 脱敏完成（sanitize 脚本 + 全量替换路径/QQ/角色名），CI 通过 | 1 天 |
| **M2** | 文档 8 篇写完 + 示例配置/人设 | 1–2 天 |
| **M3** | 单测补齐（4 个模块）+ CI 三平台绿 | 1 天 |
| **M4** | 首次 Release v0.1.0 + 仓库公开 | 半天 |
| M5 | 社区反馈 → 群聊/多模态进 v0.2 | 滚动 |

**先做 M1**：脱敏是唯一"不做完不能公开"的硬门槛。

---

## 十、现在就做的前三步

1. 写 `scripts/sanitize.mjs`，跑一遍现有代码，把 10 处路径 + 10 处 QQ 号 + 3 处角色名改成配置项
2. 把 `qq-personal-public/` 升级成 monorepo 骨架（含 LICENSE/NOTICE/.gitignore）
3. 补 4 个模块的 `node:test` 单测，让 CI 有东西可跑

---

## 附：开源后不承诺的事

- 不承诺支持多账号
- 不承诺群聊（除非有 PR）
- 不承诺兼容所有 DSH 版本
- 不提供个人 QQ 自动化相关的"反检测"建议
