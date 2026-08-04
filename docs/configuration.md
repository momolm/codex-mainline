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
- `max_message_chars`: safe upper boundary for Telegram text blocks. The committed default is `4000`, leaving room below Telegram's 4096-character hard limit.
- `run_detail_output_preview_chars`: target size for a completed tool output preview. Large outputs retain a bounded head and tail with an omission marker; raw runtime evidence remains in `runtime_dir`.
- `input_collect_seconds`: sliding collection window for adjacent ordinary Telegram updates. The default is `1`; one message stays unwrapped, while multiple messages become one ordered input.
- `loose_media_collect_seconds`: additional collection time for media that Telegram delivers as separate updates without a media-group identifier.
- `rapid_empty_poll_backoff_seconds`: short backoff after an empty `getUpdates` response. It avoids an extra full polling interval while retaining bounded retry behavior.
- `turn_stall_timeout_seconds`: quiet-period threshold for recovering an active turn whose app-server event stream has stopped. Active reasoning, command, tool, web, image-generation, file-change, collaboration, and compaction items suspend the detector. Each turn receives at most one automatic recovery attempt.
- `turn_stall_recovery_notice`, `turn_stall_recovery_prompt`, `turn_stall_input_prompt`, `turn_stall_recovery_failed_notice`: locale-keyed user notice and continuation text for silent-turn recovery.
- `sticker_catalog_path`, `sticker_cache_dir`, `max_sticker_preview_count`: shared visual sticker catalog, cached preview media, and per-atlas selection limit.
- `companion_inbox_enabled`, `companion_inbox_notice_path`, `companion_inbox_read_command`: optional integration with the durable companion inbox described in [companion-inbox.md](companion-inbox.md).
- `startup_context_paths`: files listed in the startup prompt.
- `startup_autonomy_context_paths`: extra files listed only in autonomous wake startup prompts.
- `rhythm_enabled`, `rhythm_interval_seconds`, `rhythm_message_path`: optional wake loop. `rhythm_enabled` defaults to `false`; enable it explicitly with `/rhythm on` or config.
- `work_budget_seconds`, `work_budget_prompt_path`, `rest_seconds`: long-turn closeout and rest settings.
- `context_compaction_trigger_used_percent`: proactive compaction threshold. The default is `90`.
- `/compact`: bridge command that starts native compaction for the bound thread while no turn or compaction transition is active.
- `compaction_recovery_max_attempts`: pause-turn recovery budget after compaction failure.
- `compaction_recovery_pause_prompt`: short prompt sent on the recovery model after compaction failure.
- `compaction_recovery_resume_prompt`: prompt sent after failed-compaction recovery succeeds.
- `proactive_compaction_resume_prompt`: prompt sent after proactive compaction succeeds when no queued user input is waiting.
- `compaction_input_queue_path`, `compaction_replay_queue_path`: optional overrides for queued Telegram input and protected replay input paths. Defaults live under `runtime_dir`.
- `server_overloaded_continue_prompt`: optional override for the continuation prompt sent after an OpenAI `serverOverloaded` turn failure.

## Silent-Turn Recovery

The inactivity guard watches real app-server progress rather than wall-clock turn duration. User messages, Telegram polling, typing indicators, token snapshots, and steer acknowledgements do not reset it. Long reasoning and long-running tools remain valid active work because their open runtime items suspend detection.

When a genuinely quiet active turn reaches `turn_stall_timeout_seconds`, the bridge interrupts it and starts one same-thread continuation. An input that exposed the stall is carried into that continuation. If the recovery turn also becomes silent, automatic recovery stops and the bridge asks the operator to use `/stop`.

## MCP Runtime Control

`/mcp` reports the MCP servers, tools, authentication state, and startup state visible to the currently bound Codex thread. `/mcp reload` asks app-server to reread MCP configuration from disk, refreshes the current thread, and returns the resulting inventory. Both commands stay in the bridge layer and do not enter model context.

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
