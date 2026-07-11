# Codex Mainline

[English](README.en-US.md) | [中文](README.zh-CN.md)

Codex Mainline 是一个面向持久 Codex app-server session 的 Telegram 界面和生命周期层。

它不是反向代理，也不模拟 Codex 桌面应用。它基于 Codex CLI 提供的官方 `codex app-server` websocket 接口运行，并在其外层增加一个外部适应层：Telegram 传输、持久状态、watchdog 监督、文件交付、语言切换、上下文压缩恢复、节律唤醒，以及手机优先的操作方式。

这个仓库只包含通用桥接代码。不包含凭据、运行日志、聊天历史、本地路径或项目私有资料。

当前状态：公开桥接版本，支持双语桥接输出、watchdog 生命周期脚本、图片和文件输入，以及上下文压缩恢复。

## 为什么需要它

当 Codex 能持续连接真实工作目录、真实主机和持久任务上下文时，它最有用。Codex Mainline 把这一点变成一个实际可用、长期在线的工作流：

- 用 Telegram 作为手机和桌面都能使用的轻量界面。
- 让一条持久 Codex thread 承接多条消息。
- 让 Codex 通过官方 Codex runtime 和已安装工具操作主机。
- 保持桥接层干净：不做反代、不模拟非官方模型 API、不抓取应用 UI。
- 当主机在线且 sandbox 允许写入时，让系统能够修复、升级和迭代自身。

结果是三端解耦：

- Codex 运行端：官方 Codex CLI app-server session。
- Telegram 界面端：私聊、图片、文件、命令和移动端入口。
- 主机电脑端：文件系统、shell、浏览器 / computer-use 工具和项目工作区。

## 核心功能

- 持久 Codex app-server thread，保存在 `runtime/tg_mainline/state.json`。
- 基于 Bot API long polling 的 Telegram 私聊桥接。
- 把消息转入同一个 Codex 上下文，包括文本、caption、照片、图片文件、静态 sticker、Telegram 文件、媒体组和有边界的回复 / 引用上下文。
- 完整生成后的 assistant 回复通过 Telegram 原生 Rich Message Markdown 渲染；失败时自动回退纯文本，不维护流式渲染状态。
- 通过 `<tg_send_file path="..." />` 显式交付本地文件。
- 桥接层机械输出支持双语：`zh-CN` 和 `en-US`。
- 不进入模型上下文的桥接层 slash commands：
  - `/status`
  - `/model`
  - `/effort`
  - `/language`
  - `/rhythm`
  - `/session`
  - `/history`
  - `/goal`
  - `/computer`
  - `/stop`
  - `/plan`
- 可选安装的 `$effort` skill：在持续任务中由 Codex 主动判断，并在 `high`、`xhigh`、`max` 三档间持久换挡。
- 上下文压缩保护：
  - 默认在上下文使用率达到 90% 时主动压缩；
  - 发送压缩开始 / 完成 / 失败 / 超时的 Telegram 通知；
  - 压缩期间对普通消息排队；
  - 压缩失败后使用 `gpt-5.4-mini low` 发送短暂停 turn，以触发原生压缩恢复；
  - 失败链路之后如果压缩恢复成功，会注入继续任务的恢复提示。
- 面向长期本地运行的 watchdog 监督。
- 可选的自主跟进节律唤醒消息。
- 面向长 active turn 的工作预算提醒。
- 紧凑 JSONL 运行诊断，大 payload 使用 sidecar。
- Windows 启动 / 停止 helper，包括可双击的 `.bat` 入口。
- 当本地 Codex 环境具备相关工具 / plugin 时，支持 Computer Use 请求。

## 运行要求

必须项：

- Windows 10/11，用于随仓库提供的 PowerShell 和 `.bat` 监督脚本。
- Node.js 22 或更高版本。
- 可通过 `codex` 调用的 Codex CLI，并支持 `codex app-server`。
- Codex CLI 已完成登录或 API key 配置。
- 来自 BotFather 的 Telegram bot token。
- 一个允许访问 bot 的 Telegram 私聊 chat ID。

可选项：

- Codex 桌面应用。它适合检查登录 / session 和本地排障，但桥接器不依赖它运行。
- Telegram HTTP proxy，用于 Telegram Bot API 在你的网络中不可直连的情况。
- 浏览器 / computer-use 工具，用于主机 UI 自动化。

默认情况下，桥接器会自行启动 app-server：

```powershell
codex app-server --listen ws://127.0.0.1:48751
```

你也可以单独运行兼容的 app-server，并把 `app_server_endpoint` 指向它。

## 安装

克隆仓库：

```powershell
git clone https://github.com/momolm/codex-mainline.git
cd codex-mainline
```

如果需要，先安装 Node.js 22+，然后安装或更新 Codex CLI：

```powershell
npm install -g @openai/codex
codex --version
codex app-server --help
```

登录 Codex CLI：

