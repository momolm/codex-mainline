function xmlUnescape(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
function attributeValue(attrs, name) {
  const match = String(attrs || "").match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`, "i"));
  return match ? xmlUnescape(match[1] ?? match[2] ?? "").trim() : "";
}

export function extractTelegramDeliveries(text) {
  const files = [];
  const stickers = [];
  let cleaned = String(text || "").replace(
    /<tg_send_file\b([^>]*)\/?>\s*(?:<\/tg_send_file>)?/gi,
    (full, attrs) => {
      const filePath = attributeValue(attrs, "path");
      if (filePath && filePath !== "..." && !filePath.includes("...")) files.push(filePath);
      return "";
    },
  );
  cleaned = cleaned.replace(
    /<tg_send_sticker\b([^>]*)\/?>\s*(?:<\/tg_send_sticker>)?/gi,
    (full, attrs) => {
      const setName = attributeValue(attrs, "set");
      const indexText = attributeValue(attrs, "index");
      const fileUniqueId = attributeValue(attrs, "file_unique_id");
      const index = /^\d+$/.test(indexText) ? Number.parseInt(indexText, 10) : -1;
      const validFileUniqueId = /^[A-Za-z0-9_-]{1,256}$/.test(fileUniqueId) ? fileUniqueId : "";
      if (/^[A-Za-z0-9_]{1,128}$/.test(setName) && (index >= 0 || validFileUniqueId)) {
        const delivery = { setName };
        if (index >= 0) delivery.index = index;
        if (validFileUniqueId) delivery.fileUniqueId = validFileUniqueId;
        stickers.push(delivery);
      }
      return "";
    },
  );
  return { text: cleaned.trim(), files, stickers };
}
