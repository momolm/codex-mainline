import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMcpRuntimeStatus,
  listMcpServerInventory,
  mcpUsageNotice,
  parseMcpCommand,
  reloadMcpServerInventory,
} from "./mcp-runtime-control.mjs";

test("parses the compact MCP command family", () => {
  assert.deepEqual(parseMcpCommand("/mcp"), { action: "status" });
  assert.deepEqual(parseMcpCommand(" /MCP reload "), { action: "reload" });
  assert.deepEqual(parseMcpCommand("/mcp unknown"), { action: "invalid" });
  assert.equal(parseMcpCommand("/mcprofile"), null);
});

test("formats inventory, auth, startup failures, and localized text together", () => {
  const dictionary = {
    reloadedTitle: "已刷新",
    threadUnbound: "未绑定",
    summary: "服务 {servers} 工具 {tools}",
    reloadQueued: "下轮生效",
    startupReady: "就绪",
    startupFailed: "失败",
    authUnsupported: "无需登录",
    authUnknown: "未知",
    version: " | v{version}",
    server: "- {name}: {status} | {tools} tools | auth={auth}{version}",
    error: "  error: {error}",
    usageStatus: "/mcp",
    usageReload: "/mcp reload",
    usageNote: "说明",
  };
  const translate = (key, params = {}) => String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => params[name]);
  const text = formatMcpRuntimeStatus({
    data: [{
      name: "docs",
      serverInfo: { version: "1.2.3" },
      tools: { search: { name: "search" }, alias: { name: "search" }, fetch: { name: "fetch" } },
      authStatus: "unsupported",
    }],
  }, {
    reloaded: true,
    threadId: "thread-123",
    startupStatuses: [
      { name: "docs", status: "ready" },
      { name: "blender", status: "failed", error: "connection refused" },
    ],
    translate,
  });
  assert.match(text, /已刷新/);
  assert.match(text, /服务 2 工具 2/);
  assert.match(text, /docs: 就绪 \| 2 tools \| auth=无需登录 \| v1\.2\.3/);
  assert.match(text, /blender: 失败/);
  assert.match(text, /connection refused/);
});

test("usage notice keeps status and reload under one command family", () => {
  const text = mcpUsageNotice();
  assert.match(text, /Usage: \/mcp$/m);
  assert.match(text, /Usage: \/mcp reload$/m);
});

test("inventory uses the current thread and consumes pagination centrally", async () => {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (!params.cursor) return { data: [{ name: "first" }], nextCursor: "page-2" };
    return { data: [{ name: "second" }], nextCursor: null };
  };
  const result = await listMcpServerInventory({ request, threadId: "thread-123" });
  assert.deepEqual(result.data.map((item) => item.name), ["first", "second"]);
  assert.equal(calls[0].method, "mcpServerStatus/list");
  assert.equal(calls[1].params.cursor, "page-2");
});

test("reload uses the native refresh RPC before reading inventory", async () => {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    return method === "config/mcpServer/reload" ? {} : { data: [{ name: "blender" }], nextCursor: null };
  };
  const result = await reloadMcpServerInventory({ request, threadId: "thread-123" });
  assert.equal(result.data[0].name, "blender");
  assert.equal(calls[0].method, "config/mcpServer/reload");
  assert.equal(calls[1].method, "mcpServerStatus/list");
});
