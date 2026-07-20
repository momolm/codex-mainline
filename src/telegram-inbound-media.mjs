import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function safeFileName(value, fallback = "file") {
  const cleaned = String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || fallback;
}
export function extensionFromTelegramFile(filePath, fallback = ".jpg") {
  return path.extname(String(filePath || "")).toLowerCase() || fallback;
}

function joinVisibleText(parts, separator = "\n") {
  return parts
    .map((part) => String(part || ""))
    .filter((part) => part.length > 0)
    .join(separator);
}

export function telegramRichTextPlainText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => telegramRichTextPlainText(item)).join("");
  }
  if (!value || typeof value !== "object") return "";

  if (value.type === "custom_emoji") return String(value.alternative_text || "");
  if (value.type === "mathematical_expression") return String(value.expression || "");
  if (value.type === "anchor") return "";
  if (Object.hasOwn(value, "text")) return telegramRichTextPlainText(value.text);
  return "";
}

function telegramRichCaptionPlainText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type) {
    return telegramRichTextPlainText(value);
  }
  return joinVisibleText([
    telegramRichTextPlainText(value.text),
    telegramRichTextPlainText(value.credit),
  ]);
}

function telegramRichBlocksPlainText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return joinVisibleText(blocks.map((block) => telegramRichBlockPlainText(block)));
}

function telegramRichListPlainText(items) {
  if (!Array.isArray(items)) return "";
  return joinVisibleText(items.map((item) => {
    if (!item || typeof item !== "object") return "";
    const body = telegramRichBlocksPlainText(item.blocks);
    const label = String(item.label || "");
    return label && body ? `${label} ${body}` : label || body;
  }));
}

function telegramRichTablePlainText(cells) {
  if (!Array.isArray(cells)) return "";
  return joinVisibleText(cells.map((row) => {
    if (!Array.isArray(row)) return "";
    return joinVisibleText(row.map((cell) => telegramRichTextPlainText(cell?.text)), "\t");
  }));
}

export function telegramRichBlockPlainText(block) {
  if (!block || typeof block !== "object") return "";
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "pre":
    case "footer":
    case "thinking":
      return telegramRichTextPlainText(block.text);
    case "divider":
    case "anchor":
      return "";
    case "mathematical_expression":
      return String(block.expression || "");
    case "list":
      return telegramRichListPlainText(block.items);
    case "blockquote":
      return joinVisibleText([
        telegramRichBlocksPlainText(block.blocks),
        telegramRichTextPlainText(block.credit),
      ]);
    case "pullquote":
      return joinVisibleText([
        telegramRichTextPlainText(block.text),
        telegramRichTextPlainText(block.credit),
      ]);
    case "collage":
    case "slideshow":
      return joinVisibleText([
        telegramRichBlocksPlainText(block.blocks),
        telegramRichCaptionPlainText(block.caption),
      ]);
    case "table":
      return joinVisibleText([
        telegramRichTextPlainText(block.caption),
        telegramRichTablePlainText(block.cells),
      ]);
    case "details":
      return joinVisibleText([
        telegramRichTextPlainText(block.summary),
        telegramRichBlocksPlainText(block.blocks),
      ]);
    case "map":
    case "animation":
    case "audio":
    case "photo":
    case "video":
    case "voice_note":
      return telegramRichCaptionPlainText(block.caption);
    default:
      return joinVisibleText([
        telegramRichTextPlainText(block.text),
        telegramRichTextPlainText(block.summary),
        telegramRichBlocksPlainText(block.blocks),
        telegramRichCaptionPlainText(block.caption),
        telegramRichTextPlainText(block.credit),
        telegramRichListPlainText(block.items),
        telegramRichTablePlainText(block.cells),
        typeof block.expression === "string" ? block.expression : "",
      ]);
  }
}

export function telegramRichMessageText(richMessage) {
  return telegramRichBlocksPlainText(richMessage?.blocks).trim();
}

export function telegramMessageText(message) {
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.caption === "string") return message.caption;
  return telegramRichMessageText(message?.rich_message);
}

function largestPhoto(message) {
  if (!Array.isArray(message?.photo) || message.photo.length === 0) return null;
  return [...message.photo].sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0))[0]
    ?? message.photo.at(-1)
    ?? null;
}

function stickerThumbnail(sticker) {
  return sticker?.thumbnail || sticker?.thumb || null;
}

