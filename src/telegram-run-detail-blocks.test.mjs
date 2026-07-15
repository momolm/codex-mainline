import assert from "node:assert/strict";
import test from "node:test";

import {
  TELEGRAM_SAFE_MESSAGE_CHARS,
  renderRunDetailBlocks,
  splitRunDetailText,
} from "./telegram-run-detail-blocks.mjs";
import { formatToolOutputPreview } from "./telegram-tool-output-preview.mjs";

test("short runtime detail stays in one live block", () => {
  const rendered = renderRunDetailBlocks("turn: abc\ntool #1 started");
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /Codex run details \(live\)/);
  assert.doesNotMatch(rendered[0], /block 1/);
  assert.ok(rendered[0].length <= TELEGRAM_SAFE_MESSAGE_CHARS);
});

test("the current summary remains above the detail in a single block", () => {
  const summary = "turn: abc\nstatus: live\nlatest: tool #1 started";
  const rendered = renderRunDetailBlocks("stage: tool call\ntool #1 started", {
    summary,
    summaryReserve: summary,
  });
  assert.equal(rendered.length, 1);
  assert.match(rendered[0], /latest: tool #1 started/);
  assert.match(rendered[0], /---/);
  assert.match(rendered[0], /stage: tool call/);
});

test("long runtime detail continues across safe Telegram blocks", () => {
  const text = Array.from({ length: 24 }, (_, index) => (
    `tool #${index + 1} started\n$ ${"echo & <detail> ".repeat(22)}\ntool #${index + 1} completed`
  )).join("\n");
  const chunks = splitRunDetailText(text);
  const rendered = renderRunDetailBlocks(text);
  assert.ok(chunks.length > 1);
  assert.equal(rendered.length, chunks.length);
  assert.ok(rendered.every((block) => block.length <= TELEGRAM_SAFE_MESSAGE_CHARS));
});

test("completed state appears only on the final block", () => {
  const text = Array.from({ length: 30 }, (_, index) => (
    `tool #${index + 1}\n${"output & <preview> ".repeat(24)}`
  )).join("\n");
  const rendered = renderRunDetailBlocks(text, { done: true });
  assert.ok(rendered.length > 1);
  assert.ok(rendered.slice(0, -1).every((block) => block.includes("(continued)")));
  assert.match(rendered.at(-1), /\(done\)/);
});

test("completed continuation blocks stay stable while the live tail grows", () => {
  const entry = (index) => `tool #${index}\n${"stable continuation ".repeat(55)}`;
  const first = Array.from({ length: 14 }, (_, index) => entry(index + 1)).join("\n");
  const second = Array.from({ length: 22 }, (_, index) => entry(index + 1)).join("\n");
  const reserve = `turn: ${"&".repeat(64)}\nstatus: live\nlatest: ${"&".repeat(183)}`;
  const firstBlocks = renderRunDetailBlocks(first, { summary: "turn: abc\nlatest: tool #14", summaryReserve: reserve });
  const secondBlocks = renderRunDetailBlocks(second, { summary: "turn: abc\nlatest: tool #22", summaryReserve: reserve });
  assert.ok(secondBlocks.length > firstBlocks.length);
  assert.equal(secondBlocks[0], firstBlocks[0]);
  assert.doesNotMatch(secondBlocks[0], /latest:/);
  assert.match(secondBlocks.at(-1), /latest: tool #22/);
});

test("summary is carried only by the live tail block", () => {
  const text = Array.from({ length: 30 }, (_, index) => (
    `tool #${index + 1}\n${"long output ".repeat(45)}`
  )).join("\n");
  const summary = "turn: abc\nstatus: live\nlatest: tool #30";
  const reserve = `turn: ${"&".repeat(64)}\nstatus: live\nlatest: ${"&".repeat(183)}`;
  const rendered = renderRunDetailBlocks(text, { summary, summaryReserve: reserve });
  assert.ok(rendered.slice(0, -1).every((block) => !block.includes("turn: abc")));
  assert.match(rendered.at(-1), /turn: abc/);
});

test("seventeen tools keep the detail shape while continuing blocks", () => {
  const entries = Array.from({ length: 17 }, (_, index) => {
    const number = index + 1;
    const preview = formatToolOutputPreview(
      `tool-${number}-HEAD\n${"middle output ".repeat(90)}\ntool-${number}-TAIL`,
    ).preview;
    return [
      `tool #${number} started`,
      `$ command-${number}`,
      `cwd: C:\\fixture-${number}`,
      preview,
      `tool #${number} completed`,
    ].join("\n");
  });
  const rendered = renderRunDetailBlocks(entries.join("\n"), {
    done: true,
    summary: "turn: abc\nstatus: done\nlatest: tool #17",
    summaryReserve: `turn: ${"&".repeat(64)}\nstatus: done\nlatest: ${"&".repeat(183)}`,
  });
  const joined = rendered.join("\n");
  assert.ok(rendered.length > 1);
  assert.ok(rendered.every((block) => block.length <= TELEGRAM_SAFE_MESSAGE_CHARS));
  for (let number = 1; number <= 17; number += 1) {
    assert.match(joined, new RegExp(`tool-${number}-HEAD`));
    assert.match(joined, new RegExp(`tool-${number}-TAIL`));
  }
});

test("localized titles still participate in exact HTML sizing", () => {
  const title = ({ index, total, state }) => `运行细节${total > 1 ? ` 第 ${index + 1} 块` : ""}（${state}）`;
  const rendered = renderRunDetailBlocks(`<>&"`.repeat(5000), { title });
  assert.ok(rendered.length > 1);
  assert.ok(rendered.every((block) => block.length <= TELEGRAM_SAFE_MESSAGE_CHARS));
});
