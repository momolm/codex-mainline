# Codex Mainline

Codex Mainline is a Telegram interface and lifecycle layer for a persistent Codex app-server session.

It is not a reverse proxy and does not impersonate the Codex desktop app. It runs against the official `codex app-server` websocket interface provided by Codex CLI, then adds an external adaptation layer around it: Telegram transport, durable state, watchdog supervision, file delivery, language switching, context-compaction recovery, rhythm wakeups, and phone-first operation.

This repository contains the generic bridge code only. Credentials, runtime logs, chat history, local paths, and project-specific private material are not included.

Current status: initial public code migration with bilingual bridge output support for `zh-CN` and `en-US`.

## Why This Exists

Codex is strongest when it can stay connected to a real working directory, a real host machine, and a durable task context. Codex Mainline turns that into a practical always-available workflow:

- Use Telegram as the lightweight UI from phone or desktop.
- Keep one durable Codex thread alive across many messages.
- Let Codex operate the host through the official Codex runtime and installed tools.
- Keep the bridge clean: no reverse proxy, no unofficial model API emulation, no scraping.
- Let the system repair, upgrade, and iterate on itself when the host is online and the sandbox permits writes.

The result is a three-part decoupling:

- Codex runtime: the official Codex CLI app-server session.
- Telegram interface: private chat, images, files, commands, and mobile access.
- Host computer: filesystem, shell, browser/computer-use tools, and project workspace.

## Core Features

- Persistent Codex app-server thread saved in `runtime/tg_mainline/state.json`.
- Telegram private-chat bridge using Bot API long polling.
- Message forwarding into the same Codex context, including text, captions, photos, image documents, media groups, and bounded reply/quote context.
- Assistant replies relayed back to Telegram.
- Explicit local file delivery with `<tg_send_file path="..." />`.
- Bilingual bridge-layer mechanical output: `zh-CN` and `en-US`.
- Bridge-level slash commands that do not enter model context:
  - `/status`
  - `/effort`
  - `/language`
  - `/rhythm`
  - `/session`
  - `/history`
  - `/goal`
  - `/computer`
  - `/stop`
  - `/plan`
- Context compaction guard:
  - sends Telegram notices for compaction start/completion/failure/timeout;
  - queues normal messages during compaction;
  - retries failed compaction recovery with per-turn model/effort overrides;
  - injects a resume prompt after a failed compaction chain later succeeds.
- Watchdog supervision for long-running local operation.
- Optional rhythm wake messages for autonomous follow-up.
- Work-budget watcher for long active turns.
- Compact JSONL runtime diagnostics with payload sidecars for large records.
- Windows launch/stop helpers, including double-click `.bat` entrypoints.
- Computer-use request support when the host Codex environment has the relevant tools/plugin available.

## Requirements

Required:

- Windows 10/11 for the included PowerShell and `.bat` supervision scripts.
- Node.js 22 or newer.
- Codex CLI available as `codex`, with `codex app-server` support.
- A working Codex login or API-key setup for the CLI.
- A Telegram bot token from BotFather.
- A private Telegram chat ID allowed to talk to the bot.

Optional:

- Codex desktop app. Useful for login/session inspection and local troubleshooting, but not required by the bridge.
- A Telegram HTTP proxy, if Telegram Bot API is blocked on your network.
- Browser/computer-use tools in your Codex environment, if you want host UI automation.

The bridge starts app-server itself by default:

```powershell
codex app-server --listen ws://127.0.0.1:48751
```

You can also run a compatible app-server separately and point `app_server_endpoint` at it.

## Install

Clone the repository:

```powershell
git clone https://github.com/momolm/codex-mainline.git
cd codex-mainline
```

Install Node.js 22+ if needed, then install or update Codex CLI:

```powershell
npm install -g @openai/codex
codex --version
codex app-server --help
```

Authenticate Codex CLI:

```powershell
codex login
codex doctor --summary
```

Create local Telegram config:

```powershell
copy config\telegram.local.example.json config\telegram.local.json
notepad config\telegram.local.json
```

Fill:

```json
{
  "bot_token": "123456789:replace-with-your-telegram-bot-token",
  "allowed_chat_id": "123456789",
  "telegram_api_proxy_url": null
}
```

