# Security

This project should be private-by-default in runtime behavior and public-safe in repository content.

Do not commit:

- Telegram bot tokens.
- Chat IDs or user allowlists.
- Local config files.
- Runtime state.
- Event logs.
- Payload sidecars.
- Private prompts.
- Private project notes or local operator files.

Recommended practices:

- Use environment variables for credentials.
- Keep long polling private and allowlist-bound.
- Avoid public webhooks until a deployment threat model exists.
- Do not accept high-risk actions from plain chat text without explicit confirmation.
- Keep file delivery explicit and path-validated.

## 安全边界

仓库内容必须公开安全，运行时默认保持私有。

不要提交：

- Telegram bot token。
- chat ID 或白名单。
- 本地配置文件。
- 运行状态。
- 事件日志。
- payload sidecar。
- 私有 prompt。
- 项目私有说明或本地操作文件。

建议：

- 凭据走环境变量。
- long polling 保持私有和白名单限制。
- 没有部署威胁模型前避免公共 webhook。
- 高风险动作不要只靠普通聊天文本触发。
- 文件交付必须显式、校验路径。