```powershell
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

执行 dry-run 检查：

```powershell
npm run dry-run
```

从终端启动：

```powershell
npm start
```

在 Windows 上以监督模式启动：

```powershell
.\scripts\Start-CodexMainlineWatchdog.ps1
```

也可以双击：

```text
Start-CodexMainlineWatchdog.bat
```

停止 mainline 和 watchdog：

```text
Stop-CodexMainlineAndWatchdog.bat
```

更详细的安装说明见 [docs/installation.md](docs/installation.md)。

## Windows 入口

仓库根目录只暴露两个可双击入口：

- `Start-CodexMainlineWatchdog.bat`：启动 watchdog，并由 watchdog 监督 mainline。
- `Stop-CodexMainlineAndWatchdog.bat`：同时停止 mainline 和 watchdog。

PowerShell 脚本在 `scripts/` 下：

- `scripts/Start-CodexMainline.ps1`
- `scripts/Stop-CodexMainline.ps1`
- `scripts/Start-CodexMainlineWatchdog.ps1`
- `scripts/Watch-CodexMainline.ps1`

## 语言

默认语言在 `config/codex-mainline.settings.json` 中配置：

```json
{
  "locale": "zh-CN",
  "fallback_locale": "zh-CN",
  "locales_dir": "locales"
}
```

支持值为 `zh-CN` 和 `en-US`。你可以在 Telegram 中运行时切换：

```text
/language en-US
/language zh-CN
```

桥接层固定文本位于：

- `locales/zh-CN.json`
- `locales/en-US.json`

文本和 prompt 路径配置可以按 locale 分支：

```json
{
  "rhythm_message_path": {
    "zh-CN": "prompts/rhythm_autonomous_action.zh-CN.md",
    "en-US": "prompts/rhythm_autonomous_action.en-US.md"
  }
}
```

## 配置

默认配置位于 `config/codex-mainline.settings.json`。这个文件是公开安全的，并会提交到仓库。密钥应放在环境变量或 ignored 本地文件中。

重要字段：

- `locale`、`fallback_locale`、`locales_dir`：桥接输出语言和 locale catalog 目录。
- `codex_command`：用于启动 Codex CLI 的命令。
- `app_server_endpoint`：`codex app-server` 的 websocket endpoint。
- `model`、`service_tier`、`effort`：默认 turn 设置。`/model` 可从 Codex 本地可见模型缓存中运行时切换默认模型；`/effort` 从同一缓存动态读取并校验当前模型公布的推理档位，默认配置使用 `xhigh`。`service_tier` 默认是 `standard`；账号支持提速时可显式切到 `fast`。
- `sandbox_mode`、`sandbox_network_access`、`sandbox_extra_writable_roots`：turn 的 Codex sandbox 策略。
- `bot_token_env`、`allowed_chat_id_env`、`telegram_api_proxy_url_env`：环境变量名。
- `local_config_path`：保存本地 Telegram 凭据的 ignored JSON 文件。
- `state_path`：持久桥接状态。
- `runtime_dir`：仅本地使用的日志、附件、生成图片、sidecar、lock 和 ready 文件目录。
- `bot_commands`：启动时注册到 Telegram 的 slash menu。
- `startup_context_paths`：首个启动 prompt 中列出的文件。
- `startup_autonomy_context_paths`：只在自主唤醒启动 prompt 中额外列出的文件。
- `rhythm_*`：可选自主唤醒设置。`rhythm_enabled` 默认是 `false`；需要时用 `/rhythm on` 或配置显式开启。
- `work_budget_*`：长 turn 收尾设置。
- `context_compaction_*`、`compaction_recovery_*` 和 `compacting_*`：压缩触发、暂停 turn 恢复和用户可见行为；主动压缩默认阈值为 90%。
- `compaction_input_queue_path` 和 `compaction_replay_queue_path`：压缩期间收到的输入队列，以及压缩失败后受保护输入的重放队列。

详见 [docs/configuration.md](docs/configuration.md)。

可选持久 `$effort` skill 的安装和使用方式见 [docs/effort-skill.md](docs/effort-skill.md)。

## 启动上下文

`startup_context_paths` 控制首个 Codex turn 被要求读取哪些文件。提交的默认值指向 `docs/operator-context.example.md`。

`startup_autonomy_context_paths` 供自主唤醒 prompt 使用。普通一次性部署保持空数组；长期 mainline 会话可以指向精简的节律或自治说明。

真实部署时，请替换成你自己的公开或本地 instruction 文件。如果文件包含密钥或不应公开的项目特定资料，请保持其本地化并加入 ignored 范围。

## 文件交付

当 Codex 需要把本地文件发送到 Telegram 时，应在普通 assistant 回复末尾包含这个标记：

```xml
<tg_send_file path="relative/or/absolute/path.ext" />
```

桥接器会从可见文本中移除该标记，校验路径，并把图片作为 photo、其他文件通过 Telegram 文件上传发送。`config/` 和 `runtime/` 下的文件禁止交付。

## 边界

- Codex Mainline 是围绕官方 Codex CLI app-server 的本地桥接器，不是托管服务。
- `codex app-server` 命令在 Codex CLI 中标记为 experimental，因此协议细节可能随 CLI 版本变化。
- 官方 Codex 认证、模型可用性、rate limit 和安全行为仍然适用。
- Telegram 操作要求主机电脑保持在线。
- 浏览器和 computer-use 工作流取决于本地 Codex 环境中可用的工具。
- 没有单独威胁模型时，不要把 app-server websocket 暴露到公网。
- 不要提交 token、chat ID、本地状态、运行日志、附件下载、生成的私有文件或 payload sidecar。

## 文档

- [docs/installation.md](docs/installation.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/i18n.md](docs/i18n.md)
- [docs/codex-field-inheritance.md](docs/codex-field-inheritance.md)
- [docs/security.md](docs/security.md)
