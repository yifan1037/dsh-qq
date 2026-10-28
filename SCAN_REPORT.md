# 开源前扫描报告

生成时间：2026-10-27T12:30:37.653Z
输出目录：`qq-personal-public/`（只读复制，未改动任何现有文件）

## 已复制文件（13 个）

- `packages\dsh-qq-personal\package.json`（693 B）
- `packages\dsh-qq-personal\README.md`（762 B）
- `packages\dsh-qq-personal\cordis.patch.yml`（960 B）
- `packages\dsh-qq-personal\lib\index.js`（54279 B）
- `packages\dsh-qq-personal\lib\console.cjs`（56667 B）
- `packages\dsh-qq-personal\lib\client.js`（10084 B）
- `packages\dsh-qq-personal\lib\capabilities.js`（8768 B）
- `packages\dsh-qq-personal\lib\tasks.js`（7444 B）
- `packages\qq-agent-presets\package.json`（511 B）
- `packages\qq-agent-presets\qq-tool-restrict.mjs`（21668 B）
- `packages\qq-agent-presets\presets\qq-chat.patch.yml`（6759 B）
- `packages\qq-agent-presets\presets\qq-chat-v2.patch.yml`（11564 B）
- `packages\qq-agent-presets\presets\qq-work.patch.yml`（13091 B）

## 脱敏（已自动替换）

| 类型 | 替换为 |
|---|---|
| QQ 号 36****366 | 10001 |
| 机器人号 22****275 | 10002 |
| 名字「主人（真名）」 | 主人 |
| 人设名「角色名（真名）」 | 助手 |
| 本地绝对路径 | `<path>` / `<you>` |
| sk- 开头的 key | sk-EXAMPLE |

## 残留检查（1 个文件有残留）

### packages\dsh-qq-personal\lib\index.js
- 长 token（32+） × 4：`--------------------------------------------------------------------------- / ------------------------------------------`


> 说明：index.js 里命中的 4 个「长 token」都是注释分隔线（-----），误报，不是密钥。

## 未复制（按白名单排除）

- `state/`（social-v2、sessions、import 的 720 条私聊、l5-runs、explore.log）
- `roles/角色名（真名）.md`（私人人设卡）
- `personas/角色名（真名）-lean.md`（人设卡简版）
- `config.json` / `settings.json`（真实配置，含 token）
- `qq-memory/`、`tasks/`、`capabilities.json`
- 所有 `.bak-*` 备份（里面同样有数据）
- `qq-bridge`（第三方 MIT 项目的 fork，见 FORK_NOTES.md）
