#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  downloadTelegramFile,
  extensionFromTelegramFile,
  safeFileName,
  telegramAttachmentDescriptors,
  telegramMessageKind,
  telegramMessageText,
} from "./telegram-inbound-media.mjs";
import {
  resolveTelegramDeliveryFilePath,
  sendTelegramLocalMedia,
  telegramOutboundKind,
} from "./telegram-outbound-media.mjs";
import {
  defaultStickerLibraryPaths,
  knownStickerSetNames,
  migrateStickerLibraryStorage,
  prepareStickerVisualSelection,
  registerStickerSetNames,
  refreshStickerSet,
  removeStickerSet,
  resolveStickerForSend,
  stickerSetList,
} from "./telegram-sticker-library.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_CONFIG = path.join(WORKSPACE_ROOT, "config", "companion-inbox.settings.json");

let TELEGRAM_PROXY_URL = null;

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG,
    mode: "serve",
    dryRun: false,
    once: false,
    limit: null,
    before: null,
    text: null,
    textFile: null,
    sendStdin: false,
    mediaPath: null,
    mediaKind: null,
    caption: null,
    captionFile: null,
    stickerAction: null,
    stickerSetName: null,
    stickerIndex: null,
    stickerFileUniqueId: null,
    stickerOffset: 0,
    stickerCount: 12,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      i += 1;
      if (i >= argv.length) throw new Error("--config requires a path");
      options.configPath = argv[i];
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--once") {
      options.once = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--self-test") {
      options.mode = "self-test";
    } else if (arg === "--read") {
      options.mode = "read";
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        i += 1;
        options.limit = Number.parseInt(next, 10);
      }
    } else if (arg === "--before") {
      i += 1;
      if (i >= argv.length) throw new Error("--before requires a message id");
      options.before = Number.parseInt(argv[i], 10);
    } else if (arg === "--send") {
      options.mode = "send";
      i += 1;
      if (i >= argv.length) throw new Error("--send requires text");
      options.text = argv[i];
    } else if (arg === "--send-file") {
      options.mode = "send";
      i += 1;
      if (i >= argv.length) throw new Error("--send-file requires a path");
      options.textFile = argv[i];
    } else if (arg === "--send-stdin") {
      options.mode = "send";
      options.sendStdin = true;
    } else if (["--send-media", "--send-photo", "--send-document", "--send-sticker"].includes(arg)) {
      options.mode = "send-media";
      options.mediaKind = {
        "--send-media": "auto",
        "--send-photo": "photo",
        "--send-document": "document",
        "--send-sticker": "sticker",
      }[arg];
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a path`);
      options.mediaPath = argv[i];
    } else if (arg === "--caption") {
      i += 1;
      if (i >= argv.length) throw new Error("--caption requires text");
      options.caption = argv[i];
    } else if (arg === "--caption-file") {
      i += 1;
      if (i >= argv.length) throw new Error("--caption-file requires a path");
      options.captionFile = argv[i];
    } else if (arg === "--sticker-pack") {
      options.mode = "sticker-pack";
      i += 1;
      if (i >= argv.length) throw new Error("--sticker-pack requires an action");
      options.stickerAction = String(argv[i]).trim().toLowerCase();
      if (["add", "refresh", "remove", "preview", "send"].includes(options.stickerAction)) {
        i += 1;
        if (i >= argv.length) throw new Error(`--sticker-pack ${options.stickerAction} requires a set name`);
        options.stickerSetName = argv[i];
      }
      if (options.stickerAction === "send") {
        i += 1;
        if (i >= argv.length) throw new Error("--sticker-pack send requires an index or id:<file_unique_id>");
        const selector = String(argv[i]);
        if (selector.startsWith("id:") && selector.length > 3) {
          options.stickerFileUniqueId = selector.slice(3);
          if (!/^[A-Za-z0-9_-]{1,256}$/.test(options.stickerFileUniqueId)) {
            throw new Error("invalid sticker file_unique_id");
          }
        } else if (/^\d+$/.test(selector)) {
          options.stickerIndex = Number.parseInt(selector, 10);
        } else {
          throw new Error("sticker selector must be an index or id:<file_unique_id>");
        }
      }
      if (!["list", "discover", "add", "refresh", "remove", "preview", "send"].includes(options.stickerAction)) {
        throw new Error(`unsupported sticker pack action: ${options.stickerAction}`);
      }
    } else if (arg === "--offset") {
      i += 1;
      if (i >= argv.length) throw new Error("--offset requires a number");
      options.stickerOffset = Number.parseInt(argv[i], 10);
    } else if (arg === "--count") {
      i += 1;
      if (i >= argv.length) throw new Error("--count requires a number");
      options.stickerCount = Number.parseInt(argv[i], 10);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function resolveWorkspacePath(value) {
  if (!value || typeof value !== "string") throw new Error("Path value is empty.");
  return path.isAbsolute(value) ? value : path.join(WORKSPACE_ROOT, value);
}

function normalizeSendText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\\n|\/n/g, "\n");
}

function readSendText(options) {
  const inputKinds = [
    options.text !== null,
    options.textFile !== null,
    options.sendStdin,
  ].filter(Boolean).length;
  if (inputKinds !== 1) throw new Error("send mode requires exactly one of --send, --send-file, or --send-stdin");
  if (options.textFile !== null) return normalizeSendText(readFileSync(resolveWorkspacePath(options.textFile), "utf8"));
  if (options.sendStdin) return normalizeSendText(readFileSync(0, "utf8"));
  return normalizeSendText(options.text);
}

function readMediaCaption(options) {
  if (options.caption !== null && options.captionFile !== null) {
    throw new Error("media send accepts only one of --caption or --caption-file");
  }
  if (options.captionFile !== null) {
    return normalizeSendText(readFileSync(resolveWorkspacePath(options.captionFile), "utf8"));
  }
  return options.caption === null ? "" : normalizeSendText(options.caption);
}

function resolveOutboundMediaPath(config, filePath) {
  const blockedPaths = [
    resolveWorkspacePath(String(config.local_config_path)),
    path.join(WORKSPACE_ROOT, "config", "telegram.local.json"),
    path.join(WORKSPACE_ROOT, "config", "companion-inbox.local.json"),
    resolveWorkspacePath(String(config.state_path)),
  ];
  return resolveTelegramDeliveryFilePath({
    workspaceRoot: WORKSPACE_ROOT,
    filePath,
    maxBytes: Math.max(1, Math.trunc(numberFromConfig(config, "outbound_attachment_max_bytes", 45 * 1024 * 1024))),
    blockedPaths,
  });
}

function stickerCatalogPath(config) {
  if (config.sticker_catalog_path) return resolveWorkspacePath(String(config.sticker_catalog_path));
  return defaultStickerLibraryPaths(WORKSPACE_ROOT).catalogPath;
}

function stickerCacheDir(config) {
  if (config.sticker_cache_dir) return resolveWorkspacePath(String(config.sticker_cache_dir));
  return defaultStickerLibraryPaths(WORKSPACE_ROOT).cacheDir;
}

function formatStickerSetEntries(config, entries) {
  if (!entries.length) return companionText(config, "贴纸书架为空。", "The sticker shelf is empty.");
  const unit = companionText(config, "张", "stickers");
  return entries.map((entry) => `${entry.title} | ${entry.name} | ${entry.sticker_count} ${unit}`).join("\n");
}

function discoveredStickerSets(config, db) {
  const registered = new Set(stickerSetList(stickerCatalogPath(config)).map((entry) => entry.name));
  const names = knownStickerSetNames(allMessages(config, db));
  return names.map((name) => ({ name, registered: registered.has(name) }));
}

function formatDiscoveredStickerSets(config, entries) {
  if (!entries.length) return companionText(config, "伴随信箱消息史中尚未发现贴纸包。", "No sticker sets were found in companion history.");
  return entries.map((entry) => `${entry.registered
    ? companionText(config, "[已加入]", "[registered]")
    : companionText(config, "[待选择]", "[available]")} ${entry.name}`).join("\n");
}

function formatStickerVisualSelection(config, result) {
  const unit = companionText(config, "张", "stickers");
  const header = `${result.set.title} | ${result.set.name} | ${result.set.sticker_count} ${unit}`;
  const lines = result.stickers.map((sticker) => {
    const selector = sticker.file_unique_id ? `id:${sticker.file_unique_id}` : `index:${sticker.index}`;
    return `[${String(sticker.label).padStart(2, "0")}] #${sticker.index} ${sticker.emoji || ""} ${selector}`.trim();
  });
  return [header, `${companionText(config, "视觉索引", "visual atlas")}: ${result.atlas_path}`, ...lines].join("\n");
}

