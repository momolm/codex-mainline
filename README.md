# Codex Mainline

[English](README.en-US.md) | [中文](README.zh-CN.md)

Codex Mainline is a Telegram interface and lifecycle layer for a persistent Codex app-server session.

It is not a reverse proxy and does not impersonate the Codex desktop app. It runs against the official `codex app-server` websocket interface provided by Codex CLI, then adds an external adaptation layer around it: Telegram transport, durable state, watchdog supervision, file delivery, language switching, context-compaction recovery, rhythm wakeups, and phone-first operation.

This repository contains the generic bridge code only. Credentials, runtime logs, chat history, local paths, and project-specific private material are not included.

Current status: public bridge with bilingual output, watchdog lifecycle scripts, static sticker image input, and context-compaction recovery support.

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
- Message forwarding into the same Codex context, including text, captions, photos, image documents, static stickers, media groups, and bounded reply/quote context.
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
  - after a failed compaction, sends a short pause turn with `gpt-5.4-mini low` to trigger native recovery;
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
Start-CodexMainlineWatchdog.bat
```

Stop both mainline and watchdog:

```text
Stop-CodexMainlineAndWatchdog.bat
```

More detailed setup notes are in [docs/installation.md](docs/installation.md).

## Windows Entrypoints

The repository root exposes two double-click entrypoints:

- `Start-CodexMainlineWatchdog.bat`: starts the watchdog and lets it supervise the mainline.
- `Stop-CodexMainlineAndWatchdog.bat`: stops both the mainline and the watchdog.

The PowerShell scripts live in `scripts/`:

- `scripts/Start-CodexMainline.ps1`
- `scripts/Stop-CodexMainline.ps1`
- `scripts/Start-CodexMainlineWatchdog.ps1`
- `scripts/Watch-CodexMainline.ps1`
- `scripts/Install-CodexMainlineStartup.ps1`

Optional Windows logon startup:

```powershell
.\scripts\Install-CodexMainlineStartup.ps1 -UseScheduledTask
```

`-UseScheduledTask` registers the watchdog at logon with highest privileges and removes the legacy Startup-folder entry if one exists. Omit it to install a hidden Startup-folder `.vbs` launcher instead.

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
- `model`, `service_tier`, `effort`: default turn settings. `service_tier` defaults to `standard`; use `fast` only when the connected account supports it.
- `sandbox_mode`, `sandbox_network_access`, `sandbox_extra_writable_roots`: Codex sandbox policy for turns.
- `bot_token_env`, `allowed_chat_id_env`, `telegram_api_proxy_url_env`: environment variable names.
- `local_config_path`: ignored JSON file for local Telegram credentials.
- `state_path`: persisted bridge state.
- `runtime_dir`: local-only logs, attachments, generated images, sidecars, locks, and ready files.
- `bot_commands`: Telegram slash menu registered at startup.
- `startup_context_paths`: files included in the first startup prompt.
- `startup_autonomy_context_paths`: extra files listed only for autonomous wake startup prompts.
- `rhythm_*`: optional autonomous wake settings. `rhythm_enabled` defaults to `false`; enable it explicitly with `/rhythm on` or config.
- `work_budget_*`: long-turn closeout settings.
- `context_compaction_*`, `compaction_recovery_*`, and `compacting_*`: compaction trigger, pause-turn recovery, and user-visible behavior.
- `compaction_input_queue_path` and `compaction_replay_queue_path`: runtime queues for inputs received during compaction and inputs protected for replay after compaction failure.

See [docs/configuration.md](docs/configuration.md) for details.

## Startup Context

`startup_context_paths` controls which files the first Codex turn is told to read. The committed default points at `docs/operator-context.example.md`.

`startup_autonomy_context_paths` is used by autonomous wake prompts. Keep it empty for ordinary one-shot deployments, or point it at compact rhythm/autonomy notes for long-lived mainline sessions.

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
- [docs/codex-field-inheritance.md](docs/codex-field-inheritance.md)
- [docs/security.md](docs/security.md)
