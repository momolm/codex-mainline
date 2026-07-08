#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_CONFIG = path.join(
  WORKSPACE_ROOT,
  "config",
  "codex-mainline.settings.json",
);

let TELEGRAM_PROXY_URL = null;
let DEBUG_RAW = false;
let MAIN_RUNTIME_DIR = null;
const MAX_JSONL_BYTES = 64 * 1024 * 1024;
const JSONL_REDIRECTS = new Map();
const LARGE_JSONL_STRING_BYTES = 16 * 1024;
const JSONL_PREVIEW_CHARS = 400;
const INBOUND_FILE_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const INBOUND_TEXT_FILE_READ_MAX_BYTES = 512 * 1024;
const INBOUND_TEXT_FILE_CONTEXT_MAX_CHARS = 24 * 1024;
const INBOUND_TEXT_FILE_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".xml",
  ".yaml", ".yml", ".toml", ".ini", ".log", ".sql", ".py", ".js", ".mjs",
  ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".htm", ".ps1", ".bat",
  ".cmd", ".sh",
]);

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG,
    dryRun: false,
    once: false,
    wake: false,
    startupMessage: null,
    debugRaw: false,
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
    } else if (arg === "--wake") {
      options.wake = true;
    } else if (arg === "--startup-message") {
      i += 1;
      if (i >= argv.length) throw new Error("--startup-message requires text");
      options.startupMessage = argv[i];
    } else if (arg === "--debug-raw") {
      options.debugRaw = true;
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

function resolveWritableRoots(config) {
  const roots = new Set([path.resolve(WORKSPACE_ROOT)]);
  const extras = Array.isArray(config?.sandbox_extra_writable_roots)
    ? config.sandbox_extra_writable_roots
    : [];
  for (const item of extras) {
    if (typeof item !== "string" || !item.trim()) continue;
    roots.add(path.resolve(resolveWorkspacePath(item.trim())));
  }
  return [...roots];
}

function sandboxModeFromConfig(config) {
  const raw = String(config?.sandbox_mode || "workspace-write").trim();
  const allowed = new Set(["workspace-write", "danger-full-access", "read-only"]);
  if (!allowed.has(raw)) {
    throw new Error(`Unsupported sandbox_mode: ${raw}`);
  }
  return raw;
}

function turnSandboxPolicy(config, override = null) {
  if (override) return override;
  const mode = sandboxModeFromConfig(config);
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return {
      type: "readOnly",
      networkAccess: booleanFromConfig(config, "sandbox_network_access", false),
    };
  }
  return {
    type: "workspaceWrite",
    writableRoots: resolveWritableRoots(config),
    networkAccess: booleanFromConfig(config, "sandbox_network_access", false),
  };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

const DEFAULT_LOCALE = "zh-CN";
const SUPPORTED_LOCALES = new Set(["zh-CN", "en-US"]);

function normalizeLocale(value) {
  const raw = String(value || DEFAULT_LOCALE).trim();
  const normalized = raw.toLowerCase().replace("_", "-");
  if (normalized === "zh" || normalized === "zh-cn" || normalized === "cn") return "zh-CN";
  if (normalized === "en" || normalized === "en-us" || normalized === "us") return "en-US";
  return SUPPORTED_LOCALES.has(raw) ? raw : DEFAULT_LOCALE;
}

function localeFilePath(config, locale) {
  const dir = resolveWorkspacePath(String(config.locales_dir || "locales"));
  return path.join(dir, `${locale}.json`);
}

function loadLocaleFile(config, locale) {
  const filePath = localeFilePath(config, locale);
  if (!existsSync(filePath)) return {};
  try {
    return readJson(filePath);
  } catch (error) {
    throw new Error(`Failed to load locale file ${filePath}: ${error.message || error}`);
  }
}

function prepareI18n(config) {
  const locale = normalizeLocale(config.locale);
  const fallbackLocale = normalizeLocale(config.fallback_locale || DEFAULT_LOCALE);
  config.locale = locale;
  Object.defineProperty(config, "__i18n", {
    value: {
      locale,
      fallbackLocale,
      messages: loadLocaleFile(config, locale),
      fallbackMessages: locale === fallbackLocale ? {} : loadLocaleFile(config, fallbackLocale),
    },
    enumerable: false,
    configurable: true,
  });
  return config;
}

function localeOf(config) {
  return config?.__i18n?.locale || normalizeLocale(config?.locale);
}

function nestedValue(source, key) {
  if (!source || typeof source !== "object") return undefined;
  let cursor = source;
  for (const part of String(key).split(".")) {
    if (!cursor || typeof cursor !== "object" || !Object.hasOwn(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function interpolate(value, params = {}) {
  return String(value).replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, key) => {
    const replacement = nestedValue(params, key);
    return replacement === undefined || replacement === null ? match : String(replacement);
  });
}

function localizedEntry(config, key, params = {}, fallback = "") {
  const i18n = config?.__i18n;
  const raw = nestedValue(i18n?.messages, key) ?? nestedValue(i18n?.fallbackMessages, key) ?? fallback;
  if (Array.isArray(raw)) return raw.map((item) => interpolate(item, params));
  return interpolate(raw, params);
}

function t(config, key, params = {}, fallback = "") {
  const value = localizedEntry(config, key, params, fallback);
  return Array.isArray(value) ? value.join("\n") : String(value);
}

function tLines(config, key, params = {}, fallback = []) {
  const value = localizedEntry(config, key, params, fallback);
  if (Array.isArray(value)) return value.map((item) => String(item));
  return String(value).split("\n");
}

function localizedConfigValue(config, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value[localeOf(config)] ?? value[DEFAULT_LOCALE] ?? value["en-US"] ?? value.default ?? null;
  }
  return value ?? null;
}

function localizedConfigText(config, configKey, localeKey, params = {}, fallback = "") {
  const configured = localizedConfigValue(config, config?.[configKey]);
  if (configured !== null && configured !== undefined && String(configured).trim() !== "") {
    return interpolate(configured, params);
  }
  return t(config, localeKey, params, fallback);
}

function localizedConfigPath(config, configKey) {
  const value = localizedConfigValue(config, config?.[configKey]);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sidecarPayload(filePath, label, payload) {
  const json = JSON.stringify(payload);
  const hash = createHash("sha256").update(json).digest("hex");
  const safeLabel = String(label || "payload").replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80) || "payload";
  const dir = path.join(path.dirname(filePath), "payloads", safeLabel);
  const payloadPath = path.join(dir, `${hash}.json`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(payloadPath)) {
    writeFileSync(payloadPath, json, "utf8");
  }
  return {
    payloadRef: path.relative(path.dirname(filePath), payloadPath),
    sha256: hash,
    bytes: Buffer.byteLength(json, "utf8"),
  };
}

function compactPreview(value, maxChars = JSONL_PREVIEW_CHARS) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15)).trimEnd()} ...[truncated]`;
}

function archivePathForJsonl(filePath) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.${stamp}.${process.pid}${parsed.ext}`);
}

function rotateJsonlIfNeeded(filePath) {
  try {
    if (!existsSync(filePath)) return true;
    if (statSync(filePath).size <= MAX_JSONL_BYTES) return true;
    renameSync(filePath, archivePathForJsonl(filePath));
    return true;
  } catch {
    return false;
  }
}

function jsonlAppendPath(filePath) {
  const redirected = JSONL_REDIRECTS.get(filePath);
  if (redirected) return redirected;
  if (rotateJsonlIfNeeded(filePath)) return filePath;
  const parsed = path.parse(filePath);
  const fallbackPath = path.join(parsed.dir, `${parsed.name}.active-${process.pid}${parsed.ext}`);
  JSONL_REDIRECTS.set(filePath, fallbackPath);
  return fallbackPath;
}

function summarizeThreadSnapshot(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : null;
  return {
    id: thread?.id ?? null,
    sessionId: thread?.sessionId ?? null,
    forkedFromId: thread?.forkedFromId ?? null,
    name: thread?.name ?? null,
    status: thread?.status ?? null,
    cwd: thread?.cwd ?? null,
    path: thread?.path ?? null,
    source: thread?.source ?? null,
    modelProvider: thread?.modelProvider ?? null,
    createdAt: thread?.createdAt ?? null,
    updatedAt: thread?.updatedAt ?? null,
    preview: compactPreview(thread?.preview ?? "", 500),
    previewChars: String(thread?.preview ?? "").length,
    turnsCount: turns ? turns.length : null,
    itemsCount: turns ? turns.reduce((sum, turn) => sum + (Array.isArray(turn?.items) ? turn.items.length : 0), 0) : null,
    omittedCumulativeSnapshot: true,
    omittedReason: "thread snapshot repeats durable Codex session history; see session path for the canonical record",
  };
}

function isThreadSnapshot(value) {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && typeof value.id === "string"
      && (
        Array.isArray(value.turns)
        || Object.hasOwn(value, "itemsView")
        || typeof value.sessionId === "string"
      ),
  );
}

function replaceCumulativeSnapshots(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => replaceCumulativeSnapshots(item));
  if (isThreadSnapshot(value)) return summarizeThreadSnapshot(value);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = replaceCumulativeSnapshots(child);
  }
  return result;
}

function summarizeLargeString(filePath, label, value) {
  const text = String(value ?? "");
  const ref = sidecarPayload(filePath, label, text);
  return {
    ...ref,
    chars: text.length,
    preview: compactPreview(text),
  };
}

function slimLargeStrings(filePath, value, label = "payload") {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= LARGE_JSONL_STRING_BYTES) return value;
    return summarizeLargeString(filePath, label, value);
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => slimLargeStrings(filePath, item, `${label}_${index}`));
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = slimLargeStrings(filePath, child, `${label}_${key}`);
  }
  return result;
}

function slimRpcMessageForJsonl(filePath, value) {
  if (!value?.message || typeof value.message !== "object") return value;
  const message = replaceCumulativeSnapshots(structuredClone(value.message));
  const method = message.method ?? null;

  if (method === "turn/diff/updated" && typeof message.params?.diff === "string") {
    message.params.diff = summarizeLargeString(filePath, "turn_diff", message.params.diff);
  }

  const item = message.params?.item;
  if (item?.type === "commandExecution" && typeof item.aggregatedOutput === "string") {
    item.aggregatedOutput = summarizeLargeString(filePath, "command_output", item.aggregatedOutput);
  }
  if (item?.type === "imageGeneration" && typeof item.result === "string") {
    item.result = summarizeLargeString(filePath, "image_generation_result", item.result);
  }
  if (
    (method === "item/commandExecution/outputDelta" || method === "item/commandExecutionOutput/delta")
    && typeof message.params?.delta === "string"
  ) {
    message.params.delta = slimLargeStrings(filePath, message.params.delta, "command_output_delta");
  }

  return {
    ...value,
    message: slimLargeStrings(filePath, message, "message"),
  };
}

function slimJsonlValue(filePath, value) {
  if (!path.basename(filePath).startsWith("events")) return value;
  return slimRpcMessageForJsonl(filePath, value);
}

function appendJsonl(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const targetPath = jsonlAppendPath(filePath);
  const slimValue = slimJsonlValue(targetPath, value);
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...slimValue })}\n`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      appendFileSync(targetPath, line, "utf8");
      return true;
    } catch (error) {
      if (!["EBUSY", "EPERM"].includes(error?.code) || attempt === 4) {
        const fallbackPath = `${targetPath}.spill-${process.pid}.jsonl`;
        try {
          appendFileSync(fallbackPath, line, "utf8");
        } catch {
          // Logging must never crash the bridge.
        }
        if (!["EBUSY", "EPERM"].includes(error?.code)) {
          console.error(`appendJsonl failed for ${filePath}: ${error.message || error}`);
        }
        return false;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
  return false;
}

function appendLifecycle(runtimeDir, event, data = {}) {
  if (!runtimeDir) return false;
  return appendJsonl(path.join(runtimeDir, "lifecycle.jsonl"), { event, ...data });
}

function iso(date = new Date()) {
  return date.toISOString();
}

function escapeXmlAttribute(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[char]);
}

function formatPulseTime(date = new Date(), timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function telegramMessageDate(message) {
  const seconds = Number(message?.date);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000);
  return new Date();
}

function buildPulseHeader(config, date = new Date(), role = {}) {
  const source = optionalString(role?.source, config?.pulse_source) ?? "user";
  const channel = optionalString(role?.channel, config?.pulse_channel) ?? "telegram_private_chat";
  const timeZone = optionalString(config?.pulse_time_zone) ?? "Asia/Shanghai";
  return `<pulse time="${escapeXmlAttribute(formatPulseTime(date, timeZone))}" source="${escapeXmlAttribute(source)}" channel="${escapeXmlAttribute(channel)}" />`;
}

function buildTelegramPulseHeader(config, message) {
  return buildPulseHeader(config, telegramMessageDate(message));
}

function buildSystemPulseHeader(config, {
  source = "mainline",
  channel = "local_event",
  date = new Date(),
} = {}) {
  return buildPulseHeader(config, date, { source, channel });
}

function withSystemPulseHeader(config, text, options = {}) {
  const header = buildSystemPulseHeader(config, options);
  const body = String(text ?? "").trim();
  return body ? `${header}\n${body}` : header;
}

function hhmmss(date = new Date()) {
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

function numberFromConfig(config, key, fallback) {
  const raw = config[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

function booleanFromConfig(config, key, fallback) {
  const raw = config[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
  }
  throw new Error(`${key} must be a boolean`);
}

function optionalString(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return null;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireRuntimeLock(lockPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    let existing = null;
    try {
      existing = readJson(lockPath);
    } catch {
      existing = null;
    }
    if (processIsAlive(existing?.pid)) {
      throw new Error(`Codex Mainline TG mainline is already running: pid=${existing.pid}`);
    }
    unlinkSync(lockPath);
  }

  const fd = openSync(lockPath, "wx");
  closeSync(fd);
  writeJson(lockPath, { pid: process.pid, started_at: iso() });

  return () => {
    try {
      const current = existsSync(lockPath) ? readJson(lockPath) : null;
      if (current?.pid === process.pid) unlinkSync(lockPath);
    } catch {
      // Best effort.
    }
  };
}

function defaultState() {
  return {
    schema_version: 1,
    update_offset: 0,
    thread_id: null,
    active_turn_id: null,
    active_turn_started_at: null,
    active_turn_computer_use: false,
    last_input_at: null,
    last_output_at: null,
    last_codex_visible_output_at: null,
    context_usage_snapshot: null,
    rate_limits_snapshot: null,
    next_wake_at: null,
    last_wake_at: null,
    wake_count: 0,
    last_wake_skip_at: null,
    last_wake_skip_reason: null,
    rest_until: null,
    rest_started_at: null,
    rest_reason: null,
    work_budget_turn_id: null,
    work_budget_steered_at: null,
    compacting_until: null,
    compacting_started_at: null,
    compacting_item_id: null,
    compaction_recovery_pending: false,
    compaction_recovery_attempt: 0,
    compaction_recovery_pause_attempt: 0,
    compaction_recovery_model_active: false,
    compaction_recovery_restore_model: null,
    compaction_recovery_restore_effort: null,
    compaction_recovery_restore_in_progress: false,
    compaction_recovery_resume_pending: false,
    compaction_recovery_resume_reason: null,
    compaction_recovery_resume_last_sent_at: null,
    compaction_last_failed_at: null,
    compaction_last_failed_turn_id: null,
    compaction_last_error: null,
    compaction_circuit_opened_at: null,
    compaction_circuit_reason: null,
    compaction_protected_turn: null,
    server_overloaded_last_error_at: null,
    server_overloaded_last_turn_id: null,
    server_overloaded_resume_requested_for_turn_id: null,
    server_overloaded_recovery_turn_id: null,
    last_error: null,
    created_at: iso(),
    updated_at: iso(),
  };
}

function loadState(filePath) {
  if (!existsSync(filePath)) return defaultState();
  return { ...defaultState(), ...readJson(filePath) };
}

function patchState(filePath, state, patch) {
  const latest = loadState(filePath);
  Object.assign(latest, patch, { updated_at: iso() });
  writeJson(filePath, latest);
  Object.assign(state, latest);
  return state;
}

function printLine() {
  console.log("─".repeat(72));
}

function printHeader(title) {
  printLine();
  console.log(title);
  printLine();
}

function logSystem(text) {
  closeLiveStream();
  console.log(`[${hhmmss()}] system`);
  console.log(text);
}

function logBlock(title, text) {
  closeLiveStream();
  console.log(`[${hhmmss()}] ${title}`);
  const value = String(text ?? "");
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}

let liveLabel = null;
let liveText = "";

function beginLiveStream(label) {
  if (liveLabel === label) return;
  closeLiveStream();
  liveLabel = label;
  liveText = "";
  console.log(`[${hhmmss()}] ${label}`);
}

function writeLiveDelta(delta) {
  const value = String(delta ?? "");
  if (!value) return;
  liveText += value;
  process.stdout.write(value);
}

function closeLiveStream() {
  if (!liveLabel) return;
  process.stdout.write(liveText.endsWith("\n") ? "" : "\n");
  liveLabel = null;
  liveText = "";
}

function findOnPath(commandName) {
  const result = spawnSync("where.exe", [commandName], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function resolveCodexInvocation(commandName = "codex") {
  const candidates = findOnPath(commandName);
  if (candidates.length === 0) throw new Error(`Command not found on PATH: ${commandName}`);
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const dir = path.dirname(candidate);
    const npmCodexJs = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if ((lower.endsWith("\\codex.cmd") || lower.endsWith("\\codex.ps1") || lower.endsWith("\\codex")) && existsSync(npmCodexJs)) {
      return { command: "node", prefixArgs: [npmCodexJs] };
    }
  }
  const exe = candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe"));
  if (exe) return { command: exe, prefixArgs: [] };
  throw new Error(`No spawn-safe codex command found. Candidates: ${candidates.join("; ")}`);
}

function appServerEnv() {
  const env = { ...process.env };
  const stablePwshDir = "C:\\Program Files\\PowerShell\\7";
  if (existsSync(path.join(stablePwshDir, "pwsh.exe"))) {
    const parts = String(env.Path || env.PATH || "")
      .split(";")
      .filter(Boolean)
      .filter((part) => !/\\WindowsApps\\Microsoft\.PowerShell_/i.test(part));
    env.Path = [stablePwshDir, ...parts.filter((part) => part.toLowerCase() !== stablePwshDir.toLowerCase())].join(";");
    env.PATH = env.Path;
  }
  return env;
}

function loadSecrets(config) {
  const localConfigPath = resolveWorkspacePath(String(config.local_config_path));
  const local = existsSync(localConfigPath) ? readJson(localConfigPath) : {};
  const token = process.env[String(config.bot_token_env)] || local.bot_token;
  const allowedChatId = process.env[String(config.allowed_chat_id_env)] || local.allowed_chat_id;
  const proxyEnv = String(config.telegram_api_proxy_url_env || "CODEX_MAINLINE_TG_PROXY_URL");
  const proxyUrl = process.env[proxyEnv] || local.telegram_api_proxy_url || local.proxy_url || config.telegram_api_proxy_url || null;
  if (!token) throw new Error(`Missing Telegram bot token. Set ${config.bot_token_env} or ${localConfigPath}`);
  if (!allowedChatId) throw new Error(`Missing allowed chat id. Set ${config.allowed_chat_id_env} or ${localConfigPath}`);
  return { token: String(token), allowedChatId: String(allowedChatId), proxyUrl: proxyUrl ? String(proxyUrl) : null };
}

function peekSecrets(config) {
  const localConfigPath = resolveWorkspacePath(String(config.local_config_path));
  const local = existsSync(localConfigPath) ? readJson(localConfigPath) : {};
  const proxyEnv = String(config.telegram_api_proxy_url_env || "CODEX_MAINLINE_TG_PROXY_URL");
  return {
    hasToken: Boolean(process.env[String(config.bot_token_env)] || local.bot_token),
    allowedChatId: process.env[String(config.allowed_chat_id_env)] || local.allowed_chat_id || null,
    proxyUrl: process.env[proxyEnv] || local.telegram_api_proxy_url || local.proxy_url || config.telegram_api_proxy_url || null,
    localConfigPath,
  };
}

function isAllowedPrivateMessage(message, allowedChatId) {
  return Boolean(
    message
      && message.chat?.type === "private"
      && String(message.chat?.id) === allowedChatId
      && String(message.from?.id) === allowedChatId,
  );
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
  let body;
  try {
    body = TELEGRAM_PROXY_URL
      ? await telegramApiViaCurl(url, method, payload)
      : await (async () => {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          return await response.json();
        })();
  } catch (error) {
    const proxyHint = TELEGRAM_PROXY_URL
      ? `Telegram API request ${method} failed through proxy ${TELEGRAM_PROXY_URL}. Check the proxy URL and network connectivity.`
      : `Telegram API request ${method} failed. If Telegram Bot API is blocked on this network, set telegram_api_proxy_url in config/telegram.local.json or CODEX_MAINLINE_TG_PROXY_URL.`;
    throw new Error(`${proxyHint} Original error: ${error?.message || error}`, { cause: error });
  }
  if (!body.ok) throw new Error(`${method} failed: ${JSON.stringify(body)}`);
  return body.result;
}

function configuredBotCommands(config) {
  const configured = Array.isArray(config.bot_commands) ? config.bot_commands : [];
  const commands = configured
    .map((item) => {
      const command = String(item?.command || "").trim().replace(/^\//, "");
      const configuredDescription = localizedConfigValue(config, item?.description);
      const description = String(configuredDescription || t(config, `botCommands.${command}`, {}, "")).trim();
      return { command, description };
    })
    .filter((item) => /^[a-z0-9_]{1,32}$/.test(item.command) && item.description.length > 0)
    .map((item) => ({
      command: item.command,
      description: item.description.slice(0, 256),
    }));
  return commands;
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
  if (commands.length === 0) return;
  const scope = botCommandScope(config, chatId);
  await telegramApi(token, "setMyCommands", {
    commands,
    scope,
  });
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "set_bot_commands",
    commands: commands.map((item) => item.command),
    scope,
  });
  logSystem(`bot command menu registered: ${commands.map((item) => `/${item.command}`).join(", ")}`);
}

async function downloadTelegramFile({ token, filePath, outputPath }) {
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  mkdirSync(path.dirname(outputPath), { recursive: true });
  if (TELEGRAM_PROXY_URL) {
    const args = ["-fL", "-sS", "--max-time", "120", "-x", TELEGRAM_PROXY_URL, "-o", outputPath, url];
    await new Promise((resolve, reject) => {
      const child = spawn("curl.exe", args, { cwd: WORKSPACE_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(outputPath, buffer);
  return outputPath;
}

async function sendText({ token, chatId, text, maxChars, runtimeDir, echo = false }) {
  const chunks = [];
  let remaining = String(text || "");
  while (remaining.length > maxChars) {
    chunks.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }
  chunks.push(remaining || "(empty)");

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (echo) logBlock(`Codex -> TG ${index + 1}/${chunks.length}`, chunk);
    const result = await telegramApi(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
    appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
      direction: "send",
      message_id: result?.message_id ?? null,
      chars: chunk.length,
    });
    if (!echo) logSystem(`TG sent ${index + 1}/${chunks.length}, chars=${chunk.length}`);
  }
}

async function sendChatAction({ token, chatId, action = "typing", runtimeDir }) {
  try {
    await telegramApi(token, "sendChatAction", {
      chat_id: chatId,
      action,
    });
    appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
      direction: "send_chat_action",
      action,
    });
    return true;
  } catch (error) {
    appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
      direction: "send_chat_action_failed",
      action,
      error: String(error?.message || error).slice(0, 500),
    });
    return false;
  }
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function splitTextForTelegram(value, maxChars) {
  const chunks = [];
  let remaining = String(value || "");
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < Math.floor(maxChars * 0.5)) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  chunks.push(remaining.trimEnd() || "(empty)");
  return chunks;
}

function compactOneLine(value, maxChars = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15)).trimEnd()} ...[truncated]`;
}

function formatRunDetailBlock(config, chunk, index, total, done = false) {
  const suffix = index > 0 ? t(config, "runDetails.blockSuffix", { index: index + 1 }) : "";
  const state = done ? t(config, "runDetails.done") : t(config, "runDetails.live");
  return [
    `<b>${htmlEscape(t(config, "runDetails.title", { suffix, state }))}</b>`,
    `<blockquote expandable>${htmlEscape(chunk)}</blockquote>`,
  ].join("\n");
}

async function sendFormattedText({ token, chatId, text, parseMode, runtimeDir }) {
  const result = await telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  });
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "send_formatted",
    message_id: result?.message_id ?? null,
    chars: String(text || "").length,
    parse_mode: parseMode,
  });
  logSystem(`TG formatted sent, chars=${String(text || "").length}`);
  return result;
}

async function editFormattedText({ token, chatId, messageId, text, parseMode, runtimeDir }) {
  const result = await telegramApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  });
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "edit_formatted",
    message_id: messageId,
    chars: String(text || "").length,
    parse_mode: parseMode,
  });
  return result;
}

async function telegramApiMultipartViaCurl({ token, method, fields, files }) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const args = ["-fL", "-sS", "--max-time", "120", "-X", "POST"];
  if (TELEGRAM_PROXY_URL) args.push("-x", TELEGRAM_PROXY_URL);
  for (const [name, value] of Object.entries(fields || {})) {
    args.push("-F", `${name}=${String(value)}`);
  }
  for (const [name, filePath] of Object.entries(files || {})) {
    args.push("-F", `${name}=@${filePath}`);
  }
  args.push(url);

  return await new Promise((resolve, reject) => {
    const child = spawn("curl.exe", args, { cwd: WORKSPACE_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

async function sendPhotoLocal({ token, chatId, photoPath, caption, runtimeDir }) {
  const result = await telegramApiMultipartViaCurl({
    token,
    method: "sendPhoto",
    fields: {
      chat_id: chatId,
      ...(caption ? { caption } : {}),
    },
    files: { photo: photoPath },
  });
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "send_photo",
    message_id: result?.message_id ?? null,
    path: photoPath,
    caption_chars: String(caption || "").length,
  });
  logSystem(`TG photo sent: ${photoPath}`);
  return result;
}

async function sendDocumentLocal({ token, chatId, documentPath, caption, runtimeDir }) {
  const result = await telegramApiMultipartViaCurl({
    token,
    method: "sendDocument",
    fields: {
      chat_id: chatId,
      ...(caption ? { caption } : {}),
    },
    files: { document: documentPath },
  });
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "send_document",
    message_id: result?.message_id ?? null,
    path: documentPath,
    caption_chars: String(caption || "").length,
  });
  logSystem(`TG file sent: ${documentPath}`);
  return result;
}

function imageGenerationPathFromItem(item, runtimeDir) {
  if (item?.savedPath && existsSync(item.savedPath)) return item.savedPath;
  const result = String(item?.result || "");
  if (!result) return null;

  const match = result.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
  const base64 = match ? match[1] : result;
  const outputDir = path.join(runtimeDir, "generated_images");
  mkdirSync(outputDir, { recursive: true });
  const fileName = `${safeFileName(item?.id || `generated-${Date.now()}`, "generated-image")}.png`;
  const outputPath = path.join(outputDir, fileName);
  writeFileSync(outputPath, Buffer.from(base64, "base64"));
  return outputPath;
}

