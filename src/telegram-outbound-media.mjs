import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const TELEGRAM_PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export function isTelegramPhotoPath(filePath) {
  return TELEGRAM_PHOTO_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}
export function resolveTelegramDeliveryFilePath({
  workspaceRoot,
  filePath,
  maxBytes = 45 * 1024 * 1024,
  blockedPaths = [],
}) {
  const rawPath = String(filePath || "").trim();
  if (!rawPath) throw new Error("empty delivery file path");
  const resolved = path.resolve(workspaceRoot, rawPath);
  const item = existsSync(resolved) ? statSync(resolved) : null;
  if (!item) throw new Error(`delivery file does not exist: ${rawPath}`);
  if (!item.isFile()) throw new Error(`delivery path is not a file: ${rawPath}`);
  if (item.size > maxBytes) throw new Error(`delivery file is too large for Telegram: ${rawPath}`);
  const blocked = new Set(blockedPaths.map((itemPath) => path.resolve(itemPath).toLowerCase()));
  if (blocked.has(resolved.toLowerCase())) throw new Error(`delivery file is blocked: ${rawPath}`);
  return resolved;
}

export function telegramOutboundKind(filePath, requestedKind = "auto", fileSize = 0) {
  const kind = String(requestedKind || "auto").trim().toLowerCase();
  if (["photo", "document", "sticker"].includes(kind)) return kind;
  if (kind !== "auto") throw new Error(`unsupported Telegram media kind: ${requestedKind}`);
  if (isTelegramPhotoPath(filePath) && Number(fileSize || 0) <= 10 * 1024 * 1024) return "photo";
  return "document";
}

function telegramMediaMethod(kind) {
  if (kind === "photo") return { method: "sendPhoto", field: "photo" };
  if (kind === "sticker") return { method: "sendSticker", field: "sticker" };
  return { method: "sendDocument", field: "document" };
}

export async function telegramApiMultipartViaCurl({
  token,
  method,
  fields,
  files,
  proxyUrl = null,
  cwd = process.cwd(),
}) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const args = ["-fL", "-sS", "--max-time", "120", "-X", "POST"];
  if (proxyUrl) args.push("-x", proxyUrl);
  for (const [name, value] of Object.entries(fields || {})) args.push("-F", `${name}=${String(value)}`);
  for (const [name, localPath] of Object.entries(files || {})) args.push("-F", `${name}=@${localPath}`);
  args.push(url);

  return await new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${method} curl failed with code ${code}: ${stderr || stdout || "(no output)"}`));
        return;
      }
      try {
        const body = JSON.parse(stdout);
        if (!body.ok) reject(new Error(`${method} failed: ${JSON.stringify(body)}`));
        else resolve(body.result);
      } catch (error) {
        reject(new Error(`${method} returned non-JSON response: ${error.message}`));
      }
    });
  });
}
export async function sendTelegramLocalMedia({
  token,
  chatId,
  filePath,
  kind,
  caption = "",
  proxyUrl = null,
  cwd = process.cwd(),
}) {
  const selected = telegramMediaMethod(kind);
  if (selected.method === "sendSticker" && String(caption || "").trim()) {
    throw new Error("Telegram stickers do not support captions");
  }
  return await telegramApiMultipartViaCurl({
    token,
    method: selected.method,
    fields: {
      chat_id: chatId,
      ...(caption ? { caption } : {}),
    },
    files: { [selected.field]: filePath },
    proxyUrl,
    cwd,
  });
}
