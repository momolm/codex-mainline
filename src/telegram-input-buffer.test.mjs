import assert from "node:assert/strict";
import test from "node:test";

import { bufferTelegramInput } from "./telegram-input-buffer.mjs";

test("ordinary messages share one sliding one-second collection window", () => {
  const pendingInputs = new Map();
  const first = bufferTelegramInput({
    pendingInputs,
    key: "chat:input",
    message: { message_id: 10, text: "说明" },
    now: 1_000,
  });
  const second = bufferTelegramInput({
    pendingInputs,
    key: "chat:input",
    message: { message_id: 11, text: "转发一" },
    now: 1_400,
  });

  assert.equal(first, second);
  assert.equal(second.messages.size, 2);
  assert.equal(second.flushAt, 2_400);
  assert.equal(second.imageMessageCount, 0);
});
test("an image promotes the current input group to the image collection window", () => {
  const pendingInputs = new Map();
  bufferTelegramInput({
    pendingInputs,
    key: "chat:input",
    message: { message_id: 20, text: "先看这句" },
    now: 2_000,
  });
  const image = bufferTelegramInput({
    pendingInputs,
    key: "chat:input",
    message: { message_id: 21, photo: [{}] },
    hasImage: true,
    now: 2_500,
  });
  assert.equal(image.flushAt, 5_500);

  const followup = bufferTelegramInput({
    pendingInputs,
    key: "chat:input",
    message: { message_id: 22, text: "补充说明" },
    now: 3_000,
  });

  assert.equal(followup.flushAt, 6_000);
  assert.equal(followup.messages.size, 3);
  assert.equal(followup.imageMessageCount, 1);
});

test("a repeated Telegram message id does not inflate the image count", () => {
  const pendingInputs = new Map();
  const args = {
    pendingInputs,
    key: "chat:input",
    message: { message_id: 30, photo: [{}] },
    hasImage: true,
  };
  bufferTelegramInput({ ...args, now: 4_000 });
  const repeated = bufferTelegramInput({ ...args, now: 4_200 });

  assert.equal(repeated.messages.size, 1);
  assert.equal(repeated.imageMessageCount, 1);
  assert.equal(repeated.flushAt, 7_200);
});
