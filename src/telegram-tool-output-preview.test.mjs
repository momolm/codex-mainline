import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS,
  capturedToolOutputLiveHead,
  captureToolOutput,
  createToolOutputCapture,
  formatCapturedToolOutputPreview,
  formatToolOutputPreview,
  toolOutputLiveHeadChars,
} from "./telegram-tool-output-preview.mjs";

test("short output remains complete", () => {
  const result = formatToolOutputPreview("first line\nlast line");
  assert.equal(result.preview, "first line\nlast line");
  assert.equal(result.truncated, false);
  assert.equal(result.omittedChars, 0);
});

test("long output keeps its head and tail with an exact omission marker", () => {
  const text = Array.from({ length: 80 }, (_, index) => `line-${String(index + 1).padStart(3, "0")}`).join("\n");
  const result = formatToolOutputPreview(text);
  assert.match(result.preview, /^line-001/);
  assert.match(result.preview, /line-080$/);
  assert.match(result.preview, /\[\.\.\. \d+ chars omitted \.\.\.\]/);
  assert.ok(result.omittedChars > 0);
  assert.ok(result.preview.length <= DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS);
});

test("the live head remains a stable prefix of the completed preview", () => {
  const text = Array.from({ length: 80 }, (_, index) => `line-${String(index + 1).padStart(3, "0")}`).join("\n");
  const liveHead = text.slice(0, toolOutputLiveHeadChars());
  const result = formatToolOutputPreview(text);
  assert.ok(result.preview.startsWith(liveHead));
});

test("a long single line keeps both ends", () => {
  const result = formatToolOutputPreview(`HEAD-${"x".repeat(800)}-TAIL`, 120);
  assert.match(result.preview, /^HEAD-/);
  assert.match(result.preview, /-TAIL$/);
  assert.ok(result.preview.length <= 120);
});

test("stream capture stays bounded and renders the final head-tail window", () => {
  let capture = createToolOutputCapture();
  for (let index = 0; index < 100; index += 1) {
    capture = captureToolOutput(capture, `chunk-${String(index).padStart(3, "0")}\n`);
  }
  const result = formatCapturedToolOutputPreview(capture);
  const liveHead = capturedToolOutputLiveHead(capture);
  assert.equal(capture.overflowed, true);
  assert.ok(capture.head.length <= DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS);
  assert.ok(capture.tail.length <= DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS);
  assert.match(result.preview, /^chunk-000/);
  assert.match(result.preview, /chunk-099$/);
  assert.ok(result.preview.startsWith(liveHead));
});

test("preview normalizes CRLF and supports a localized marker", () => {
  const short = formatToolOutputPreview("first\r\nsecond\rthird");
  assert.equal(short.preview, "first\nsecond\nthird");
  assert.equal(short.totalChars, 18);

  const localized = formatToolOutputPreview("x".repeat(500), 100, {
    omissionMarker: (chars) => `[省略 ${chars} 字符]`,
  });
  assert.match(localized.preview, /\[省略 \d+ 字符\]/);
  assert.ok(localized.preview.length <= 100);
});
