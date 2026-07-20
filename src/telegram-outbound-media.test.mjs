import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isTelegramPhotoPath,
  resolveTelegramDeliveryFilePath,
  telegramOutboundKind,
} from "./telegram-outbound-media.mjs";

assert.equal(isTelegramPhotoPath("hello.PNG"), true);
assert.equal(isTelegramPhotoPath("hello.pdf"), false);
assert.equal(telegramOutboundKind("hello.jpg", "auto", 1024), "photo");
assert.equal(telegramOutboundKind("hello.jpg", "auto", 11 * 1024 * 1024), "document");
assert.equal(telegramOutboundKind("hello.webp", "sticker", 1024), "sticker");

const dir = path.join(os.tmpdir(), `telegram-outbound-media-${process.pid}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
try {
  const filePath = path.join(dir, "image.png");
  writeFileSync(filePath, "image");
  assert.equal(resolveTelegramDeliveryFilePath({ workspaceRoot: dir, filePath }), filePath);
  assert.throws(
    () => resolveTelegramDeliveryFilePath({ workspaceRoot: dir, filePath, blockedPaths: [filePath] }),
    /blocked/,
  );
  assert.throws(
    () => resolveTelegramDeliveryFilePath({ workspaceRoot: dir, filePath, maxBytes: 1 }),
    /too large/,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("telegram outbound media tests passed");
