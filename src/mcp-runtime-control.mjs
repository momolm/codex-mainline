const AUTH_LABEL_KEYS = new Map([
  ["unsupported", "authUnsupported"],
  ["notLoggedIn", "authNotLoggedIn"],
  ["bearerToken", "authBearerToken"],
  ["oAuth", "authOAuth"],
]);

const STARTUP_LABEL_KEYS = new Map([
  ["starting", "startupStarting"],
  ["ready", "startupReady"],
  ["failed", "startupFailed"],
  ["cancelled", "startupCancelled"],
]);

const DEFAULT_MESSAGES = {
  title: "MCP runtime:",
  reloadedTitle: "MCP hot reload completed:",
  threadUnbound: "(no thread is currently bound)",
  thread: "thread: {thread}",
  summary: "servers: {servers} | tools: {tools}",
  reloadQueued: "The current thread is queued for refresh; the next turn uses the updated tool set.",
  noServers: "No MCP servers are currently visible.",
  unnamed: "(unnamed)",
  startupStarting: "starting",
  startupReady: "ready",
  startupFailed: "failed",
  startupCancelled: "cancelled",
  startupLoaded: "loaded",
  authUnsupported: "unsupported",
  authNotLoggedIn: "not logged in",
  authBearerToken: "Bearer token",
  authOAuth: "OAuth",
  authUnknown: "unknown",
  version: " | v{version}",
  server: "- {name}: {status} | {tools} tools | auth={auth}{version}",
  error: "  error: {error}",
  usageStatus: "Usage: /mcp",
  usageReload: "Usage: /mcp reload",
  usageNote: "Note: reload rereads MCP config from disk, refreshes the current Codex thread, and returns server, tool, and auth status.",
};

function interpolate(value, params = {}) {
  return String(value).replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, key) => (
    params[key] === undefined || params[key] === null ? match : String(params[key])
  ));
}

function defaultTranslate(key, params = {}) {
  return interpolate(DEFAULT_MESSAGES[key] ?? key, params);
}

function translated(translate, key, params = {}) {
  return String((translate || defaultTranslate)(key, params));
}

function compactOneLine(value, maxChars = 300) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function toolCount(server) {
  const tools = server?.tools && typeof server.tools === "object" ? server.tools : {};
  const names = Object.entries(tools).map(([key, tool]) => (
    String(tool?.name || key || "").trim()
  )).filter(Boolean);
  return new Set(names).size;
}

function startupStatusMap(startupStatuses) {
  const map = new Map();
  for (const item of Array.isArray(startupStatuses) ? startupStatuses : []) {
    const name = String(item?.name || "").trim();
    if (name) map.set(name, item);
  }
  return map;
}

export function parseMcpCommand(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (value === "/mcp") return { action: "status" };
  if (value === "/mcp reload") return { action: "reload" };
  if (value.startsWith("/mcp ")) return { action: "invalid" };
  return null;
}

export function mcpUsageNotice(translate = defaultTranslate) {
  return [
    translated(translate, "usageStatus"),
    translated(translate, "usageReload"),
    translated(translate, "usageNote"),
  ].join("\n");
}

export async function listMcpServerInventory({ request, threadId = null }) {
  if (typeof request !== "function") throw new TypeError("request must be a function");
  const data = [];
  const seenCursors = new Set();
  let cursor = null;
  do {
    const result = await request("mcpServerStatus/list", {
      threadId,
      detail: "toolsAndAuthOnly",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (Array.isArray(result?.data)) data.push(...result.data);
    const nextCursor = String(result?.nextCursor || "").trim() || null;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return { data, nextCursor: null, threadId };
}

export async function reloadMcpServerInventory({ request, threadId = null }) {
  if (typeof request !== "function") throw new TypeError("request must be a function");
  await request("config/mcpServer/reload");
  return await listMcpServerInventory({ request, threadId });
}

export function formatMcpRuntimeStatus(
  response,
  {
    reloaded = false,
    threadId = null,
    startupStatuses = [],
    translate = defaultTranslate,
  } = {},
) {
  const servers = Array.isArray(response?.data) ? response.data : [];
  const startupByName = startupStatusMap(startupStatuses);
  const serverByName = new Map();
  for (const server of servers) {
    const name = String(server?.name || "").trim();
    if (name) serverByName.set(name, server);
  }
  for (const [name] of startupByName) {
    if (!serverByName.has(name)) serverByName.set(name, { name, tools: {} });
  }

  const rows = [...serverByName.values()].sort((a, b) => (
    String(a?.name || "").localeCompare(String(b?.name || ""))
  ));
  const totalTools = rows.reduce((sum, server) => sum + toolCount(server), 0);
  const lines = [
    translated(translate, reloaded ? "reloadedTitle" : "title"),
    translated(translate, "thread", {
      thread: threadId || translated(translate, "threadUnbound"),
    }),
    translated(translate, "summary", { servers: rows.length, tools: totalTools }),
  ];
  if (reloaded) lines.push(translated(translate, "reloadQueued"));

  if (rows.length === 0) {
    lines.push("", translated(translate, "noServers"));
  } else {
    lines.push("");
    for (const server of rows) {
      const name = String(server?.name || translated(translate, "unnamed"));
      const tools = toolCount(server);
      const startup = startupByName.get(name);
      const startupKey = STARTUP_LABEL_KEYS.get(startup?.status)
        || (tools > 0 || server?.serverInfo ? "startupReady" : "startupLoaded");
      const authKey = AUTH_LABEL_KEYS.get(server?.authStatus);
      const auth = authKey
        ? translated(translate, authKey)
        : String(server?.authStatus || translated(translate, "authUnknown"));
      const rawVersion = String(server?.serverInfo?.version || "").trim();
      const version = rawVersion ? translated(translate, "version", { version: rawVersion }) : "";
      lines.push(translated(translate, "server", {
        name,
        status: translated(translate, startupKey),
        tools,
        auth,
        version,
      }));
      if (startup?.error) {
        lines.push(translated(translate, "error", { error: compactOneLine(startup.error) }));
      }
    }
  }

  lines.push("", mcpUsageNotice(translate));
  return lines.join("\n").trimEnd();
}
