# Codex Mainline

> Status: public scaffold. Code migration has not started yet.

Codex Mainline is a planned open-source chat bridge for running a persistent Codex workflow through Telegram or another chat entry point. It is based on a private working system, but this repository starts empty on purpose: no private memory, handoff files, local credentials, runtime logs, personal prompts, or chat history are included.

The goal is a maintainer-friendly mainline: one durable Codex session, clear status commands, watchdog recovery, context-compaction handling, file delivery, and configurable user-facing output in Chinese or English.

## Features

Planned feature set:

- Persistent Codex app-server thread with saved session state.
- Telegram private-chat bridge using long polling.
- Direct bridge commands for status, effort, session switching, history search, stop/interrupt, and plan mode.
- Optional Computer Use handoff for desktop tasks when supported by the local Codex environment.
- Watchdog process that restarts the bridge without stopping the supervisor.
- Context compaction guard: notify users, queue normal messages during compaction, retry recovery, then resume.
- File delivery from local paths back to Telegram through an explicit marker.
- Incoming images, media groups, captions, and reply/quote context forwarding.
- Typing indicators and compact runtime detail blocks.
- Runtime logs designed for diagnostics, not for long-term memory.
- Configurable locale for mechanical output: `zh-CN` and `en-US`.

## Non-goals

- This project is not a general chatbot platform.
- It does not include private agent memory, personality files, handoff documents, local tokens, chat IDs, or runtime state.
- It should not hard-code one person's workflow, identity, or machine paths.
- It should not implement natural-language control with keyword tables. Control commands should be explicit commands, buttons, protocol events, or app-server RPC calls.

## Configuration

Configuration is expected to live in JSON files. A local config file should be ignored by Git, while an example config should be committed.

Minimal shape:

```json
{
  "locale": "en-US",
  "model": "gpt-5.5",
  "effort": "xhigh",
  "app_server_endpoint": "ws://127.0.0.1:48751",
  "runtime_dir": "runtime/mainline",
  "state_path": "runtime/mainline/state.json",
  "telegram": {
    "bot_token_env": "CODEX_MAINLINE_TELEGRAM_BOT_TOKEN",
    "allowed_chat_id_env": "CODEX_MAINLINE_TELEGRAM_ALLOWED_CHAT_ID",
    "api_proxy_url_env": "CODEX_MAINLINE_TELEGRAM_PROXY_URL"
  },
  "context_compaction": {
    "trigger_used_percent": 90,
    "window_seconds": 600,
    "recovery_max_attempts": 5
  }
}
```

Language switching should be a normal config change:

```json
{
  "locale": "zh-CN"
}
```

```json
{
  "locale": "en-US"
}
```

Protocol text such as JSON field names, app-server method names, XML pulse fields, and file-delivery markers must not be translated.

## Usage

The implementation is not migrated yet. The intended future flow is:

```powershell
git clone https://github.com/momolm/codex-mainline.git
cd codex-mainline
copy examples\config.en-US.json config.local.json
$env:CODEX_MAINLINE_TELEGRAM_BOT_TOKEN = "<telegram bot token>"
$env:CODEX_MAINLINE_TELEGRAM_ALLOWED_CHAT_ID = "<private chat id>"
node src\start-codex-mainline.mjs --config config.local.json
```

The local `config.local.json` and everything under `runtime/` should stay untracked.

## Repository Layout

Planned layout:

```text
src/                 Bridge implementation
locales/             zh-CN and en-US mechanical output strings
examples/            Safe example configs
docs/                Architecture, configuration, i18n, Telegram setup, security
runtime/             Local-only state and logs, ignored by Git
```

## Chinese

Codex Mainline 是一个计划开源的 Codex 聊天主线桥接工具。目标是让维护者可以通过 Telegram 或其他聊天入口运行一个持续的 Codex 工作流：单一持久 session、状态命令、看门狗恢复、上下文压缩保护、本地文件回传，以及可配置的中文 / 英文机械输出。

这个仓库从空白公开版本开始，不包含任何私有记忆、交接文件、本地凭据、运行日志、个人提示词或聊天历史。

### 主要功能

计划功能包括：

- 保存 Codex app-server thread，持续复用同一主线会话。
- Telegram 私聊 long polling bridge。
- `/status`、`/effort`、`/session`、`/history`、`/stop`、`/plan` 等桥接层命令。
- 可选 Computer Use 交接。
- watchdog 保活和重启恢复。
- 上下文压缩保护：通知、排队、恢复、继续。
- 本地文件显式回传 Telegram。
- 图片、相册、caption、reply / quote 上下文转发。
- typing 指示和紧凑运行细节。
- 诊断日志，不把 runtime 当长期记忆。
- 机械输出可配置为 `zh-CN` 或 `en-US`。

### 使用方式

代码尚未迁移。未来使用方式会类似：

```powershell
git clone https://github.com/momolm/codex-mainline.git
cd codex-mainline
copy examples\config.zh-CN.json config.local.json
$env:CODEX_MAINLINE_TELEGRAM_BOT_TOKEN = "<Telegram bot token>"
$env:CODEX_MAINLINE_TELEGRAM_ALLOWED_CHAT_ID = "<private chat id>"
node src\start-codex-mainline.mjs --config config.local.json
```

`config.local.json` 和 `runtime/` 不应提交到 Git。