async function getUpdates({ token, offset, timeoutSeconds, runtimeDir }) {
  const updates = await telegramApi(token, "getUpdates", {
    offset,
    timeout: timeoutSeconds,
    allowed_updates: ["message"],
  });
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "poll",
    count: updates.length,
    offset,
  });
  return updates;
}

function compactionInputQueuePath(config, runtimeDir) {
  if (config.compaction_input_queue_path) {
    return resolveWorkspacePath(String(config.compaction_input_queue_path));
  }
  return path.join(runtimeDir, "compaction_input_queue.jsonl");
}

function compactionReplayQueuePath(config, runtimeDir) {
  if (config.compaction_replay_queue_path) {
    return resolveWorkspacePath(String(config.compaction_replay_queue_path));
  }
  return path.join(runtimeDir, "compaction_replay_queue.jsonl");
}

function countNonBlankLines(filePath) {
  if (!filePath || !existsSync(filePath)) return 0;
  try {
    return readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function enqueueCompactionInput({ config, runtimeDir, message, reason }) {
  const queuePath = compactionInputQueuePath(config, runtimeDir);
  appendJsonl(queuePath, {
    schema_version: 1,
    kind: "telegram_message",
    reason,
    queued_at: iso(),
    message_id: message?.message_id ?? null,
    message,
  });
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "recv_compaction_queued",
    message_id: message?.message_id ?? null,
    chars: telegramMessageText(message).length,
    kind: telegramMessageKind(message),
    reason,
  });
  return queuePath;
}

function requeueCompactionInputs({ config, runtimeDir, messages, reason }) {
  for (const message of messages) {
    enqueueCompactionInput({ config, runtimeDir, message, reason });
  }
}

function cloneInputItems(input) {
  return JSON.parse(JSON.stringify(inputItems(input)));
}

function protectedTurnRecord({ turnId, input, reason, metadata = null }) {
  if (!turnId) return null;
  return {
    schema_version: 1,
    turn_id: turnId,
    protected_at: iso(),
    reason: String(reason || "turn_input"),
    input: cloneInputItems(input),
    metadata,
  };
}

function enqueueCompactionReplayInput({ config, runtimeDir, replay, reason }) {
  if (!replay?.input) return null;
  const queuePath = compactionReplayQueuePath(config, runtimeDir);
  appendJsonl(queuePath, {
    ...replay,
    schema_version: 1,
    kind: "codex_input",
    queue_reason: reason,
    queued_at: iso(),
  });
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "compaction_replay_queued",
    turn_id: replay.turn_id ?? null,
    chars: JSON.stringify(replay.input).length,
    reason,
    metadata: replay.metadata ?? null,
  });
  return queuePath;
}

function drainCompactionReplayQueue(config, runtimeDir) {
  const queuePath = compactionReplayQueuePath(config, runtimeDir);
  if (!existsSync(queuePath)) return [];
  const processingPath = `${queuePath}.processing-${process.pid}-${Date.now()}`;
  try {
    renameSync(queuePath, processingPath);
  } catch {
    return [];
  }

  try {
    const lines = readFileSync(processingPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const inputs = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item?.kind === "codex_input" && item.input) inputs.push(item);
      } catch {
        // Malformed queue lines are ignored.
      }
    }
    return inputs;
  } finally {
    try {
      unlinkSync(processingPath);
    } catch {
      // Best effort.
    }
  }
}

function requeueCompactionReplayInputs({ config, runtimeDir, inputs, reason }) {
  for (const input of inputs) {
    enqueueCompactionReplayInput({ config, runtimeDir, replay: input, reason });
  }
}

function drainCompactionInputQueue(config, runtimeDir) {
  const queuePath = compactionInputQueuePath(config, runtimeDir);
  if (!existsSync(queuePath)) return [];
  const processingPath = `${queuePath}.processing-${process.pid}-${Date.now()}`;
  try {
    renameSync(queuePath, processingPath);
  } catch {
    return [];
  }

  try {
    const lines = readFileSync(processingPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const messages = [];
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item?.kind === "telegram_message" && item.message) messages.push(item.message);
      } catch {
        // Malformed queue lines are ignored.
      }
    }
    return normalizeTelegramMessages(messages);
  } finally {
    try {
      unlinkSync(processingPath);
    } catch {
      // Best effort.
    }
  }
}

function safeFileName(value, fallback) {
  const cleaned = String(value || fallback || "file").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || fallback || "file";
}

function extensionFromTelegramFile(filePath, fallback = ".jpg") {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return ext || fallback;
}

function isTelegramPhotoPath(filePath) {
  return [".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(filePath).toLowerCase());
}

function isTelegramTextFile({ fileName, mimeType }) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (String(mimeType || "").startsWith("text/")) return true;
  return INBOUND_TEXT_FILE_EXTENSIONS.has(ext);
}

function telegramFileDescriptor(message) {
  const document = message?.document;
  if (!document?.file_id) return null;
  return {
    fileId: document.file_id,
    fileName: safeFileName(document.file_name || "file", "file"),
    mimeType: String(document.mime_type || ""),
    fileSize: Number(document.file_size || 0),
  };
}

function xmlUnescape(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractTelegramSendFiles(text) {
  const files = [];
  const cleaned = String(text || "").replace(
    /<tg_send_file\b([^>]*)\/?>\s*(?:<\/tg_send_file>)?/gi,
    (full, attrs) => {
      const pathMatch = String(attrs || "").match(/\bpath\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
      if (pathMatch) {
        const filePath = xmlUnescape(pathMatch[1] ?? pathMatch[2] ?? "").trim();
        if (filePath && filePath !== "..." && !filePath.includes("...")) files.push(filePath);
      }
      return "";
    },
  );
  return { text: cleaned.trim(), files };
}

function resolveDeliveryFilePath(filePath) {
  const rawPath = String(filePath || "").trim();
  if (!rawPath) throw new Error("empty delivery file path");
  const resolved = path.resolve(WORKSPACE_ROOT, rawPath);
  const item = existsSync(resolved) ? statSync(resolved) : null;
  if (!item) throw new Error(`delivery file does not exist: ${rawPath}`);
  if (!item.isFile()) throw new Error(`delivery path is not a file: ${rawPath}`);
  if (item.size > 45 * 1024 * 1024) throw new Error(`delivery file is too large for Telegram: ${rawPath}`);

  const lower = resolved.toLowerCase();
  const blockedRoots = [
    path.join(WORKSPACE_ROOT, "config").toLowerCase(),
    path.join(WORKSPACE_ROOT, "runtime").toLowerCase(),
  ];
  if (blockedRoots.some((root) => lower === root || lower.startsWith(`${root}${path.sep}`))) {
    throw new Error(`delivery file is blocked: ${rawPath}`);
  }
  return resolved;
}

function imageDescriptorsFromMessage(message) {
  const images = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = [...message.photo].sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0))[0] ?? message.photo.at(-1);
    if (photo?.file_id) images.push({ fileId: photo.file_id, fallbackName: "photo.jpg" });
  }
  const document = message.document;
  if (document?.file_id && String(document.mime_type || "").startsWith("image/")) {
    images.push({ fileId: document.file_id, fallbackName: document.file_name || "image" });
  }
  const sticker = message.sticker;
  if (sticker?.file_id && !sticker.is_animated && !sticker.is_video) {
    images.push({ fileId: sticker.file_id, fallbackName: "sticker.webp" });
  }
  return images;
}

function telegramMessageText(message) {
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.caption === "string") return message.caption;
  return "";
}

function telegramMediaGroupId(message) {
  const value = message?.media_group_id;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function mediaGroupBufferKey(message) {
  const groupId = telegramMediaGroupId(message);
  if (!groupId) return "";
  return `${message?.chat?.id ?? "unknown"}:${groupId}`;
}

function looseInputBufferKey(message) {
  return `${message?.chat?.id ?? "unknown"}:loose-media`;
}

function telegramMessageHasImage(message) {
  return imageDescriptorsFromMessage(message).length > 0;
}

function telegramSenderLabel(message) {
  const from = message?.from;
  if (!from) return "unknown";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  const username = from.username ? `@${from.username}` : "";
  const id = from.id ? `id:${from.id}` : "";
  return [name, username, id].filter(Boolean).join(" ") || "unknown";
}

function telegramMessageKind(message) {
  if (!message) return "unknown";
  if (typeof message.text === "string") return "text";
  if (Array.isArray(message.photo) && message.photo.length > 0) return "photo";
  if (message.document) return String(message.document.mime_type || "").startsWith("image/") ? "file:image" : "file";
  if (message.sticker) return "sticker";
  if (message.animation) return "animation";
  if (message.video) return "video";
  if (message.voice) return "voice";
  if (message.audio) return "audio";
  if (message.video_note) return "video_note";
  if (message.contact) return "contact";
  if (message.location) return "location";
  if (message.venue) return "venue";
  if (message.poll) return "poll";
  return "other";
}

function telegramAttachmentSummary(message) {
  const parts = [];
  if (Array.isArray(message?.photo) && message.photo.length > 0) {
    parts.push(`photo x${message.photo.length}`);
  }
  if (message?.document) {
    const fileName = message.document.file_name ? ` ${message.document.file_name}` : "";
    const mimeType = message.document.mime_type ? ` ${message.document.mime_type}` : "";
    parts.push(`file${fileName}${mimeType}`.trim());
  }
  if (message?.sticker) {
    const emoji = message.sticker.emoji ? ` ${message.sticker.emoji}` : "";
    parts.push(`sticker${emoji}`);
  }
  for (const key of ["animation", "video", "voice", "audio", "video_note", "contact", "location", "venue", "poll"]) {
    if (message?.[key]) parts.push(key);
  }
  return parts.join("; ");
}

function formatTelegramReplyContext(config, message) {
  const quoted = message?.reply_to_message;
  if (!quoted) return "";
  const text = telegramMessageText(quoted);
  const quoteText = typeof message?.quote?.text === "string" ? message.quote.text : "";
  const attachmentSummary = telegramAttachmentSummary(quoted);
  const lines = [
    t(config, "telegramInput.quotedHeader"),
    `message_id: ${quoted.message_id ?? "unknown"}`,
    `from: ${telegramSenderLabel(quoted)}`,
    `type: ${telegramMessageKind(quoted)}`,
  ];
  if (quoted.date) lines.push(`time: ${new Date(Number(quoted.date) * 1000).toISOString()}`);
  if (text) lines.push(t(config, "telegramInput.content", { text: compactPreview(text, 1200) }));
  if (quoteText) lines.push(t(config, "telegramInput.quote", { text: compactPreview(quoteText, 600) }));
  if (attachmentSummary) lines.push(t(config, "telegramInput.attachment", { text: compactPreview(attachmentSummary, 600) }));
  if (!text && !attachmentSummary) lines.push(t(config, "telegramInput.noReadableQuoted"));
  return lines.join("\n");
}

async function downloadMessageImages({ token, message, runtimeDir }) {
  const descriptors = imageDescriptorsFromMessage(message);
  const imagePaths = [];
  if (descriptors.length === 0) return imagePaths;

  const baseDir = path.join(runtimeDir, "attachments", String(message.message_id ?? Date.now()));
  mkdirSync(baseDir, { recursive: true });

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    const file = await telegramApi(token, "getFile", { file_id: descriptor.fileId });
    const ext = extensionFromTelegramFile(file.file_path, path.extname(descriptor.fallbackName) || ".jpg");
    const name = safeFileName(path.basename(descriptor.fallbackName, path.extname(descriptor.fallbackName)), `image-${index + 1}`);
    const outputPath = path.join(baseDir, `${name}${ext}`);
    await downloadTelegramFile({ token, filePath: file.file_path, outputPath });
    imagePaths.push(outputPath);
  }

  return imagePaths;
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function inboundTextFileContent(filePath) {
  const stat = statSync(filePath);
  if (stat.size > INBOUND_TEXT_FILE_READ_MAX_BYTES) {
    return {
      readable: false,
      reason: `text file exceeds read limit ${formatFileSize(INBOUND_TEXT_FILE_READ_MAX_BYTES)}`,
    };
  }
  const buffer = readFileSync(filePath);
  if (buffer.includes(0)) {
    return { readable: false, reason: "file contains NUL bytes and is treated as binary" };
  }
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (text.length > INBOUND_TEXT_FILE_CONTEXT_MAX_CHARS) {
    return {
      readable: true,
      truncated: true,
      text: text.slice(0, INBOUND_TEXT_FILE_CONTEXT_MAX_CHARS),
      originalChars: text.length,
    };
  }
  return { readable: true, truncated: false, text, originalChars: text.length };
}

async function downloadMessageFiles({ token, message, runtimeDir }) {
  const descriptor = telegramFileDescriptor(message);
  if (!descriptor) return [];

  const baseDir = path.join(runtimeDir, "attachments", String(message.message_id ?? Date.now()));
  mkdirSync(baseDir, { recursive: true });

  const result = {
    messageId: message.message_id ?? null,
    fileName: descriptor.fileName,
    mimeType: descriptor.mimeType,
    fileSize: descriptor.fileSize,
    path: null,
    downloaded: false,
    text: null,
    error: null,
  };

  if (descriptor.fileSize > INBOUND_FILE_DOWNLOAD_MAX_BYTES) {
    result.error = `file exceeds download limit ${formatFileSize(INBOUND_FILE_DOWNLOAD_MAX_BYTES)}`;
    return [result];
  }

  try {
    const file = await telegramApi(token, "getFile", { file_id: descriptor.fileId });
    const fallbackExt = path.extname(descriptor.fileName) || ".bin";
    const ext = extensionFromTelegramFile(file.file_path, fallbackExt);
    const baseName = safeFileName(path.basename(descriptor.fileName, path.extname(descriptor.fileName)), "file");
    const outputPath = path.join(baseDir, `${baseName}${ext}`);
    if (!existsSync(outputPath) || statSync(outputPath).size <= 0) {
      await downloadTelegramFile({ token, filePath: file.file_path, outputPath });
    }
    result.path = outputPath;
    result.downloaded = true;

    if (isTelegramTextFile(descriptor)) {
      result.text = inboundTextFileContent(outputPath);
    }
  } catch (error) {
    result.error = error?.message || String(error);
  }

  return [result];
}

function formatTelegramFileContext(config, fileItems) {
  const files = Array.isArray(fileItems) ? fileItems : [];
  if (files.length === 0) return "";
  const lines = [
    t(config, "telegramInput.fileHeader", {}, "[Telegram file attachments]"),
  ];
  for (const file of files) {
    const unknown = t(config, "common.unknown", {}, "(unknown)");
    lines.push(t(config, "telegramInput.fileName", { name: file.fileName || unknown }, "- file name: {name}"));
    lines.push(t(config, "telegramInput.fileMessageId", { id: file.messageId ?? unknown }, "  message_id: {id}"));
    lines.push(t(config, "telegramInput.fileMime", { mime: file.mimeType || unknown }, "  mime: {mime}"));
    lines.push(t(config, "telegramInput.fileSize", { size: formatFileSize(file.fileSize) }, "  size: {size}"));
    if (file.path) lines.push(t(config, "telegramInput.filePath", { path: file.path }, "  local path: {path}"));
    if (file.error) {
      lines.push(t(config, "telegramInput.fileStatus", { text: file.error }, "  status: {text}"));
      continue;
    }
    if (file.text?.readable) {
      const suffix = file.text.truncated
        ? t(
          config,
          "telegramInput.fileTextTruncatedSuffix",
          { limit: INBOUND_TEXT_FILE_CONTEXT_MAX_CHARS, chars: file.text.originalChars },
          " (first {limit} chars, original {chars} chars)",
        )
        : "";
      lines.push(t(config, "telegramInput.fileTextContent", { suffix }, "  text content{suffix}:"));
      lines.push("```text");
      lines.push(file.text.text);
      lines.push("```");
    } else if (file.text && !file.text.readable) {
      lines.push(t(config, "telegramInput.fileTextUnreadable", { reason: file.text.reason }, "  text read: {reason}"));
    } else if (file.downloaded) {
      lines.push(t(
        config,
        "telegramInput.fileStatus",
        { text: t(config, "telegramInput.fileBinaryStatus", {}, "downloaded; file body was not expanded") },
        "  status: {text}",
      ));
    }
  }
  return lines.join("\n");
}

function normalizeTelegramMessages(messages) {
  const values = Array.isArray(messages) ? messages : [messages];
  const seen = new Set();
  return values
    .filter(Boolean)
    .sort((a, b) => Number(a.message_id || 0) - Number(b.message_id || 0))
    .filter((message) => {
      const key = String(message.message_id ?? `${message.date ?? ""}:${telegramMessageText(message)}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function buildTelegramInputFromMessages({ token, messages, runtimeDir, config }) {
  const normalized = normalizeTelegramMessages(messages);
  const primaryMessage = normalized[0] ?? null;
  const pulseHeader = buildTelegramPulseHeader(config, primaryMessage);
  const replyCarrier = normalized.find((message) => message.reply_to_message) ?? primaryMessage;
  const replyMessage = replyCarrier?.reply_to_message ?? null;
  const replyContext = replyMessage ? formatTelegramReplyContext(config, replyCarrier) : "";
  const replyImagePaths = replyMessage
    ? await downloadMessageImages({ token, message: replyMessage, runtimeDir })
    : [];
  const imagePaths = [];
  const fileItems = [];
  for (const message of normalized) {
    imagePaths.push(...await downloadMessageImages({ token, message, runtimeDir }));
    fileItems.push(...await downloadMessageFiles({ token, message, runtimeDir }));
  }
  const fileContext = formatTelegramFileContext(config, fileItems);

  const incomingText = normalized
    .map((message) => telegramMessageText(message).trim())
    .filter(Boolean)
    .join("\n\n");
  const mediaGroupId = telegramMediaGroupId(primaryMessage);
  const isGroup = Boolean(mediaGroupId) || normalized.length > 1;
  const messageIds = normalized
    .map((message) => message.message_id)
    .filter((id) => id !== null && id !== undefined);

  const currentContext = (() => {
    if (replyContext || isGroup || fileContext) {
      const lines = [t(config, "telegramInput.currentHeader")];
      if (mediaGroupId) lines.push(`media_group_id: ${mediaGroupId}`);
      if (messageIds.length > 0) lines.push(`message_ids: ${messageIds.join(", ")}`);
      if (incomingText) {
        lines.push(t(config, "telegramInput.content", { text: incomingText }));
      } else if (imagePaths.length > 0) {
        lines.push(t(config, "telegramInput.currentImages", { count: imagePaths.length }));
      } else {
        lines.push(t(config, "telegramInput.currentNoText"));
      }
      if (fileContext) lines.push(fileContext);
      return lines.join("\n");
    }
    return incomingText || (imagePaths.length > 0 ? t(config, "telegramInput.imageOnly") : "");
  })();

  const leadingText = [pulseHeader, replyContext, currentContext].filter(Boolean).join("\n");
  const input = [
    ...textInput(leadingText),
    ...replyImagePaths.map((imagePath) => localImageInput(imagePath)),
    ...imagePaths.map((imagePath) => localImageInput(imagePath)),
  ];
  const logText = [
    pulseHeader,
    replyContext,
    ...replyImagePaths.map((imagePath) => `[quoted image] ${imagePath}`),
    currentContext,
    ...imagePaths.map((imagePath) => `[image] ${imagePath}`),
    ...fileItems.map((file) => `[file] ${file.path || file.fileName || "unknown"}${file.error ? ` (${file.error})` : ""}`),
  ].filter(Boolean).join("\n");

  return {
    input,
    logText,
    mediaGroupId,
    messageIds,
    primaryMessage,
    replyMessage,
    incomingText,
    imagePaths,
    fileItems,
    replyContext,
    replyImagePaths,
    handled: Boolean(incomingText || imagePaths.length > 0 || fileItems.length > 0 || replyContext || replyImagePaths.length > 0),
  };
}

async function readyz(endpoint) {
  const url = new URL(endpoint);
  try {
    const response = await fetch(`http://${url.hostname}:${url.port}/readyz`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

function endpointWithPort(endpoint, port) {
  const url = new URL(endpoint);
  const pathSuffix = url.pathname && url.pathname !== "/" ? url.pathname : "";
  return `${url.protocol}//${url.hostname}:${port}${pathSuffix}`;
}

async function canBindEndpoint(endpoint) {
  const url = new URL(endpoint);
  const host = url.hostname || "127.0.0.1";
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) return false;
  return await new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    server.once("error", () => finish(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => finish(true));
    });
  });
}

async function selectAppServerEndpoint(config, runtimeDir) {
  const configuredEndpoint = String(config.app_server_endpoint);
  if (await readyz(configuredEndpoint)) {
    return { endpoint: configuredEndpoint, reused: true, configuredEndpoint };
  }
  if (await canBindEndpoint(configuredEndpoint)) {
    return { endpoint: configuredEndpoint, reused: false, configuredEndpoint };
  }

  const base = new URL(configuredEndpoint);
  const basePort = Number(base.port);
  const scanCount = Math.max(0, Math.trunc(numberFromConfig(config, "app_server_fallback_port_scan", 10)));
  for (let offset = 1; offset <= scanCount; offset += 1) {
    const candidate = endpointWithPort(configuredEndpoint, basePort + offset);
    if (await readyz(candidate)) {
      return { endpoint: candidate, reused: true, configuredEndpoint };
    }
    if (await canBindEndpoint(candidate)) {
      appendJsonl(path.join(runtimeDir, "app-server.jsonl"), {
        event: "endpoint_fallback_selected",
        configured_endpoint: configuredEndpoint,
        selected_endpoint: candidate,
        reason: "configured_endpoint_not_ready_and_not_bindable",
      });
      logSystem(`app-server endpoint fallback: ${configuredEndpoint} -> ${candidate}`);
      return { endpoint: candidate, reused: false, configuredEndpoint };
    }
  }

  throw new Error(`app-server endpoint unavailable: ${configuredEndpoint}`);
}

async function ensureAppServer(config, runtimeDir) {
  const selected = await selectAppServerEndpoint(config, runtimeDir);
  const endpoint = selected.endpoint;
  config.app_server_endpoint = endpoint;
  if (selected.reused) return null;
  const invocation = resolveCodexInvocation(String(config.codex_command || "codex"));
  mkdirSync(runtimeDir, { recursive: true });
  const child = spawn(invocation.command, [...invocation.prefixArgs, "app-server", "--listen", endpoint], {
    cwd: WORKSPACE_ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    shell: false,
    env: appServerEnv(),
  });
  appendJsonl(path.join(runtimeDir, "app-server.jsonl"), {
    event: "spawned",
    pid: child.pid ?? null,
    endpoint,
    configured_endpoint: selected.configuredEndpoint,
  });
  child.stderr.on("data", (chunk) => {
    appendFileSync(path.join(runtimeDir, "app-server.stderr.log"), chunk, "utf8");
  });
  child.once("exit", (code, signal) => {
    appendJsonl(path.join(runtimeDir, "app-server.jsonl"), {
      event: "exit",
      pid: child.pid ?? null,
      endpoint,
      code,
      signal,
    });
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await readyz(endpoint)) {
      logSystem(`app-server ready: ${endpoint}`);
      return child;
    }
    await delay(250);
  }
  child.kill("SIGTERM");
  throw new Error("app-server did not become ready");
}

async function openSocket(endpoint) {
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open timed out")), 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket open failed"));
    }, { once: true });
  });
  return ws;
}

function textInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

function pluginMentionInput(name, pluginPath) {
  return { type: "mention", name, path: pluginPath };
}

function skillInput(name, skillPath) {
  return { type: "skill", name, path: skillPath };
}

function inputItems(input) {
  return Array.isArray(input) ? input : textInput(String(input ?? ""));
}

function prependTextToInput(prefix, input) {
  const value = String(prefix ?? "").trimEnd();
  const items = inputItems(input);
  if (!value) return items;
  if (items[0]?.type === "text") {
    return [
      { ...items[0], text: `${value}\n${String(items[0].text ?? "")}` },
      ...items.slice(1),
    ];
  }
  return [...textInput(value), ...items];
}

function formatStartupPathList(config, paths) {
  const items = Array.isArray(paths)
    ? paths.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
  return items.length > 0 ? `- ${items.join("\n- ")}` : `- ${t(config, "startup.contextMissing")}`;
}

function formatStartupContextPathList(config) {
  return formatStartupPathList(config, config.startup_context_paths);
}

function formatStartupAutonomyPathList(config) {
  return formatStartupPathList(config, config.startup_autonomy_context_paths);
}

function startupAutonomyContextConfigured(config) {
  return Array.isArray(config.startup_autonomy_context_paths)
    && config.startup_autonomy_context_paths.some((item) => typeof item === "string" && item.trim());
}

function buildStartupInput(config, userInput, sourceLabel = null) {
  if (!Array.isArray(userInput)) return textInput(buildStartupPrompt(config, userInput, sourceLabel));
  return prependTextToInput(buildStartupPrompt(config, "", sourceLabel), userInput);
}

function localImageInput(imagePath) {
  return { type: "localImage", path: imagePath };
}

function buildStartupPrompt(config, userText, sourceLabel = null) {
  const paths = formatStartupContextPathList(config);
  const label = String(sourceLabel || t(config, "startup.sourceLabel")).trim() || t(config, "startup.sourceLabel");
  return [
    t(config, "startup.header"),
    t(config, "startup.intro"),
    paths,
    "",
    t(config, "startup.extraContextRule"),
    "",
    t(config, "startup.replyRule"),
    t(config, "startup.deliveryRule"),
    "",
    `【${label}】`,
    userText,
  ].join("\n");
}

function buildWakePrompt(config) {
  const lines = [
    t(config, "startup.header"),
    t(config, "startup.wakeIntro"),
    formatStartupContextPathList(config),
    "",
  ];
  if (startupAutonomyContextConfigured(config)) {
    lines.push(
      t(config, "startup.autonomyIntro"),
      formatStartupAutonomyPathList(config),
      "",
    );
  }
  lines.push(
    t(config, "startup.wakeRule"),
    t(config, "startup.deliveryRule"),
    "",
    t(config, "startup.wakeAction"),
  );
  return lines.join("\n");
}

function rhythmEnabled(config) {
  return booleanFromConfig(config, "rhythm_enabled", false);
}

function rhythmIntervalSeconds(config) {
  return Math.max(60, Math.trunc(numberFromConfig(config, "rhythm_interval_seconds", 2400)));
}

function rhythmMessage(config) {
  const fromFile = readOptionalText(localizedConfigPath(config, "rhythm_message_path"));
  return fromFile || localizedConfigText(config, "rhythm_message", "rhythm.fallbackMessage");
}

function rhythmTelegramNotice(config) {
  const value = localizedConfigValue(config, config.rhythm_telegram_notice);
  if (value === false || value === null) return null;
  const text = String(value ?? "").trim();
  return text || t(config, "rhythm.telegramNotice");
}

function rhythmIdleRequiredSeconds(config) {
  return Math.max(0, Math.trunc(numberFromConfig(config, "rhythm_idle_required_seconds", 180)));
}