Run a dry-run check:

```powershell
npm run dry-run
```

Start from a terminal:

```powershell
npm start
```

Start supervised on Windows:

```powershell
.\scripts\Start-CodexMainlineWatchdog.ps1
```

Or double-click:

```text
Start-CodexMainline.bat
```

Stop both mainline and watchdog:

```text
Stop-CodexMainline.bat
```

More detailed setup notes are in [docs/installation.md](docs/installation.md).

## Windows Entrypoints

The repository root includes double-click entrypoints:

- `Start-CodexMainline.bat`: starts the watchdog and mainline in the background.
- `Start-CodexMainlineWatchdog.bat`: explicit watchdog startup entry.
- `Stop-CodexMainline.bat`: stops the mainline and watchdog.
- `Stop-CodexMainlineAndWatchdog.bat`: explicit stop-all entry.

The PowerShell scripts live in `scripts/`:

- `scripts/Start-CodexMainline.ps1`
- `scripts/Stop-CodexMainline.ps1`
- `scripts/Start-CodexMainlineWatchdog.ps1`
- `scripts/Watch-CodexMainline.ps1`

## Language

The default language is configured in `config/codex-mainline.settings.json`:

```json
{
  "locale": "zh-CN",
  "fallback_locale": "zh-CN",
  "locales_dir": "locales"
}
```

Supported values are `zh-CN` and `en-US`. You can switch at runtime from Telegram:

```text
/language en-US
/language zh-CN
```

Bridge-layer mechanical text lives in:

- `locales/zh-CN.json`
- `locales/en-US.json`

Text and prompt-path config values can be locale-keyed:

```json
{
  "rhythm_message_path": {
    "zh-CN": "prompts/rhythm_autonomous_action.zh-CN.md",
    "en-US": "prompts/rhythm_autonomous_action.en-US.md"
  }
}
```

## Configuration

Default settings live in `config/codex-mainline.settings.json`. The file is public-safe and committed. Secrets should live in environment variables or ignored local files.

Important fields:

- `locale`, `fallback_locale`, `locales_dir`: bridge output language and locale catalog directory.
- `codex_command`: command used to start Codex CLI.
- `app_server_endpoint`: websocket endpoint for `codex app-server`.
- `model`, `service_tier`, `effort`: default turn settings.
- `sandbox_mode`, `sandbox_network_access`, `sandbox_extra_writable_roots`: Codex sandbox policy for turns.
- `bot_token_env`, `allowed_chat_id_env`, `telegram_api_proxy_url_env`: environment variable names.
- `local_config_path`: ignored JSON file for local Telegram credentials.
- `state_path`: persisted bridge state.
- `runtime_dir`: local-only logs, attachments, generated images, sidecars, locks, and ready files.
- `bot_commands`: Telegram slash menu registered at startup.
- `startup_context_paths`: files included in the first startup prompt.
- `rhythm_*`: optional autonomous wake settings.
- `work_budget_*`: long-turn closeout settings.
- `context_compaction_*` and `compacting_*`: compaction trigger, retry, and user-visible behavior.

See [docs/configuration.md](docs/configuration.md) for details.

## Startup Context

`startup_context_paths` controls which files the first Codex turn is told to read. The committed default points at `docs/operator-context.example.md`.

For a real deployment, replace this with your own public or local instruction files. Keep private files local and ignored if they contain secrets or project-specific data that should not be published.

## File Delivery

When Codex needs to send a local file to Telegram, it should include this marker at the end of a normal assistant reply:

```xml
<tg_send_file path="relative/or/absolute/path.ext" />
```

The bridge removes the marker from visible text, validates the path, and sends images as photos and other files as documents. Files under `config/` and `runtime/` are blocked from delivery.

## Boundaries

- Codex Mainline is a local bridge around the official Codex CLI app-server. It is not a hosted service.
- The `codex app-server` command is marked experimental by Codex CLI, so protocol details may change across CLI versions.
- Official Codex authentication, model availability, rate limits, and safety behavior still apply.
- The host machine must be online for Telegram operation.
- Browser and computer-use workflows depend on the tools available in the local Codex environment.
- Do not expose the app-server websocket publicly without a separate threat model.
- Do not commit tokens, chat IDs, local state, runtime logs, attachment downloads, generated private files, or payload sidecars.

