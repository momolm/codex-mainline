# Architecture

Codex Mainline is intended to be a thin transport and lifecycle layer around a single durable Codex app-server thread.

## Components

- Chat transport: receives private Telegram messages and sends visible replies.
- Codex session client: connects to the app-server websocket, resumes or starts a thread, and starts turns.
- State store: keeps thread ID, update offset, active turn ID, compaction state, and rate/context snapshots.
- Watchdog: supervises the bridge process and restarts it without deleting session state.
- Runtime logs: compact JSONL diagnostics, not long-term memory.
- Locales: mechanical output strings for `zh-CN` and `en-US`.

## Principles

- Keep semantic judgment inside the Codex context.
- Keep the shell thin: transport, timing, state, logs, and explicit commands.
- Do not classify natural-language control text with keyword tables.
- Separate user-visible mechanical text from internal diagnostics.
- Keep private local state out of Git.

## 架构

Codex Mainline 计划作为单一持久 Codex app-server thread 外的一层轻量传输和生命周期壳。

核心组件：

- 聊天传输层：接收 Telegram 私聊消息并发送可见回复。
- Codex session 客户端：连接 app-server websocket，恢复或创建 thread，并启动 turn。
- 状态存储：保存 thread ID、update offset、active turn、上下文压缩状态和限额快照。
- Watchdog：监督 bridge 进程，重启时不删除 session 状态。
- Runtime 日志：紧凑 JSONL 诊断，不作为长期记忆。
- Locales：`zh-CN` 与 `en-US` 机械输出文案。
