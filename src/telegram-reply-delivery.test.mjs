import assert from "node:assert/strict";
import test from "node:test";

import { deliverAssistantText } from "./telegram-reply-delivery.mjs";

test("sends completed assistant text through native rich Markdown once", async () => {
  const calls = [];
  const result = await deliverAssistantText({
    text: "**done**",
    richMarkdown: true,
    sendRich: async (value) => {
      calls.push(["rich", value]);
      return "rich-result";
    },
    sendPlain: async (value) => {
      calls.push(["plain", value]);
      return "plain-result";
    },
  });

  assert.equal(result, "rich-result");
  assert.deepEqual(calls, [["rich", "**done**"]]);
});

test("falls back to plain text once when rich Markdown is rejected", async () => {
  const calls = [];
  const error = new Error("unsupported rich message");
  const result = await deliverAssistantText({
    text: "<custom_tag>text</custom_tag>",
    richMarkdown: true,
    sendRich: async () => {
      calls.push("rich");
      throw error;
    },
    sendPlain: async (value) => {
      calls.push(["plain", value]);
      return "plain-result";
    },
    onRichFallback: async (caught) => {
      calls.push(["fallback", caught]);
    },
  });

  assert.equal(result, "plain-result");
  assert.deepEqual(calls, [
    "rich",
    ["fallback", error],
    ["plain", "<custom_tag>text</custom_tag>"],
  ]);
});

test("keeps non-assistant messages on the plain sender", async () => {
  const calls = [];
  await deliverAssistantText({
    text: "system notice",
    sendRich: async () => calls.push("rich"),
    sendPlain: async (value) => calls.push(["plain", value]),
  });

  assert.deepEqual(calls, [["plain", "system notice"]]);
});
