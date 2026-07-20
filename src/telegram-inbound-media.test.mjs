import assert from "node:assert/strict";

import {
  imageDescriptorsFromTelegramMessage,
  safeFileName,
  telegramAttachmentDescriptors,
  telegramMessageKind,
  telegramMessageShape,
  telegramMessageText,
  telegramRichMessageText,
  telegramRichTextPlainText,
} from "./telegram-inbound-media.mjs";

assert.equal(safeFileName('bad:name?.png', "file"), "bad_name_.png");
assert.equal(telegramMessageText({ caption: "图片说明" }), "图片说明");

const photo = telegramAttachmentDescriptors({
  photo: [
    { file_id: "small", file_size: 10, width: 10, height: 10 },
    { file_id: "large", file_size: 20, width: 20, height: 20 },
  ],
});
assert.equal(photo.length, 1);
assert.equal(photo[0].fileId, "large");
assert.equal(telegramMessageKind({ photo: [{}] }), "photo");

const animatedSticker = telegramAttachmentDescriptors({
  sticker: {
    file_id: "animated",
    file_unique_id: "u1",
    is_animated: true,
    emoji: "👌",
    thumbnail: { file_id: "preview", file_unique_id: "u2", width: 100, height: 100 },
  },
});
assert.deepEqual(animatedSticker.map((item) => item.kind), ["sticker", "sticker_preview"]);
assert.equal(imageDescriptorsFromTelegramMessage({ sticker: { file_id: "animated", is_animated: true } }).length, 0);
assert.equal(imageDescriptorsFromTelegramMessage({ sticker: { file_id: "static" } })[0].fallbackName, "sticker.webp");
assert.equal(telegramMessageKind({ voice: { file_id: "voice" } }), "voice");

assert.equal(
  telegramRichTextPlainText([
    "pong",
    { type: "bold", text: "。" },
    { type: "custom_emoji", alternative_text: "🌸", custom_emoji_id: "emoji-id" },
  ]),
  "pong。🌸",
);
assert.equal(
  telegramRichMessageText({
    blocks: [
      { type: "heading", text: "标题", size: 2 },
      { type: "paragraph", text: ["第一段", { type: "italic", text: "正文" }] },
      {
        type: "list",
        items: [
          { label: "1.", blocks: [{ type: "paragraph", text: "列表项" }] },
        ],
      },
      {
        type: "details",
        summary: "摘要",
        blocks: [{ type: "paragraph", text: "详情" }],
      },
      {
        type: "table",
        caption: "表格",
        cells: [[{ text: "A" }, { text: { type: "bold", text: "B" } }]],
      },
    ],
  }),
  "标题\n第一段正文\n1. 列表项\n摘要\n详情\n表格\nA\tB",
);
assert.equal(
  telegramMessageText({ rich_message: { blocks: [{ type: "paragraph", text: "转发正文" }] } }),
  "转发正文",
);
assert.equal(
  telegramMessageKind({ rich_message: { blocks: [{ type: "paragraph", text: "转发正文" }] } }),
  "text",
);

assert.deepEqual(
  telegramMessageShape({
    message_id: 42,
    text: "不会写入结构日志的正文",
    rich_message: { markdown: "同样不会写入", entities: [] },
  }),
  {
    message_id: 42,
    top_level_keys: ["message_id", "rich_message", "text"],
    nested_object_keys: {
      rich_message: ["entities", "markdown"],
    },
  },
);

console.log("telegram inbound media tests passed");
