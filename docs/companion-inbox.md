# Companion Inbox and Visual Stickers

Codex Companion Inbox is an optional second Telegram bot for asynchronous contact. The main bot remains the live Codex thread interface. The companion bot stores incoming and outgoing messages durably, writes a small unread notice, and lets the mainline bring that notice into the same Codex thread when the thread is idle.

The companion process is disabled by default. Its message store, attachments, notice file, sticker cache, and logs stay under `runtime/` and are ignored by Git.

## Setup

Copy the local example and configure a second BotFather token:

```powershell
copy config\companion-inbox.local.example.json config\companion-inbox.local.json
notepad config\companion-inbox.local.json
```

Start the companion process in a separate terminal:

```powershell
npm run companion
```

Windows users can also double-click `Start-CodexCompanionInbox.bat`.

Enable notice delivery in `config/codex-mainline.settings.json`:

```json
{
  "companion_inbox_enabled": true,
  "companion_inbox_notice_path": "runtime/companion_inbox/notice.json",
  "companion_inbox_read_command": "node src/start-codex-companion-inbox.mjs --read 10"
}
```

The companion token is optional for sticker-only administration. If companion credentials are absent, sticker commands can reuse the main bot credentials from `CODEX_MAINLINE_TG_*` or `config/telegram.local.json`.

## Message Commands

```powershell
node src/start-codex-companion-inbox.mjs --read 10
node src/start-codex-companion-inbox.mjs --read 10 --before 120
node src/start-codex-companion-inbox.mjs --send "Finished the long task."
node src/start-codex-companion-inbox.mjs --send-file notes\update.md
node src/start-codex-companion-inbox.mjs --send-photo output.png --caption "Result"
```

Reading marks incoming companion messages as read. New incoming messages write `runtime/companion_inbox/notice.json`; the mainline deduplicates notices by unread count, latest unread ID, and update time.

## Visual Sticker Shelf

Sticker sets are discovered from real incoming sticker messages. The main bot and companion bot share one catalog under `runtime/telegram_shared/sticker_sets/`. The catalog stores stable `file_unique_id` values and resolves the current bot-specific `file_id` only at send time.

List, refresh, inspect, and remove sets:

```powershell
node src/start-codex-companion-inbox.mjs --sticker-pack list
node src/start-codex-companion-inbox.mjs --sticker-pack discover
node src/start-codex-companion-inbox.mjs --sticker-pack refresh <set_name>
node src/start-codex-companion-inbox.mjs --sticker-pack preview <set_name> --offset 0 --count 12 --json
node src/start-codex-companion-inbox.mjs --sticker-pack remove <set_name>
```

The preview command refreshes the live set before every selection, downloads the current window, and generates a local visual atlas. It requires Python 3 and Pillow:

```powershell
python -m pip install Pillow
```

After visual selection, send by stable identity:

```powershell
node src/start-codex-companion-inbox.mjs --sticker-pack send <set_name> id:<file_unique_id>
```

The mainline can send the same sticker from an assistant reply:

```xml
<tg_send_sticker set="set_name" file_unique_id="stable_file_unique_id" />
```

Sticker pack order, additions, and removals are re-read from Telegram before preview or send, so stale numeric positions do not silently select a different sticker.

## Boundaries

- Use a private bot and an explicit allowed chat ID.
- Keep both local credential files outside Git.
- The mainline reads only the compact notice file. Message bodies enter Codex when the model runs the explicit `--read` command.
- Companion history archives old active records in bounded JSON shards while preserving read and delivery metadata.
