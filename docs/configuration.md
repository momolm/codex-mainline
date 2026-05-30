# Configuration

Use committed example configs and an ignored local config.

Recommended files:

- `examples/config.en-US.json`
- `examples/config.zh-CN.json`
- `config.local.json` ignored by Git

Important fields:

- `locale`: `zh-CN` or `en-US`.
- `model`: Codex model name.
- `effort`: reasoning effort.
- `app_server_endpoint`: local app-server websocket URL.
- `runtime_dir`: local runtime evidence directory.
- `state_path`: bridge state file.
- `telegram.bot_token_env`: environment variable holding the Telegram bot token.
- `telegram.allowed_chat_id_env`: environment variable holding the private chat ID.

Do not commit tokens, chat IDs, runtime state, event logs, or local payload sidecars.

## 配置

建议提交 example config，把真实配置放在被 Git 忽略的 `config.local.json`。

关键字段：

- `locale`：`zh-CN` 或 `en-US`。
- `model`：Codex 模型名。
- `effort`：推理强度。
- `app_server_endpoint`：本地 app-server websocket 地址。
- `runtime_dir`：本地运行证据目录。
- `state_path`：bridge 状态文件。
- `telegram.bot_token_env`：保存 Telegram bot token 的环境变量名。
- `telegram.allowed_chat_id_env`：保存私聊 chat ID 的环境变量名。

不要提交 token、chat ID、运行状态、事件日志或 payload sidecar。
