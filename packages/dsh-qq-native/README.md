# dsh-qq-native

> A native QQ transport plugin for **DeepSeek Harness (DSH)**.
> Connects to a OneBot v11 endpoint (SnowLuma) from inside the plugin — no separate bridge process.

[![status](https://img.shields.io/badge/status-early%20preview-orange)](#status)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## What it is

This plugin makes a DSH agent reachable over QQ **without a middle process**:

```
QQ  ⇄  SnowLuma (OneBot v11: HTTP 3010 / WS 3011)
          ⇅
     dsh-qq-native  (this plugin, runs inside DSH)
          ⇅
     a DSH session (your existing conversation)
```

It handles the part that used to live in a separate "bridge" daemon:

- receive private messages over WebSocket
- batch them (so three quick lines trigger **one** reply, not three)
- build a prompt (persona + memory + recent context)
- ask the DSH session
- send the answer back, split into up to three bubbles

---

## Features

| Feature | Notes |
|---|---|
| Private chat | all messages from `ownerQQ`; no prefix needed |
| Message batching | 1.6 s window, hard cap 6 s, dedupe by `message_id` |
| Multi-bubble replies | split on newlines / sentence ends, 0.6–1.5 s apart |
| Memory injection | impressions + memory index + last few turns |
| Persona injection | once per session (saves tokens) |
| Memory writing | a reply line `记：...` is stored, **not** sent to QQ |
| Silence | reply `[SILENT]` to say nothing |
| Session reuse | remembers `sessionId`; can resume an existing conversation |
| L5 exploration | wakes on schedule, explores allowed directories, reports back |
| Task queue | continues queued tasks in work mode |
| Proactive messages | after long idle time, during daytime, capped per day |
| Cost accounting | token deltas written back for the console |
| Screen watch (read-only) | periodic screenshots, change detection, no input injection |
| Hobbies | self-directed "own time" notes that feed back into chat |

---

## Requirements

- Windows 10/11 (screen watch & some tools are Windows-specific; core chat is portable)
- Node.js **>= 22**
- DSH (DeepSeek Harness) with plugin support
- **SnowLuma** installed and logged in — *not bundled*, install it yourself

---

## Install

1. Place this package where DSH can link it, then register it in your DSH profile:

   ```jsonc
   // ~/.dsh/profiles/<profile>/package.json
   {
     "dependencies": { "dsh-qq-native": "link:C:/path/to/dsh-qq-native" },
     "dsh": { "profile": { "bundles": [ /* ... */ "dsh-qq-native" ] } }
   }
   ```

2. Copy `config.example.json` to `~/.dsh/qq-native/config.json` and fill in your values.

3. Restart DSH. Check `~/.dsh/qq-native/plugin.log`:

   ```
   [module] index.js 被加载
   [apply] runner 已启动
   [ws] 已连接
   ```

---

## Configuration

See [`config.example.json`](examples/config.example.json) and `docs/CONFIG.md`.
Data lives under `~/.dsh/qq-native/` (`state.json`, `plugin.log`, `data/`, `state/`).

---

## Security model

- Only replies to **one** QQ number (`ownerQQ`)
- Memory / persona / session data never leave your machine
- Screen watch is **read-only** (no mouse/keyboard injection) and off by default
- Emergency stop is honored via `capabilities.json` (`panic` flag)

See `docs/SECURITY.md` for the full model.

---

## Status

Early preview. Implemented: private chat, memory, persona, batching, multi-bubble,
L5 exploration, task queue, proactive messages, cost accounting, screen watch, hobbies.

Not implemented yet:

- group chat
- images / stickers / voice
- quote replies, poke
- full unread watermark

---

## Legal / responsible use

- This project automates a **personal** QQ account. That may violate Tencent's Terms of
  Service. **Use at your own risk**; no anti-detection features will be provided.
- SnowLuma is third-party software with its own EULA. It is **not** included here and must
  not be redistributed with this project.
- Nothing from a user's personal conversation, persona card, or memory database is part of
  this repository.

---

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) (third-party code under `vendor/`).