async function getStickerSetFromTelegram(token, setName) {
  return await telegramApi(token, "getStickerSet", { name: setName });
}

async function handleStickerPackCommand({ config, db, options, runtimeDir }) {
  const catalogPath = stickerCatalogPath(config);
  const cacheDir = stickerCacheDir(config);
  if (options.stickerAction === "list") {
    const entries = stickerSetList(catalogPath);
    console.log(options.json ? JSON.stringify(entries, null, 2) : formatStickerSetEntries(config, entries));
    return;
  }
  if (options.stickerAction === "discover") {
    const entries = discoveredStickerSets(config, db);
    console.log(options.json ? JSON.stringify(entries, null, 2) : formatDiscoveredStickerSets(config, entries));
    return;
  }
  if (options.stickerAction === "remove") {
    const result = await removeStickerSet({ catalogPath, cacheDir, setName: options.stickerSetName });
    console.log(options.json ? JSON.stringify(result, null, 2) : result.removed ? `removed=${result.set_name}` : `not_registered=${result.set_name}`);
    return;
  }

  const secrets = loadSecrets(config);
  TELEGRAM_PROXY_URL = secrets.proxyUrl;
  const getStickerSet = (setName) => getStickerSetFromTelegram(secrets.token, setName);
  if (options.stickerAction === "add" || options.stickerAction === "refresh") {
    const entry = await refreshStickerSet({ catalogPath, setName: options.stickerSetName, getStickerSet });
    console.log(options.json ? JSON.stringify(entry, null, 2) : `registered=${entry.name} title=${entry.title} stickers=${entry.sticker_count}`);
    return;
  }
  if (options.stickerAction === "preview") {
    const maxCount = Math.max(1, Math.trunc(numberFromConfig(config, "max_sticker_preview_count", 24)));
    const count = Math.max(1, Math.min(Number.isFinite(options.stickerCount) ? options.stickerCount : 12, maxCount));
    const result = await prepareStickerVisualSelection({
      catalogPath,
      cacheDir,
      setName: options.stickerSetName,
      offset: Number.isFinite(options.stickerOffset) ? options.stickerOffset : 0,
      limit: count,
      getStickerSet,
      getTelegramFile: (fileId) => telegramApi(secrets.token, "getFile", { file_id: fileId }),
      downloadFile: ({ filePath, outputPath }) => downloadTelegramFile({
        token: secrets.token,
        filePath,
        outputPath,
        proxyUrl: TELEGRAM_PROXY_URL,
        cwd: WORKSPACE_ROOT,
      }),
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatStickerVisualSelection(config, result));
    return;
  }
  if (options.stickerAction === "send") {
    const { sticker, fileId } = await resolveStickerForSend({
      catalogPath,
      setName: options.stickerSetName,
      index: options.stickerIndex,
      fileUniqueId: options.stickerFileUniqueId,
      getStickerSet,
    });
    const stored = appendMessage(config, db, {
      direction: "codex_to_operator",
      sender: "codex",
      text: "",
      content_type: "sticker",
      attachments: [{
        kind: "sticker",
        role: "content",
        set_name: options.stickerSetName,
        sticker_index: sticker.index,
        file_unique_id: sticker.file_unique_id,
        emoji: sticker.emoji,
        is_animated: sticker.is_animated,
        is_video: sticker.is_video,
        local_path: sticker.preview_path,
        status: "pending",
        error: null,
      }],
    });
    try {
      const result = await telegramApi(secrets.token, "sendSticker", {
        chat_id: secrets.allowedChatId,
        sticker: fileId,
      });
      markDelivered(config, db, stored.id, [result?.message_id].filter(Number.isInteger));
      appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
        direction: "send_sticker_from_set",
        message_id: result?.message_id ?? null,
        id: stored.id,
        set_name: options.stickerSetName,
        sticker_index: sticker.index,
      });
      console.log(`sent=#${stored.id} sticker_set=${options.stickerSetName} index=${sticker.index}`);
      return;
    } catch (error) {
      markDeliveryFailed(config, db, stored.id, error);
      throw error;
    }
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function readJsonIfExists(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return readJson(filePath);
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...value })}\n`, "utf8");
}

function iso(date = new Date()) {
  return date.toISOString();
}

function numberFromConfig(config, key, fallback) {
  const raw = config[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

function companionText(config, zhCN, enUS) {
  return String(config?.locale || "zh-CN").toLowerCase() === "en-us" ? enUS : zhCN;
}

function clampWindow(config, value) {
  const fallback = Math.trunc(numberFromConfig(config, "default_window", 10));
  const maxWindow = Math.trunc(numberFromConfig(config, "max_window", 50));
  const parsed = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(1, Math.min(parsed, maxWindow));
}

function loadLocalConfig(config) {
  const localConfigPath = resolveWorkspacePath(String(config.local_config_path));
  return existsSync(localConfigPath) ? readJson(localConfigPath) : {};
}

function loadSecrets(config) {
  const local = loadLocalConfig(config);
  const mainlineLocalPath = path.join(WORKSPACE_ROOT, "config", "telegram.local.json");
  const mainlineLocal = existsSync(mainlineLocalPath) ? readJson(mainlineLocalPath) : {};
  const proxyEnv = String(config.telegram_api_proxy_url_env || "CODEX_COMPANION_TG_PROXY_URL");
  const token = process.env[String(config.bot_token_env)]
    || local.bot_token
    || process.env.CODEX_MAINLINE_TG_BOT_TOKEN
    || mainlineLocal.bot_token;
  const allowedChatId = process.env[String(config.allowed_chat_id_env)]
    || local.allowed_chat_id
    || process.env.CODEX_MAINLINE_TG_ALLOWED_CHAT_ID
    || mainlineLocal.allowed_chat_id;
  const proxyUrl = process.env[proxyEnv]
    || local.telegram_api_proxy_url
    || local.proxy_url
    || process.env.CODEX_MAINLINE_TG_PROXY_URL
    || mainlineLocal.telegram_api_proxy_url
    || config.telegram_api_proxy_url
    || null;
  if (!token) throw new Error(`Missing Telegram bot token. Set ${config.bot_token_env} or ${config.local_config_path}`);
  if (!allowedChatId) throw new Error(`Missing allowed chat id. Set ${config.allowed_chat_id_env} or ${config.local_config_path}`);
  return { token: String(token), allowedChatId: String(allowedChatId), proxyUrl: proxyUrl ? String(proxyUrl) : null };
}

function peekSecrets(config) {
  const local = loadLocalConfig(config);
  const mainlineLocalPath = path.join(WORKSPACE_ROOT, "config", "telegram.local.json");
  const mainlineLocal = existsSync(mainlineLocalPath) ? readJson(mainlineLocalPath) : {};
  const proxyEnv = String(config.telegram_api_proxy_url_env || "CODEX_COMPANION_TG_PROXY_URL");
  return {
    hasToken: Boolean(process.env[String(config.bot_token_env)] || local.bot_token || process.env.CODEX_MAINLINE_TG_BOT_TOKEN || mainlineLocal.bot_token),
    allowedChatId: process.env[String(config.allowed_chat_id_env)] || local.allowed_chat_id || process.env.CODEX_MAINLINE_TG_ALLOWED_CHAT_ID || mainlineLocal.allowed_chat_id || null,
    proxyUrl: process.env[proxyEnv] || local.telegram_api_proxy_url || local.proxy_url || process.env.CODEX_MAINLINE_TG_PROXY_URL || mainlineLocal.telegram_api_proxy_url || config.telegram_api_proxy_url || null,
    localConfigPath: resolveWorkspacePath(String(config.local_config_path)),
  };
}

function loadState(statePath) {
  return {
    schema_version: 1,
    update_offset: null,
    ...readJsonIfExists(statePath, {}),
  };
}

function saveState(statePath, state) {
  writeJson(statePath, { schema_version: 1, ...state });
}

function emptyDb() {
  return {
    schema_version: 1,
    next_id: 1,
    active_archive: {
      policy: "archive_old_messages",
    },
    messages: [],
  };
}

function normalizeDb(raw) {
  const db = { ...emptyDb(), ...(raw && typeof raw === "object" ? raw : {}) };
  db.next_id = Number.isInteger(db.next_id) && db.next_id > 0 ? db.next_id : 1;
  db.messages = Array.isArray(db.messages)
    ? db.messages.filter((item) => Number.isInteger(item?.id)).map(normalizeMessage)
    : [];
  return db;
}

function loadDb(config) {
  return normalizeDb(readJsonIfExists(resolveWorkspacePath(String(config.message_store_path)), emptyDb()));
}

function normalizeMessage(item) {
  const message = { ...item };
  message.text = String(message.text || "");
  message.content_type = String(message.content_type || (message.text ? "text" : "unknown"));
  message.attachments = Array.isArray(message.attachments)
    ? message.attachments.filter((attachment) => attachment && typeof attachment === "object").map((attachment) => ({ ...attachment }))
    : [];
  if (message.direction === "operator_to_codex") {
    message.codex_read_at = message.codex_read_at ?? message.read_at ?? null;
  } else if (message.direction === "codex_to_operator") {
    message.delivered_at = message.delivered_at ?? null;
    message.operator_ack_at = message.operator_ack_at ?? null;
    if (message.telegram_message_ids === undefined && message.telegram_message_id !== undefined && message.telegram_message_id !== null) {
      message.telegram_message_ids = [message.telegram_message_id];
    }
  }
  return message;
}

function archiveDir(config) {
  if (config.message_archive_dir) return resolveWorkspacePath(String(config.message_archive_dir));
  return path.join(path.dirname(resolveWorkspacePath(String(config.message_store_path))), "archive");
}

function activeMessageLimit(config) {
  return Math.max(1, Math.trunc(numberFromConfig(config, "active_message_limit", numberFromConfig(config, "retention_limit", 5000))));
}

function archiveBatchSize(config) {
  return Math.max(1, Math.trunc(numberFromConfig(config, "archive_batch_size", 1000)));
}

function archiveFileName(messages) {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const timestamp = iso().replace(/[:.]/g, "-");
  return `messages-${String(first.id).padStart(8, "0")}-${String(last.id).padStart(8, "0")}-${timestamp}.json`;
}

function writeArchiveMessages(config, messages) {
  if (!messages.length) return null;
  const dir = archiveDir(config);
  mkdirSync(dir, { recursive: true });
  const first = messages[0];
  const last = messages[messages.length - 1];
  const archivePath = path.join(dir, archiveFileName(messages));
  writeJson(archivePath, {
    schema_version: 1,
    archived_at: iso(),
    start_id: first.id,
    end_id: last.id,
    count: messages.length,
    messages,
  });
  return archivePath;
}

function archiveOldMessages(config, db) {
  const limit = activeMessageLimit(config);
  if (db.messages.length <= limit) return [];
  const excess = db.messages.length - limit;
  const archived = db.messages.slice(0, excess);
  db.messages = db.messages.slice(excess);
  const batchSize = archiveBatchSize(config);
  const paths = [];
  for (let index = 0; index < archived.length; index += batchSize) {
    const archivePath = writeArchiveMessages(config, archived.slice(index, index + batchSize));
    if (archivePath) paths.push(archivePath);
  }
  return paths;
}

function saveDb(config, db) {
  archiveOldMessages(config, db);
  writeJson(resolveWorkspacePath(String(config.message_store_path)), db);
  writeNotice(config, db);
}

function loadArchiveShards(config) {
  const dir = archiveDir(config);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => {
      const archivePath = path.join(dir, entry.name);
      try {
        const data = readJson(archivePath);
        const messages = Array.isArray(data?.messages)
          ? data.messages.filter((item) => Number.isInteger(item?.id)).map(normalizeMessage)
          : [];
        return {
          path: archivePath,
          data,
          messages,
          start_id: Number.isInteger(data?.start_id) ? data.start_id : (messages[0]?.id ?? 0),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.start_id - b.start_id || a.path.localeCompare(b.path));
}

function saveArchiveShard(shard) {
  const messages = shard.messages;
  const first = messages[0] || null;
  const last = messages[messages.length - 1] || null;
  writeJson(shard.path, {
    ...shard.data,
    schema_version: 1,
    start_id: first?.id ?? shard.data?.start_id ?? null,
    end_id: last?.id ?? shard.data?.end_id ?? null,
    count: messages.length,
    messages,
  });
}

function allMessages(config, db) {
  const merged = new Map();
  for (const shard of loadArchiveShards(config)) {
    for (const item of shard.messages) merged.set(item.id, item);
  }
  for (const item of db.messages) merged.set(item.id, item);
  return [...merged.values()].sort((a, b) => a.id - b.id);
}

function codexReadAt(item) {
  return item.codex_read_at ?? item.read_at ?? null;
}

function operatorAckAt(item) {
  return item.operator_ack_at ?? null;
}

function unreadMessages(config, db) {
  return allMessages(config, db).filter((item) => item.direction === "operator_to_codex" && !codexReadAt(item));
}

function unackedOutgoingMessages(config, db) {
  return allMessages(config, db).filter((item) => item.direction === "codex_to_operator" && !operatorAckAt(item));
}

function lastMessages(config, db, limit, before = null) {
  const capped = clampWindow(config, limit);
  const messages = allMessages(config, db);
  const source = Number.isInteger(before)
    ? messages.filter((item) => item.id < before)
    : messages;
  return source.slice(-capped);
}

function appendMessage(config, db, fields) {
  const now = iso();
  const message = {
    id: db.next_id,
    created_at: now,
    direction: fields.direction,
    sender: fields.sender,
    text: String(fields.text || "").slice(0, Math.trunc(numberFromConfig(config, "max_message_chars", 3000))),
    content_type: String(fields.content_type || (fields.text ? "text" : "unknown")),
    attachments: Array.isArray(fields.attachments) ? fields.attachments.map((item) => ({ ...item })) : [],
    telegram_message_id: fields.telegram_message_id ?? null,
  };
  if (message.direction === "operator_to_codex") {
    message.codex_read_at = fields.codex_read_at ?? fields.read_at ?? null;
  } else if (message.direction === "codex_to_operator") {
    message.delivered_at = fields.delivered_at ?? null;
    message.operator_ack_at = fields.operator_ack_at ?? null;
    if (fields.telegram_message_ids !== undefined) message.telegram_message_ids = fields.telegram_message_ids;
  }
  db.next_id += 1;
  db.messages.push(message);
  saveDb(config, db);
  return message;
}

function updateStoredMessages(config, db, ids, updater) {
  const idSet = new Set(ids);
  let count = 0;
  for (const item of db.messages) {
    if (idSet.has(item.id)) {
      updater(item);
      count += 1;
    }
  }
  for (const shard of loadArchiveShards(config)) {
    let changed = false;
    for (const item of shard.messages) {
      if (idSet.has(item.id)) {
        updater(item);
        count += 1;
        changed = true;
      }
    }
    if (changed) saveArchiveShard(shard);
  }
  if (count > 0) saveDb(config, db);
  else writeNotice(config, db);
  return count;
}

function markIncomingMessagesRead(config, db, messages) {
  const now = iso();
  const ids = new Set(messages
    .filter((item) => item.direction === "operator_to_codex" && !codexReadAt(item))
    .map((item) => item.id));
  const count = updateStoredMessages(config, db, ids, (item) => {
    item.codex_read_at = now;
  });
  return { count, codex_read_at: now };
}

function markDelivered(config, db, id, telegramMessageIds) {
  const now = iso();
  const ids = [Number.parseInt(String(id), 10)].filter(Number.isInteger);
  const count = updateStoredMessages(config, db, ids, (item) => {
    if (item.direction !== "codex_to_operator") return;
    item.delivered_at = now;
    item.telegram_message_ids = telegramMessageIds;
    item.telegram_message_id = telegramMessageIds[0] ?? item.telegram_message_id ?? null;
    item.attachments = (item.attachments || []).map((attachment) => (
      attachment.status === "pending" ? { ...attachment, status: "sent", error: null } : attachment
    ));
  });
  return { count, delivered_at: now };
}

function markDeliveryFailed(config, db, id, error) {
  const message = error?.message || String(error);
  const ids = [Number.parseInt(String(id), 10)].filter(Number.isInteger);
  const count = updateStoredMessages(config, db, ids, (item) => {
    if (item.direction !== "codex_to_operator") return;
    item.attachments = (item.attachments || []).map((attachment) => (
      attachment.status === "pending" ? { ...attachment, status: "failed", error: message } : attachment
    ));
  });
  return { count, error: message };
}

function markOperatorAck(config, db, target = "all") {
  const now = iso();
  let candidates = unackedOutgoingMessages(config, db);
  if (target !== "all" && target !== null && target !== undefined) {
    const id = Number.parseInt(String(target), 10);
    candidates = Number.isInteger(id) ? candidates.filter((item) => item.id === id) : [];
  }
  const count = updateStoredMessages(config, db, candidates.map((item) => item.id), (item) => {
    if (item.direction !== "codex_to_operator") return;
    item.operator_ack_at = now;
  });
  return { count, operator_ack_at: now };
}

function latestUnread(config, db) {
  const unread = unreadMessages(config, db);
  return unread.length ? unread[unread.length - 1] : null;
}

function writeNotice(config, db) {
  if (!config.notice_path) return;
  const noticePath = resolveWorkspacePath(String(config.notice_path));
  const unread = unreadMessages(config, db);
  const latest = unread.length ? unread[unread.length - 1] : null;
  writeJson(noticePath, {
    schema_version: 1,
    updated_at: iso(),
    unread_count: unread.length,
    latest_unread_id: latest?.id ?? null,
  });
}

function directionLabel(config, direction) {
  const operator = companionText(config, "操作者", "Operator");
  if (direction === "operator_to_codex") return `${operator} -> Codex`;
  if (direction === "codex_to_operator") return `Codex -> ${operator}`;
  return direction;
}

function operatorReadByLaterMessage(item, messages) {
  return messages.some((candidate) => (
    candidate.direction === "operator_to_codex"
    && Number.isInteger(candidate.id)
    && candidate.id > item.id
  ));
}

function attachmentLabel(config, attachment) {
  if (attachment.kind === "photo") return companionText(config, "图片", "photo");
  if (attachment.kind === "image_document") return companionText(config, "图片文件", "image file");
  if (attachment.kind === "sticker") return attachment.is_animated
    ? companionText(config, "动态表情包", "animated sticker")
    : attachment.is_video
      ? companionText(config, "视频表情包", "video sticker")
      : companionText(config, "表情包", "sticker");
  if (attachment.kind === "sticker_preview") return companionText(config, "表情包预览", "sticker preview");
  if (attachment.kind === "document") return companionText(config, "文件", "file");
  if (attachment.kind === "unsupported") return `${companionText(config, "未适配消息", "unsupported message")}: ${attachment.telegram_type || "unknown"}`;
  return attachment.kind || companionText(config, "附件", "attachment");
}

function formatAttachment(config, attachment) {
  const lines = [`[${attachmentLabel(config, attachment)}]`];
  const details = [];
  if (attachment.emoji) details.push(`${companionText(config, "表情", "emoji")} ${attachment.emoji}`);
  if (attachment.width && attachment.height) details.push(`${attachment.width}x${attachment.height}`);
  if (details.length) lines.push(details.join(" · "));
  if (attachment.local_path) lines.push(`${attachment.role === "preview"
    ? companionText(config, "预览", "preview")
    : companionText(config, "文件", "file")}: ${attachment.local_path}`);
  if (attachment.status === "skipped" || attachment.status === "failed") {
    lines.push(`${companionText(config, "附件状态", "attachment status")}: ${attachment.error || attachment.status}`);
  }
  return lines.join("\n");
}

function formatMessageBody(config, item) {
  const sections = [];
  const text = String(item.text || "").trim();
  if (text) sections.push(text);
  for (const attachment of item.attachments || []) sections.push(formatAttachment(config, attachment));
  if (!sections.length) sections.push(`[${item.content_type || "unknown"}]`);
  return sections.join("\n\n");
}

function formatMessage(config, item, messages = []) {
  const body = formatMessageBody(config, item);
  if (item.direction === "operator_to_codex") {
    return `#${item.id} ${item.created_at} ${directionLabel(config, item.direction)}\n${body}`;
  } else if (item.direction === "codex_to_operator") {
    const suffix = (operatorAckAt(item) || operatorReadByLaterMessage(item, messages))
      ? companionText(config, "【操作者已读】", "[operator read]")
      : companionText(config, "【操作者未读】", "[operator unread]");
    return `#${item.id} ${item.created_at} ${directionLabel(config, item.direction)}\n${body}${suffix}`;
  }
  return `#${item.id} ${item.created_at} ${directionLabel(config, item.direction)}\n${body}`;
}