function workBudgetSeconds(config) {
  return Math.max(60, Math.trunc(numberFromConfig(config, "work_budget_seconds", 1200)));
}

function typingActionIntervalSeconds(config) {
  return Math.max(1, Math.min(4, Math.trunc(numberFromConfig(config, "typing_action_interval_seconds", 4))));
}

function restSeconds(config) {
  return Math.max(0, Math.trunc(numberFromConfig(config, "rest_seconds", 600)));
}

function readOptionalText(value) {
  if (!value || typeof value !== "string") return null;
  const filePath = resolveWorkspacePath(value);
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
  return text || null;
}

function workBudgetPrompt(config) {
  return readOptionalText(localizedConfigPath(config, "work_budget_prompt_path"))
    || t(config, "workBudget.fallbackPrompt");
}

function compactingSeconds(config) {
  return Math.max(30, Math.trunc(numberFromConfig(config, "compacting_seconds", 180)));
}

function mediaGroupCollectSeconds(config) {
  return Math.max(1, Math.trunc(numberFromConfig(config, "media_group_collect_seconds", 2)));
}

function looseMediaCollectSeconds(config) {
  return Math.max(1, Math.trunc(numberFromConfig(config, "loose_media_collect_seconds", 3)));
}

function compactingStartedNotice(config) {
  return localizedConfigText(config, "compacting_started_notice", "compaction.started");
}

function compactingBusyNotice(config) {
  return localizedConfigText(config, "compacting_busy_notice", "compaction.busy");
}

function compactingQueuedNotice(config) {
  return localizedConfigText(config, "compacting_queued_notice", "compaction.queued");
}

function compactingCompletedNotice(config) {
  return localizedConfigText(config, "compacting_completed_notice", "compaction.completed");
}

function formatCompactionRecoveryStep(config, step) {
  if (!step) return t(config, "compaction.defaultStep");
  return `${step.model} ${step.effort}`;
}

function compactionRecoveryPausePrompt(config) {
  return localizedConfigText(config, "compaction_recovery_pause_prompt", "compaction.pausePrompt");
}

function compactingFailedNotice(config, nextStep = null) {
  if (nextStep) {
    return t(config, "compaction.failedNext", { step: formatCompactionRecoveryStep(config, nextStep) });
  }
  return localizedConfigText(config, "compacting_failed_notice", "compaction.failed");
}

function compactingTimedOutNotice(config, nextStep = null) {
  if (nextStep) {
    return t(config, "compaction.timedOutNext", { step: formatCompactionRecoveryStep(config, nextStep) });
  }
  return localizedConfigText(config, "compacting_timed_out_notice", "compaction.timedOut");
}

function compactionRecoveryStep(attempt) {
  const normalizedAttempt = Math.max(1, Math.trunc(Number(attempt || 1)));
  return {
    attempt: normalizedAttempt,
    model: "gpt-5.4-mini",
    effort: "low",
  };
}

function compactionDefaultStep(config) {
  return {
    model: String(config.model || "gpt-5.5"),
    effort: String(config.effort || "high"),
  };
}

function compactionDegradedStep() {
  return compactionRecoveryStep(1);
}

function compactionTurnOverride(state) {
  return state?.compaction_recovery_model_active ? compactionDegradedStep() : null;
}

function contextCompactionTriggerUsedPercent(config) {
  const configured = finiteNumber(config.context_compaction_trigger_used_percent);
  if (configured === null) return 85;
  return Math.max(50, Math.min(99, configured));
}

function compactionRecoveryMaxAttempts(config) {
  return Math.max(0, Math.trunc(numberFromConfig(config, "compaction_recovery_max_attempts", 1)));
}

function nextCompactionRecoveryStep(state, config) {
  const currentAttempt = Math.max(0, Math.trunc(Number(state?.compaction_recovery_pause_attempt || 0)));
  const nextAttempt = currentAttempt + 1;
  const maxAttempts = compactionRecoveryMaxAttempts(config);
  if (nextAttempt > maxAttempts) return null;
  return compactionRecoveryStep(nextAttempt);
}

function compactionRecoveryExhaustedNotice(config, maxAttempts) {
  return localizedConfigText(config, "compaction_recovery_exhausted_notice", "compaction.exhausted", { maxAttempts });
}

function compactionRecoveryResumePrompt(config) {
  return localizedConfigText(config, "compaction_recovery_resume_prompt", "compaction.resumePrompt");
}

function proactiveCompactionResumePrompt(config) {
  return localizedConfigText(config, "proactive_compaction_resume_prompt", "compaction.proactiveResumePrompt");
}

function compactionResumePrompt(config, reason) {
  return reason === "proactive"
    ? proactiveCompactionResumePrompt(config)
    : compactionRecoveryResumePrompt(config);
}

function contextUsageUsedPercent(snapshot) {
  const used = finiteNumber(snapshot?.used_tokens);
  const total = finiteNumber(snapshot?.total_tokens);
  if (used === null || total === null || total <= 0) return null;
  return (used / total) * 100;
}

function shouldStartProactiveCompaction(state, config) {
  if (!state.thread_id || state.active_turn_id) return false;
  if (isCompactionBlocked(state) || state.compacting_until) return false;
  if (state.compaction_circuit_opened_at) return false;
  const snapshot = state.context_usage_snapshot;
  if (!snapshot || snapshot.thread_id !== state.thread_id) return false;
  const usedPercent = contextUsageUsedPercent(snapshot);
  if (usedPercent === null) return false;
  return usedPercent >= contextCompactionTriggerUsedPercent(config);
}

function isCompactionErrorText(value) {
  return /compact|compaction|contextCompaction|responses\/compact|\u4e0a\u4e0b\u6587\u538b\u7f29/i.test(String(value || ""));
}

function isServerOverloadedErrorText(value) {
  const text = String(value || "");
  return /"codexErrorInfo"\s*:\s*"serverOverloaded"/i.test(text)
    || /\bcodexErrorInfo\b[\s\S]*\bserverOverloaded\b/i.test(text);
}

function serverOverloadedContinuePrompt(config) {
  return localizedConfigText(config, "server_overloaded_continue_prompt", "serverOverloaded.continuePrompt");
}

function isFailedRuntimeItem(item) {
  const status = String(item?.status ?? "").toLowerCase();
  if (status === "failed" || status === "error") return true;
  if (item?.exitCode === null || item?.exitCode === undefined) return false;
  const exitCode = Number(item.exitCode);
  return Number.isFinite(exitCode) && exitCode !== 0;
}

function runtimeItemFailureReason(item, prefix) {
  const parts = [
    prefix,
    item?.id ? `id=${item.id}` : null,
    item?.status ? `status=${item.status}` : null,
    item?.exitCode !== null && item?.exitCode !== undefined ? `exitCode=${item.exitCode}` : null,
    item?.error ? `error=${compactOneLine(item.error, 240)}` : null,
    item?.message ? `message=${compactOneLine(item.message, 240)}` : null,
  ].filter(Boolean);
  return parts.join(", ");
}

function parseIsoTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
}

function isResting(state) {
  const restUntil = parseIsoTime(state.rest_until);
  return restUntil !== null && Date.now() < restUntil;
}

function isCompacting(state) {
  const compactingUntil = parseIsoTime(state.compacting_until);
  return compactingUntil !== null && Date.now() < compactingUntil;
}

function isCompactionBlocked(state) {
  return Boolean(
    state.compaction_recovery_pending
    || state.compaction_recovery_model_active
    || isCompacting(state)
  );
}

function compactionResumeReason(state) {
  if (!state?.compaction_recovery_resume_pending) return null;
  const reason = String(state.compaction_recovery_resume_reason || "").trim();
  return reason || "recovery";
}

function isCompactionRecoveryResumeReady(state) {
  return Boolean(
    compactionResumeReason(state) === "recovery"
    && !state.compaction_recovery_pending
    && !state.compaction_recovery_model_active
    && !state.compaction_recovery_restore_in_progress
    && !state.compaction_circuit_opened_at
    && !isCompacting(state)
    && !state.compacting_until
  );
}

function shouldStoreInputForCompactionResume(state) {
  const reason = compactionResumeReason(state);
  return reason === "proactive" || reason === "recovery";
}

function hasCompactingTimedOut(state) {
  const compactingUntil = parseIsoTime(state.compacting_until);
  return compactingUntil !== null && Date.now() >= compactingUntil;
}

function formatBeijingTime(value, config = null) {
  const time = parseIsoTime(value);
  if (time === null) return value ? String(value) : null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(time)).map((part) => [part.type, part.value]),
  );
  const formatted = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  return config ? t(config, "common.beijingTime", { time: formatted }, `${formatted} Asia/Shanghai`) : `${formatted} Asia/Shanghai`;
}

function formatBeijingTimeShort(value) {
  const time = typeof value === "number" ? value : parseIsoTime(value);
  if (!Number.isFinite(time)) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(time)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteInteger(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.trunc(number);
}

function clampPercent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function formatInteger(config, value) {
  const number = finiteInteger(value);
  return number === null ? t(config, "common.unknown") : number.toLocaleString("en-US");
}

function formatCompactTokens(config, value) {
  const number = finiteInteger(value);
  if (number === null) return t(config, "common.unknown");
  if (number >= 1000000) return `${Math.round(number / 10000) / 100}M`;
  if (number >= 1000) return `${Math.round(number / 1000)}K`;
  return String(number);
}

function remainingPercent(used, total) {
  const usedNumber = finiteNumber(used);
  const totalNumber = finiteNumber(total);
  if (usedNumber === null || totalNumber === null || totalNumber <= 0) return null;
  return clampPercent(((totalNumber - usedNumber) / totalNumber) * 100);
}

function statusBar(percent, width = 18) {
  const safePercent = clampPercent(percent);
  if (safePercent === null) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((safePercent / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function formatWindowDuration(config, minutes) {
  const value = finiteInteger(minutes);
  if (value === 300) return t(config, "time.hours5");
  if (value === 10080) return t(config, "time.days7");
  if (value !== null && value % 1440 === 0) return t(config, "time.days", { value: value / 1440 });
  if (value !== null && value % 60 === 0) return t(config, "time.hours", { value: value / 60 });
  return value === null ? t(config, "time.unknownWindow") : t(config, "time.minutes", { value });
}

function contextUsageSnapshotFromParams(params, observedAt = iso()) {
  const tokenUsage = params?.tokenUsage;
  const last = tokenUsage?.last ?? {};
  const modelContextWindow = finiteInteger(tokenUsage?.modelContextWindow);
  const usedTokens = finiteInteger(last.inputTokens ?? last.totalTokens);
  if (modelContextWindow === null || usedTokens === null) return null;
  return {
    observed_at: observedAt,
    thread_id: params?.threadId ?? null,
    turn_id: params?.turnId ?? null,
    used_tokens: usedTokens,
    total_tokens: modelContextWindow,
    turn_total_tokens: finiteInteger(last.totalTokens),
    output_tokens: finiteInteger(last.outputTokens),
    reasoning_output_tokens: finiteInteger(last.reasoningOutputTokens),
    remaining_percent: remainingPercent(usedTokens, modelContextWindow),
  };
}

function rateLimitSnapshotFromPayload(rateLimits, observedAt = iso()) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const normalize = (limit) => {
    if (!limit || typeof limit !== "object") return null;
    const usedPercent = clampPercent(
      limit.usedPercent
        ?? limit.used_percent
        ?? limit.usagePercent
        ?? limit.usage_percent,
    );
    const remainingFromPayload = clampPercent(limit.remainingPercent ?? limit.remaining_percent);
    const remainingPercent = usedPercent === null
      ? remainingFromPayload
      : Math.max(0, 100 - usedPercent);
    return {
      used_percent: usedPercent,
      remaining_percent: remainingPercent,
      window_duration_mins: finiteInteger(limit.windowDurationMins),
      resets_at: finiteInteger(limit.resetsAt),
    };
  };
  return {
    observed_at: observedAt,
    limit_id: rateLimits.limitId ?? null,
    limit_name: rateLimits.limitName ?? null,
    plan_type: rateLimits.planType ?? null,
    rate_limit_reached_type: rateLimits.rateLimitReachedType ?? null,
    primary: normalize(rateLimits.primary),
    secondary: normalize(rateLimits.secondary),
  };
}

function rateLimitSnapshotFromParams(params, observedAt = iso()) {
  return rateLimitSnapshotFromPayload(params?.rateLimits, observedAt);
}

function isSuspiciousZeroRateLimitSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const primaryUsed = finiteNumber(snapshot.primary?.used_percent);
  const secondaryUsed = finiteNumber(snapshot.secondary?.used_percent);
  const primaryWindow = finiteInteger(snapshot.primary?.window_duration_mins);
  const secondaryWindow = finiteInteger(snapshot.secondary?.window_duration_mins);
  const modelSpecific = Boolean(snapshot.limit_name) || (
    snapshot.limit_id
    && snapshot.limit_id !== "codex"
  );
  return Boolean(
    modelSpecific
    && primaryWindow === 300
    && secondaryWindow === 10080
    && primaryUsed === 0
    && secondaryUsed === 0,
  );
}

function readFileTail(filePath, maxBytes = 512 * 1024) {
  if (!existsSync(filePath)) return "";
  const size = statSync(filePath).size;
  const bytesToRead = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, size - bytesToRead);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function snapshotTime(snapshot) {
  return parseIsoTime(snapshot?.observed_at);
}

function isNewerSnapshot(candidate, current) {
  if (!candidate) return false;
  const candidateTime = snapshotTime(candidate);
  const currentTime = snapshotTime(current);
  if (candidateTime === null) return currentTime === null;
  return currentTime === null || candidateTime > currentTime;
}

function readLatestStatusSnapshotsFromEvents(runtimeDir) {
  const eventsPath = path.join(runtimeDir, "events.jsonl");
  const lines = readFileTail(eventsPath).split(/\r?\n/).filter(Boolean);
  let contextUsageSnapshot = null;
  let rateLimitsSnapshot = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (contextUsageSnapshot && rateLimitsSnapshot) break;
    let entry = null;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const method = entry?.message?.method;
    if (!contextUsageSnapshot && method === "thread/tokenUsage/updated") {
      contextUsageSnapshot = contextUsageSnapshotFromParams(entry.message?.params, entry.ts);
    } else if (!rateLimitsSnapshot && method === "account/rateLimits/updated") {
      const candidate = rateLimitSnapshotFromParams(entry.message?.params, entry.ts);
      if (candidate && !isSuspiciousZeroRateLimitSnapshot(candidate)) {
        rateLimitsSnapshot = candidate;
      }
    }
  }

  return { contextUsageSnapshot, rateLimitsSnapshot };
}

function hydrateStatusSnapshots({ runtimeDir, statePath, state }) {
  let snapshots = null;
  try {
    snapshots = readLatestStatusSnapshotsFromEvents(runtimeDir);
  } catch (error) {
    logSystem(`status snapshot hydrate skipped: ${error.message || error}`);
    return state;
  }

  const patch = {};
  const contextSnapshotMatchesThread = !snapshots.contextUsageSnapshot?.thread_id
    || !state.thread_id
    || snapshots.contextUsageSnapshot.thread_id === state.thread_id;
  if (contextSnapshotMatchesThread && isNewerSnapshot(snapshots.contextUsageSnapshot, state.context_usage_snapshot)) {
    patch.context_usage_snapshot = snapshots.contextUsageSnapshot;
  }
  const currentRateLimitSuspicious = isSuspiciousZeroRateLimitSnapshot(state.rate_limits_snapshot);
  const candidateRateLimitSuspicious = isSuspiciousZeroRateLimitSnapshot(snapshots.rateLimitsSnapshot);
  if (
    isNewerSnapshot(snapshots.rateLimitsSnapshot, state.rate_limits_snapshot)
    || (
      currentRateLimitSuspicious
      && snapshots.rateLimitsSnapshot
      && !candidateRateLimitSuspicious
    )
  ) {
    patch.rate_limits_snapshot = snapshots.rateLimitsSnapshot;
  } else if (currentRateLimitSuspicious && !snapshots.rateLimitsSnapshot) {
    patch.rate_limits_snapshot = null;
  }
  return Object.keys(patch).length > 0 ? patchState(statePath, state, patch) : state;
}

function formatContextUsageLine(config, snapshot) {
  if (!snapshot) return t(config, "status.contextNone");
  const remaining = clampPercent(snapshot.remaining_percent);
  const usedTokens = formatInteger(config, snapshot.used_tokens);
  const totalTokens = formatCompactTokens(config, snapshot.total_tokens);
  const stale = formatBeijingTimeShort(snapshot.observed_at);
  return [
    t(config, "status.context", {
      bar: statusBar(remaining),
      remaining: remaining ?? "?",
      used: usedTokens,
      total: totalTokens,
    }),
    stale ? t(config, "status.snapshot", { time: stale }) : null,
  ].filter(Boolean).join("\n");
}

function formatRateLimitLine(config, label, limit) {
  if (!limit) return t(config, "status.limitNone", { label });
  const remaining = clampPercent(limit.remaining_percent);
  const resetTime = limit.resets_at ? formatBeijingTimeShort(limit.resets_at * 1000) : null;
  return t(config, "status.limit", {
    label,
    bar: statusBar(remaining),
    remaining: remaining ?? "?",
    reset: resetTime ?? t(config, "common.unknown"),
  });
}

function formatRateLimitLines(config, snapshot) {
  if (!snapshot) {
    return [
      t(config, "status.primaryLimitNone"),
      t(config, "status.secondaryLimitNone"),
    ];
  }
  const primaryLabel = t(config, "status.limitLabel", { window: formatWindowDuration(config, snapshot.primary?.window_duration_mins) });
  const secondaryLabel = t(config, "status.limitLabel", { window: formatWindowDuration(config, snapshot.secondary?.window_duration_mins) });
  const stale = formatBeijingTimeShort(snapshot.observed_at);
  if (isSuspiciousZeroRateLimitSnapshot(snapshot)) {
    return [
      t(config, "status.limitSuspicious", { label: primaryLabel }),
      t(config, "status.limitSuspicious", { label: secondaryLabel }),
      stale ? t(config, "status.limitSnapshot", { time: stale }) : null,
    ].filter(Boolean);
  }
  return [
    formatRateLimitLine(config, primaryLabel, snapshot.primary),
    formatRateLimitLine(config, secondaryLabel, snapshot.secondary),
    stale ? t(config, "status.limitSnapshot", { time: stale }) : null,
  ].filter(Boolean);
}

function formatMainlineStatus(state, config) {
  const pendingRecoveryStep = nextCompactionRecoveryStep(state, config);
  const activeRecoveryStep = state.compaction_recovery_pause_attempt
    ? compactionRecoveryStep(state.compaction_recovery_pause_attempt)
    : null;
  const recoveryStatus = state.compaction_recovery_pending
    ? pendingRecoveryStep
      ? t(config, "compaction.recoveryPending", {
        attempt: pendingRecoveryStep.attempt,
        step: formatCompactionRecoveryStep(config, pendingRecoveryStep),
      })
      : t(config, "compaction.recoveryOverLimit")
    : state.compaction_recovery_model_active
      ? t(config, "compaction.recoveryActive", { step: formatCompactionRecoveryStep(config, activeRecoveryStep) })
      : state.compaction_recovery_resume_pending
        ? t(config, "compaction.resumePending", { reason: state.compaction_recovery_resume_reason ?? "" })
      : state.compaction_circuit_opened_at
        ? t(config, "compaction.circuitOpen", { reason: state.compaction_circuit_reason ?? t(config, "common.unknown") })
        : t(config, "compaction.none");
  const runtimeDir = resolveWorkspacePath(String(config.runtime_dir || "runtime/tg_mainline"));
  const lines = [
    t(config, "status.title"),
    t(config, "status.session", { thread: state.thread_id ?? t(config, "status.threadMissing") }),
    formatContextUsageLine(config, state.context_usage_snapshot),
    ...formatRateLimitLines(config, state.rate_limits_snapshot),
    "",
    t(config, "status.activeTurn", { value: state.active_turn_id ? t(config, "common.yes") : t(config, "common.no") }),
    t(config, "status.model", { value: config.model ?? "gpt-5.5" }),
    t(config, "status.effort", { value: normalizedEffort(config.effort) }),
    t(config, "status.resting", {
      value: isResting(state)
        ? t(config, "status.until", { time: formatBeijingTime(state.rest_until, config) })
        : t(config, "status.notResting"),
    }),
    t(config, "status.compacting", {
      value: isCompacting(state)
        ? t(config, "status.until", { time: formatBeijingTime(state.compacting_until, config) })
        : t(config, "status.notResting"),
    }),
    t(config, "status.proactiveCompact", { percent: contextCompactionTriggerUsedPercent(config) }),
    t(config, "status.compactionRecovery", { value: recoveryStatus }),
    t(config, "status.compactionQueues", {
      input: countNonBlankLines(compactionInputQueuePath(config, runtimeDir)),
      replay: countNonBlankLines(compactionReplayQueuePath(config, runtimeDir)),
    }),
    t(config, "status.nextWake", { time: formatBeijingTime(state.next_wake_at, config) ?? t(config, "common.unset") }),
    t(config, "status.lastWake", { time: formatBeijingTime(state.last_wake_at, config) ?? t(config, "common.none") }),
    t(config, "status.wakeCount", { count: Number(state.wake_count || 0) }),
    t(config, "status.lastWakeSkip", { value: state.last_wake_skip_reason ?? t(config, "common.none") }),
    t(config, "status.lastVisibleOutput", { time: formatBeijingTime(state.last_codex_visible_output_at, config) ?? t(config, "common.none") }),
    t(config, "status.lastError", { value: state.last_error ? t(config, "common.yes") : t(config, "common.no") }),
    t(config, "status.rhythm", {
      value: rhythmEnabled(config)
        ? t(config, "rhythm.statusOn", { minutes: rhythmIntervalSeconds(config) / 60 })
        : t(config, "common.disabled"),
    }),
  ];
  return lines.join("\n");
}

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

function codexHomeDir() {
  return process.env.CODEX_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".codex") : null)
    || (process.env.HOME ? path.join(process.env.HOME, ".codex") : null);
}

function modelChoices(config) {
  const current = String(config.model || "gpt-5.5").trim();
  const home = codexHomeDir();
  const modelsCachePath = home ? path.join(home, "models_cache.json") : null;
  let models = [];
  try {
    const cache = modelsCachePath && existsSync(modelsCachePath) ? readJson(modelsCachePath) : null;
    models = Array.isArray(cache?.models) ? cache.models : [];
  } catch (error) {
    logSystem(`Codex models cache read skipped: ${error.message || error}`);
  }
  const seen = new Set();
  const choices = [];
  const addChoice = (choice) => {
    const id = String(choice?.slug || choice?.id || choice?.model || choice || "").trim();
    if (!id) return;
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const label = typeof choice === "object" && choice?.display_name
      ? String(choice.display_name).trim()
      : typeof choice === "object" && choice?.label
        ? String(choice.label).trim()
        : "";
    const priority = Number.isFinite(Number(choice?.priority)) ? Number(choice.priority) : 9999;
    choices.push({ id, label, priority });
  };
  for (const item of models) {
    if (String(item?.visibility || "list") !== "list") continue;
    addChoice(item);
  }
  addChoice({ id: current });
  return choices.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function normalizedModelKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function modelChoiceKeys(choice) {
  const keys = new Set([normalizedModelKey(choice.id), normalizedModelKey(choice.label)]);
  const parts = String(choice.id || "").split("-").filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    const suffix = parts.slice(index).join("-");
    if (suffix.length >= 3) keys.add(normalizedModelKey(suffix));
  }
  return [...keys].filter(Boolean);
}

function resolveModelChoice(config, value) {
  const needle = normalizedModelKey(value);
  if (!needle) return { choice: null, matches: [] };
  const matches = modelChoices(config).filter((choice) => modelChoiceKeys(choice).includes(needle));
  return { choice: matches.length === 1 ? matches[0] : null, matches };
}

function formatModelChoiceLine(choice, currentModel) {
  const current = String(currentModel || "").trim().toLowerCase() === choice.id.toLowerCase();
  const label = choice.label || choice.id;
  const details = choice.id === label ? "" : ` (${choice.id})`;
  return `${current ? "* " : "- "}${label}${details}`;
}

function modelUsageNotice(config) {
  const choices = modelChoices(config);
  return [
    t(config, "model.current", { model: String(config.model || "gpt-5.5").trim() }),
    "",
    t(config, "model.available"),
    ...choices.map((choice) => formatModelChoiceLine(choice, config.model)),
    "",
    ...tLines(config, "model.usage"),
    "",
    t(config, "model.note"),
  ].join("\n");
}

function parseModelCommand(text) {
  const value = String(text ?? "").trim();
  if (value === "/model") return { action: "status" };
  if (!value.startsWith("/model ")) return null;
  return { action: "set", model: value.slice(7).trim() };
}

function updateConfigModel({ config, configPath, model }) {
  const { choice } = resolveModelChoice(config, model);
  if (!choice) {
    throw new Error(`Unsupported model: ${model}`);
  }
  const diskConfig = readJson(configPath);
  diskConfig.model = choice.id;
  writeJson(configPath, diskConfig);
  config.model = choice.id;
  return choice.id;
}

function normalizedEffort(value) {
  const effort = String(value || "high").trim().toLowerCase();
  return VALID_EFFORTS.has(effort) ? effort : "high";
}

function effortUsageNotice(config) {
  return [
    t(config, "effort.current", { effort: normalizedEffort(config.effort) }),
    "",
    ...tLines(config, "effort.usage"),
    "",
    t(config, "effort.note"),
  ].join("\n");
}

function parseEffortCommand(text) {
  const value = String(text ?? "").trim();
  if (value === "/effort") return { action: "status" };
  if (!value.startsWith("/effort ")) return null;
  return { action: "set", effort: value.slice(8).trim().toLowerCase() };
}

function updateConfigEffort({ config, configPath, effort }) {
  const nextEffort = normalizedEffort(effort);
  if (nextEffort !== effort) {
    throw new Error(`Unsupported effort: ${effort}`);
  }
  const diskConfig = readJson(configPath);
  diskConfig.effort = nextEffort;
  writeJson(configPath, diskConfig);
  config.effort = nextEffort;
  return nextEffort;
}

function languageUsageNotice(config) {
  return [
    t(config, "language.current", { locale: localeOf(config) }),
    "",
    ...tLines(config, "language.usage"),
    "",
    t(config, "language.note"),
  ].join("\n");
}

function parseLanguageCommand(text) {
  const value = String(text ?? "").trim();
  if (value === "/language" || value === "/locale") return { action: "status" };
  if (value.startsWith("/language ")) return { action: "set", locale: value.slice(10).trim() };
  if (value.startsWith("/locale ")) return { action: "set", locale: value.slice(8).trim() };
  return null;
}

