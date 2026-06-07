# Installation

This guide covers a local Windows deployment of Codex Mainline.

## 1. Install Required Software

Required:

- Windows 10/11.
- Node.js 22 or newer.
- Git.
- Codex CLI with `codex app-server` support.

Install or update Codex CLI:

```powershell
npm install -g @openai/codex
codex --version
codex app-server --help
```

Authenticate:

```powershell
codex login
codex doctor --summary
```

You can also use API-key login if that matches your Codex setup:

```powershell
$env:OPENAI_API_KEY = "<your-api-key>"
$env:OPENAI_API_KEY | codex login --with-api-key
codex doctor --summary
```

Codex desktop app is optional. It is useful for inspection and troubleshooting, but Codex Mainline runs through Codex CLI and `codex app-server`.

## 2. Clone The Repository

```powershell
git clone https://github.com/momolm/codex-mainline.git
cd codex-mainline
```

The bridge currently uses Node.js built-ins and does not require project npm dependencies. If future versions add dependencies, run the install command documented in the release notes.

## 3. Create A Telegram Bot

1. Open Telegram and talk to `@BotFather`.
2. Use `/newbot`.
3. Copy the bot token.
4. Send one private message to your new bot.
5. Read your private chat ID from `getUpdates`.

PowerShell example:

```powershell
$token = "<telegram-bot-token>"
Invoke-RestMethod "https://api.telegram.org/bot$token/getUpdates"
```

Look for:

```json
{
  "message": {
    "chat": {
      "id": 123456789
    }
  }
}
```

Use that numeric `id` as `allowed_chat_id`.

If Telegram Bot API needs a proxy on your network, set `telegram_api_proxy_url` or the `CODEX_MAINLINE_TG_PROXY_URL` environment variable.

## 4. Configure Codex Mainline

Create the ignored local config:

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

You may use environment variables instead:

```powershell
$env:CODEX_MAINLINE_TG_BOT_TOKEN = "<telegram bot token>"
$env:CODEX_MAINLINE_TG_ALLOWED_CHAT_ID = "<private chat id>"
$env:CODEX_MAINLINE_TG_PROXY_URL = "http://127.0.0.1:7897"
```

## 5. Verify

```powershell
npm run dry-run
```

Then verify Codex app-server can start:

```powershell
codex app-server --listen ws://127.0.0.1:48751
```

Stop it with `Ctrl+C` after the check. The bridge can start it automatically during normal operation.

## 6. Start

Foreground terminal:

```powershell
npm start
```

PowerShell wrapper:

```powershell
.\scripts\Start-CodexMainline.ps1
```

Supervised background mode:

```powershell
.\scripts\Start-CodexMainlineWatchdog.ps1
```

Double-click mode:

```text
Start-CodexMainlineWatchdog.bat
```

Optional logon startup:

```powershell
.\scripts\Install-CodexMainlineStartup.ps1 -UseScheduledTask
```

This registers the watchdog at logon with highest privileges. To remove the startup entry:

```powershell
.\scripts\Install-CodexMainlineStartup.ps1 -Remove
```

## 7. Stop

Stop both mainline and watchdog:

```text
Stop-CodexMainlineAndWatchdog.bat
```

Or:

```powershell
.\scripts\Stop-CodexMainline.ps1 -StopWatchdog -InitialDelaySeconds 0
```

## 8. Optional Language Switch

Edit `config/codex-mainline.settings.json`:

```json
{
  "locale": "en-US"
}
```

Or send in Telegram:

```text
/language en-US
/language zh-CN
```

## 9. Operational Notes

- Keep the host machine online.
- Keep `config/telegram.local.json` private.
- Keep `runtime/` out of Git.
- The app-server websocket should stay on loopback unless you have a separate security design.
- If Codex CLI changes `app-server` behavior, update or pin the CLI version before running unattended.

---

# 安装说明

这份说明面向 Windows 本地部署。

## 1. 安装必须软件

必须项：

- Windows 10/11。
- Node.js 22 或更高版本。
- Git。
- 支持 `codex app-server` 的 Codex CLI。

安装或更新 Codex CLI：

```powershell
npm install -g @openai/codex
codex --version
codex app-server --help
```

登录并检查：

```powershell
codex login
codex doctor --summary
```

Codex App 是可选项。它适合查看 session 和排查登录状态，但 Codex Mainline 真正依赖的是 Codex CLI 和 `codex app-server`。

## 2. 克隆仓库

```powershell
git clone https://github.com/momolm/codex-mainline.git
cd codex-mainline
```

当前桥接器只使用 Node.js 内置模块，不需要项目级 npm 依赖。未来如果版本引入依赖，以 release notes 为准。

## 3. 创建 Telegram Bot

1. 在 Telegram 里打开 `@BotFather`。
2. 使用 `/newbot`。
3. 复制 bot token。
4. 给新 bot 发送一条私聊消息。
5. 通过 `getUpdates` 读取自己的私聊 chat ID。

PowerShell 示例：

```powershell
$token = "<telegram-bot-token>"
Invoke-RestMethod "https://api.telegram.org/bot$token/getUpdates"
```

找到：

```json
{
  "message": {
    "chat": {
      "id": 123456789
    }
  }
}
```

把这个数字写成 `allowed_chat_id`。

## 4. 配置

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

如果 Telegram Bot API 需要代理，设置 `telegram_api_proxy_url` 或环境变量 `CODEX_MAINLINE_TG_PROXY_URL`。

## 5. 检查和启动

```powershell
npm run dry-run
npm start
```

后台 watchdog 模式：

```powershell
.\scripts\Start-CodexMainlineWatchdog.ps1
```

或者双击：

```text
Start-CodexMainlineWatchdog.bat
```

可选：安装开机自启：

```powershell
.\scripts\Install-CodexMainlineStartup.ps1 -UseScheduledTask
```

这会用最高权限在登录时启动 watchdog。卸载：

```powershell
.\scripts\Install-CodexMainlineStartup.ps1 -Remove
```

关闭主线和 watchdog：

```text
Stop-CodexMainlineAndWatchdog.bat
```