function formatMessages(config, items, emptyText = null) {
  const resolvedEmptyText = emptyText || companionText(config, "没有消息。", "No messages.");
  if (!items.length) return resolvedEmptyText;
  return items.map((item) => formatMessage(config, item, items)).join("\n\n---\n\n");
}

function assertSelfTest(condition, message) {
  if (!condition) throw new Error(`self-test failed: ${message}`);
}

function runSelfTest(config) {
  const dir = path.join(WORKSPACE_ROOT, ".codex_tmp", `companion-inbox-selftest-${process.pid}-${Date.now()}`);
  const testConfig = {
    ...config,
    locale: "zh-CN",
    runtime_dir: dir,
    message_store_path: path.join(dir, "messages.json"),
    message_archive_dir: path.join(dir, "archive"),
    state_path: path.join(dir, "state.json"),
    notice_path: path.join(dir, "notice.json"),
    active_message_limit: 3,
    archive_batch_size: 2,
    default_window: 2,
    max_window: 3,
  };
  try {
    let db = loadDb(testConfig);
    appendMessage(testConfig, db, {
      direction: "operator_to_codex",
      sender: "operator",
      text: "一",
      content_type: "photo",
      attachments: [{ kind: "photo", role: "content", status: "downloaded", local_path: "D:\\test\\photo.jpg" }],
    });
    appendMessage(testConfig, db, { direction: "operator_to_codex", sender: "operator", text: "二" });
    appendMessage(testConfig, db, {
      direction: "codex_to_operator",
      sender: "codex",
      text: "三",
      content_type: "document",
      attachments: [{ kind: "document", role: "content", status: "pending", local_path: "D:\\test\\report.pdf" }],
    });
    db = loadDb(testConfig);
    assertSelfTest(db.messages.length === 3, "expected 3 messages");
    assertSelfTest(db.messages[0].attachments[0].kind === "photo", "attachment metadata should survive storage");
    assertSelfTest(formatMessages(testConfig, [db.messages[0]]).includes("D:\\test\\photo.jpg"), "formatted read should expose the local attachment path");
    assertSelfTest(unreadMessages(testConfig, db).length === 2, "expected 2 unread incoming messages");
    lastMessages(testConfig, db, 2);
    assertSelfTest(unreadMessages(testConfig, db).length === 2, "peek should not mark messages read");
    markIncomingMessagesRead(testConfig, db, lastMessages(testConfig, db, 2));
    db = loadDb(testConfig);
    assertSelfTest(unreadMessages(testConfig, db).length === 1, "expected 1 unread after reading the latest window");
    assertSelfTest(Boolean(db.messages.find((item) => item.text === "二")?.codex_read_at), "read should write codex_read_at on messages in the window");
    markDelivered(testConfig, db, 3, [1003]);
    db = loadDb(testConfig);
    assertSelfTest(Boolean(db.messages.find((item) => item.id === 3)?.delivered_at), "delivery should write delivered_at");
    assertSelfTest(db.messages.find((item) => item.id === 3)?.attachments[0].status === "sent", "delivery should mark outbound attachments sent");
    appendMessage(testConfig, db, { direction: "operator_to_codex", sender: "operator", text: "后续消息" });
    db = loadDb(testConfig);
    const outgoingReadView = formatMessages(testConfig, lastMessages(testConfig, db, 2));
    assertSelfTest(outgoingReadView.includes("三") && outgoingReadView.includes("【操作者已读】"), "later operator message should imply previous outgoing was read");
    markOperatorAck(testConfig, db, 3);
    db = loadDb(testConfig);
    assertSelfTest(Boolean(db.messages.find((item) => item.id === 3)?.operator_ack_at), "ack should write operator_ack_at");
    appendMessage(testConfig, db, { direction: "operator_to_codex", sender: "operator", text: "四" });
    db = loadDb(testConfig);
    assertSelfTest(db.messages.length === 3, "retention limit should keep 3 messages");
    assertSelfTest(db.messages[0].text === "三", "oldest message should be trimmed");
    assertSelfTest(loadArchiveShards(testConfig).length >= 1, "expected archived messages");
    assertSelfTest(allMessages(testConfig, db).length === 5, "archive plus active should preserve all messages");
    assertSelfTest(allMessages(testConfig, db)[0].attachments[0].kind === "photo", "archive should preserve attachment metadata");
    assertSelfTest(lastMessages(testConfig, db, 99).length === 3, "max window should cap at 3");
    assertSelfTest(lastMessages(testConfig, db, 2).map((item) => item.text).join("") === "后续消息四", "read window should return the latest messages");
    assertSelfTest(lastMessages(testConfig, db, 2, 3).map((item) => item.text).join("") === "一二", "before window should read archived messages");
    const notice = readJson(resolveWorkspacePath(String(testConfig.notice_path)));
    assertSelfTest(Number.isInteger(notice.unread_count), "notice should expose unread count");
    assertSelfTest(Number.isInteger(notice.latest_unread_id), "notice should expose latest unread id");
    assertSelfTest(!Object.hasOwn(notice, "requires_action_count"), "notice should stay message-only");
    markIncomingMessagesRead(testConfig, db, allMessages(testConfig, db));
    db = loadDb(testConfig);
    assertSelfTest(unreadMessages(testConfig, db).length === 0, "archive unread messages should be markable as read");
    console.log("companion inbox self-test passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function telegramApiViaCurl(url, method, payload) {
  const maxTimeSeconds = Math.max(30, Math.trunc(Number(payload?.timeout || 0) + 15));
  const args = [
    "-sS",
    "--max-time",
    String(maxTimeSeconds),
    "-H",
    "content-type: application/json",
    "-X",
    "POST",
  ];
  if (TELEGRAM_PROXY_URL) args.push("-x", TELEGRAM_PROXY_URL);
  args.push("--data-binary", "@-", url);

  return await new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, {
      cwd: WORKSPACE_ROOT,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`${method} returned non-JSON response: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function telegramApi(token, method, payload) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const body = TELEGRAM_PROXY_URL
    ? await telegramApiViaCurl(url, method, payload)
    : await (async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        return await response.json();
      })();
  if (!body.ok) throw new Error(`${method} failed: ${JSON.stringify(body)}`);
  return body.result;
}

function operatorAckReplyMarkup(config, messageId) {
  return {
    inline_keyboard: [
      [
        {
          text: companionText(config, "已阅", "Read"),
          callback_data: `operator_ack:${messageId}`,
        },
      ],
    ],
  };
}

async function sendText({ token, chatId, text, maxChars, runtimeDir, replyMarkup = null }) {
  const chunks = [];
  let remaining = String(text || "");
  while (remaining.length > maxChars) {
    chunks.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }
  chunks.push(remaining || "(empty)");
  const results = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const payload = {
      chat_id: chatId,
      text: chunks[index],
      disable_web_page_preview: true,
    };
    if (replyMarkup && index === chunks.length - 1) payload.reply_markup = replyMarkup;
    const result = await telegramApi(token, "sendMessage", payload);
    results.push(result);
    appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
      direction: "send",
      message_id: result?.message_id ?? null,
      chars: chunks[index].length,
      has_reply_markup: Boolean(replyMarkup && index === chunks.length - 1),
    });
  }
  return results;
}

async function getUpdates({ token, offset, timeoutSeconds, runtimeDir }) {
  const updates = await telegramApi(token, "getUpdates", {
    offset,
    timeout: timeoutSeconds,
    allowed_updates: ["message", "callback_query"],
  });
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "poll",
    count: updates.length,
    offset,
  });
  return updates;
}

function configuredBotCommands(config) {
  const configured = Array.isArray(config.bot_commands) ? config.bot_commands : [];
  return configured
    .map((item) => ({
      command: String(item?.command || "").trim().replace(/^\//, ""),
      description: String(item?.description || "").trim(),
    }))
    .filter((item) => /^[a-z0-9_]{1,32}$/.test(item.command) && item.description.length > 0)
    .map((item) => ({ command: item.command, description: item.description.slice(0, 256) }));
}

function botCommandScope(config, chatId) {
  const scope = String(config.bot_commands_scope || "chat").trim().toLowerCase();
  if (scope === "default") return { type: "default" };
  if (scope === "all_private_chats") return { type: "all_private_chats" };
  return { type: "chat", chat_id: chatId };
}

async function ensureBotCommands({ token, chatId, config, runtimeDir }) {
  if (config.bot_commands_enabled === false) return;
  const commands = configuredBotCommands(config);
  if (!commands.length) {
    await telegramApi(token, "deleteMyCommands", {
      scope: botCommandScope(config, chatId),
    });
    appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
      direction: "delete_bot_commands",
    });
    return;
  }
  await telegramApi(token, "setMyCommands", {
    commands,
    scope: botCommandScope(config, chatId),
  });
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "set_bot_commands",
    commands: commands.map((item) => item.command),
  });
}

function isAllowedPrivateMessage(message, allowedChatId) {
  return Boolean(
    message
      && message.chat?.type === "private"
      && String(message.chat?.id) === allowedChatId
      && String(message.from?.id) === allowedChatId,
  );
}

function isAllowedPrivateCallback(query, allowedChatId) {
  return Boolean(
    query
      && String(query.from?.id) === allowedChatId
      && query.message?.chat?.type === "private"
      && String(query.message?.chat?.id) === allowedChatId,
  );
}

async function handleCallbackQuery({ config, db, query, token, chatId, runtimeDir }) {
  const data = String(query?.data || "");
  const match = /^operator_ack:(\d+)$/.exec(data);
  if (!match) {
    await telegramApi(token, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: companionText(config, "这个按钮已经不可用。", "This button is no longer available."),
      show_alert: false,
    });
    return;
  }

  const messageId = Number.parseInt(match[1], 10);
  const result = markOperatorAck(config, db, messageId);
  await telegramApi(token, "answerCallbackQuery", {
    callback_query_id: query.id,
    text: result.count > 0
      ? companionText(config, "已标记操作者已阅。", "Marked as read by the operator.")
      : companionText(config, "这条消息已经确认过了。", "This message was already confirmed."),
    show_alert: false,
  });

  const telegramMessageId = query.message?.message_id;
  if (telegramMessageId) {
    try {
      await telegramApi(token, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: telegramMessageId,
      });
    } catch (error) {
      appendJsonl(path.join(runtimeDir, "errors.jsonl"), {
        error: `editMessageReplyMarkup failed after ack: ${error?.message || error}`,
      });
    }
  }

  appendJsonl(path.join(runtimeDir, "messages.jsonl"), {
    direction: "operator_ack",
    id: messageId,
    count: result.count,
  });
}

async function reactToIncomingMessage({ config, token, chatId, messageId, runtimeDir }) {
  if (config.incoming_message_reaction_enabled === false || !messageId) return;
  const emoji = String(config.incoming_message_reaction_emoji || "👌");
  try {
    await telegramApi(token, "setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [
        {
          type: "emoji",
          emoji,
        },
      ],
      is_big: false,
    });
    appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
      direction: "react",
      message_id: messageId,
      emoji,
    });
  } catch (error) {
    appendJsonl(path.join(runtimeDir, "errors.jsonl"), {
      error: `setMessageReaction failed: ${error?.message || error}`,
      message_id: messageId,
      emoji,
    });
  }
}

function attachmentRecord(descriptor) {
  return {
    kind: descriptor.kind,
    role: descriptor.role,
    file_unique_id: descriptor.fileUniqueId,
    file_name: descriptor.fallbackName,
    mime_type: descriptor.mimeType,
    file_size: descriptor.fileSize,
    width: descriptor.width,
    height: descriptor.height,
    emoji: descriptor.emoji || null,
    set_name: descriptor.setName || null,
    is_animated: Boolean(descriptor.isAnimated),
    is_video: Boolean(descriptor.isVideo),
    status: "pending",
    local_path: null,
    error: null,
  };
}

async function downloadIncomingAttachments({ config, token, message, runtimeDir, logicalMessageId }) {
  const descriptors = telegramAttachmentDescriptors(message);
  const maxBytes = Math.max(1, Math.trunc(numberFromConfig(config, "attachment_download_max_bytes", 20 * 1024 * 1024)));
  const baseDir = path.join(runtimeDir, "attachments", String(logicalMessageId));
  const attachments = [];

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    const record = attachmentRecord(descriptor);
    attachments.push(record);
    if (descriptor.fileSize > maxBytes) {
      record.status = "skipped";
      record.error = companionText(
        config,
        `附件超过下载上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MB`,
        `attachment exceeds ${(maxBytes / 1024 / 1024).toFixed(0)} MB download limit`,
      );
      continue;
    }

    try {
      const file = await telegramApi(token, "getFile", { file_id: descriptor.fileId });
      const fallbackExt = path.extname(descriptor.fallbackName) || ".bin";
      const ext = extensionFromTelegramFile(file.file_path, fallbackExt);
      const fallbackBase = path.basename(descriptor.fallbackName, path.extname(descriptor.fallbackName));
      const baseName = safeFileName(fallbackBase, `${descriptor.kind}-${index + 1}`);
      const outputPath = path.join(baseDir, `${baseName}${ext}`);
      if (!existsSync(outputPath) || statSync(outputPath).size <= 0) {
        await downloadTelegramFile({
          token,
          filePath: file.file_path,
          outputPath,
          proxyUrl: TELEGRAM_PROXY_URL,
          cwd: WORKSPACE_ROOT,
        });
      }
      record.status = "downloaded";
      record.local_path = outputPath;
    } catch (error) {
      record.status = "failed";
      record.error = error?.message || String(error);
    }
  }
  return attachments;
}

async function handleTelegramMessage({ config, db, message, token, chatId, runtimeDir }) {
  const text = telegramMessageText(message);
  const contentType = telegramMessageKind(message);
  const attachments = await downloadIncomingAttachments({
    config,
    token,
    message,
    runtimeDir,
    logicalMessageId: db.next_id,
  });
  if (!text && attachments.length === 0 && contentType !== "text") {
    attachments.push({
      kind: "unsupported",
      role: "metadata",
      telegram_type: contentType,
      status: "metadata_only",
      local_path: null,
      error: null,
    });
  }

  const stored = appendMessage(config, db, {
    direction: "operator_to_codex",
    sender: "operator",
    text,
    content_type: contentType,
    attachments,
    telegram_message_id: message.message_id ?? null,
  });
  const registration = await registerStickerSetNames({
    catalogPath: stickerCatalogPath(config),
    setNames: attachments.map((attachment) => attachment.set_name).filter(Boolean),
    getStickerSet: (name) => getStickerSetFromTelegram(token, name),
  });
  appendJsonl(path.join(runtimeDir, "messages.jsonl"), {
    direction: "recv",
    id: stored.id,
    chars: stored.text.length,
    content_type: contentType,
    attachment_count: attachments.length,
    downloaded_attachment_count: attachments.filter((item) => item.status === "downloaded").length,
    sticker_sets_added: registration.added.map((entry) => entry.name),
    sticker_set_registration_failures: registration.failed,
  });
  await reactToIncomingMessage({
    config,
    token,
    chatId,
    messageId: message.message_id ?? null,
    runtimeDir,
  });
}

function acquireRuntimeLock(lockPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd = null;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    throw new Error(`Companion inbox appears to be running already: ${lockPath}`);
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: iso() }), "utf8");
  closeSync(fd);
  return () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Best-effort cleanup only.
    }
  };
}

async function serve({ config, statePath, runtimeDir, options }) {
  const secrets = loadSecrets(config);
  TELEGRAM_PROXY_URL = secrets.proxyUrl;
  const lockPath = path.join(runtimeDir, "companion_inbox.lock.json");
  const releaseLock = acquireRuntimeLock(lockPath);
  process.once("exit", releaseLock);
  process.once("SIGINT", () => {
    releaseLock();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    releaseLock();
    process.exit(143);
  });

  try {
    await ensureBotCommands({
      token: secrets.token,
      chatId: secrets.allowedChatId,
      config,
      runtimeDir,
    });
  } catch (error) {
    console.error(`[companion-inbox] bot command menu registration failed: ${error.message || error}`);
  }

  const pollTimeout = Math.trunc(numberFromConfig(config, "poll_timeout_seconds", 25));
  const idleSleep = numberFromConfig(config, "idle_sleep_seconds", 2);
  console.log("[companion-inbox] started");
  while (true) {
    try {
      const state = loadState(statePath);
      const updates = await getUpdates({
        token: secrets.token,
        offset: state.update_offset,
        timeoutSeconds: pollTimeout,
        runtimeDir,
      });
      for (const update of updates) {
        const db = loadDb(config);
        state.update_offset = Math.max(Number(state.update_offset || 0), update.update_id + 1);
        saveState(statePath, state);
        const message = update.message;
        if (message) {
          if (!isAllowedPrivateMessage(message, secrets.allowedChatId)) continue;
          await handleTelegramMessage({
            config,
            db,
            message,
            token: secrets.token,
            chatId: secrets.allowedChatId,
            runtimeDir,
          });
          continue;
        }
        const callbackQuery = update.callback_query;
        if (callbackQuery) {
          if (!isAllowedPrivateCallback(callbackQuery, secrets.allowedChatId)) continue;
          await handleCallbackQuery({
            config,
            db,
            query: callbackQuery,
            token: secrets.token,
            chatId: secrets.allowedChatId,
            runtimeDir,
          });
        }
      }
      if (options.once) return;
      await delay(Math.max(0, idleSleep) * 1000);
    } catch (error) {
      appendJsonl(path.join(runtimeDir, "errors.jsonl"), { error: error?.stack || String(error) });
      console.error(`[companion-inbox] error: ${String(error?.message || error).split(/\r?\n/)[0]}`);
      if (options.once) throw error;
      await delay(5000);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const configPath = resolveWorkspacePath(options.configPath);
  const config = readJson(configPath);
  const runtimeDir = resolveWorkspacePath(String(config.runtime_dir));
  const statePath = resolveWorkspacePath(String(config.state_path));

  if (options.dryRun) {
    const peek = peekSecrets(config);
    console.log("Codex Companion Inbox - Dry Run");
    console.log(`has_bot_token=${peek.hasToken}`);
    console.log(`allowed_chat_id=${peek.allowedChatId ?? "(missing)"}`);
    console.log(`telegram_proxy_url=${peek.proxyUrl ?? "(none)"}`);
    console.log(`message_store=${resolveWorkspacePath(String(config.message_store_path))}`);
    console.log(`notice_path=${resolveWorkspacePath(String(config.notice_path))}`);
    console.log(`active_message_limit=${activeMessageLimit(config)}`);
    console.log(`archive_batch_size=${archiveBatchSize(config)}`);
    return;
  }

  if (options.mode === "self-test") {
    runSelfTest(config);
    return;
  }

  mkdirSync(runtimeDir, { recursive: true });
  const defaults = defaultStickerLibraryPaths(WORKSPACE_ROOT);
  await migrateStickerLibraryStorage({
    catalogPath: stickerCatalogPath(config),
    cacheDir: stickerCacheDir(config),
    legacyCatalogPath: defaults.legacyCatalogPath,
    legacyCacheDir: defaults.legacyCacheDir,
  });
  const db = loadDb(config);
  writeNotice(config, db);

  if (options.mode === "read") {
    const messages = lastMessages(config, db, options.limit, options.before);
    console.log(options.json ? JSON.stringify(messages, null, 2) : formatMessages(config, messages));
    markIncomingMessagesRead(config, db, messages);
    return;
  }
  if (options.mode === "sticker-pack") {
    await handleStickerPackCommand({ config, db, options, runtimeDir });
    return;
  }
  if (options.mode === "send-media") {
    const secrets = loadSecrets(config);
    TELEGRAM_PROXY_URL = secrets.proxyUrl;
    const filePath = resolveOutboundMediaPath(config, options.mediaPath);
    const fileStat = statSync(filePath);
    const kind = telegramOutboundKind(filePath, options.mediaKind, fileStat.size);
    const caption = readMediaCaption(options);
    const maxCaptionChars = Math.max(0, Math.trunc(numberFromConfig(config, "max_media_caption_chars", 1024)));
    if (caption.length > maxCaptionChars) {
      throw new Error(`media caption exceeds ${maxCaptionChars} characters`);
    }
    if (kind === "sticker" && caption.trim()) {
      throw new Error("Telegram stickers do not support captions");
    }

    const stored = appendMessage(config, db, {
      direction: "codex_to_operator",
      sender: "codex",
      text: caption,
      content_type: kind,
      attachments: [{
        kind,
        role: "content",
        file_name: path.basename(filePath),
        file_size: fileStat.size,
        local_path: filePath,
        status: "pending",
        error: null,
      }],
    });
    try {
      const result = await sendTelegramLocalMedia({
        token: secrets.token,
        chatId: secrets.allowedChatId,
        filePath,
        kind,
        caption,
        proxyUrl: TELEGRAM_PROXY_URL,
        cwd: WORKSPACE_ROOT,
      });
      markDelivered(config, db, stored.id, [result?.message_id].filter(Number.isInteger));
      appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
        direction: `send_${kind}`,
        message_id: result?.message_id ?? null,
        id: stored.id,
        path: filePath,
        caption_chars: caption.length,
      });
      console.log(`sent=#${stored.id} media=${kind}`);
      return;
    } catch (error) {
      markDeliveryFailed(config, db, stored.id, error);
      throw error;
    }
  }
  if (options.mode === "send") {
    const secrets = loadSecrets(config);
    TELEGRAM_PROXY_URL = secrets.proxyUrl;
    const text = readSendText(options);
    const stored = appendMessage(config, db, {
      direction: "codex_to_operator",
      sender: "codex",
      text,
    });
    const results = await sendText({
      token: secrets.token,
      chatId: secrets.allowedChatId,
      text,
      maxChars: Math.trunc(numberFromConfig(config, "max_message_chars", 3000)),
      runtimeDir,
      replyMarkup: config.operator_ack_button_enabled === false ? null : operatorAckReplyMarkup(config, stored.id),
    });
    markDelivered(config, db, stored.id, results.map((item) => item?.message_id).filter(Number.isInteger));
    console.log(`sent=#${stored.id}`);
    return;
  }

  await serve({ config, statePath, runtimeDir, options });
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