## Documentation

- [docs/installation.md](docs/installation.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/i18n.md](docs/i18n.md)
- [docs/security.md](docs/security.md)

---

# 中文说明

Codex Mainline 是一个围绕持久 Codex app-server session 构建的 Telegram 主线界面和生命周期层。

它不是反代，也不是模拟 Codex 桌面端。它使用 Codex CLI 提供的官方 `codex app-server` websocket 接口，在外层增加 Telegram 交互、持久状态、watchdog 保活、文件交付、语言切换、上下文压缩恢复、节律唤醒和手机优先操作能力。

这个仓库只包含通用桥接代码。不包含凭据、运行日志、聊天历史、本地路径或项目私有资料。

## 项目定位

Codex Mainline 的核心目标，是把 Codex 从“打开电脑前台操作的工具”，扩展成“能通过 Telegram 长期交互的本地主线”。

它实现三端解耦：

- Codex 运行端：官方 Codex CLI app-server session。
- Telegram 交互端：私聊、图片、文件、命令和手机入口。
- 本地电脑端：文件系统、shell、浏览器 / computer-use 工具和项目工作区。

因此，在电脑在线、watchdog 运行、权限配置允许的情况下，你可以直接通过 Telegram 让 Codex 修改、修复、升级和迭代 Codex Mainline 自身。

## 特色

- 以官方 Codex CLI app-server 为核心，不走反代，不伪造模型 API。
- Telegram 私聊作为轻量界面，手机和桌面都能使用。
- 运行态干净：私有凭据、本地日志、附件和状态都留在 ignored runtime/config 文件里。
- 一条持久 Codex thread 承接连续工作，不把每条 Telegram 消息割裂成新会话。
- 支持文本、图片、媒体组、引用上下文和本地文件回传。
- 支持中文 / 英文桥接层固定输出，可通过配置和 `/language` 切换。
- 支持 `/status`、`/effort`、`/language`、`/rhythm`、`/session`、`/history`、`/goal`、`/computer`、`/stop`、`/plan` 等桥接命令。
- 有上下文压缩保护、失败恢复、输入排队和恢复后续跑提示。
- 有 watchdog 保活和可选节律器，适合长时间本地运行。
- 在 Codex 环境具备对应工具时，可承接浏览器操作、computer use 和本地工程维护。

## 必须依赖

- Windows 10/11。
- Node.js 22 或更高版本。
- Codex CLI，且能运行 `codex app-server`。
- Codex CLI 已完成登录或 API key 配置。
- Telegram bot token。
- 允许访问 bot 的 Telegram 私聊 chat ID。

Codex App 不是硬依赖。它适合查看 session、登录状态和调试历史；真正运行时需要的是 Codex CLI 的 `codex app-server` 能力。

## 安装

```powershell
git clone https://github.com/momolm/codex-mainline.git
cd codex-mainline
npm install -g @openai/codex
codex --version
codex app-server --help
codex login
codex doctor --summary
```

创建本地 Telegram 配置：

```powershell
copy config\telegram.local.example.json config\telegram.local.json
notepad config\telegram.local.json
```

填入：

```json
{
  "bot_token": "123456789:replace-with-your-telegram-bot-token",
  "allowed_chat_id": "123456789",
  "telegram_api_proxy_url": null
}
```

检查配置：

```powershell
npm run dry-run
```

启动：

```powershell
npm start
```

Windows 日常使用可以直接双击：

```text
Start-CodexMainline.bat
Stop-CodexMainline.bat
```

`Start-CodexMainline.bat` 会启动 watchdog 和主线；`Stop-CodexMainline.bat` 会让主线和 watchdog 一起退出。

## 语言切换

默认语言在 `config/codex-mainline.settings.json` 中设置：

```json
{
  "locale": "zh-CN",
  "fallback_locale": "zh-CN",
  "locales_dir": "locales"
}
```

运行时也可以在 Telegram 里发送：

```text
/language en-US
/language zh-CN
```

桥接层固定提示和命令回复在 `locales/zh-CN.json` 与 `locales/en-US.json` 中维护。
