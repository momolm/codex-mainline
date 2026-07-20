# Architecture

Codex Mainline is a thin transport and lifecycle layer around a single durable Codex app-server thread.

The bridge is built around `codex app-server`, not around the Codex desktop app. A desktop app can be useful beside it, but the runtime contract is the app-server websocket endpoint.

It is not a reverse proxy. It does not emulate a model API or scrape an app UI. The project relies on Codex CLI to provide the official app-server websocket, then adds an external adaptation layer for Telegram transport, state, supervision, language catalogs, and phone-first operation.

## Components

- Telegram transport: receives allowed private-chat messages, preserves forwarded/replied context, downloads supported media including static stickers, and sends visible replies.
- Input collector: holds one short sliding window for adjacent ordinary updates, then emits either one natural message or one ordered multi-message input.
- Codex session client: connects to the app-server websocket, resumes or starts a thread, and starts turns.
- App-server launcher: starts `codex app-server --listen <endpoint>` through Codex CLI when the configured endpoint is not already ready.
- State store: keeps thread ID, update offset, current and last turn evidence, compaction state, wake state, and rate/context snapshots.
- I18n catalog: loads bridge-layer mechanical output from `locales/<locale>.json`.
- Runtime logs: compact JSONL diagnostics, not documentation or source of truth.
- File delivery: extracts `<tg_send_file path="..." />`, validates local paths, and sends Telegram photos/documents.
- Sticker shelf: discovers live Telegram sticker sets, shares a stable `file_unique_id` catalog across bots, renders visual preview atlases, and resolves current bot-specific file IDs only when sending.
- Companion inbox: optional second Telegram bot for durable asynchronous contact; the main thread receives only a compact unread notice until it explicitly reads the messages.
- Run-detail renderer: keeps one live tail block, freezes completed continuation blocks, and stays within the exact Telegram HTML message boundary.
- Tool-output preview: captures a bounded stream window and renders head-tail completion previews without retaining unbounded command output in memory.
- MCP runtime control: lists or hot-reloads the MCP inventory for the currently bound Codex thread through native app-server RPCs.
- Compaction guard: watches context usage, starts compaction, queues input, sends pause-turn recovery after failure/timeout, and resumes work after recovery.
- Turn inactivity guard: watches model/runtime progress, suspends itself around open reasoning and tool items, and performs one same-thread recovery when an event stream becomes silent.
- Turn request channel: accepts one explicit request bound to the active thread and origin turn; the current action persists a validated effort and starts one same-thread continuation.
- PowerShell process layer: starts/stops the Node runner and supervises it with a watchdog on Windows.

## Principles

- Prefer official local Codex interfaces over unofficial network/API emulation.
- Keep semantic judgment inside the Codex context.
- Keep the runner thin: transport, timing, state, logs, and explicit commands.
- Do not classify natural-language control text with keyword tables.
- Bridge slash commands are explicit protocol commands and should not enter model context.
- User-visible bridge text should come from locale catalogs or locale-keyed config values, not hardcoded strings.
- Keep private local state out of Git.
- Treat `runtime/` as local evidence, not source of truth.

## Three-Part Decoupling

- Codex runtime: the official Codex CLI app-server process and durable thread.
- Telegram interface: private chat, media, files, slash commands, and mobile access.
- Host computer: local filesystem, shell, browser/computer-use tools, and project workspaces.

Codex Mainline connects these parts without requiring the Telegram UI, Codex runtime, and host operation surface to be the same application.

## Data Flow

1. Telegram long polling receives one or more updates.
2. The bridge validates the allowed chat ID.
3. Slash commands are handled by the bridge when possible.
4. Adjacent normal updates pass through one short sliding collection window, then become Codex input with pulse metadata, forwarded/reply context, and downloaded media.
5. The app-server turn streams items back to the bridge.
6. The inactivity guard records real progress and pauses its timer while reasoning or tool items remain open.
7. Tool events update compact run-detail blocks. Full blocks become stable continuations, while the last block remains live; large output previews keep a bounded head and tail.
8. A completed assistant reply is sent once through Telegram native Rich Message Markdown. Delivery directives may add validated local files or a sticker selected by stable identity.
9. Runtime evidence is written under `runtime/tg_mainline/`.

## MCP Hot Reload

The `/mcp` command family is a bridge protocol surface. Status reads `mcpServerStatus/list` with pagination for the current thread. Reload first calls `config/mcpServer/reload`, then rereads the same inventory. App-server startup notifications provide per-server progress or failure evidence without introducing a second MCP state machine in the bridge.

## Telegram Markdown Lifecycle

Markdown rendering stays outside the Node.js process. The bridge forwards one completed assistant string to Telegram Bot API `sendRichMessage` and retains no parsed document, render tree, incremental token buffer, or message-history cache. The request-local string and callbacks become collectible when delivery settles.

System notices, tool-detail cards, and file delivery retain their existing paths. Telegram streaming remains disabled. This keeps rendering work bounded to one finalized reply and prevents the bridge from repeatedly parsing or accumulating historical Markdown.
