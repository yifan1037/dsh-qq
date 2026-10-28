# 第三方代码说明（重要）

## qq-bridge

本仓库**不包含** `qq-bridge`。它是第三方 MIT 项目：

```
Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors
License: MIT
```

本项目在本地对它做过大量修改（适配 DSH、混合模式、权限、记忆、任务队列等）。
如果要一起开源，应当：

1. 以 **fork** 的形式发布，保留原版权声明和 LICENSE
2. 在 README/CHANGELOG 里写清「修改自 qq-bridge」，并列出主要改动
3. 不要声称 qq-bridge 部分是你原创

## SnowLuma

本仓库**不包含也不分发** SnowLuma。SnowLuma 的 EULA 禁止打包/再分发/自动部署。
使用者需要自行获取并安装，本仓库只通过 OneBot v11 协议与它通信。

## DSH

依赖 DeepSeek Harness（`@deepseek-ai/*`），按其自身许可使用。
