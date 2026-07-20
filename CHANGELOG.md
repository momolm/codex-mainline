# Changelog

Notable project changes are recorded here. Release tags remain the authoritative package boundaries.

## [0.1.14] - 2026-07-21

### Added

- A shared visual sticker shelf with live pack discovery, preview atlases, and stable `file_unique_id` delivery.
- An optional durable Companion Inbox for asynchronous Telegram contact while preserving one Codex main thread.
- Silent-turn recovery that interrupts and continues a stopped app-server event stream without timing out active reasoning or tool work.

### Changed

- Adjacent ordinary Telegram updates now pass through a short sliding collection window and enter the model as one ordered input.
- Rich and forwarded Telegram inputs share the same normalized media and reply-context pipeline.
- Empty Telegram polls use a short bounded backoff to reduce visible input latency.

### Fixed

- User messages no longer remain trapped indefinitely behind an active turn whose model stream has silently stopped.

## [0.1.13] - 2026-07-15

### Added

- `/mcp` and `/mcp reload` for current-thread MCP inventory and native app-server hot reload.
- Stable dynamic continuation blocks for long Telegram run details.
- Bounded head-tail previews for large tool outputs.

### Changed

- Raised the committed Telegram text boundary to 4000 characters while retaining exact HTML-aware sizing for run-detail blocks.
- Kept completed continuation blocks immutable while the active tail continues to update.

## [0.1.12] - 2026-07-11

### Added

- Telegram native Rich Message Markdown for completed assistant replies, with plain-text fallback.

## [0.1.11] - 2026-07-10

### Added

- Optional persistent `$effort` shifts for sustained same-thread work.
- Runtime discovery and validation of each model's advertised reasoning levels.

[0.1.14]: https://github.com/momolm/codex-mainline/releases/tag/v0.1.14
[0.1.13]: https://github.com/momolm/codex-mainline/releases/tag/v0.1.13
[0.1.12]: https://github.com/momolm/codex-mainline/releases/tag/v0.1.12
[0.1.11]: https://github.com/momolm/codex-mainline/releases/tag/v0.1.11
