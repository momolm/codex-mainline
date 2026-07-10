# Configuration

The default committed config is `config/codex-mainline.settings.json`.

Use environment variables or `config/telegram.local.json` for local secrets. `*.local.json` is ignored by Git.

## Runtime Requirements

Codex Mainline needs a Codex app-server websocket endpoint. The default path is:

```powershell
codex app-server --listen ws://127.0.0.1:48751
```

That means the host must have:

- Node.js 22 or newer.
- Codex CLI available on `PATH` as `codex`.
- `codex app-server` support in that CLI.

Codex App is optional. It can be helpful for session inspection and local account troubleshooting, but it is not required by the bridge when the CLI can start app-server.

Advanced deployments may run app-server separately and set `app_server_endpoint` to that websocket URL. In that case the bridge connects to the existing endpoint instead of relying on the desktop app.

## Credential Loading

The runner reads credentials in this order:

1. Environment variables named by `bot_token_env`, `allowed_chat_id_env`, and `telegram_api_proxy_url_env`.
2. `local_config_path`, defaulting to `config/telegram.local.json`.
3. Public config values such as `telegram_api_proxy_url` for non-secret defaults.

Local file shape:

```json
{
  "bot_token": "123456789:replace-with-your-telegram-bot-token",
  "allowed_chat_id": "123456789",
  "telegram_api_proxy_url": null
}
```

## Important Settings

- `locale`: bridge output language. Supported values are `zh-CN` and `en-US`.
- `fallback_locale`: locale used when the active locale does not contain a key.
- `locales_dir`: directory containing locale JSON files.
- `codex_command`: command used to spawn Codex CLI when an app-server is not already ready.
- `app_server_endpoint`: websocket URL for the app-server. The default is `ws://127.0.0.1:48751`.
- `app_server_fallback_port_scan`: how many higher ports to scan when the configured endpoint is unavailable.
- `model`: default Codex model. `/model` can switch it at runtime using Codex's local visible model cache (`models_cache.json`).
- `service_tier`: service tier for turns. The default config uses `standard`; set `fast` only when the connected account supports it.
- `effort`: default reasoning effort. The default is `xhigh`; `/effort` reads the selected model's `supported_reasoning_levels` from Codex's local `models_cache.json`, so model-specific levels do not require bridge updates.
- `sandbox_mode`: `workspace-write`, `danger-full-access`, or `read-only`.
- `sandbox_network_access`: whether turns may use network in sandboxed modes.
- `sandbox_extra_writable_roots`: additional writable roots for `workspace-write`.
- `state_path`: bridge state file.
- `runtime_dir`: local-only runtime evidence directory.
- `bot_commands`: slash commands registered with Telegram.
- `startup_context_paths`: files listed in the startup prompt.
- `startup_autonomy_context_paths`: extra files listed only in autonomous wake startup prompts.
- `rhythm_enabled`, `rhythm_interval_seconds`, `rhythm_message_path`: optional wake loop. `rhythm_enabled` defaults to `false`; enable it explicitly with `/rhythm on` or config.
- `work_budget_seconds`, `work_budget_prompt_path`, `rest_seconds`: long-turn closeout and rest settings.
- `context_compaction_trigger_used_percent`: proactive compaction threshold. The default is `90`.
- `compaction_recovery_max_attempts`: pause-turn recovery budget after compaction failure.
- `compaction_recovery_pause_prompt`: short prompt sent on the recovery model after compaction failure.
- `compaction_recovery_resume_prompt`: prompt sent after failed-compaction recovery succeeds.
- `proactive_compaction_resume_prompt`: prompt sent after proactive compaction succeeds when no queued user input is waiting.
- `compaction_input_queue_path`, `compaction_replay_queue_path`: optional overrides for queued Telegram input and protected replay input paths. Defaults live under `runtime_dir`.
- `server_overloaded_continue_prompt`: optional override for the continuation prompt sent after an OpenAI `serverOverloaded` turn failure.

## Persistent Effort Shift

The optional `$effort` skill uses `runtime_dir/turn.request.json` as a one-request channel. The request is bound to the active Codex Mainline thread and origin turn. Runtime effort validation uses the selected model's live reasoning-level catalog.

Install and operating instructions are in [effort-skill.md](effort-skill.md).

## Language Maps

Text and prompt path settings may be plain strings or locale-keyed objects. Locale-keyed objects make the same config switch cleanly between Chinese and English:

```json
{
  "work_budget_prompt_path": {
    "zh-CN": "prompts/work_budget_rest.zh-CN.md",
    "en-US": "prompts/work_budget_rest.en-US.md"
  }
}
```

Bridge command replies, status text, compaction notices, and bot command descriptions live in:

- `locales/zh-CN.json`
- `locales/en-US.json`

The Telegram command `/language en-US` or `/language zh-CN` writes the selected locale back to `config/codex-mainline.settings.json`.

## Safety

Do not commit:

- Telegram bot tokens.
- Chat IDs or allowlists.
- `config/telegram.local.json`.
- Runtime state.
- Event logs.
- Downloaded attachments.
- Generated files that contain private data.
- Payload sidecars.