export function telegramAttachmentDescriptors(message) {
  const descriptors = [];
  const photo = largestPhoto(message);
  if (photo?.file_id) {
    descriptors.push({
      kind: "photo",
      role: "content",
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id || null,
      fallbackName: "photo.jpg",
      mimeType: "image/jpeg",
      fileSize: Number(photo.file_size || 0),
      width: Number(photo.width || 0),
      height: Number(photo.height || 0),
    });
  }

  const document = message?.document;
  if (document?.file_id && String(document.mime_type || "").startsWith("image/")) {
    descriptors.push({
      kind: "image_document",
      role: "content",
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id || null,
      fallbackName: safeFileName(document.file_name || "image", "image"),
      mimeType: String(document.mime_type || ""),
      fileSize: Number(document.file_size || 0),
      width: null,
      height: null,
    });
  }

  const sticker = message?.sticker;
  if (sticker?.file_id) {
    const isAnimated = Boolean(sticker.is_animated);
    const isVideo = Boolean(sticker.is_video);
    descriptors.push({
      kind: "sticker",
      role: "content",
      fileId: sticker.file_id,
      fileUniqueId: sticker.file_unique_id || null,
      fallbackName: isAnimated ? "sticker.tgs" : isVideo ? "sticker.webm" : "sticker.webp",
      mimeType: isAnimated ? "application/x-tgsticker" : isVideo ? "video/webm" : "image/webp",
      fileSize: Number(sticker.file_size || 0),
      width: Number(sticker.width || 0),
      height: Number(sticker.height || 0),
      emoji: sticker.emoji || null,
      setName: sticker.set_name || null,
      isAnimated,
      isVideo,
    });

    const thumbnail = stickerThumbnail(sticker);
    if ((isAnimated || isVideo) && thumbnail?.file_id) {
      descriptors.push({
        kind: "sticker_preview",
        role: "preview",
        fileId: thumbnail.file_id,
        fileUniqueId: thumbnail.file_unique_id || null,
        fallbackName: "sticker-preview.jpg",
        mimeType: "image/jpeg",
        fileSize: Number(thumbnail.file_size || 0),
        width: Number(thumbnail.width || 0),
        height: Number(thumbnail.height || 0),
        emoji: sticker.emoji || null,
        setName: sticker.set_name || null,
        isAnimated,
        isVideo,
      });
    }
  }
  return descriptors;
}

export function imageDescriptorsFromTelegramMessage(message) {
  return telegramAttachmentDescriptors(message)
    .filter((item) => item.kind === "photo" || item.kind === "image_document" || (item.kind === "sticker" && !item.isAnimated && !item.isVideo))
    .map((item) => ({ fileId: item.fileId, fallbackName: item.fallbackName }));
}

export function telegramMessageKind(message) {
  if (Array.isArray(message?.photo) && message.photo.length > 0) return "photo";
  if (message?.sticker) return "sticker";
  if (message?.document) return String(message.document.mime_type || "").startsWith("image/") ? "image_document" : "document";
  const known = [
    "animation", "audio", "video", "voice", "video_note", "contact", "location",
    "venue", "poll", "dice", "game", "story", "paid_media",
  ];
  for (const key of known) {
    if (message?.[key] !== undefined && message[key] !== null) return key;
  }
  return telegramMessageText(message) ? "text" : "unknown";
}

export function telegramMessageShape(message) {
  const value = message && typeof message === "object" ? message : {};
  const topLevelKeys = Object.keys(value).sort();
  const nestedObjectKeys = {};

  for (const key of topLevelKeys) {
    const field = value[key];
    if (!field || typeof field !== "object" || Array.isArray(field)) continue;
    nestedObjectKeys[key] = Object.keys(field).sort();
  }

  return {
    message_id: Number.isFinite(Number(value.message_id)) ? Number(value.message_id) : null,
    top_level_keys: topLevelKeys,
    nested_object_keys: nestedObjectKeys,
  };
}

export async function downloadTelegramFile({
  token,
  filePath,
  outputPath,
  proxyUrl = null,
  cwd = process.cwd(),
}) {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  mkdirSync(path.dirname(outputPath), { recursive: true });
  if (proxyUrl) {
    const args = ["-fL", "-sS", "--max-time", "120", "-x", proxyUrl, "-o", outputPath, url];
    await new Promise((resolve, reject) => {
      const child = spawn("curl.exe", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`download file curl failed with code ${code}: ${stderr || "(no output)"}`));
      });
    });
    return outputPath;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`download file failed: HTTP ${response.status}`);
  writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
  return outputPath;
}