function updateConfigLocale({ config, configPath, locale }) {
  const raw = String(locale || "").trim();
  const lower = raw.toLowerCase().replace("_", "-");
  const knownInput = ["zh", "zh-cn", "cn", "en", "en-us", "us"].includes(lower) || SUPPORTED_LOCALES.has(raw);
  const nextLocale = normalizeLocale(locale);
  if (!knownInput || !SUPPORTED_LOCALES.has(nextLocale)) {
    throw new Error(`Unsupported locale: ${locale}`);
  }
  const diskConfig = readJson(configPath);
  diskConfig.locale = nextLocale;
  writeJson(configPath, diskConfig);
  config.locale = nextLocale;
  prepareI18n(config);
  return nextLocale;
}

function rhythmMinutes(config) {
  return Math.trunc(rhythmIntervalSeconds(config) / 60);
}

function rhythmUsageNotice(config, state) {
  return [
    t(config, "rhythm.title"),
    t(config, "rhythm.status", {
      status: rhythmEnabled(config)
        ? t(config, "rhythm.statusOn", { minutes: rhythmMinutes(config) })
        : t(config, "common.disabled"),
    }),
    t(config, "rhythm.nextWake", { time: formatBeijingTime(state.next_wake_at, config) ?? t(config, "common.unset") }),
    "",
    ...tLines(config, "rhythm.usage"),
    "",
    t(config, "rhythm.note"),
  ].join("\n");
}

function parseRhythmCommand(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (value === "/rhythm") return { action: "status" };
  if (!value.startsWith("/rhythm ")) return null;
  const arg = value.slice(8).trim();
  if (arg === "on") return { action: "on" };
  if (arg === "off") return { action: "off" };
  const match = /^([1-9]\d*)m$/.exec(arg);
  if (match) return { action: "set", minutes: Number(match[1]) };
  return { action: "invalid", arg };
}

function updateConfigRhythm({ config, configPath, state, statePath, command }) {
  const diskConfig = readJson(configPath);
  const previousEnabled = rhythmEnabled(config);
  const previousMinutes = rhythmMinutes(config);

  if (command.action === "off") {
    diskConfig.rhythm_enabled = false;
    config.rhythm_enabled = false;
    writeJson(configPath, diskConfig);
    patchState(statePath, state, { next_wake_at: null });
    return {
      previousEnabled,
      previousMinutes,
      nextEnabled: false,
      nextMinutes: previousMinutes,
      nextWakeAt: null,
    };
  }

  if (command.action === "on") {
    diskConfig.rhythm_enabled = true;
    config.rhythm_enabled = true;
  } else if (command.action === "set") {
    const minutes = Math.max(1, Math.trunc(Number(command.minutes)));
    diskConfig.rhythm_enabled = true;
    diskConfig.rhythm_interval_seconds = minutes * 60;
    config.rhythm_enabled = true;
    config.rhythm_interval_seconds = minutes * 60;
  } else {
    throw new Error(`Unsupported rhythm action: ${command.action}`);
  }

  writeJson(configPath, diskConfig);
  const nextMinutes = rhythmMinutes(config);
  const nextWakeAt = addSeconds(new Date(), rhythmIntervalSeconds(config)).toISOString();
  patchState(statePath, state, {
    next_wake_at: nextWakeAt,
    last_wake_skip_at: null,
    last_wake_skip_reason: null,
  });
  return {
    previousEnabled,
    previousMinutes,
    nextEnabled: true,
    nextMinutes,
    nextWakeAt,
  };
}

function rhythmChangedNotice(config, result, configPath) {
  const from = result.previousEnabled ? `${result.previousMinutes}m` : t(config, "common.disabled");
  const to = result.nextEnabled ? `${result.nextMinutes}m` : t(config, "common.disabled");
  return [
    t(config, "rhythm.changed", { from, to }),
    t(config, "rhythm.nextWake", { time: formatBeijingTime(result.nextWakeAt, config) ?? t(config, "common.unset") }),
    t(config, "common.writtenBack", { path: path.relative(WORKSPACE_ROOT, configPath) }),
  ].join("\n");
}

function formatSessionStatus(config, state) {
  return [
    t(config, "session.statusTitle"),
    t(config, "session.thread", { thread: state.thread_id ?? t(config, "session.newThreadNext") }),
    "",
    ...tLines(config, "session.usage"),
    t(config, "session.note"),
  ].join("\n").trimEnd();
}

function parseHistoryCommand(text) {
  const value = String(text ?? "").trim();
  if (value === "/history") return { action: "usage" };
  if (!value.startsWith("/history")) return null;
  if (value.length <= "/history".length || !/\s/.test(value["/history".length])) return null;
  const query = value.slice("/history".length + 1).trim();
  if (!query) return { action: "usage" };
  return { action: "search", query };
}

function historyUsageNotice(config) {
  return t(config, "history.usage");
}

function threadTitle(config, thread) {
  const name = String(thread?.name || "").trim();
  if (name) return name;
  const preview = String(thread?.preview || "").trim();
  if (preview) return compactOneLine(preview, 64);
  return t(config, "history.untitled");
}

function cwdLabel(cwd) {
  const value = String(cwd || "").trim();
  if (!value) return null;
  const base = path.basename(value);
  return base || value;
}

function historyThreadTime(thread) {
  const updatedAt = Number(thread?.updatedAt ?? thread?.updated_at);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  return formatBeijingTimeShort(updatedAt < 10_000_000_000 ? updatedAt * 1000 : updatedAt);
}

function formatHistorySearchResults(config, query, response) {
  const rows = Array.isArray(response?.data) ? response.data : [];
  if (rows.length === 0) {
    return [
      t(config, "history.title", { query }),
      t(config, "history.noResults"),
    ].join("\n");
  }
  const lines = [
    t(config, "history.title", { query }),
    t(config, "history.count", { count: rows.length }),
    "",
  ];
  rows.forEach((item, index) => {
    const thread = item?.thread || {};
    const title = threadTitle(config, thread);
    const updated = historyThreadTime(thread);
    const cwd = cwdLabel(thread.cwd);
    const snippet = compactOneLine(item?.snippet || thread.preview || "", 180);
    lines.push(`${index + 1}. ${title}`);
    lines.push(t(config, "history.thread", { thread: thread.id || t(config, "common.unknown") }));
    if (updated || cwd) lines.push(`   ${[updated, cwd].filter(Boolean).join(" | ")}`);
    if (snippet) lines.push(t(config, "history.summary", { snippet }));
    if (thread.id) lines.push(t(config, "history.switch", { thread: thread.id }));
    lines.push("");
  });
  if (response?.nextCursor) {
    lines.push(t(config, "history.more"));
  }
  return lines.join("\n").trimEnd();
}

function parseSessionCommand(text) {
  const value = String(text ?? "").trim();
  if (value === "/session") return { action: "status" };
  if (value === "/session new") return { action: "new" };
  if (value.startsWith("/session use ")) return { action: "use", threadId: value.slice(13).trim() };
  return null;
}

function parseGoalCommand(text) {
  const value = String(text ?? "").trim();
  if (value === "/goal" || value === "/goal status") return { action: "status" };
  if (value === "/goal clear") return { action: "clear" };
  if (value === "/goal pause") return { action: "pause" };
  if (value === "/goal resume") return { action: "resume" };
  if (!value.startsWith("/goal ")) return null;
  const body = value.slice(6).trim();
  if (!body) return { action: "invalid", reason: "empty" };
  const edit = /^edit\b/i.exec(body);
  if (edit) {
    const objective = body.slice(edit[0].length).trim();
    if (!objective) return { action: "invalid", reason: "edit_empty" };
    return { action: "edit", objective };
  }
  const reserved = /^(clear|pause|resume)\b/i.exec(body);
  if (reserved) return { action: "invalid", reason: "bad_subcommand", subcommand: reserved[1].toLowerCase() };
  return { action: "set", objective: body };
}

function goalUsageLines(config) {
  return tLines(config, "goal.usage");
}

function goalUsageNotice(config) {
  return [
    t(config, "goal.title"),
    "",
    ...goalUsageLines(config),
    "",
    t(config, "goal.note1"),
    t(config, "goal.note2"),
  ].join("\n");
}

function goalTimestamp(config, value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const ms = number < 10_000_000_000 ? number * 1000 : number;
  return formatBeijingTime(new Date(ms).toISOString(), config);
}

function formatGoalStatus(config, goal) {
  if (!goal) {
    return [
      t(config, "goal.title"),
      t(config, "goal.notSet"),
      "",
      ...goalUsageLines(config),
    ].join("\n");
  }
  const tokenBudget = goal.tokenBudget === null || goal.tokenBudget === undefined
    ? t(config, "goal.tokenBudgetUnset")
    : String(goal.tokenBudget);
  const updatedAt = goalTimestamp(config, goal.updatedAt);
  return [
    t(config, "goal.title"),
    t(config, "goal.status", { status: goal.status ?? t(config, "common.unknown") }),
    t(config, "goal.objective", { objective: goal.objective ?? t(config, "goal.objectiveEmpty") }),
    `tokens：${goal.tokensUsed ?? 0} / ${tokenBudget}`,
    t(config, "goal.elapsed", { seconds: goal.timeUsedSeconds ?? 0 }),
    updatedAt ? t(config, "goal.updated", { time: updatedAt }) : null,
    "",
    ...goalUsageLines(config),
  ].filter(Boolean).join("\n");
}

function isValidThreadId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function resetThreadBindingForNewSession({ statePath, state }) {
  const previousThreadId = state.thread_id ?? null;
  patchState(statePath, state, {
    thread_id: null,
    active_turn_id: null,
    active_turn_started_at: null,
    last_output_at: null,
    last_codex_visible_output_at: null,
    work_budget_turn_id: null,
    work_budget_steered_at: null,
    context_usage_snapshot: null,
    compacting_until: null,
    compacting_started_at: null,
    compacting_item_id: null,
    compaction_recovery_pending: false,
    compaction_recovery_attempt: 0,
    compaction_recovery_pause_attempt: 0,
    compaction_recovery_model_active: false,
    compaction_recovery_restore_model: null,
    compaction_recovery_restore_effort: null,
    compaction_recovery_restore_in_progress: false,
    compaction_recovery_resume_pending: false,
    compaction_recovery_resume_reason: null,
    compaction_recovery_resume_last_sent_at: null,
    compaction_last_failed_at: null,
    compaction_last_failed_turn_id: null,
    compaction_last_error: null,
    compaction_circuit_opened_at: null,
    compaction_circuit_reason: null,
    compaction_protected_turn: null,
    server_overloaded_last_error_at: null,
    server_overloaded_last_turn_id: null,
    server_overloaded_resume_requested_for_turn_id: null,
    server_overloaded_recovery_turn_id: null,
    last_error: null,
  });
  return { previousThreadId };
}

function bindExistingThread({ statePath, state, threadId }) {
  const previousThreadId = state.thread_id ?? null;
  patchState(statePath, state, {
    thread_id: threadId,
    active_turn_id: null,
    active_turn_started_at: null,
    active_turn_computer_use: false,
    last_output_at: null,
    last_codex_visible_output_at: null,
    work_budget_turn_id: null,
    work_budget_steered_at: null,
    context_usage_snapshot: null,
    compacting_until: null,
    compacting_started_at: null,
    compacting_item_id: null,
    compaction_recovery_pending: false,
    compaction_recovery_attempt: 0,
    compaction_recovery_pause_attempt: 0,
    compaction_recovery_model_active: false,
    compaction_recovery_restore_model: null,
    compaction_recovery_restore_effort: null,
    compaction_recovery_restore_in_progress: false,
    compaction_recovery_resume_pending: false,
    compaction_recovery_resume_reason: null,
    compaction_recovery_resume_last_sent_at: null,
    compaction_last_failed_at: null,
    compaction_last_failed_turn_id: null,
    compaction_last_error: null,
    compaction_circuit_opened_at: null,
    compaction_circuit_reason: null,
    compaction_protected_turn: null,
    server_overloaded_last_error_at: null,
    server_overloaded_last_turn_id: null,
    server_overloaded_resume_requested_for_turn_id: null,
    server_overloaded_recovery_turn_id: null,
    last_error: null,
  });
  return { previousThreadId };
}

function parsePlanCommand(text) {
  const value = String(text ?? "");
  if (!value.startsWith("/plan")) return null;
  if (value.length === 5) return { body: "" };
  if (!/\s/.test(value[5])) return null;
  return { body: value.slice(6).trim() };
}

function planUsageNotice(config) {
  return t(config, "plan.usage");
}

function planFinishedNotice(config) {
  return t(config, "plan.finished");
}

const COMPUTER_USE_PLUGIN_PATH = "plugin://computer-use@openai-bundled";
const COMPUTER_USE_PLUGIN_NAME = "Computer Use";
const COMPUTER_USE_PLUGIN_MARKDOWN = `[@${COMPUTER_USE_PLUGIN_NAME}](${COMPUTER_USE_PLUGIN_PATH})`;
const COMPUTER_SKILL_NAME = "computer";
const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".codex");
const COMPUTER_SKILL_PATH = process.env.CODEX_MAINLINE_COMPUTER_SKILL_PATH
  || path.join(CODEX_HOME, "skills", "computer", "SKILL.md");
const COMPUTER_USE_PLUGIN_CACHE_DIR = path.join(
  CODEX_HOME,
  "plugins",
  "cache",
  "openai-bundled",
  "computer-use",
);

function parseComputerCommand(text) {
  const value = String(text ?? "");
  if (!value.startsWith("/computer")) return null;
  if (value.length === 9) return { body: "" };
  if (!/\s/.test(value[9])) return null;
  return { body: value.slice(10).trim() };
}

function computerUsageNotice(config) {
  return t(config, "computer.usage");
}

function buildComputerUseInput(config, message, body) {
  const prompt = [
    COMPUTER_USE_PLUGIN_MARKDOWN,
    `${buildTelegramPulseHeader(config, message)}`,
    t(config, "computer.requestHeader"),
    t(config, "computer.requestLine1"),
    t(config, "computer.requestLine2"),
    "",
    body,
  ].join("\n");
  return [
    skillInput(COMPUTER_SKILL_NAME, COMPUTER_SKILL_PATH),
    pluginMentionInput(COMPUTER_USE_PLUGIN_NAME, COMPUTER_USE_PLUGIN_PATH),
    ...textInput(prompt),
  ];
}

function computerInputShape(input) {
  const items = inputItems(input);
  const firstText = items.find((item) => item?.type === "text")?.text ?? "";
  return {
    item_types: items.map((item) => item?.type ?? typeof item),
    has_plugin_markdown: firstText.includes(COMPUTER_USE_PLUGIN_MARKDOWN),
    has_plugin_mention: items.some((item) => item?.type === "mention" && item?.path === COMPUTER_USE_PLUGIN_PATH),
    has_computer_skill: items.some((item) => item?.type === "skill" && item?.name === COMPUTER_SKILL_NAME),
  };
}

