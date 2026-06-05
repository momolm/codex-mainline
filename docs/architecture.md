# Architecture

Codex Mainline is a thin transport and lifecycle layer around a single durable Codex app-server thread.

The bridge is built around `codex app-server`, not around the Codex desktop app. A desktop app can be useful beside it, but the runtime contract is the app-server websocket endpoint.

It is not a reverse proxy. It does not emulate a model API or scrape an app UI. The project relies on Codex CLI to provide the official app-server websocket, then adds an external adaptation layer for Telegram transport, state, supervision, language catalogs, and phone-first operation.

## Components

- Telegram transport: receives allowed private-chat messages, downloads supported image inputs including static stickers, and sends visible replies.
- Codex session client: connects to the app-server websocket, resumes or starts a thread, and starts turns.
- App-server launcher: starts `codex app-server --listen <endpoint>` through Codex CLI when the configured endpoint is not already ready.
- State store: keeps thread ID, update offset, active turn ID, compaction state, wake state, and rate/context snapshots.
- I18n catalog: loads bridge-layer mechanical output from `locales/<locale>.json`.
- Runtime logs: compact JSONL diagnostics, not documentation or source of truth.
- File delivery: extracts `<tg_send_file path="..." />`, validates local paths, and sends Telegram photos/documents.
- Compaction guard: watches context usage, starts compaction, queues input, sends pause-turn recovery after failure/timeout, and resumes work after recovery.
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

1. Telegram long polling receives an update.
2. The bridge validates the allowed chat ID.
3. Slash commands are handled by the bridge when possible.
4. Normal messages are converted into Codex input, including pulse metadata and any downloaded images.
5. The app-server turn streams items back to the bridge.
6. Assistant text is relayed to Telegram; tool details are summarized in compact runtime blocks.
7. Runtime evidence is written under `runtime/tg_mainline/`.
