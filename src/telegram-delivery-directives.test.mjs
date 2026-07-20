import assert from "node:assert/strict";

import { extractTelegramDeliveries } from "./telegram-delivery-directives.mjs";

assert.deepEqual(
  extractTelegramDeliveries([
    "完成。",
    '<tg_send_file path="D:&bsol;work&bsol;result.zip" />',
    '<tg_send_sticker set="NickCollection1_by_fStikBot" index="5" />',
  ].join("\n")),
  {
    text: "完成。",
    files: ["D:&bsol;work&bsol;result.zip"],
    stickers: [{ setName: "NickCollection1_by_fStikBot", index: 5 }],
  },
);

assert.deepEqual(
  extractTelegramDeliveries('<tg_send_sticker set="bad-name" index="x" />'),
  { text: "", files: [], stickers: [] },
);

assert.deepEqual(
  extractTelegramDeliveries('<tg_send_sticker set="NickCollection1_by_fStikBot" file_unique_id="stable-uid_1" />'),
  {
    text: "",
    files: [],
    stickers: [{ setName: "NickCollection1_by_fStikBot", fileUniqueId: "stable-uid_1" }],
  },
);

assert.deepEqual(
  extractTelegramDeliveries("普通聊天"),
  { text: "普通聊天", files: [], stickers: [] },
);

console.log("telegram delivery directive tests passed");