function latestComputerUsePluginDir() {
  try {
    if (!existsSync(COMPUTER_USE_PLUGIN_CACHE_DIR)) return null;
    const versions = readdirSync(COMPUTER_USE_PLUGIN_CACHE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    for (let i = versions.length - 1; i >= 0; i -= 1) {
      const dir = path.join(COMPUTER_USE_PLUGIN_CACHE_DIR, versions[i]);
      const exe = path.join(dir, "node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
      if (existsSync(exe)) return { dir, exe, version: versions[i] };
    }
  } catch {
    return null;
  }
  return null;
}

function computerUseTurnEndedPayload(threadId, turnId) {
  const payload = {};
  if (threadId) {
    payload.session_id = String(threadId);
    payload.conversation_id = String(threadId);
    payload.threadId = String(threadId);
  }
  if (turnId) {
    payload.turn_id = String(turnId);
    payload.turnId = String(turnId);
  }
  return JSON.stringify(payload);
}

function mcpToolCallUsesComputerUse(item) {
  if (item?.type !== "mcpToolCall") return false;
  if (String(item.server ?? "") !== "node_repl" || String(item.tool ?? "") !== "js") return false;
  const args = item.arguments ?? {};
  const code = typeof args === "string" ? args : String(args.code ?? "");
  return /computer-use-client\.mjs|setupComputerUseRuntime|\bsky\.(list_apps|list_windows|get_window|get_window_state|activate_window|click|press_key|type_text|scroll|set_value|drag|perform_secondary_action|launch_app)\b/.test(code);
}

function notifyComputerUseTurnEnded({ runtimeDir, threadId, turnId }) {
  const logPath = path.join(runtimeDir, "computer_use_notify.jsonl");
  try {
    const plugin = latestComputerUsePluginDir();
    if (!plugin) {
      appendJsonl(logPath, {
        event: "turn_ended_notify_missing",
        thread_id: threadId ?? null,
        turn_id: turnId ?? null,
      });
      logSystem("computer-use turn-ended notify skipped: helper executable not found");
      return false;
    }
    const payload = computerUseTurnEndedPayload(threadId, turnId);
    const result = spawnSync(plugin.exe, ["turn-ended", payload], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    appendJsonl(logPath, {
      event: "turn_ended_notify",
      thread_id: threadId ?? null,
      turn_id: turnId ?? null,
      helper_version: plugin.version,
      exit_code: result.status,
      signal: result.signal ?? null,
      error: result.error ? String(result.error.message || result.error) : null,
      stdout: String(result.stdout ?? "").slice(0, 1000),
      stderr: String(result.stderr ?? "").slice(0, 1000),
    });
    if (result.error || result.status !== 0) {
      logSystem(`computer-use turn-ended notify failed: ${result.error?.message || result.stderr || result.status}`);
      return false;
    }
    logSystem(`computer-use turn-ended notify sent: ${turnId ?? "(unknown)"}`);
    return true;
  } catch (error) {
    appendJsonl(logPath, {
      event: "turn_ended_notify_exception",
      thread_id: threadId ?? null,
      turn_id: turnId ?? null,
      error: String(error?.stack || error),
    });
    logSystem(`computer-use turn-ended notify exception: ${error?.message || error}`);
    return false;
  }
}

function clearCompacting(statePath, state, reason) {
  if (!state.compacting_until && !state.compacting_started_at) return state;
  logSystem(`compacting ended: ${reason}`);
  return patchState(statePath, state, {
    compacting_until: null,
    compacting_started_at: null,
    compacting_item_id: null,
  });
}

function clearRest(statePath, state, reason) {
  if (!state.rest_until && !state.rest_started_at && !state.rest_reason) return state;
  logSystem(`rest ended: ${reason}`);
  return patchState(statePath, state, {
    rest_until: null,
    rest_started_at: null,
    rest_reason: null,
  });
}

function ensureNextWake(config, statePath, state) {
  if (!rhythmEnabled(config)) return;
  if (state.next_wake_at) return;
  const next = addSeconds(new Date(), rhythmIntervalSeconds(config)).toISOString();
  patchState(statePath, state, { next_wake_at: next });
  logSystem(`rhythm armed: next wake at ${next}`);
}

function armNextWakeFromStartup(config, statePath, state) {
  if (!rhythmEnabled(config)) return state;
  const next = addSeconds(new Date(), rhythmIntervalSeconds(config)).toISOString();
  const updated = patchState(statePath, state, { next_wake_at: next });
  logSystem(`rhythm armed from startup: next wake at ${next}`);
  return updated;
}

function scheduleNextWake(config, statePath, state, patch = {}) {
  if (!rhythmEnabled(config)) return;
  const next = addSeconds(new Date(), rhythmIntervalSeconds(config)).toISOString();
  patchState(statePath, state, { ...patch, next_wake_at: next });
}

class RpcClient {
  constructor({ ws, eventsPath, onNotification }) {
    this.ws = ws;
    this.eventsPath = eventsPath;
    this.onNotification = onNotification;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener("close", () => {
      this.closed = true;
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const requestMethod = Object.hasOwn(message, "id") ? this.pending.get(message.id)?.method ?? null : null;
      appendJsonl(eventsPath, { direction: "recv", requestMethod, message });
      if (DEBUG_RAW) console.log(JSON.stringify(message));
      if (Object.hasOwn(message, "id") && this.pending.has(message.id)) {
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
        return;
      }
      if (message.method) this.onNotification(message);
      if (message.error) this.onNotification(message);
    });
  }

  async request(method, params, timeoutMs = 120000) {
    if (this.closed) throw new Error("websocket is closed");
    const id = this.nextId++;
    const message = { id, method, params };
    appendJsonl(this.eventsPath, { direction: "send", message });
    if (DEBUG_RAW) console.log(JSON.stringify(message));
    this.ws.send(JSON.stringify(message));
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }
}

class MainlineSession {
  constructor({ config, state, statePath, runtimeDir, token, chatId, maxChars }) {
    this.config = config;
    this.state = state;
    this.statePath = statePath;
    this.runtimeDir = runtimeDir;
    this.token = token;
    this.chatId = chatId;
    this.maxChars = maxChars;
    this.ws = null;
    this.rpc = null;
    this.currentTurnId = null;
    this.currentAssistantText = "";
    this.currentAssistantItems = new Map();
    this.sentAssistantItems = new Set();
    this.pendingTelegramRelays = [];
    this.telegramRelayQueue = Promise.resolve();
    this.runDetailText = "";
    this.runDetailMessageIds = [];
    this.runDetailRendered = [];
    this.runDetailFlushTimer = null;
    this.runDetailFlushInFlight = false;
    this.runDetailFlushAgain = false;
    this.runDetailFinal = false;
    this.runDetailStarted = false;
    this.runDetailToolStates = new Map();
    this.runDetailLatest = null;
    this.activeCommandId = null;
    this.commandCounter = 0;
    this.commandNumbers = new Map();
    this.commandOutputSeen = new Set();
    this.currentTurnDone = null;
    this.currentTurnDoneResolve = null;
    this.currentTurnDoneTypingAttached = false;
    this.computerUseTurnIds = new Set();
    this.typingIndicatorToken = null;
    this.typingIndicatorPromise = Promise.resolve();
  }

  async ensureConnected() {
    if (this.rpc && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await ensureAppServer(this.config, this.runtimeDir);
    this.ws = await openSocket(String(this.config.app_server_endpoint));
    this.rpc = new RpcClient({
      ws: this.ws,
      eventsPath: path.join(this.runtimeDir, "events.jsonl"),
      onNotification: (message) => this.handleNotification(message),
    });
    await this.rpc.request("initialize", {
      clientInfo: { name: "codex-mainline", title: "Codex Mainline", version: "0.1.8" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    });
    logSystem("app-server websocket connected");
  }

  async ensureThread(options = {}) {
    await this.ensureConnected();
    const model = String(options.model || this.config.model || "gpt-5.5");
    const serviceTier = optionalString(this.config.service_tier);
    if (this.state.thread_id) {
      await this.rpc.request("thread/resume", {
        threadId: this.state.thread_id,
        cwd: WORKSPACE_ROOT,
        model,
        serviceTier,
        approvalPolicy: "never",
        sandbox: sandboxModeFromConfig(this.config),
        personality: "pragmatic",
        persistExtendedHistory: true,
        includeTurns: false,
      });
      return this.state.thread_id;
    }

    const started = await this.rpc.request("thread/start", {
      cwd: WORKSPACE_ROOT,
      model,
      serviceTier,
      approvalPolicy: "never",
      sandbox: sandboxModeFromConfig(this.config),
      ephemeral: false,
      personality: "pragmatic",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const threadId = started.thread?.id;
    if (!threadId) throw new Error("thread/start did not return thread.id");
    patchState(this.statePath, this.state, { thread_id: threadId });
    logSystem(`new mainline thread: ${threadId}`);
    return threadId;
  }

  async verifyThreadCanResume(threadId) {
    await this.ensureConnected();
    const model = String(this.config.model || "gpt-5.5");
    const serviceTier = optionalString(this.config.service_tier);
    await this.rpc.request("thread/resume", {
      threadId,
      cwd: WORKSPACE_ROOT,
      model,
      serviceTier,
      approvalPolicy: "never",
      sandbox: sandboxModeFromConfig(this.config),
      personality: "pragmatic",
      persistExtendedHistory: true,
      includeTurns: false,
    });
    return true;
  }

  async searchHistoryThreads(query, { limit = 8 } = {}) {
    await this.ensureConnected();
    return await this.rpc.request("thread/search", {
      searchTerm: String(query || "").trim(),
      limit,
      sortKey: "updated_at",
      archived: false,
    });
  }

  async resumeBoundThreadForGoal() {
    if (!this.state.thread_id) return null;
    await this.verifyThreadCanResume(this.state.thread_id);
    return this.state.thread_id;
  }

  async getGoal() {
    const threadId = await this.resumeBoundThreadForGoal();
    if (!threadId) return null;
    const result = await this.rpc.request("thread/goal/get", { threadId });
    return result?.goal ?? null;
  }

  async setGoal(objective) {
    const threadId = await this.resumeBoundThreadForGoal();
    if (!threadId) throw new Error(t(this.config, "goal.needThread"));
    const result = await this.rpc.request("thread/goal/set", { threadId, objective });
    return result?.goal ?? null;
  }

  async updateGoal(params) {
    const threadId = await this.resumeBoundThreadForGoal();
    if (!threadId) throw new Error(t(this.config, "goal.needThread"));
    const result = await this.rpc.request("thread/goal/set", { threadId, ...params });
    return result?.goal ?? null;
  }

  async pauseGoal() {
    const current = await this.getGoal();
    if (!current) return null;
    return await this.updateGoal({ status: "paused" });
  }

  async resumeGoal() {
    const current = await this.getGoal();
    if (!current) return null;
    return await this.updateGoal({ status: "active" });
  }

  async editGoal(objective) {
    const current = await this.getGoal();
    if (!current) return null;
    return await this.updateGoal({ objective });
  }

  async clearGoal() {
    const threadId = await this.resumeBoundThreadForGoal();
    if (!threadId) return false;
    const result = await this.rpc.request("thread/goal/clear", { threadId });
    return Boolean(result?.cleared);
  }

  async pauseActiveGoalIfNeeded() {
    const current = await this.getGoal();
    if (!current || current.status !== "active") return { paused: false, goal: current };
    const goal = await this.updateGoal({ status: "paused" });
    return { paused: true, goal };
  }

  async interruptActiveTurn() {
    await this.ensureConnected();
    if (!this.state.thread_id || !this.state.active_turn_id) {
      return { interrupted: false, reason: "no_active_turn" };
    }
    await this.rpc.request("thread/resume", {
      threadId: this.state.thread_id,
      cwd: WORKSPACE_ROOT,
      model: String(this.config.model || "gpt-5.5"),
      serviceTier: optionalString(this.config.service_tier),
      approvalPolicy: "never",
      sandbox: sandboxModeFromConfig(this.config),
      personality: "pragmatic",
      persistExtendedHistory: true,
      includeTurns: false,
    });
    await this.rpc.request("turn/interrupt", {
      threadId: this.state.thread_id,
      turnId: this.state.active_turn_id,
    });
    return { interrupted: true, turnId: this.state.active_turn_id };
  }

  async startContextCompaction({ model = null, effort = null, resumeReason = null } = {}) {
    const threadId = await this.ensureThread({ model });
    const configOverride = {};
    if (model) configOverride.model = String(model);
    if (effort) configOverride.model_reasoning_effort = String(effort);
    if (Object.keys(configOverride).length > 0) {
      await this.rpc.request("thread/resume", {
        threadId,
        cwd: WORKSPACE_ROOT,
        model: model ? String(model) : String(this.config.model || "gpt-5.5"),
        serviceTier: optionalString(this.config.service_tier),
        approvalPolicy: "never",
        sandbox: sandboxModeFromConfig(this.config),
        personality: "pragmatic",
        persistExtendedHistory: true,
        includeTurns: false,
        config: configOverride,
      });
    }
    const now = new Date();
    const statePatch = {
      compacting_started_at: iso(now),
      compacting_until: addSeconds(now, compactingSeconds(this.config)).toISOString(),
      compacting_item_id: "compact-start-requested",
    };
    if (resumeReason) {
      statePatch.compaction_recovery_resume_pending = true;
      statePatch.compaction_recovery_resume_reason = String(resumeReason);
      statePatch.compaction_recovery_resume_last_sent_at = null;
    }
    patchState(this.statePath, this.state, statePatch);
    await this.rpc.request("thread/compact/start", { threadId });
    return { threadId };
  }

  async restoreDefaultModelForThread() {
    if (!this.state.thread_id) return false;
    const fallbackStep = compactionDefaultStep(this.config);
    const step = {
      model: String(this.state.compaction_recovery_restore_model || fallbackStep.model),
      effort: String(this.state.compaction_recovery_restore_effort || fallbackStep.effort),
    };
    await this.rpc.request("thread/resume", {
      threadId: this.state.thread_id,
      cwd: WORKSPACE_ROOT,
      model: step.model,
      serviceTier: optionalString(this.config.service_tier),
      approvalPolicy: "never",
      sandbox: sandboxModeFromConfig(this.config),
      personality: "pragmatic",
      persistExtendedHistory: true,
      includeTurns: false,
      config: { model: step.model, model_reasoning_effort: step.effort },
    });
    logSystem(`default model restored after compaction recovery: model=${step.model}, effort=${step.effort}`);
    return true;
  }

  turnParams(threadId, prompt, options = {}) {
    const serviceTier = optionalString(this.config.service_tier);
    const effort = String(options.effort || this.config.effort || "high");
    const model = String(options.model || this.config.model || "gpt-5.5");
    const params = {
      threadId,
      cwd: WORKSPACE_ROOT,
      model,
      approvalPolicy: "never",
      effort,
      sandboxPolicy: turnSandboxPolicy(this.config, options.sandboxPolicy),
      input: inputItems(prompt),
    };
    if (options.collaborationMode) {
      params.collaborationMode = options.collaborationMode;
    }
    if (serviceTier) {
      params.serviceTier = serviceTier;
      params.responsesapiClientMetadata = { serviceTier, reasoningEffort: effort, model };
    }
    return params;
  }

  collaborationMode(mode, options = {}) {
    const model = String(options.model || this.config.model || "gpt-5.5");
    const effort = String(options.effort || this.config.effort || "high");
    return {
      mode,
      settings: {
        model,
        reasoning_effort: effort,
        developer_instructions: null,
      },
    };
  }

  async startTurn(userInput, {
    startup = false,
    startupSourceLabel = null,
    model = null,
    effort = null,
    computerUse = false,
    typingIndicator = false,
    protectInputOnCompactionFailure = false,
    protectedInputReason = "turn_input",
    protectedInputMetadata = null,
  } = {}) {
    const degradedStep = compactionTurnOverride(this.state);
    const effectiveModel = model ?? degradedStep?.model ?? null;
    const effectiveEffort = effort ?? degradedStep?.effort ?? null;
    const overrides = { model: effectiveModel, effort: effectiveEffort };
    const threadId = await this.ensureThread(overrides);
    const prompt = startup ? buildStartupInput(this.config, userInput, startupSourceLabel) : userInput;
    const maxWaitMs = numberFromConfig(this.config, "turn_max_wait_seconds", 1800) * 1000;
    this.prepareTurnWait(maxWaitMs);
    if (typingIndicator) this.enableTypingIndicatorForCurrentTurn("user_request");
    let result;
    try {
      result = await this.rpc.request("turn/start", this.turnParams(threadId, prompt, {
        model: effectiveModel,
        effort: effectiveEffort,
        collaborationMode: this.collaborationMode("default", overrides),
      }));
    } catch (error) {
      this.stopTypingIndicator();
      const done = this.currentTurnDoneResolve;
      this.currentTurnDoneResolve = null;
      done?.(false);
      throw error;
    }
    const turnId = result.turn?.id;
    if (turnId) {
      this.currentTurnId = turnId;
      if (computerUse) this.computerUseTurnIds.add(turnId);
      const patch = {
        active_turn_id: turnId,
        active_turn_started_at: iso(),
        active_turn_computer_use: Boolean(computerUse),
      };
      if (protectInputOnCompactionFailure) {
        patch.compaction_protected_turn = protectedTurnRecord({
          turnId,
          input: prompt,
          reason: protectedInputReason,
          metadata: protectedInputMetadata,
        });
      }
      patchState(this.statePath, this.state, patch);
    }
    return { turnId: turnId ?? this.currentTurnId, done: this.currentTurnDone };
  }

  async startPlanTurn(userInput, {
    startup = false,
    typingIndicator = false,
    protectInputOnCompactionFailure = false,
    protectedInputReason = "plan_input",
    protectedInputMetadata = null,
  } = {}) {
    const threadId = await this.ensureThread();
    const prompt = startup ? buildStartupInput(this.config, userInput) : userInput;
    const maxWaitMs = numberFromConfig(this.config, "turn_max_wait_seconds", 1800) * 1000;
    this.prepareTurnWait(maxWaitMs);
    if (typingIndicator) this.enableTypingIndicatorForCurrentTurn("user_plan_request");
    let result;
    try {
      result = await this.rpc.request("turn/start", this.turnParams(threadId, prompt, {
        sandboxPolicy: {
          type: "readOnly",
          networkAccess: false,
        },
        collaborationMode: this.collaborationMode("plan"),
      }));
    } catch (error) {
      this.stopTypingIndicator();
      const done = this.currentTurnDoneResolve;
      this.currentTurnDoneResolve = null;
      done?.(false);
      throw error;
    }
    const turnId = result.turn?.id;
    if (turnId) {
      this.currentTurnId = turnId;
      const patch = {
        active_turn_id: turnId,
        active_turn_started_at: iso(),
        active_turn_computer_use: false,
      };
      if (protectInputOnCompactionFailure) {
        patch.compaction_protected_turn = protectedTurnRecord({
          turnId,
          input: prompt,
          reason: protectedInputReason,
          metadata: protectedInputMetadata,
        });
      }
      patchState(this.statePath, this.state, patch);
    }
    return { turnId: turnId ?? this.currentTurnId, done: this.currentTurnDone };
  }

  async wake() {
    const threadId = await this.ensureThread();
    const maxWaitMs = numberFromConfig(this.config, "turn_max_wait_seconds", 1800) * 1000;
    this.prepareTurnWait(maxWaitMs);
    const result = await this.rpc.request("turn/start", this.turnParams(threadId, withSystemPulseHeader(this.config, buildWakePrompt(this.config)), {
      collaborationMode: this.collaborationMode("default"),
    }));
    const turnId = result.turn?.id;
    if (turnId) {
      this.currentTurnId = turnId;
      patchState(this.statePath, this.state, {
        active_turn_id: turnId,
        active_turn_started_at: iso(),
        active_turn_computer_use: false,
      });
    }
    return { turnId: turnId ?? this.currentTurnId, done: this.currentTurnDone };
  }

  shouldContinueAfterServerOverloaded(failedTurnId) {
    if (!failedTurnId) return false;
    if (!isServerOverloadedErrorText(this.state.last_error)) return false;
    if (this.state.server_overloaded_recovery_turn_id === failedTurnId) return false;
    if (this.state.server_overloaded_resume_requested_for_turn_id === failedTurnId) return false;
    return true;
  }

  async continueAfterServerOverloaded(failedTurnId) {
    if (!failedTurnId || !this.state.thread_id) return null;
    if (!this.shouldContinueAfterServerOverloaded(failedTurnId)) return null;

    patchState(this.statePath, this.state, {
      server_overloaded_last_error_at: iso(),
      server_overloaded_last_turn_id: failedTurnId,
      server_overloaded_resume_requested_for_turn_id: failedTurnId,
      last_error: null,
    });

    this.ensureRunDetailsStarted(t(this.config, "runDetails.systemEvent"));
    this.appendRunDetail(`serverOverloaded detected; continuation requested: failed_turn=${failedTurnId}`);
    this.flushRunDetails(false);

    try {
      const prompt = withSystemPulseHeader(this.config, serverOverloadedContinuePrompt(this.config));
      const turn = await this.startTurn(prompt, {
        startup: false,
        startupSourceLabel: "serverOverloaded recovery",
        typingIndicator: true,
      });
      if (turn?.turnId) {
        patchState(this.statePath, this.state, {
          server_overloaded_recovery_turn_id: turn.turnId,
        });
      }
      logSystem(`serverOverloaded continuation started: failed_turn=${failedTurnId}, recovery_turn=${turn?.turnId ?? "(unknown)"}`);
      return turn;
    } catch (error) {
      const message = error?.stack || String(error);
      patchState(this.statePath, this.state, { last_error: message });
      this.ensureRunDetailsStarted(t(this.config, "runDetails.systemError"));
      this.appendRunDetail(`serverOverloaded continuation start failed: ${compactOneLine(error?.message || error, 240)}`);
      this.flushRunDetails(true);
      logSystem(`serverOverloaded continuation start failed: ${error?.message || error}`);
      return null;
    }
  }

  prepareTurnWait(maxWaitMs) {
    this.currentAssistantText = "";
    this.currentAssistantItems = new Map();
    this.sentAssistantItems = new Set();
    this.pendingTelegramRelays = [];
    this.telegramRelayQueue = Promise.resolve();
    this.resetRunDetails();
    this.currentTurnDoneTypingAttached = false;
    this.currentTurnDone = new Promise((resolve) => {
      const timer = setTimeout(() => {
        logSystem("turn still running; keeping bridge alive and waiting for events");
        resolve(false);
      }, maxWaitMs);
      this.currentTurnDoneResolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  }

  startTypingIndicator(reason = "turn") {
    if (this.typingIndicatorToken?.active) return;
    const token = { active: true, reason };
    this.typingIndicatorToken = token;
    const intervalMs = typingActionIntervalSeconds(this.config) * 1000;
    logSystem(`TG typing indicator started: ${reason}`);
    this.typingIndicatorPromise = (async () => {
      while (token.active) {
        await sendChatAction({
          token: this.token,
          chatId: this.chatId,
          action: "typing",
          runtimeDir: this.runtimeDir,
        });
        await delay(intervalMs);
      }
      return true;
    })().catch((error) => {
      patchState(this.statePath, this.state, { last_error: error.stack || String(error) });
      logSystem(`TG typing indicator failed: ${error.message || error}`);
      return false;
    }).finally(() => {
      if (this.typingIndicatorToken === token) this.typingIndicatorToken = null;
      logSystem(`TG typing indicator stopped: ${reason}`);
    });
  }

  stopTypingIndicator() {
    if (this.typingIndicatorToken) this.typingIndicatorToken.active = false;
  }

  enableTypingIndicatorForCurrentTurn(reason = "turn") {
    this.startTypingIndicator(reason);
    if (!this.currentTurnDone || this.currentTurnDoneTypingAttached) return;
    this.currentTurnDoneTypingAttached = true;
    this.currentTurnDone = this.currentTurnDone.finally(() => {
      this.stopTypingIndicator();
    });
  }

  resetRunDetails() {
    if (this.runDetailFlushTimer) clearTimeout(this.runDetailFlushTimer);
    this.runDetailText = "";
    this.runDetailMessageIds = [];
    this.runDetailRendered = [];
    this.runDetailFlushTimer = null;
    this.runDetailFlushInFlight = false;
    this.runDetailFlushAgain = false;
    this.runDetailFinal = false;
    this.runDetailStarted = false;
    this.activeCommandId = null;
    this.commandCounter = 0;
    this.commandNumbers = new Map();
    this.commandOutputSeen = new Set();
    this.commandOutputStats = new Map();
  }

  ensureRunDetailsStarted(reason) {
    if (this.runDetailStarted) return;
    this.runDetailStarted = true;
    this.appendRunDetail([
      `turn: ${this.currentTurnId ?? "(unknown)"}`,
      t(this.config, "runDetails.stage", { reason }),
    ].join("\n"));
  }

  appendRunDetail(text) {
    const value = String(text ?? "");
    if (!value.trim()) return;
    const prefix = this.runDetailText ? "\n" : "";
    this.runDetailText += `${prefix}${value.trimEnd()}`;
    this.scheduleRunDetailFlush();
  }

  appendRunDetailRaw(text) {
    const value = String(text ?? "");
    if (!value) return;
    this.runDetailText += value;
    this.scheduleRunDetailFlush();
  }

  noteRunDetailToolStarted(key, label) {
    const id = String(key || `tool-${this.commandCounter + 1}`);
    const prior = this.runDetailToolStates.get(id) ?? {};
    this.runDetailToolStates.set(id, {
      ...prior,
      label: compactOneLine(label || prior.label || id, 180),
      completed: false,
      failed: false,
    });
    this.runDetailLatest = `started ${compactOneLine(label || id, 180)}`;
  }

  noteRunDetailToolCompleted(key, label, failed = false) {
    const id = String(key || `tool-${this.commandCounter + 1}`);
    const prior = this.runDetailToolStates.get(id) ?? {};
    const compactLabel = compactOneLine(label || prior.label || id, 180);
    this.runDetailToolStates.set(id, {
      ...prior,
      label: compactLabel,
      completed: true,
      failed: Boolean(failed),
    });
    this.runDetailLatest = `${failed ? "failed" : "completed"} ${compactLabel}`;
  }

  runDetailSummaryText({ final = this.runDetailFinal, toolStates = this.runDetailToolStates, latest = this.runDetailLatest } = {}) {
    const lines = [
      `turn: ${this.currentTurnId ?? "(unknown)"}`,
      t(this.config, "runDetails.status", { state: final ? t(this.config, "runDetails.done") : t(this.config, "runDetails.live") }),
    ];
    if (latest) lines.push(t(this.config, "runDetails.latest", { latest }));
    lines.push(t(this.config, "runDetails.expandHint"));
    return lines.join("\n");
  }

  scheduleRunDetailFlush(delayMs = 6000) {
    if (this.runDetailFlushTimer) return;
    this.runDetailFlushTimer = setTimeout(() => {
      this.runDetailFlushTimer = null;
      this.flushRunDetails(false);
    }, delayMs);
  }

  runDetailTextForTelegram({
    text = this.runDetailText,
    final = this.runDetailFinal,
    toolStates = this.runDetailToolStates,
    latest = this.runDetailLatest,
  } = {}) {
    const maxChars = Math.max(1200, Math.trunc(numberFromConfig(this.config, "run_detail_max_chars", 2600)));
    const summary = this.runDetailSummaryText({ final, toolStates, latest });
    const fullText = `${summary}\n\n---\n\n${text}`;
    if (fullText.length <= maxChars) return fullText;
    const headChars = Math.trunc(maxChars * 0.65);
    const tailChars = Math.max(300, maxChars - headChars);
    return [
      fullText.slice(0, headChars).trimEnd(),
      "",
      t(this.config, "runDetails.truncated", { path: path.join(this.runtimeDir, "events*.jsonl") }),
      "",
      fullText.slice(-tailChars).trimStart(),
    ].join("\n");
  }

  flushRunDetails(final = false) {
    if (!this.runDetailText.trim()) return Promise.resolve(true);
    this.runDetailFinal = this.runDetailFinal || final;
    if (this.runDetailFlushInFlight && !final) {
      this.runDetailFlushAgain = true;
      return Promise.resolve(false);
    }
    if (this.runDetailFlushTimer) {
      clearTimeout(this.runDetailFlushTimer);
      this.runDetailFlushTimer = null;
    }

    this.runDetailFlushInFlight = true;
    const segmentText = this.runDetailText;
    const segmentFinal = this.runDetailFinal;
    const segmentToolStates = new Map(this.runDetailToolStates);
    const segmentLatest = this.runDetailLatest;
    const segmentMessageIds = this.runDetailMessageIds;
    const segmentRendered = this.runDetailRendered;
    const chunkSize = Math.max(1000, Math.min(3300, this.maxChars - 600));
    const rawChunks = splitTextForTelegram(
      this.runDetailTextForTelegram({
        text: segmentText,
        final: segmentFinal,
        toolStates: segmentToolStates,
        latest: segmentLatest,
      }),
      chunkSize,
    );
    const renderedChunks = rawChunks.map((chunk, index) => (
      formatRunDetailBlock(this.config, chunk, index, rawChunks.length, segmentFinal)
    ));

    const relay = this.telegramRelayQueue.then(async () => {
      for (let index = 0; index < renderedChunks.length; index += 1) {
        const rendered = renderedChunks[index];
        if (segmentRendered[index] === rendered) continue;
        if (segmentMessageIds[index]) {
          await editFormattedText({
            token: this.token,
            chatId: this.chatId,
            messageId: segmentMessageIds[index],
            text: rendered,
            parseMode: "HTML",
            runtimeDir: this.runtimeDir,
          });
        } else {
          const result = await sendFormattedText({
            token: this.token,
            chatId: this.chatId,
            text: rendered,
            parseMode: "HTML",
            runtimeDir: this.runtimeDir,
          });
          segmentMessageIds[index] = result?.message_id ?? null;
        }
        segmentRendered[index] = rendered;
      }
      return true;
    }).catch((error) => {
      patchState(this.statePath, this.state, { last_error: error.stack || String(error) });
      logSystem(`TG run detail relay failed: ${error.message || error}`);
      return false;
    }).finally(() => {
      this.runDetailFlushInFlight = false;
      if (this.runDetailFlushAgain) {
        this.runDetailFlushAgain = false;
        this.scheduleRunDetailFlush(this.runDetailFinal ? 0 : 500);
      }
    });

    this.telegramRelayQueue = relay.then(() => undefined, () => undefined);
    this.pendingTelegramRelays.push(relay);
    return relay;
  }

  closeRunDetailSegment() {
    if (!this.runDetailText.trim()) return Promise.resolve(true);
    const relay = this.flushRunDetails(true);
    this.resetRunDetails();
    return relay;
  }

  waitForRunDetailsIdle() {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.runDetailFlushInFlight && !this.runDetailFlushTimer) {
          resolve(true);
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  }

  commandNumber(itemId) {
    const key = String(itemId || `command-${this.commandCounter + 1}`);
    if (!this.commandNumbers.has(key)) {
      this.commandCounter += 1;
      this.commandNumbers.set(key, this.commandCounter);
    }
    return this.commandNumbers.get(key);
  }

  appendCommandOutput(itemId, output) {
    const value = String(output ?? "");
    if (!value) return;
    const key = String(itemId || this.activeCommandId || "command");
    this.ensureRunDetailsStarted(t(this.config, "runDetails.toolOutput"));
    const stat = this.commandOutputStats.get(key) ?? { chars: 0, previewChars: 0, truncated: false };
    stat.chars += value.length;
    const previewLimit = Math.max(0, Math.trunc(numberFromConfig(this.config, "run_detail_output_preview_chars", 260)));
    const remainingPreview = Math.max(0, previewLimit - stat.previewChars);
    if (!this.commandOutputSeen.has(key)) {
      this.commandOutputSeen.add(key);
      const number = this.commandNumbers.get(key);
      this.appendRunDetail(`${number ? `tool #${number} ` : ""}output preview:`);
    }
    if (remainingPreview > 0) {
      const preview = value.slice(0, remainingPreview);
      stat.previewChars += preview.length;
      this.appendRunDetailRaw(`\n${preview}`);
      if (value.length > remainingPreview && !stat.truncated) {
        stat.truncated = true;
        this.appendRunDetailRaw("\n...[output truncated in TG; full output is in runtime events]");
      }
    } else if (!stat.truncated) {
      stat.truncated = true;
      this.appendRunDetailRaw("\n...[output truncated in TG; full output is in runtime events]");
    }
    this.commandOutputStats.set(key, stat);
  }

  appendGenericToolStart(item) {
    const id = item?.id ?? `${item?.type || "tool"}-${this.commandCounter + 1}`;
    const number = this.commandNumber(id);
    this.ensureRunDetailsStarted(t(this.config, "runDetails.toolCall"));
    this.noteRunDetailToolStarted(id, `tool #${number} ${item?.type ?? "(unknown)"}`);
    this.appendRunDetail([
      `tool #${number} started: ${item?.type ?? "(unknown)"}`,
      item?.id ? `id: ${item.id}` : null,
      item?.name ? `name: ${item.name}` : null,
      item?.query ? `query: ${compactOneLine(item.query)}` : null,
    ].filter(Boolean).join("\n"));
  }

  appendGenericToolCompletion(item) {
    const id = item?.id ?? `${item?.type || "tool"}-${this.commandCounter + 1}`;
    const number = this.commandNumber(id);
    this.ensureRunDetailsStarted(t(this.config, "runDetails.toolDone"));
    this.noteRunDetailToolCompleted(
      id,
      `tool #${number} ${item?.type ?? "(unknown)"} status=${item?.status ?? "(unknown)"}`,
      String(item?.status ?? "").toLowerCase() === "failed",
    );
    this.appendRunDetail([
      `tool #${number} completed: ${item?.type ?? "(unknown)"}`,
      item?.id ? `id: ${item.id}` : null,
      item?.status ? `status: ${item.status}` : null,
    ].filter(Boolean).join("\n"));
  }

  noteComputerUseActivity(turnId, item) {
    const effectiveTurnId = turnId ?? this.currentTurnId ?? this.state.active_turn_id ?? null;
    if (!effectiveTurnId) return;
    const firstSeen = !this.computerUseTurnIds.has(effectiveTurnId);
    this.computerUseTurnIds.add(effectiveTurnId);
    if (this.state.active_turn_id === effectiveTurnId && !this.state.active_turn_computer_use) {
      patchState(this.statePath, this.state, { active_turn_computer_use: true });
    }
    if (firstSeen) {
      appendJsonl(path.join(this.runtimeDir, "computer_use_notify.jsonl"), {
        event: "turn_marked_by_tool",
        thread_id: this.state.thread_id ?? null,
        turn_id: effectiveTurnId,
        item_id: item?.id ?? null,
      });
      logSystem(`computer-use activity detected in turn: ${effectiveTurnId}`);
    }
  }

  appendWebSearchStart(item) {
    this.ensureRunDetailsStarted(t(this.config, "runDetails.webSearch"));
    const query = item?.query || item?.action?.query || "(query pending)";
    logSystem(`web search started: ${query}`);
    this.appendRunDetail([
      "web search started",
      `query: ${query}`,
      item?.action ? `action: ${JSON.stringify(item.action)}` : null,
    ].filter(Boolean).join("\n"));
  }

  appendWebSearchCompletion(item) {
    this.ensureRunDetailsStarted(t(this.config, "runDetails.webSearch"));
    const query = item?.query || item?.action?.query || "(query pending)";
    logSystem(`web search completed: ${query}`);
    this.appendRunDetail([
      "web search completed",
      `query: ${query}`,
      item?.action ? `action: ${JSON.stringify(item.action)}` : null,
    ].filter(Boolean).join("\n"));
  }

  noteContextCompactionStarted(item) {
    const now = new Date();
    const until = addSeconds(now, compactingSeconds(this.config)).toISOString();
    logSystem(`context compaction started: ${item?.id ?? "(unknown)"}`);
    this.ensureRunDetailsStarted(t(this.config, "runDetails.contextCompaction"));
    this.appendRunDetail(`context compaction started: ${item?.id ?? "(unknown)"}`);
    const statePatch = {
      compacting_started_at: iso(now),
      compacting_until: until,
      compacting_item_id: item?.id ?? null,
    };
    if (!this.state.compaction_recovery_model_active) {
      Object.assign(statePatch, {
        compaction_recovery_pending: false,
        compaction_recovery_attempt: 0,
        compaction_recovery_pause_attempt: 0,
        compaction_recovery_model_active: false,
        compaction_recovery_restore_model: null,
        compaction_recovery_restore_effort: null,
        compaction_recovery_restore_in_progress: false,
        compaction_last_failed_at: null,
        compaction_last_failed_turn_id: null,
        compaction_last_error: null,
        compaction_circuit_opened_at: null,
        compaction_circuit_reason: null,
      });
    }
    patchState(this.statePath, this.state, statePatch);
    this.relayToTelegram(compactingStartedNotice(this.config));
  }

  noteContextCompactionCompleted(item) {
    logSystem(`context compaction completed: ${item?.id ?? "(unknown)"}`);
    this.ensureRunDetailsStarted(t(this.config, "runDetails.contextCompaction"));
    this.appendRunDetail(`context compaction completed: ${item?.id ?? "(unknown)"}`);
    const shouldRestoreDefaultModel = Boolean(this.state.compaction_recovery_model_active);
    patchState(this.statePath, this.state, {
      compacting_started_at: null,
      compacting_until: null,
      compacting_item_id: null,
      compaction_recovery_pending: false,
      compaction_recovery_attempt: 0,
      compaction_recovery_pause_attempt: 0,
      compaction_recovery_restore_in_progress: shouldRestoreDefaultModel,
      compaction_last_error: null,
      compaction_last_failed_turn_id: null,
      compaction_circuit_opened_at: null,
      compaction_circuit_reason: null,
    });
    if (shouldRestoreDefaultModel) {
      this.restoreDefaultModelForThread().then((restored) => {
        if (!restored) logSystem("default model restore skipped: no thread bound");
        patchState(this.statePath, this.state, {
          compaction_recovery_model_active: false,
          compaction_recovery_restore_model: null,
          compaction_recovery_restore_effort: null,
          compaction_recovery_restore_in_progress: false,
        });
        this.relayToTelegram(compactingCompletedNotice(this.config));
      }).catch((error) => {
        const message = error?.stack || String(error);
        patchState(this.statePath, this.state, {
          compaction_recovery_restore_in_progress: false,
          last_error: message,
        });
        appendJsonl(path.join(this.runtimeDir, "errors.jsonl"), { error: message });
        logSystem(`default model restore failed: ${error.message || error}`);
      });
      return;
    }
    patchState(this.statePath, this.state, {
      compaction_recovery_model_active: false,
      compaction_recovery_restore_model: null,
      compaction_recovery_restore_effort: null,
      compaction_recovery_restore_in_progress: false,
    });
    this.relayToTelegram(compactingCompletedNotice(this.config));
  }

  queueProtectedTurnForReplay(turnId, reason) {
    const protectedTurn = this.state.compaction_protected_turn;
    const shouldReplayProtectedTurn = Boolean(
      turnId
      && protectedTurn?.turn_id
      && protectedTurn.turn_id === turnId
      && protectedTurn.input,
    );
    if (!shouldReplayProtectedTurn) return false;
    const queuePath = enqueueCompactionReplayInput({
      config: this.config,
      runtimeDir: this.runtimeDir,
      replay: protectedTurn,
      reason,
    });
    logSystem(`protected turn input queued after compaction issue: turn=${turnId}, queue=${queuePath}, reason=${reason}`);
    return true;
  }

  noteContextCompactionFailed(reason, turnId = null) {
    const failedTurnId = turnId ?? this.currentTurnId ?? null;
    if (failedTurnId && this.state.compaction_last_failed_turn_id === failedTurnId) return;
    const summary = compactOneLine(reason, 500);
    const nextStep = nextCompactionRecoveryStep(this.state, this.config);
    const restoreStep = compactionDefaultStep(this.config);
    const shouldReplayProtectedTurn = this.queueProtectedTurnForReplay(
      failedTurnId,
      "compaction_failed_before_sampling",
    );
    logSystem(`context compaction failed: ${summary}`);
    this.ensureRunDetailsStarted(t(this.config, "runDetails.contextCompaction"));
    if (shouldReplayProtectedTurn) {
      this.appendRunDetail(`protected turn input queued for replay: turn=${failedTurnId}`);
    }
    this.appendRunDetail(`context compaction failed: ${summary}`);
    const patch = {
      compacting_started_at: null,
      compacting_until: null,
      compacting_item_id: null,
      compaction_recovery_pending: true,
      compaction_recovery_model_active: true,
      compaction_recovery_restore_model: restoreStep.model,
      compaction_recovery_restore_effort: restoreStep.effort,
      compaction_recovery_restore_in_progress: false,
      compaction_recovery_resume_pending: true,
      compaction_recovery_resume_reason: "recovery",
      compaction_recovery_resume_last_sent_at: null,
      compaction_last_failed_at: iso(),
      compaction_last_failed_turn_id: failedTurnId,
      compaction_last_error: summary,
      last_error: summary,
    };
    if (shouldReplayProtectedTurn) patch.compaction_protected_turn = null;
    patchState(this.statePath, this.state, patch);
    this.relayToTelegram(compactingFailedNotice(this.config, nextStep));
  }

  noteContextCompactionTimedOut() {
    if (!this.state.compacting_until && !this.state.compacting_started_at) return;
    const reason = `context compaction timed out after ${compactingSeconds(this.config)}s`;
    logSystem(reason);
    this.ensureRunDetailsStarted(t(this.config, "runDetails.contextCompaction"));
    this.appendRunDetail(reason);
    const timedOutTurnId = this.state.active_turn_id ?? this.currentTurnId ?? null;
    const shouldReplayProtectedTurn = this.queueProtectedTurnForReplay(
      timedOutTurnId,
      "compaction_timed_out_before_sampling",
    );
    if (shouldReplayProtectedTurn) {
      this.appendRunDetail(`protected turn input queued for replay: turn=${timedOutTurnId}`);
    }
    const restoreStep = compactionDefaultStep(this.config);
    const patch = {
      compacting_started_at: null,
      compacting_until: null,
      compacting_item_id: null,
      compaction_recovery_pending: true,
      compaction_recovery_model_active: true,
      compaction_recovery_restore_model: restoreStep.model,
      compaction_recovery_restore_effort: restoreStep.effort,
      compaction_recovery_restore_in_progress: false,
      compaction_recovery_resume_pending: true,
      compaction_recovery_resume_reason: "recovery",
      compaction_recovery_resume_last_sent_at: null,
      compaction_last_failed_at: iso(),
      compaction_last_error: reason,
      last_error: reason,
    };
    if (shouldReplayProtectedTurn) patch.compaction_protected_turn = null;
    patchState(this.statePath, this.state, patch);
    this.relayToTelegram(compactingTimedOutNotice(this.config, nextCompactionRecoveryStep(this.state, this.config)));
  }

  relayToTelegram(text) {
    const value = String(text ?? "");
    if (!value.trim()) return;
    const relay = this.telegramRelayQueue.then(() => sendText({
      token: this.token,
      chatId: this.chatId,
      text: value,
      maxChars: this.maxChars,
      runtimeDir: this.runtimeDir,
      echo: false,
    })).catch((error) => {
      patchState(this.statePath, this.state, { last_error: error.stack || String(error) });
      logSystem(`TG relay failed: ${error.message || error}`);
      return false;
    });
    this.telegramRelayQueue = relay.then(() => undefined, () => undefined);
    this.pendingTelegramRelays.push(relay);
  }

  relayGeneratedImage(item) {
    const imagePath = imageGenerationPathFromItem(item, this.runtimeDir);
    if (!imagePath) {
      logSystem("image generation completed without a sendable image");
      return;
    }
    const relay = this.telegramRelayQueue.then(() => sendPhotoLocal({
      token: this.token,
      chatId: this.chatId,
      photoPath: imagePath,
      runtimeDir: this.runtimeDir,
    })).catch((error) => {
      patchState(this.statePath, this.state, { last_error: error.stack || String(error) });
      logSystem(`TG image relay failed: ${error.message || error}`);
      return false;
    });
    this.telegramRelayQueue = relay.then(() => undefined, () => undefined);
    this.pendingTelegramRelays.push(relay);
  }

  relayDeliveryFile(filePath) {
    let resolvedPath = null;
    try {
      resolvedPath = resolveDeliveryFilePath(filePath);
    } catch (error) {
      logSystem(`TG delivery skipped: ${error.message || error}`);
      return;
    }

    const relay = this.telegramRelayQueue.then(() => {
      if (isTelegramPhotoPath(resolvedPath)) {
        return sendPhotoLocal({
          token: this.token,
          chatId: this.chatId,
          photoPath: resolvedPath,
          runtimeDir: this.runtimeDir,
        });
      }
      return sendDocumentLocal({
        token: this.token,
        chatId: this.chatId,
        documentPath: resolvedPath,
        runtimeDir: this.runtimeDir,
      });
    }).catch((error) => {
      patchState(this.statePath, this.state, { last_error: error.stack || String(error) });
      logSystem(`TG file relay failed: ${error.message || error}`);
      return false;
    });
    this.telegramRelayQueue = relay.then(() => undefined, () => undefined);
    this.pendingTelegramRelays.push(relay);
  }

  relayAssistantItem(itemId, text) {
    const key = String(itemId || `assistant-${this.sentAssistantItems.size + 1}`);
    if (this.sentAssistantItems.has(key)) return;
    const { text: visibleText, files } = extractTelegramSendFiles(text);
    if (!visibleText.trim() && files.length === 0) return;
    this.sentAssistantItems.add(key);
    this.closeRunDetailSegment();
    if (visibleText.trim()) this.relayToTelegram(visibleText);
    for (const filePath of files) {
      this.relayDeliveryFile(filePath);
    }
  }

  noteCodexVisibleOutput() {
    const now = iso();
    patchState(this.statePath, this.state, {
      last_output_at: now,
      last_codex_visible_output_at: now,
    });
  }

  async steer(userInput) {
    await this.ensureConnected();
    if (!this.state.thread_id || !this.state.active_turn_id) {
      throw new Error("no active turn to steer");
    }
    await this.rpc.request("thread/resume", {
      threadId: this.state.thread_id,
      cwd: WORKSPACE_ROOT,
      model: String(this.config.model || "gpt-5.5"),
      serviceTier: optionalString(this.config.service_tier),
      approvalPolicy: "never",
      sandbox: "workspace-write",
      personality: "pragmatic",
      persistExtendedHistory: true,
      includeTurns: false,
    });
    await this.rpc.request("turn/steer", {
      threadId: this.state.thread_id,
      expectedTurnId: this.state.active_turn_id,
      input: inputItems(userInput),
    });
    logSystem(`message appended to active turn: ${this.state.active_turn_id}`);
  }

  handleNotification(message) {
    if (message.method === "thread/tokenUsage/updated") {
      const snapshot = contextUsageSnapshotFromParams(message.params, iso());
      if (snapshot) {
        patchState(this.statePath, this.state, { context_usage_snapshot: snapshot });
      }
      return;
    }

    if (message.method === "account/rateLimits/updated") {
      const snapshot = rateLimitSnapshotFromParams(message.params, iso());
      if (snapshot && !isSuspiciousZeroRateLimitSnapshot(snapshot)) {
        patchState(this.statePath, this.state, { rate_limits_snapshot: snapshot });
      }
      return;
    }

    if (message.method === "item/agentMessage/delta" || message.method === "item/plan/delta") {
      beginLiveStream(t(this.config, "log.codexToUser"));
      const delta = message.params?.delta ?? message.params?.text ?? "";
      const itemId = message.params?.itemId ?? message.params?.id ?? "assistant";
      this.currentAssistantText += String(delta ?? "");
      this.currentAssistantItems.set(
        itemId,
        `${this.currentAssistantItems.get(itemId) ?? ""}${String(delta ?? "")}`,
      );
      if (String(delta ?? "").length > 0) {
        this.noteCodexVisibleOutput();
      }
      writeLiveDelta(delta);
      return;
    }

    if (message.method === "item/commandExecution/outputDelta" || message.method === "item/commandExecutionOutput/delta") {
      beginLiveStream("tool output");
      const delta = message.params?.delta ?? message.params?.text ?? "";
      writeLiveDelta(delta);
      this.appendCommandOutput(
        message.params?.itemId ?? message.params?.id ?? this.activeCommandId,
        delta,
      );
      return;
    }

    if (message.method === "item/fileChange/outputDelta") {
      beginLiveStream("file change");
      const delta = message.params?.delta ?? message.params?.text ?? "";
      writeLiveDelta(delta);
      this.appendCommandOutput(message.params?.itemId ?? message.params?.id ?? "fileChange", delta);
      return;
    }

    if (message.method === "item/started" && message.params?.item?.type === "commandExecution") {
      const item = message.params.item;
      const command = item.command ?? "(unknown command)";
      const number = this.commandNumber(item.id);
      this.activeCommandId = String(item.id || "");
      logBlock("tool", `$ ${command}`);
      this.ensureRunDetailsStarted(t(this.config, "runDetails.toolCall"));
      this.noteRunDetailToolStarted(item.id, `tool #${number} ${compactOneLine(command, 180)}`);
      this.appendRunDetail([
        `tool #${number} started`,
        `$ ${compactOneLine(command, 360)}`,
        item.cwd ? `cwd: ${item.cwd}` : null,
      ].filter(Boolean).join("\n"));
      return;
    }

    if (message.method === "item/started" && message.params?.item?.type === "imageGeneration") {
      logSystem("image generation started");
      this.ensureRunDetailsStarted(t(this.config, "runDetails.toolCall"));
      this.appendRunDetail("image generation started");
      return;
    }

    if (message.method === "item/started") {
      const item = message.params?.item ?? {};
      if (mcpToolCallUsesComputerUse(item)) {
        this.noteComputerUseActivity(message.params?.turnId ?? this.currentTurnId, item);
      }
      if (item.type === "webSearch") {
        this.appendWebSearchStart(item);
      } else if (item.type === "contextCompaction") {
        this.noteContextCompactionStarted(item);
      } else if (["fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item.type)) {
        this.appendGenericToolStart(item);
      }
      return;
    }

    if (message.method === "item/completed" && message.params?.item?.type === "commandExecution") {
      const item = message.params.item;
      logSystem(`tool completed: status=${item.status ?? "(unknown)"}, exit=${item.exitCode ?? "(unknown)"}`);
      const key = String(item.id || this.activeCommandId || "command");
      const number = this.commandNumber(key);
      if (item.aggregatedOutput && !this.commandOutputSeen.has(key)) {
        this.appendCommandOutput(key, item.aggregatedOutput);
      }
      this.ensureRunDetailsStarted(t(this.config, "runDetails.toolDone"));
      const outputStat = this.commandOutputStats.get(key);
      this.noteRunDetailToolCompleted(
        key,
        `tool #${number} status=${item.status ?? "(unknown)"} exit=${item.exitCode ?? "(unknown)"}`,
        String(item.status ?? "").toLowerCase() === "failed" || (item.exitCode !== null && item.exitCode !== undefined && Number(item.exitCode) !== 0),
      );
      this.appendRunDetail([
        `tool #${number} completed`,
        `status: ${item.status ?? "(unknown)"}`,
        `exit: ${item.exitCode ?? "(unknown)"}`,
        `durationMs: ${item.durationMs ?? "(unknown)"}`,
        outputStat ? `outputChars: ${outputStat.chars}` : null,
      ].filter(Boolean).join("\n"));
      if (this.activeCommandId === key) this.activeCommandId = null;
      return;
    }

    if (message.method === "item/completed" && message.params?.item?.type === "imageGeneration") {
      const item = message.params.item;
      logSystem(`image generation completed: savedPath=${item.savedPath ?? "(none)"}`);
      this.ensureRunDetailsStarted(t(this.config, "runDetails.toolDone"));
      this.appendRunDetail(`image generation completed: savedPath=${item.savedPath ?? "(none)"}`);
      this.relayGeneratedImage(item);
      return;
    }

    if (message.method === "item/completed") {
      const item = message.params?.item ?? {};
      if (mcpToolCallUsesComputerUse(item)) {
        this.noteComputerUseActivity(message.params?.turnId ?? this.currentTurnId, item);
      }
      if (item.type === "agentMessage" || item.type === "plan") {
        if (isCompactionBlocked(this.state)) {
          logSystem(`${item.type} relay suppressed: compaction lock active`);
          return;
        }
        const itemId = item.id ?? message.params?.itemId ?? "assistant";
        const text = item.text ?? this.currentAssistantItems.get(itemId) ?? "";
        if (text && !this.currentAssistantItems.has(itemId)) {
          this.noteCodexVisibleOutput();
        }
        if (text && !this.currentAssistantItems.has(itemId)) {
          logBlock(item.type === "plan" ? t(this.config, "log.codexPlan") : t(this.config, "log.codexToUser"), text);
        }
        this.relayAssistantItem(itemId, text);
      } else if (item.type === "webSearch") {
        this.appendWebSearchCompletion(item);
      } else if (item.type === "contextCompaction") {
        if (isFailedRuntimeItem(item)) {
          this.noteContextCompactionFailed(
            runtimeItemFailureReason(item, "contextCompaction completed failed"),
            message.params?.turnId ?? this.currentTurnId,
          );
        } else {
          this.noteContextCompactionCompleted(item);
        }
      } else if (["fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item.type)) {
        this.appendGenericToolCompletion(item);
      }
      return;
    }

    if (message.method === "item/failed") {
      const item = message.params?.item ?? {};
      if (item.type === "contextCompaction") {
        this.noteContextCompactionFailed(
          runtimeItemFailureReason(item, "contextCompaction item failed"),
          message.params?.turnId ?? this.currentTurnId,
        );
        return;
      }
    }

    if (message.method === "thread/status/changed") {
      const status = JSON.stringify(message.params?.status ?? {});
      if (status.includes("active")) logSystem(`thread active`);
      return;
    }

    if (message.method === "turn/started") {
      const turnId = message.params?.turn?.id ?? message.params?.turnId ?? null;
      if (turnId) {
        this.currentTurnId = turnId;
        patchState(this.statePath, this.state, {
          active_turn_id: turnId,
          active_turn_started_at: iso(),
        });
      }
      logSystem(`turn started: ${turnId ?? "(unknown)"}`);
      return;
    }

    if (message.method === "turn/completed") {
      const turnId = message.params?.turn?.id ?? message.params?.turnId ?? this.currentTurnId;
      const threadId = message.params?.threadId ?? message.params?.turn?.threadId ?? this.state.thread_id;
      const status = message.params?.turn?.status ?? message.params?.status ?? "(unknown)";
      const failed = String(status).toLowerCase() === "failed";
      const wasComputerUseTurn = Boolean(
        turnId && (
          this.computerUseTurnIds.delete(turnId)
          || (this.state.active_turn_computer_use && this.state.active_turn_id === turnId)
        ),
      );
      closeLiveStream();
      logSystem(`turn completed: ${turnId ?? "(unknown)"}, status=${status}`);
      this.stopTypingIndicator();
      if (wasComputerUseTurn) {
        notifyComputerUseTurnEnded({ runtimeDir: this.runtimeDir, threadId, turnId });
      }
      if (this.runDetailText.trim()) {
        this.appendRunDetail(`turn completed: ${turnId ?? "(unknown)"}, status=${status}`);
      }
      const failedDuringCompaction = failed && (
        this.state.compacting_started_at
        || this.state.compacting_until
        || isCompactionErrorText(this.state.last_error)
      );
      const serverOverloadedRecoveryTurn = Boolean(
        turnId && this.state.server_overloaded_recovery_turn_id === turnId,
      );
      const shouldContinueServerOverloaded = failed
        && !failedDuringCompaction
        && !serverOverloadedRecoveryTurn
        && this.shouldContinueAfterServerOverloaded(turnId);
      if (failedDuringCompaction) {
        this.noteContextCompactionFailed(`turn completed with status=${status}`, turnId);
      }
      const reply = this.currentAssistantText.trim();
      const patch = {
        active_turn_id: null,
        active_turn_started_at: null,
        active_turn_computer_use: false,
        last_error: failed ? this.state.last_error : null,
      };
      if (turnId && this.state.compaction_protected_turn?.turn_id === turnId) {
        patch.compaction_protected_turn = null;
      }
      if (serverOverloadedRecoveryTurn) {
        patch.server_overloaded_recovery_turn_id = null;
      }
      if (turnId && this.state.work_budget_turn_id === turnId && this.state.work_budget_steered_at) {
        const now = new Date();
        Object.assign(patch, {
          rest_started_at: iso(now),
          rest_until: addSeconds(now, restSeconds(this.config)).toISOString(),
          rest_reason: "work_budget",
          work_budget_turn_id: null,
          work_budget_steered_at: null,
        });
      } else if (turnId && this.state.work_budget_turn_id === turnId) {
        Object.assign(patch, {
          work_budget_turn_id: null,
          work_budget_steered_at: null,
        });
      }
      patchState(this.statePath, this.state, patch);
      this.currentTurnId = null;
      const done = this.currentTurnDoneResolve;
      this.currentTurnDoneResolve = null;
      if (!failedDuringCompaction && reply && this.sentAssistantItems.size === 0) {
        this.relayAssistantItem("turn-final-fallback", reply);
      }
      this.flushRunDetails(true);
      if (this.runDetailText.trim()) {
        this.pendingTelegramRelays.push(this.waitForRunDetailsIdle());
      }
      void Promise.allSettled(this.pendingTelegramRelays).then((results) => {
        done?.(results.every((result) => result.status === "fulfilled" && result.value !== false));
      });
      if (shouldContinueServerOverloaded) {
        void this.continueAfterServerOverloaded(turnId);
      }
      return;
    }

    if (message.method === "thread/context/compacted" || message.method === "context/compacted") {
      logSystem("context compacted");
      this.ensureRunDetailsStarted(t(this.config, "runDetails.systemEvent"));
      this.appendRunDetail("context compacted");
      this.noteContextCompactionCompleted({ id: message.params?.itemId ?? "deprecated-event" });
      return;
    }

    if (message.method === "error" || message.error) {
      closeLiveStream();
      const errorText = JSON.stringify(message.error ?? message.params ?? message);
      patchState(this.statePath, this.state, { last_error: errorText });
      logSystem(`rpc error: ${errorText}`);
      this.ensureRunDetailsStarted(t(this.config, "runDetails.systemError"));
      this.appendRunDetail(`rpc error: ${errorText}`);
      if (isCompactionErrorText(errorText)) {
        this.noteContextCompactionFailed(errorText, message.params?.turnId ?? this.currentTurnId);
      }
    }
  }
}

async function handleText({ session, config, state, statePath, text, startup, startupSourceLabel = null }) {
  patchState(statePath, state, { last_input_at: iso() });
  if (state.active_turn_id) {
    try {
      session.enableTypingIndicatorForCurrentTurn("user_append");
      await session.steer(text);
      return null;
    } catch (error) {
      logSystem(`active turn append failed; starting a new turn instead: ${error.message || error}`);
      patchState(statePath, state, { active_turn_id: null, active_turn_started_at: null, active_turn_computer_use: false });
      return await session.startTurn([
        withSystemPulseHeader(config, t(config, "main.activeAppendFallback")),
        "",
        text,
      ].join("\n"), { startup, startupSourceLabel, typingIndicator: true });
    }
  }
  return await session.startTurn(text, { startup, startupSourceLabel, typingIndicator: true });
}

async function handleInput({
  session,
  state,
  statePath,
  input,
  startup,
  startupSourceLabel = null,
  protectInputOnCompactionFailure = false,
  protectedInputReason = "telegram_input",
  protectedInputMetadata = null,
}) {
  patchState(statePath, state, { last_input_at: iso() });
  if (state.active_turn_id) {
    try {
      session.enableTypingIndicatorForCurrentTurn("user_append");
      await session.steer(input);
      return null;
    } catch (error) {
      logSystem(`active turn append failed; starting a new turn instead: ${error.message || error}`);
      patchState(statePath, state, { active_turn_id: null, active_turn_started_at: null, active_turn_computer_use: false });
      const fallback = textInput(withSystemPulseHeader(session.config, t(session.config, "main.activeAppendFallback")));
      return await session.startTurn([...fallback, ...inputItems(input)], {
        startup,
        startupSourceLabel,
        typingIndicator: true,
        protectInputOnCompactionFailure,
        protectedInputReason,
        protectedInputMetadata,
      });
    }
  }
  return await session.startTurn(input, {
    startup,
    startupSourceLabel,
    typingIndicator: true,
    protectInputOnCompactionFailure,
    protectedInputReason,
    protectedInputMetadata,
  });
}

async function buildAndLogTelegramMessagesInput({
  token,
  runtimeDir,
  messages,
  config,
  direction = null,
}) {
  const built = await buildTelegramInputFromMessages({ token, messages, runtimeDir, config });
  if (!built.handled) return { handled: false, built: null, primaryMessage: null };

  const primaryMessage = built.primaryMessage ?? {};
  logBlock(t(config, "log.userToCodex"), built.logText);
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: direction || (built.mediaGroupId ? "recv_media_group" : "recv"),
    message_id: primaryMessage.message_id ?? null,
    message_ids: built.messageIds,
    media_group_id: built.mediaGroupId || null,
    chars: built.incomingText.length,
    images: built.imagePaths.length,
    files: built.fileItems.length,
    has_reply: Boolean(built.replyMessage),
    reply_message_id: built.replyMessage?.message_id ?? null,
    reply_kind: built.replyMessage ? telegramMessageKind(built.replyMessage) : null,
    reply_chars: telegramMessageText(built.replyMessage).length,
    reply_images: built.replyImagePaths.length,
  });
  return { handled: true, built, primaryMessage };
}

async function handleTelegramMessagesInput({ session, statePath, token, runtimeDir, messages, config }) {
  const prepared = await buildAndLogTelegramMessagesInput({
    token,
    runtimeDir,
    messages,
    config,
  });
  if (!prepared.handled) return { handled: false, turn: null };

  const { built, primaryMessage } = prepared;

  const state = loadState(statePath);
  session.state = state;
  if (isResting(state)) {
    clearRest(statePath, state, "User message");
  }
  const startup = !state.thread_id;
  const turn = await handleInput({
    session,
    state,
    statePath,
    input: built.input,
    startup,
    protectInputOnCompactionFailure: true,
    protectedInputReason: "telegram_input",
    protectedInputMetadata: {
      message_id: primaryMessage.message_id ?? null,
      message_ids: built.messageIds,
      media_group_id: built.mediaGroupId || null,
      has_reply: Boolean(built.replyMessage),
      images: built.imagePaths.length,
      files: built.fileItems.length,
      reply_images: built.replyImagePaths.length,
    },
  });
  return { handled: true, turn };
}

function queueMediaGroupMessage({ pendingMediaGroups, message, config, runtimeDir }) {
  const key = mediaGroupBufferKey(message);
  if (!key) return null;
  const now = Date.now();
  const existing = pendingMediaGroups.get(key) ?? {
    key,
    mediaGroupId: telegramMediaGroupId(message),
    messages: new Map(),
    firstSeenAt: now,
    flushAt: now,
  };
  existing.messages.set(String(message.message_id ?? `${now}:${existing.messages.size}`), message);
  existing.flushAt = now + mediaGroupCollectSeconds(config) * 1000;
  existing.updatedAt = now;
  pendingMediaGroups.set(key, existing);
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "recv_media_group_part",
    message_id: message.message_id ?? null,
    media_group_id: existing.mediaGroupId,
    buffered_messages: existing.messages.size,
    flush_after_ms: Math.max(0, existing.flushAt - now),
  });
  logSystem(`TG media group part buffered: group=${existing.mediaGroupId}, count=${existing.messages.size}`);
  return existing;
}

function queueLooseInputMessage({ pendingLooseInputs, message, config, runtimeDir }) {
  const key = looseInputBufferKey(message);
  const now = Date.now();
  const existing = pendingLooseInputs.get(key) ?? {
    key,
    messages: new Map(),
    firstSeenAt: now,
    flushAt: now,
    imageMessageCount: 0,
  };
  const messageKey = String(message.message_id ?? `${now}:${existing.messages.size}`);
  if (!existing.messages.has(messageKey) && telegramMessageHasImage(message)) {
    existing.imageMessageCount += 1;
  }
  existing.messages.set(messageKey, message);
  existing.flushAt = now + looseMediaCollectSeconds(config) * 1000;
  existing.updatedAt = now;
  pendingLooseInputs.set(key, existing);
  appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
    direction: "recv_loose_media_part",
    message_id: message.message_id ?? null,
    buffered_messages: existing.messages.size,
    image_messages: existing.imageMessageCount,
    flush_after_ms: Math.max(0, existing.flushAt - now),
  });
  logSystem(`TG loose media part buffered: count=${existing.messages.size}, image_messages=${existing.imageMessageCount}`);
  return existing;
}

function nextBufferedInputFlushDelayMs(...pendingGroupsList) {
  let next = null;
  for (const pendingGroups of pendingGroupsList) {
    for (const group of pendingGroups.values()) {
      if (next === null || group.flushAt < next) next = group.flushAt;
    }
  }
  if (next === null) return null;
  return Math.max(0, next - Date.now());
}

async function flushDueMediaGroups({ pendingMediaGroups, session, statePath, token, runtimeDir, force = false }) {
  const now = Date.now();
  const due = [...pendingMediaGroups.values()]
    .filter((group) => force || group.flushAt <= now)
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  let lastTurn = null;
  for (const group of due) {
    pendingMediaGroups.delete(group.key);
    const messages = normalizeTelegramMessages([...group.messages.values()]);
    logSystem(`TG media group flushed: group=${group.mediaGroupId}, count=${messages.length}`);
    const state = loadState(statePath);
    session.state = state;
    if (isCompactionBlocked(state) || state.compacting_until || shouldStoreInputForCompactionResume(state)) {
      requeueCompactionInputs({
        config: session.config,
        runtimeDir,
        messages,
        reason: shouldStoreInputForCompactionResume(state)
          ? `${compactionResumeReason(state) || "compaction"}_resume_pending_media_group`
          : "compaction_locked_media_group",
      });
      continue;
    }
    const result = await handleTelegramMessagesInput({
      session,
      statePath,
      token,
      runtimeDir,
      config: session.config,
      messages,
    });
    if (result.handled) lastTurn = result.turn;
  }
  return lastTurn;
}

async function flushDueLooseInputs({ pendingLooseInputs, session, statePath, token, runtimeDir, force = false }) {
  const now = Date.now();
  const due = [...pendingLooseInputs.values()]
    .filter((group) => force || group.flushAt <= now)
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  let lastTurn = null;
  for (const group of due) {
    pendingLooseInputs.delete(group.key);
    const messages = normalizeTelegramMessages([...group.messages.values()]);
    logSystem(`TG loose media group flushed: count=${messages.length}, image_messages=${group.imageMessageCount}`);
    const state = loadState(statePath);
    session.state = state;
    if (isCompactionBlocked(state) || state.compacting_until || shouldStoreInputForCompactionResume(state)) {
      requeueCompactionInputs({
        config: session.config,
        runtimeDir,
        messages,
        reason: shouldStoreInputForCompactionResume(state)
          ? `${compactionResumeReason(state) || "compaction"}_resume_pending_loose_media`
          : "compaction_locked_loose_media",
      });
      continue;
    }
    const result = await handleTelegramMessagesInput({
      session,
      statePath,
      token,
      runtimeDir,
      config: session.config,
      messages,
    });
    if (result.handled) lastTurn = result.turn;
  }
  return lastTurn;
}

async function maybeRunWorkBudget({ session, config, state, statePath }) {
  if (!state.active_turn_id) return false;
  if (state.work_budget_turn_id === state.active_turn_id && state.work_budget_steered_at) return false;
  const startedAt = parseIsoTime(state.active_turn_started_at);
  if (startedAt === null) return false;
  const budgetMs = workBudgetSeconds(config) * 1000;
  if (Date.now() - startedAt < budgetMs) return false;

  const prompt = withSystemPulseHeader(config, workBudgetPrompt(config));
  try {
    await session.steer(prompt);
  } catch (error) {
    logSystem(`work budget steer failed; clearing stale active turn: ${error.message || error}`);
    patchState(statePath, state, {
      active_turn_id: null,
      active_turn_started_at: null,
      active_turn_computer_use: false,
      work_budget_turn_id: null,
      work_budget_steered_at: null,
      last_error: error.stack || String(error),
    });
    Object.assign(session.state, state);
    return false;
  }
  patchState(statePath, state, {
    work_budget_turn_id: state.active_turn_id,
    work_budget_steered_at: iso(),
    last_error: null,
  });
  Object.assign(session.state, state);
  logSystem(`work budget steer sent: ${state.active_turn_id}`);
  return true;
}

async function maybeRestoreDefaultModelAfterCompaction({ session, state, statePath }) {
  if (!state.compaction_recovery_model_active) return false;
  if (state.compaction_recovery_restore_in_progress) return false;
  if (state.compaction_recovery_pending || state.active_turn_id || isCompacting(state) || state.compacting_until) return false;
  patchState(statePath, state, { compaction_recovery_restore_in_progress: true });
  try {
    const restored = await session.restoreDefaultModelForThread();
    if (!restored) logSystem("default model restore skipped: no thread bound");
    patchState(statePath, state, {
      compaction_recovery_model_active: false,
      compaction_recovery_restore_model: null,
      compaction_recovery_restore_effort: null,
      compaction_recovery_restore_in_progress: false,
      last_error: null,
    });
    session.relayToTelegram(compactingCompletedNotice(session.config));
    return true;
  } catch (error) {
    const message = error?.stack || String(error);
    patchState(statePath, state, {
      compaction_recovery_restore_in_progress: false,
      last_error: message,
    });
    appendJsonl(path.join(session.runtimeDir, "errors.jsonl"), { error: message });
    logSystem(`default model restore retry failed: ${error.message || error}`);
    return false;
  }
}

async function maybeRunCompactionRecovery({ session, config, state, statePath }) {
  if (!state.compaction_recovery_pending) return null;
  if (state.active_turn_id) return null;
  if (isCompacting(state)) return null;

  const currentAttempt = Math.max(0, Math.trunc(Number(state.compaction_recovery_pause_attempt || 0)));
  const nextAttempt = currentAttempt + 1;
  const maxAttempts = compactionRecoveryMaxAttempts(config);
  if (nextAttempt > maxAttempts) {
    const reason = `context compaction recovery exhausted after ${currentAttempt} attempts`;
    logSystem(reason);
    const restoreStep = compactionDefaultStep(config);
    patchState(statePath, state, {
      compaction_recovery_pending: false,
      compaction_recovery_model_active: true,
      compaction_recovery_restore_model: restoreStep.model,
      compaction_recovery_restore_effort: restoreStep.effort,
      compaction_recovery_restore_in_progress: false,
      compaction_recovery_resume_pending: false,
      compaction_recovery_resume_reason: null,
      compaction_recovery_resume_last_sent_at: null,
      compaction_circuit_opened_at: iso(),
      compaction_circuit_reason: reason,
      last_error: reason,
    });
    session.relayToTelegram(compactionRecoveryExhaustedNotice(config, maxAttempts));
    return null;
  }
  const step = compactionRecoveryStep(nextAttempt);
  const restoreStep = compactionDefaultStep(config);
  const promptBody = compactionRecoveryPausePrompt(config);
  const prompt = withSystemPulseHeader(config, promptBody);
  logSystem(`context compaction recovery pause turn: attempt=${nextAttempt}, model=${step.model}, effort=${step.effort}`);
  logBlock(t(config, "log.mainlineToCodex"), prompt);
  appendJsonl(path.join(session.runtimeDir, "telegram.jsonl"), {
    direction: "compaction_recovery_pause",
    attempt: nextAttempt,
    model: step.model,
    effort: step.effort,
    chars: prompt.length,
  });
  patchState(statePath, state, {
    compaction_recovery_pending: false,
    compaction_recovery_attempt: nextAttempt,
    compaction_recovery_pause_attempt: nextAttempt,
    compaction_recovery_model_active: true,
    compaction_recovery_restore_model: restoreStep.model,
    compaction_recovery_restore_effort: restoreStep.effort,
    compaction_recovery_restore_in_progress: false,
    compaction_recovery_resume_pending: true,
    compaction_recovery_resume_reason: "recovery",
    compaction_recovery_resume_last_sent_at: null,
    last_error: null,
  });
  try {
    return await session.startTurn(prompt, {
      model: step.model,
      effort: step.effort,
      startup: !state.thread_id,
      startupSourceLabel: t(config, "compaction.pauseSourceLabel"),
      typingIndicator: false,
    });
  } catch (error) {
    const message = error?.stack || String(error);
    const reason = `recovery pause turn failed: ${error?.message || error}`;
    patchState(statePath, state, {
      compaction_recovery_pending: false,
      compaction_recovery_resume_pending: false,
      compaction_recovery_resume_reason: null,
      compaction_recovery_resume_last_sent_at: null,
      compaction_circuit_opened_at: iso(),
      compaction_circuit_reason: reason,
      last_error: message,
    });
    appendJsonl(path.join(session.runtimeDir, "errors.jsonl"), { error: message });
    logSystem(reason);
    session.relayToTelegram(compactionRecoveryExhaustedNotice(config, nextAttempt));
    return null;
  }
}

async function maybeRunCompactionRecoveryResume({ session, config, state, statePath }) {
  if (!state.compaction_recovery_resume_pending) return null;
  if (state.active_turn_id) return null;
  if (state.compaction_recovery_pending) return null;
  if (state.compaction_recovery_model_active || state.compaction_recovery_restore_in_progress) return null;
  if (isCompacting(state) || state.compacting_until) return null;

  const reason = String(state.compaction_recovery_resume_reason || "recovery");
  if (countNonBlankLines(compactionReplayQueuePath(config, session.runtimeDir)) > 0) {
    logSystem("compaction recovery resume skipped: protected replay input will continue");
    patchState(statePath, state, {
      compaction_recovery_resume_pending: false,
      compaction_recovery_resume_reason: null,
      compaction_recovery_resume_last_sent_at: null,
      last_error: null,
    });
    return null;
  }
  const promptBody = compactionResumePrompt(config, reason).trim();
  if (!promptBody) {
    patchState(statePath, state, {
      compaction_recovery_resume_pending: false,
      compaction_recovery_resume_reason: null,
      compaction_recovery_resume_last_sent_at: null,
    });
    return null;
  }
  const prompt = withSystemPulseHeader(config, promptBody);
  let queuedMessages = [];
  let queuedBuilt = null;

  if ((reason === "proactive" || reason === "recovery") && countNonBlankLines(compactionInputQueuePath(config, session.runtimeDir)) > 0) {
    queuedMessages = drainCompactionInputQueue(config, session.runtimeDir);
    const prepared = await buildAndLogTelegramMessagesInput({
      token: session.token,
      runtimeDir: session.runtimeDir,
      messages: queuedMessages,
      config,
      direction: `recv_compaction_${reason}_resume_guidance`,
    });
    if (prepared.handled) {
      queuedBuilt = prepared.built;
    } else {
      requeueCompactionInputs({
        config,
        runtimeDir: session.runtimeDir,
        messages: queuedMessages,
        reason: `${reason}_resume_input_unhandled`,
      });
      queuedMessages = [];
    }
  }

  logBlock(t(config, "log.mainlineToCodex"), prompt);
  appendJsonl(path.join(session.runtimeDir, "telegram.jsonl"), {
    direction: reason === "proactive" ? "compaction_proactive_resume" : "compaction_recovery_resume",
    reason,
    chars: prompt.length,
    queued_message_ids: queuedBuilt?.messageIds ?? [],
    queued_messages: queuedMessages.length,
  });
  patchState(statePath, state, {
    compaction_recovery_resume_pending: false,
    compaction_recovery_resume_reason: null,
    compaction_recovery_resume_last_sent_at: iso(),
    last_error: null,
  });

  try {
    const turn = await session.startTurn(prompt, {
      startup: !state.thread_id,
      startupSourceLabel: reason === "proactive"
        ? t(config, "compaction.proactiveResumeSourceLabel")
        : t(config, "compaction.resumeSourceLabel"),
      typingIndicator: false,
    });
    if (queuedBuilt && queuedMessages.length > 0) {
      try {
        session.enableTypingIndicatorForCurrentTurn(`${reason}_compaction_resume_guidance`);
        await session.steer(queuedBuilt.input);
        appendJsonl(path.join(session.runtimeDir, "telegram.jsonl"), {
          direction: reason === "proactive"
            ? "compaction_proactive_resume_guidance_steered"
            : "compaction_recovery_resume_guidance_steered",
          active_turn_id: session.state.active_turn_id ?? turn.turnId ?? null,
          message_ids: queuedBuilt.messageIds,
          count: queuedMessages.length,
          files: queuedBuilt.fileItems.length,
        });
      } catch (steerError) {
        requeueCompactionInputs({
          config,
          runtimeDir: session.runtimeDir,
          messages: queuedMessages,
          reason: `${reason}_resume_steer_failed`,
        });
        const steerMessage = steerError?.stack || String(steerError);
        patchState(statePath, state, { last_error: steerMessage });
        appendJsonl(path.join(session.runtimeDir, "errors.jsonl"), { error: steerMessage });
        logSystem(`compaction ${reason} resume guidance steer failed; messages requeued: ${steerError.message || steerError}`);
      }
    }
    return turn;
  } catch (error) {
    if (queuedMessages.length > 0) {
      requeueCompactionInputs({
        config,
        runtimeDir: session.runtimeDir,
        messages: queuedMessages,
        reason: `${reason}_resume_start_failed`,
      });
    }
    const message = error?.stack || String(error);
    patchState(statePath, state, {
      compaction_recovery_resume_pending: true,
      compaction_recovery_resume_reason: reason,
      last_error: message,
    });
    appendJsonl(path.join(session.runtimeDir, "errors.jsonl"), { error: message });
    logSystem(`compaction recovery resume turn failed: ${error.message || error}`);
    return null;
  }
}

async function maybeSteerCompactionQueuedInputs({ session, config, state, statePath, token, runtimeDir }) {
  if (!state.active_turn_id) return false;
  if (isCompactionBlocked(state) || state.compacting_until) return false;
  const resumeReason = state.compaction_recovery_resume_pending
    ? String(state.compaction_recovery_resume_reason || "")
    : null;
  if (resumeReason && resumeReason !== "proactive" && resumeReason !== "recovery") return false;
  if (resumeReason === "recovery" && !isCompactionRecoveryResumeReady(state)) return false;
  if (state.compaction_recovery_model_active || state.compaction_recovery_restore_in_progress) return false;
  if (countNonBlankLines(compactionReplayQueuePath(config, runtimeDir)) > 0) return false;

  const messages = drainCompactionInputQueue(config, runtimeDir);
  if (messages.length === 0) return false;

  try {
    logSystem(`steering queued TG inputs after compaction: count=${messages.length}, active_turn=${state.active_turn_id}`);
    const prepared = await buildAndLogTelegramMessagesInput({
      token,
      runtimeDir,
      messages,
      config,
      direction: "recv_compaction_guidance",
    });
    if (!prepared.handled) {
      appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
        direction: "recv_compaction_guidance_unhandled",
        message_ids: messages.map((message) => message.message_id).filter((id) => id !== null && id !== undefined),
        count: messages.length,
      });
      return false;
    }

    let input = prepared.built.input;
    if (resumeReason === "proactive" || resumeReason === "recovery") {
      const promptBody = compactionResumePrompt(config, resumeReason).trim();
      if (promptBody) {
        input = prependTextToInput(withSystemPulseHeader(config, promptBody), input);
      }
    }

    if (isResting(state)) {
      clearRest(statePath, state, "compaction guidance");
    }
    patchState(statePath, state, { last_input_at: iso() });
    session.state = loadState(statePath);
    session.enableTypingIndicatorForCurrentTurn("compaction_guidance");
    await session.steer(input);
    if (resumeReason === "proactive" || resumeReason === "recovery") {
      patchState(statePath, state, {
        compaction_recovery_resume_pending: false,
        compaction_recovery_resume_reason: null,
        compaction_recovery_resume_last_sent_at: iso(),
        last_error: null,
      });
    }
    appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
      direction: resumeReason === "proactive"
        ? "compaction_proactive_resume_guidance_steered"
        : resumeReason === "recovery"
          ? "compaction_recovery_resume_guidance_steered"
          : "compaction_guidance_steered",
      active_turn_id: state.active_turn_id,
      message_ids: prepared.built.messageIds,
      count: messages.length,
    });
    return true;
  } catch (error) {
    requeueCompactionInputs({
      config,
      runtimeDir,
      messages,
      reason: "compaction_guidance_steer_failed",
    });
    const message = error?.stack || String(error);
    patchState(statePath, state, { last_error: message });
    appendJsonl(path.join(runtimeDir, "errors.jsonl"), { error: message });
    logSystem(`compaction guidance steer failed; messages requeued: ${error.message || error}`);
    return false;
  }
}

async function maybeRunProactiveContextCompaction({ session, config, state }) {
  if (countNonBlankLines(compactionReplayQueuePath(config, session.runtimeDir)) > 0) {
    logSystem("proactive context compaction skipped: protected replay input pending");
    return false;
  }
  if (!shouldStartProactiveCompaction(state, config)) return false;
  const usedPercent = Math.round(contextUsageUsedPercent(state.context_usage_snapshot) ?? 0);
  const threshold = contextCompactionTriggerUsedPercent(config);
  const step = compactionTurnOverride(state) ?? compactionDefaultStep(config);
  logSystem(`proactive context compaction triggered: used=${usedPercent}%, threshold=${threshold}%`);
  try {
    await session.startContextCompaction({
      model: step.model,
      effort: step.effort,
      resumeReason: "proactive",
    });
    return true;
  } catch (error) {
    session.noteContextCompactionFailed(`proactive compact start failed: ${error?.message || error}`);
    return false;
  }
}

async function maybePreemptInputWithProactiveCompaction({
  session,
  config,
  state,
  runtimeDir,
  message,
  token,
  chatId,
  maxChars,
}) {
  if (!shouldStartProactiveCompaction(state, config)) return false;
  const queuePath = enqueueCompactionInput({
    config,
    runtimeDir,
    message,
    reason: "proactive_before_input",
  });
  logSystem(`message queued before proactive compaction: queue=${queuePath}`);
  await maybeRunProactiveContextCompaction({ session, config, state });
  await sendText({
    token,
    chatId,
    text: compactingQueuedNotice(config),
    maxChars,
    runtimeDir,
    echo: true,
  });
  return true;
}

async function maybeRunCompactionQueuedInputs({ session, config, state, statePath, token, runtimeDir }) {
  if (isCompactionBlocked(state) || state.compacting_until || state.active_turn_id || shouldStoreInputForCompactionResume(state)) return null;
  const replayInputs = drainCompactionReplayQueue(config, runtimeDir);
  if (replayInputs.length > 0) {
    const [replay, ...remaining] = replayInputs;
    if (remaining.length > 0) {
      requeueCompactionReplayInputs({
        config,
        runtimeDir,
        inputs: remaining,
        reason: "replay_queue_remaining",
      });
    }
    logSystem(`replaying protected input after compaction recovery: turn=${replay.turn_id ?? "(unknown)"}, remaining=${remaining.length}`);
    appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
      direction: "compaction_replay_started",
      turn_id: replay.turn_id ?? null,
      reason: replay.reason ?? null,
      remaining: remaining.length,
      metadata: replay.metadata ?? null,
    });
    try {
      const replayReason = String(replay.reason || "");
      if (replayReason === "telegram_plan_command") {
        return await session.startPlanTurn(replay.input, {
          startup: false,
          typingIndicator: true,
          protectInputOnCompactionFailure: true,
          protectedInputReason: replayReason,
          protectedInputMetadata: replay.metadata ?? null,
        });
      }
      return await session.startTurn(replay.input, {
        startup: false,
        startupSourceLabel: t(config, "compaction.replaySourceLabel"),
        computerUse: replayReason === "telegram_computer_command",
        typingIndicator: true,
        protectInputOnCompactionFailure: true,
        protectedInputReason: replayReason || "compaction_replay",
        protectedInputMetadata: replay.metadata ?? null,
      });
    } catch (error) {
      enqueueCompactionReplayInput({
        config,
        runtimeDir,
        replay,
        reason: "replay_start_failed",
      });
      const message = error?.stack || String(error);
      patchState(statePath, state, { last_error: message });
      appendJsonl(path.join(runtimeDir, "errors.jsonl"), { error: message });
      logSystem(`protected input replay failed to start; requeued: ${error.message || error}`);
      return null;
    }
  }

  const messages = drainCompactionInputQueue(config, runtimeDir);
  if (messages.length === 0) return null;

  logSystem(`draining queued TG inputs after compaction: count=${messages.length}`);
  const result = await handleTelegramMessagesInput({
    session,
    statePath,
    token,
    runtimeDir,
    config,
    messages,
  });
  if (!result.handled) {
    appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
      direction: "recv_compaction_queue_unhandled",
      message_ids: messages.map((message) => message.message_id).filter((id) => id !== null && id !== undefined),
      count: messages.length,
    });
  }
  return result.turn;
}

async function maybeRunRhythm({ session, config, state, statePath, token, chatId, maxChars, runtimeDir }) {
  if (!rhythmEnabled(config)) return null;
  ensureNextWake(config, statePath, state);
  const dueAt = Date.parse(state.next_wake_at || "");
  if (!Number.isFinite(dueAt) || Date.now() < dueAt) return null;

  if (isResting(state)) {
    patchState(statePath, state, {
      next_wake_at: state.rest_until,
      last_wake_skip_at: iso(),
      last_wake_skip_reason: "resting",
    });
    logSystem(`rhythm skipped: resting until ${state.rest_until}`);
    return null;
  }
  if (state.rest_until) {
    clearRest(statePath, state, "rest timer elapsed");
  }

  if (isCompactionBlocked(state)) {
    scheduleNextWake(config, statePath, state, {
      last_wake_skip_at: iso(),
      last_wake_skip_reason: "compacting",
    });
    logSystem(`rhythm skipped: context compacting until ${state.compacting_until}`);
    return null;
  }
  if (state.compacting_until) {
    session.noteContextCompactionTimedOut();
    return null;
  }

  if (state.active_turn_id) {
    const recheckAt = addSeconds(new Date(), Math.max(1, rhythmIdleRequiredSeconds(config))).toISOString();
    patchState(statePath, state, {
      next_wake_at: recheckAt,
      last_wake_skip_at: iso(),
      last_wake_skip_reason: "active_turn",
    });
    logSystem(`rhythm skipped: active turn is running (${state.active_turn_id}); recheck at ${recheckAt}`);
    return null;
  }

  const idleRequiredMs = rhythmIdleRequiredSeconds(config) * 1000;
  const lastVisibleOutputAt = parseIsoTime(state.last_codex_visible_output_at || state.last_output_at);
  if (idleRequiredMs > 0 && lastVisibleOutputAt !== null) {
    const idleUntil = lastVisibleOutputAt + idleRequiredMs;
    if (Date.now() < idleUntil) {
      const next = new Date(idleUntil).toISOString();
      patchState(statePath, state, {
        next_wake_at: next,
        last_wake_skip_at: iso(),
        last_wake_skip_reason: "recent_codex_visible_output",
      });
      logSystem(`rhythm skipped: codex visible output was recent; recheck at ${next}`);
      return null;
    }
  }

  const message = withSystemPulseHeader(config, rhythmMessage(config));
  const notice = rhythmTelegramNotice(config);
  if (notice) {
    await sendText({
      token,
      chatId,
      text: notice,
      maxChars,
      runtimeDir,
      echo: true,
    });
  }
  logBlock(t(config, "log.rhythmToCodex"), message);
  scheduleNextWake(config, statePath, state, {
    last_wake_at: iso(),
    wake_count: Number(state.wake_count || 0) + 1,
    last_wake_skip_at: null,
    last_wake_skip_reason: null,
  });
  return await handleInput({
    session,
    state,
    statePath,
    input: message,
    startup: !state.thread_id,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  DEBUG_RAW = options.debugRaw;
  const configPath = resolveWorkspacePath(options.configPath);
  const config = prepareI18n(readJson(configPath));
  const runtimeDir = resolveWorkspacePath(String(config.runtime_dir));
  const statePath = resolveWorkspacePath(String(config.state_path));
  MAIN_RUNTIME_DIR = runtimeDir;
  mkdirSync(runtimeDir, { recursive: true });
  appendLifecycle(runtimeDir, "process_started", {
    config_path: path.relative(WORKSPACE_ROOT, configPath),
    once: options.once,
    wake: options.wake,
    startup_message_present: Boolean(options.startupMessage),
    dry_run: options.dryRun,
  });
  let state = loadState(statePath);
  writeJson(statePath, state);

  const maxChars = Math.trunc(numberFromConfig(config, "max_message_chars", 3500));
  const pollTimeout = Math.trunc(numberFromConfig(config, "poll_timeout_seconds", 25));
  const idleSleep = numberFromConfig(config, "idle_sleep_seconds", 2);

  if (options.dryRun) {
    const peek = peekSecrets(config);
    const dryRunRhythm = rhythmEnabled(config)
      ? `${rhythmIntervalSeconds(config)}s, message=${JSON.stringify(rhythmMessage(config))}`
      : t(config, "common.disabled");
    const dryRunParams = {
      locale: localeOf(config),
      hasBotToken: peek.hasToken ? t(config, "common.yes") : t(config, "common.no"),
      allowedChatId: peek.allowedChatId ?? t(config, "common.unset"),
      telegramProxyUrl: peek.proxyUrl ?? t(config, "common.none"),
      appServerEndpoint: config.app_server_endpoint,
      model: config.model ?? "gpt-5.5",
      serviceTier: optionalString(config.service_tier) ?? "standard",
      effort: config.effort ?? "high",
      botCommands: config.bot_commands_enabled === false
        ? t(config, "common.disabled")
        : configuredBotCommands(config).map((item) => `/${item.command}`).join(", ") || t(config, "common.none"),
      rhythm: dryRunRhythm,
      workBudget: `${workBudgetSeconds(config)}s`,
      rest: `${restSeconds(config)}s`,
      statePath,
      threadId: state.thread_id ?? t(config, "main.newThreadFirstTurn"),
      nextWakeAt: state.next_wake_at ?? (rhythmEnabled(config) ? t(config, "main.willArmOnStart") : t(config, "common.disabled")),
    };
    printHeader(t(config, "main.dryRunTitle"));
    for (const line of tLines(config, "main.dryRunLines", dryRunParams)) {
      console.log(line);
    }
    return;
  }

  const secrets = loadSecrets(config);
  TELEGRAM_PROXY_URL = secrets.proxyUrl;
  const readyPath = path.join(runtimeDir, "mainline.ready.json");
  try {
    unlinkSync(readyPath);
  } catch {
    // Best effort.
  }
  const releaseLock = acquireRuntimeLock(path.join(runtimeDir, "mainline.lock.json"));
  appendLifecycle(runtimeDir, "runtime_lock_acquired", {
    lock_path: path.relative(WORKSPACE_ROOT, path.join(runtimeDir, "mainline.lock.json")),
  });
  const releaseReady = () => {
    try {
      const current = existsSync(readyPath) ? readJson(readyPath) : null;
      if (current?.pid === process.pid) unlinkSync(readyPath);
    } catch {
      // Best effort.
    }
  };
  const releaseRuntime = () => {
    releaseReady();
    releaseLock();
  };
  process.once("exit", (code) => {
    appendLifecycle(runtimeDir, "process_exit", { code });
    releaseRuntime();
  });
  process.once("SIGINT", () => {
    appendLifecycle(runtimeDir, "signal_received", { signal: "SIGINT" });
    releaseRuntime();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    appendLifecycle(runtimeDir, "signal_received", { signal: "SIGTERM" });
    releaseRuntime();
    process.exit(143);
  });

  printHeader(t(config, "main.startTitle"));
  try {
    await ensureBotCommands({
      token: secrets.token,
      chatId: secrets.allowedChatId,
      config,
      runtimeDir,
    });
    appendLifecycle(runtimeDir, "bot_commands_ready");
  } catch (error) {
    appendLifecycle(runtimeDir, "bot_commands_failed", {
      error: String(error?.message || error).slice(0, 500),
    });
    logSystem(`bot command menu registration failed: ${error.message || error}`);
  }
  logSystem([
    "started",
    `thread: ${state.thread_id ?? "(new on first turn)"}`,
    `endpoint: ${config.app_server_endpoint}`,
    `model: ${config.model ?? "gpt-5.5"}`,
    `effort: ${config.effort ?? "high"}`,
    rhythmEnabled(config)
      ? `rhythm: ${rhythmIntervalSeconds(config)}s, message="${rhythmMessage(config)}"`
      : "rhythm: disabled",
    `work budget: ${workBudgetSeconds(config)}s`,
    `rest: ${restSeconds(config)}s`,
    "semantic state machine: none",
  ].join("\n"));
  if (!options.wake) {
    state = armNextWakeFromStartup(config, statePath, state);
  } else {
    ensureNextWake(config, statePath, state);
  }

  const session = new MainlineSession({
    config,
    state,
    statePath,
    runtimeDir,
    token: secrets.token,
    chatId: secrets.allowedChatId,
    maxChars,
  });
  const reloadState = () => {
    state = loadState(statePath);
    session.state = state;
    return state;
  };

  appendLifecycle(runtimeDir, "app_server_connect_begin", {
    endpoint: config.app_server_endpoint,
  });
  await session.ensureConnected();
  appendLifecycle(runtimeDir, "app_server_connected", {
    endpoint: config.app_server_endpoint,
  });
  state = reloadState();
  const pendingMediaGroups = new Map();
  const pendingLooseInputs = new Map();
  writeJson(readyPath, {
    pid: process.pid,
    endpoint: config.app_server_endpoint,
    ready_at: iso(),
  });
  appendLifecycle(runtimeDir, "ready_written", {
    ready_path: path.relative(WORKSPACE_ROOT, readyPath),
    endpoint: config.app_server_endpoint,
  });
  const compactionLocked = Boolean(isCompactionBlocked(state) || state.compacting_until);
  if (!compactionLocked) {
    appendLifecycle(runtimeDir, "startup_notice_begin");
    try {
      await sendText({
        token: secrets.token,
        chatId: secrets.allowedChatId,
        text: t(config, "main.started"),
        maxChars,
        runtimeDir,
        echo: true,
      });
      appendLifecycle(runtimeDir, "startup_notice_sent");
    } catch (error) {
      appendLifecycle(runtimeDir, "startup_notice_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      logSystem(`startup TG notice failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    appendLifecycle(runtimeDir, "startup_notice_suppressed", {
      reason: "compaction_locked",
    });
    logSystem("startup TG notice suppressed: compaction recovery/lock active");
  }

  if (options.startupMessage && !compactionLocked) {
    appendLifecycle(runtimeDir, "startup_message_begin");
    logSystem("startup message requested by launcher");
    const startupMessage = withSystemPulseHeader(config, options.startupMessage);
    logBlock(t(config, "main.watchdogLog"), startupMessage);
    const turn = await handleText({
      session,
      config,
      state,
      statePath,
      text: startupMessage,
      startup: !state.thread_id,
      startupSourceLabel: t(config, "main.watchdogLabel"),
    });
    appendLifecycle(runtimeDir, "startup_message_started", {
      turn_id: turn?.turnId ?? null,
    });
    if (options.once && turn?.done) {
      await turn.done;
      return;
    }
  } else if (options.startupMessage && compactionLocked) {
    appendLifecycle(runtimeDir, "startup_message_suppressed", {
      reason: "compaction_locked",
    });
    logSystem("startup message suppressed: compaction recovery/lock active");
  } else if (options.wake && !state.active_turn_id && !compactionLocked) {
    logSystem("wake requested");
    const turn = await session.wake();
    if (options.once) {
      await turn?.done;
      return;
    }
  } else if (options.wake && compactionLocked) {
    appendLifecycle(runtimeDir, "wake_suppressed", {
      reason: "compaction_locked",
    });
    logSystem("wake suppressed: compaction recovery/lock active");
  }

  appendLifecycle(runtimeDir, "poll_loop_entered");
  while (true) {
    try {
      state = reloadState();
      if (hasCompactingTimedOut(state)) {
        session.noteContextCompactionTimedOut();
      }
      state = reloadState();
      await maybeRestoreDefaultModelAfterCompaction({ session, state, statePath });
      state = reloadState();
      const recoveryTurn = await maybeRunCompactionRecovery({ session, config, state, statePath });
      if (options.once && recoveryTurn?.done) {
        await recoveryTurn.done;
        return;
      }

      state = reloadState();
      const recoveryResumeTurn = await maybeRunCompactionRecoveryResume({ session, config, state, statePath });
      if (options.once && recoveryResumeTurn?.done) {
        await recoveryResumeTurn.done;
        return;
      }
      if (recoveryResumeTurn) {
        continue;
      }

      state = reloadState();
      const compactionGuidanceSteered = await maybeSteerCompactionQueuedInputs({
        session,
        config,
        state,
        statePath,
        token: secrets.token,
        runtimeDir,
      });
      if (compactionGuidanceSteered) {
        continue;
      }

      state = reloadState();
      await maybeRunProactiveContextCompaction({ session, config, state });

      state = reloadState();
      const flushedMediaGroupTurn = await flushDueMediaGroups({
        pendingMediaGroups,
        session,
        statePath,
        token: secrets.token,
        runtimeDir,
      });
      const flushedLooseInputTurn = await flushDueLooseInputs({
        pendingLooseInputs,
        session,
        statePath,
        token: secrets.token,
        runtimeDir,
      });
      if (options.once && flushedMediaGroupTurn?.done) {
        await flushedMediaGroupTurn.done;
        return;
      }
      if (options.once && flushedLooseInputTurn?.done) {
        await flushedLooseInputTurn.done;
        return;
      }

      state = reloadState();
      if (pendingMediaGroups.size === 0 && pendingLooseInputs.size === 0) {
        await maybeRunWorkBudget({ session, config, state, statePath });
      }

      state = reloadState();
      const queuedInputTurn = await maybeRunCompactionQueuedInputs({
        session,
        config,
        state,
        statePath,
        token: secrets.token,
        runtimeDir,
      });
      if (options.once && queuedInputTurn?.done) {
        await queuedInputTurn.done;
        return;
      }
      if (queuedInputTurn) {
        continue;
      }

      state = reloadState();
      const bufferedInputFlushDelayMs = nextBufferedInputFlushDelayMs(pendingMediaGroups, pendingLooseInputs);
      const effectivePollTimeout = bufferedInputFlushDelayMs === null
        ? pollTimeout
        : Math.max(1, Math.min(pollTimeout, Math.ceil(bufferedInputFlushDelayMs / 1000)));
      const updates = await getUpdates({
        token: secrets.token,
        offset: state.update_offset,
        timeoutSeconds: effectivePollTimeout,
        runtimeDir,
      });

      for (const update of updates) {
        patchState(statePath, state, {
          update_offset: Math.max(Number(state.update_offset || 0), update.update_id + 1),
        });
        const message = update.message;
        if (!isAllowedPrivateMessage(message, secrets.allowedChatId)) continue;
        state = reloadState();
        const slashText = typeof message.text === "string" ? message.text.trim() : "";
        if (slashText === "/stop") {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/stop",
            message_id: message.message_id ?? null,
          });
          state = reloadState();
          session.state = state;
          let pauseResult = { paused: false, goal: null };
          let pauseError = null;
          try {
            pauseResult = await session.pauseActiveGoalIfNeeded();
          } catch (error) {
            pauseError = error;
          }

          state = reloadState();
          session.state = state;
          let interruptResult = { interrupted: false, reason: "unknown" };
          let interruptError = null;
          try {
            interruptResult = await session.interruptActiveTurn();
          } catch (error) {
            interruptError = error;
          }

          if (pauseError || interruptError) {
            patchState(statePath, state, {
              last_error: [pauseError, interruptError].filter(Boolean).map((error) => error.stack || String(error)).join("\n"),
            });
          }

          const lines = [t(config, "stop.handled")];
          if (interruptError) {
            lines.push(t(config, "stop.interruptFailed", { error: String(interruptError?.message || interruptError).slice(0, 300) }));
          } else if (interruptResult.interrupted) {
            lines.push(t(config, "stop.interrupted", { turnId: interruptResult.turnId }));
          } else {
            lines.push(t(config, "stop.noActiveTurn"));
          }
          if (pauseError) {
            lines.push(t(config, "stop.pauseFailed", { error: String(pauseError?.message || pauseError).slice(0, 300) }));
          } else if (pauseResult.paused) {
            lines.push(t(config, "stop.pausedGoal"));
          } else if (pauseResult.goal) {
            lines.push(t(config, "stop.goalStatus", { status: pauseResult.goal.status ?? t(config, "common.unknown") }));
          } else {
            lines.push(t(config, "stop.noGoal"));
          }
          await sendText({
            token: secrets.token,
            chatId: secrets.allowedChatId,
            text: lines.join("\n"),
            maxChars,
            runtimeDir,
            echo: true,
          });
          continue;
        }
        if (slashText === "/status") {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/status",
            message_id: message.message_id ?? null,
          });
          state = hydrateStatusSnapshots({ runtimeDir, statePath, state });
          session.state = state;
          await sendText({
            token: secrets.token,
            chatId: secrets.allowedChatId,
            text: formatMainlineStatus(state, config),
            maxChars,
            runtimeDir,
            echo: true,
          });
          continue;
        }
        const modelCommand = parseModelCommand(slashText);
        if (modelCommand) {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/model",
            action: modelCommand.action,
            message_id: message.message_id ?? null,
          });
          if (modelCommand.action === "status") {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: modelUsageNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          const resolvedModel = resolveModelChoice(config, modelCommand.model);
          if (!resolvedModel.choice) {
            const errorText = resolvedModel.matches.length > 1
              ? t(config, "model.ambiguous", {
                value: modelCommand.model || t(config, "common.empty"),
                matches: resolvedModel.matches.map((item) => item.id).join(", "),
              })
              : t(config, "model.unsupported", { value: modelCommand.model || t(config, "common.empty") });
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: `${errorText}\n\n${modelUsageNotice(config)}`,
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          const previousModel = String(config.model || "gpt-5.5").trim();
          const nextModel = updateConfigModel({
            config,
            configPath,
            model: modelCommand.model,
          });
          logSystem(`default model changed: ${previousModel} -> ${nextModel}`);
          await sendText({
            token: secrets.token,
            chatId: secrets.allowedChatId,
            text: [
              t(config, "model.changed", { from: previousModel, to: nextModel }),
              state.active_turn_id ? t(config, "model.activeTurnNote") : t(config, "model.nextTurnNote"),
              t(config, "common.writtenBack", { path: path.relative(WORKSPACE_ROOT, configPath) }),
            ].join("\n"),
            maxChars,
            runtimeDir,
            echo: true,
          });
          continue;
        }
        const effortCommand = parseEffortCommand(slashText);
        if (effortCommand) {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/effort",
            action: effortCommand.action,
            message_id: message.message_id ?? null,
          });
          if (effortCommand.action === "status") {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: effortUsageNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (!VALID_EFFORTS.has(effortCommand.effort)) {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: `${t(config, "effort.unsupported", { value: effortCommand.effort || t(config, "common.empty") })}\n\n${effortUsageNotice(config)}`,
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          const previousEffort = normalizedEffort(config.effort);
          const nextEffort = updateConfigEffort({
            config,
            configPath,
            effort: effortCommand.effort,
          });
          logSystem(`default effort changed: ${previousEffort} -> ${nextEffort}`);
          await sendText({
            token: secrets.token,
            chatId: secrets.allowedChatId,
            text: [
              t(config, "effort.changed", { from: previousEffort, to: nextEffort }),
              state.active_turn_id ? t(config, "effort.activeTurnNote") : t(config, "effort.nextTurnNote"),
              t(config, "common.writtenBack", { path: path.relative(WORKSPACE_ROOT, configPath) }),
            ].join("\n"),
            maxChars,
            runtimeDir,
            echo: true,
          });
          continue;
        }
        const languageCommand = parseLanguageCommand(slashText);
        if (languageCommand) {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/language",
            action: languageCommand.action,
            message_id: message.message_id ?? null,
          });
          if (languageCommand.action === "status") {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: languageUsageNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          const previousLocale = localeOf(config);
          try {
            const nextLocale = updateConfigLocale({
              config,
              configPath,
              locale: languageCommand.locale,
            });
            logSystem(`locale changed: ${previousLocale} -> ${nextLocale}`);
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: [
                t(config, "language.changed", { from: previousLocale, to: nextLocale }),
                t(config, "language.nextTurnNote"),
                t(config, "common.writtenBack", { path: path.relative(WORKSPACE_ROOT, configPath) }),
              ].join("\n"),
              maxChars,
              runtimeDir,
              echo: true,
            });
          } catch (error) {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: `${t(config, "language.unsupported", { value: languageCommand.locale || t(config, "common.empty") })}\n\n${languageUsageNotice(config)}`,
              maxChars,
              runtimeDir,
              echo: true,
            });
          }
          continue;
        }
        const rhythmCommand = parseRhythmCommand(slashText);
        if (rhythmCommand) {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/rhythm",
            action: rhythmCommand.action,
            message_id: message.message_id ?? null,
          });
          if (rhythmCommand.action === "status") {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: rhythmUsageNotice(config, state),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (rhythmCommand.action === "invalid") {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: `${t(config, "rhythm.unsupported", { value: rhythmCommand.arg || t(config, "common.empty") })}\n\n${rhythmUsageNotice(config, state)}`,
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          const result = updateConfigRhythm({
            config,
            configPath,
            state,
            statePath,
            command: rhythmCommand,
          });
          logSystem(`rhythm changed: ${result.previousEnabled ? `${result.previousMinutes}m` : "off"} -> ${result.nextEnabled ? `${result.nextMinutes}m` : "off"}`);
          await sendText({
            token: secrets.token,
            chatId: secrets.allowedChatId,
            text: rhythmChangedNotice(config, result, configPath),
            maxChars,
            runtimeDir,
            echo: true,
          });
          continue;
        }
        const historyCommand = parseHistoryCommand(slashText);
        if (historyCommand) {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/history",
            action: historyCommand.action,
            message_id: message.message_id ?? null,
            chars: historyCommand.query?.length ?? 0,
          });
          if (historyCommand.action === "usage") {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: historyUsageNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          try {
            const searchLimit = Math.max(1, Math.min(20, Math.trunc(numberFromConfig(config, "history_search_limit", 8))));
            const result = await session.searchHistoryThreads(historyCommand.query, {
              limit: searchLimit,
            });
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: formatHistorySearchResults(config, historyCommand.query, result),
              maxChars,
              runtimeDir,
              echo: true,
            });
          } catch (error) {
            const messageText = String(error?.message || error);
            const unsupported = messageText.includes("unknown variant") && messageText.includes("thread/search");
            patchState(statePath, state, { last_error: error.stack || String(error) });
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: unsupported
                ? t(config, "history.unsupported")
                : t(config, "history.failed", { error: messageText.slice(0, 300) }),
              maxChars,
              runtimeDir,
              echo: true,
            });
          }
          continue;
        }
        const sessionCommand = parseSessionCommand(slashText);
        if (sessionCommand) {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/session",
            action: sessionCommand.action,
            message_id: message.message_id ?? null,
          });
          if (sessionCommand.action === "status") {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: formatSessionStatus(config, state),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (sessionCommand.action === "use" && !isValidThreadId(sessionCommand.threadId)) {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: t(config, "session.invalidThread"),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (isCompactionBlocked(state)) {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: t(config, "session.compacting"),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (state.active_turn_id) {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: t(config, "session.activeTurn", { command: sessionCommand.action === "use" ? "/session use <thread_id>" : "/session new" }),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (isResting(state)) {
            clearRest(statePath, state, "User session rollover");
          }
          if (sessionCommand.action === "use") {
            try {
              await session.verifyThreadCanResume(sessionCommand.threadId);
            } catch (error) {
              await sendText({
                token: secrets.token,
                chatId: secrets.allowedChatId,
                text: t(config, "session.resumeFailed", { error: String(error?.message || error).slice(0, 300) }),
                maxChars,
                runtimeDir,
                echo: true,
              });
              continue;
            }
            const { previousThreadId } = bindExistingThread({
              statePath,
              state,
              threadId: sessionCommand.threadId,
            });
            logSystem(`session binding switched; previous=${previousThreadId ?? "(none)"}, current=${sessionCommand.threadId}`);
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: [
                ...tLines(config, "session.switched", {
                  current: sessionCommand.threadId,
                  previous: previousThreadId ?? t(config, "common.none"),
                }),
              ].join("\n"),
              maxChars,
              runtimeDir,
              echo: true,
            });
          } else {
            const { previousThreadId } = resetThreadBindingForNewSession({ statePath, state });
            logSystem(`session binding cleared; previous thread=${previousThreadId ?? "(none)"}`);
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: [
                ...tLines(config, "session.cleared", {
                  previous: previousThreadId ?? t(config, "common.none"),
                  returnCommand: previousThreadId ? `/session use ${previousThreadId}` : "/session use <thread_id>",
                }),
              ].join("\n"),
              maxChars,
              runtimeDir,
              echo: true,
            });
          }
          continue;
        }
        const goalCommand = parseGoalCommand(slashText);
        if (goalCommand) {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/goal",
            action: goalCommand.action,
            message_id: message.message_id ?? null,
            chars: goalCommand.objective?.length ?? 0,
          });
          if (goalCommand.action === "invalid") {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: goalUsageNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (goalCommand.action === "status") {
            try {
              const goal = await session.getGoal();
              await sendText({
                token: secrets.token,
                chatId: secrets.allowedChatId,
                text: formatGoalStatus(config, goal),
                maxChars,
                runtimeDir,
                echo: true,
              });
            } catch (error) {
              patchState(statePath, state, { last_error: error.stack || String(error) });
              await sendText({
                token: secrets.token,
                chatId: secrets.allowedChatId,
                text: t(config, "goal.readFailed", { error: String(error?.message || error).slice(0, 300) }),
                maxChars,
                runtimeDir,
                echo: true,
              });
            }
            continue;
          }
          if (isCompactionBlocked(state)) {
            logSystem("goal command skipped: context compacting");
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: compactingBusyNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (state.compacting_until) {
            session.noteContextCompactionTimedOut();
            continue;
          }
          if (isResting(state)) {
            clearRest(statePath, state, "User goal command");
          }
          try {
            if (goalCommand.action === "clear") {
              const cleared = await session.clearGoal();
              await sendText({
                token: secrets.token,
                chatId: secrets.allowedChatId,
                text: cleared ? t(config, "goal.cleared") : t(config, "goal.nothingToClear"),
                maxChars,
                runtimeDir,
                echo: true,
              });
            } else if (goalCommand.action === "set") {
              const goal = await session.setGoal(goalCommand.objective);
              await sendText({
                token: secrets.token,
                chatId: secrets.allowedChatId,
                text: [
                  t(config, "goal.set"),
                  "",
                  formatGoalStatus(config, goal),
                ].join("\n"),
                maxChars,
                runtimeDir,
                echo: true,
              });
            } else if (goalCommand.action === "pause") {
              const goal = await session.pauseGoal();
              await sendText({
                token: secrets.token,
                chatId: secrets.allowedChatId,
                text: goal
                  ? [t(config, "goal.paused"), "", formatGoalStatus(config, goal)].join("\n")
                  : t(config, "goal.nothingToPause"),
                maxChars,
                runtimeDir,
                echo: true,
              });
            } else if (goalCommand.action === "resume") {
              const goal = await session.resumeGoal();
              await sendText({
                token: secrets.token,
                chatId: secrets.allowedChatId,
                text: goal
                  ? [t(config, "goal.resumed"), "", formatGoalStatus(config, goal)].join("\n")
                  : t(config, "goal.nothingToResume"),
                maxChars,
                runtimeDir,
                echo: true,
              });
            } else if (goalCommand.action === "edit") {
              const goal = await session.editGoal(goalCommand.objective);
              await sendText({
                token: secrets.token,
                chatId: secrets.allowedChatId,
                text: goal
                  ? [t(config, "goal.updatedOk"), "", formatGoalStatus(config, goal)].join("\n")
                  : t(config, "goal.nothingToEdit"),
                maxChars,
                runtimeDir,
                echo: true,
              });
            }
          } catch (error) {
            patchState(statePath, state, { last_error: error.stack || String(error) });
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: t(config, "goal.failed", { error: String(error?.message || error).slice(0, 300) }),
              maxChars,
              runtimeDir,
              echo: true,
            });
          }
          continue;
        }
        const computerCommand = parseComputerCommand(slashText);
        if (computerCommand) {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/computer",
            message_id: message.message_id ?? null,
            chars: computerCommand.body.length,
          });
          if (!computerCommand.body) {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: computerUsageNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (isCompactionBlocked(state)) {
            logSystem("computer command skipped: context compacting");
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: compactingBusyNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (state.active_turn_id) {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: t(config, "computer.activeTurn"),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (state.compacting_until) {
            session.noteContextCompactionTimedOut();
            continue;
          }
          state = reloadState();
          if (isResting(state)) {
            clearRest(statePath, state, "User computer command");
          }
          const startup = !state.thread_id;
          const computerInput = buildComputerUseInput(config, message, computerCommand.body);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "send_turn_shape",
            command: "/computer",
            message_id: message.message_id ?? null,
            startup,
            ...computerInputShape(computerInput),
          });
          const turn = await session.startTurn(computerInput, {
            startup,
            computerUse: true,
            typingIndicator: true,
            protectInputOnCompactionFailure: true,
            protectedInputReason: "telegram_computer_command",
            protectedInputMetadata: {
              command: "/computer",
              message_id: message.message_id ?? null,
            },
          });
          if (options.once && turn?.done) {
            await turn.done;
            return;
          }
          continue;
        }
        const planCommand = parsePlanCommand(slashText);
        if (planCommand) {
          logBlock(t(config, "log.userToBridge"), slashText);
          appendJsonl(path.join(runtimeDir, "telegram.jsonl"), {
            direction: "recv_command",
            command: "/plan",
            message_id: message.message_id ?? null,
            chars: planCommand.body.length,
          });
          if (!planCommand.body) {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: planUsageNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (isCompactionBlocked(state)) {
            logSystem("plan command skipped: context compacting");
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: compactingBusyNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (state.active_turn_id) {
            await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: t(config, "plan.activeTurn"),
              maxChars,
              runtimeDir,
              echo: true,
            });
            continue;
          }
          if (state.compacting_until) {
            session.noteContextCompactionTimedOut();
            continue;
          }
          state = reloadState();
          if (isResting(state)) {
            clearRest(statePath, state, "User plan command");
          }
          const startup = !state.thread_id;
          const planBody = `${buildTelegramPulseHeader(config, message)}\n${planCommand.body}`;
          const turn = await session.startPlanTurn(planBody, {
            startup,
            typingIndicator: true,
            protectInputOnCompactionFailure: true,
            protectedInputReason: "telegram_plan_command",
            protectedInputMetadata: {
              command: "/plan",
              message_id: message.message_id ?? null,
            },
          });
          const notice = turn?.done?.then(async (ok) => {
            if (ok === false) return false;
            return await sendText({
              token: secrets.token,
              chatId: secrets.allowedChatId,
              text: planFinishedNotice(config),
              maxChars,
              runtimeDir,
              echo: true,
            });
          }).catch((error) => {
            patchState(statePath, state, { last_error: error.stack || String(error) });
            return false;
          });
          if (options.once && turn?.done) {
            await notice;
            return;
          }
          continue;
        }
        if (isCompactionBlocked(state)) {
          const queuePath = enqueueCompactionInput({
            config,
            runtimeDir,
            message,
            reason: "compaction_locked",
          });
          logSystem(`message queued: context compacting; queue=${queuePath}`);
          await sendText({
            token: secrets.token,
            chatId: secrets.allowedChatId,
            text: compactingQueuedNotice(config),
            maxChars,
            runtimeDir,
            echo: true,
          });
          continue;
        }
        if (shouldStoreInputForCompactionResume(state)) {
          const queuePath = enqueueCompactionInput({
            config,
            runtimeDir,
            message,
            reason: `${compactionResumeReason(state) || "compaction"}_resume_pending`,
          });
          logSystem(`message queued while compaction resume is pending; queue=${queuePath}`);
          await sendText({
            token: secrets.token,
            chatId: secrets.allowedChatId,
            text: compactingQueuedNotice(config),
            maxChars,
            runtimeDir,
            echo: true,
          });
          continue;
        }
        if (state.compacting_until) {
          const queuePath = enqueueCompactionInput({
            config,
            runtimeDir,
            message,
            reason: "compaction_timeout_transition",
          });
          logSystem(`message queued while marking compaction timeout; queue=${queuePath}`);
          session.noteContextCompactionTimedOut();
          await sendText({
            token: secrets.token,
            chatId: secrets.allowedChatId,
            text: compactingQueuedNotice(config),
            maxChars,
            runtimeDir,
            echo: true,
          });
          continue;
        }

        if (telegramMediaGroupId(message)) {
          queueMediaGroupMessage({
            pendingMediaGroups,
            message,
            config,
            runtimeDir,
          });
          continue;
        }

        const looseInputKey = looseInputBufferKey(message);
        if (telegramMessageHasImage(message) || pendingLooseInputs.has(looseInputKey)) {
          queueLooseInputMessage({
            pendingLooseInputs,
            message,
            config,
            runtimeDir,
          });
          continue;
        }

        state = reloadState();
        if (await maybePreemptInputWithProactiveCompaction({
          session,
          config,
          state,
          runtimeDir,
          message,
          token: secrets.token,
          chatId: secrets.allowedChatId,
          maxChars,
        })) {
          continue;
        }

        const handledInput = await handleTelegramMessagesInput({
          session,
          statePath,
          token: secrets.token,
          runtimeDir,
          config,
          messages: [message],
        });
        if (handledInput.handled) {
          if (options.once && handledInput.turn?.done) {
            await handledInput.turn.done;
            return;
          }
          continue;
        }
        if (typeof message.text !== "string") {
          const kind = telegramMessageKind(message);
          const text = kind === "sticker"
            ? t(config, "main.unsupportedSticker")
            : t(config, "main.unsupportedMessage", { kind });
          await sendText({
            token: secrets.token,
            chatId: secrets.allowedChatId,
            text,
            maxChars,
            runtimeDir,
            echo: true,
          });
          continue;
        }
      }

      const postUpdateMediaGroupTurn = await flushDueMediaGroups({
        pendingMediaGroups,
        session,
        statePath,
        token: secrets.token,
        runtimeDir,
      });
      const postUpdateLooseInputTurn = await flushDueLooseInputs({
        pendingLooseInputs,
        session,
        statePath,
        token: secrets.token,
        runtimeDir,
      });
      if (options.once && postUpdateMediaGroupTurn?.done) {
        await postUpdateMediaGroupTurn.done;
        return;
      }
      if (options.once && postUpdateLooseInputTurn?.done) {
        await postUpdateLooseInputTurn.done;
        return;
      }
      if (pendingMediaGroups.size > 0 || pendingLooseInputs.size > 0) {
        continue;
      }

      state = reloadState();
      const rhythmTurn = await maybeRunRhythm({
        session,
        config,
        state,
        statePath,
        token: secrets.token,
        chatId: secrets.allowedChatId,
        maxChars,
        runtimeDir,
      });
      if (options.once && rhythmTurn?.done) {
        await rhythmTurn.done;
        return;
      }

      patchState(statePath, state, { last_error: null });
      if (options.once && updates.length > 0 && pendingMediaGroups.size === 0 && pendingLooseInputs.size === 0) return;
      await delay(Math.max(0, idleSleep) * 1000);
    } catch (error) {
      const message = error?.stack || String(error);
      patchState(statePath, state, { last_error: message });
      appendJsonl(path.join(runtimeDir, "errors.jsonl"), { error: message });
      logSystem(`error: ${String(error?.message || error).split(/\r?\n/)[0]}`);
      await delay(5000);
      if (options.once) throw error;
    }
  }
}

main().catch((error) => {
  appendLifecycle(MAIN_RUNTIME_DIR, "fatal_error", {
    error: String(error?.stack || error).slice(0, 2000),
  });
  closeLiveStream();
  console.error(error?.stack || String(error));
  process.exit(1);
});


