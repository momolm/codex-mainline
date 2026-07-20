import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cacheStickerPreviewWindow,
  loadStickerCatalog,
  migrateStickerLibraryStorage,
  knownStickerSetNames,
  prepareStickerVisualSelection,
  registerStickerSetNames,
  refreshStickerSet,
  removeStickerSet,
  resolveStickerForSend,
  selectSticker,
  stickerSetList,
} from "./telegram-sticker-library.mjs";

const dir = path.join(os.tmpdir(), `telegram-sticker-library-${process.pid}-${Date.now()}`);
const catalogPath = path.join(dir, "catalog.json");
const cacheDir = path.join(dir, "cache");
mkdirSync(dir, { recursive: true });

const payload = {
  name: "demo_pack",
  title: "Demo Pack",
  sticker_type: "regular",
  stickers: [
    { file_id: "f0", file_unique_id: "u0", emoji: "😀", width: 512, height: 512 },
    { file_id: "f1", file_unique_id: "u1", emoji: "😎", width: 512, height: 512 },
  ],
};

try {
  await refreshStickerSet({ catalogPath, setName: payload.name, getStickerSet: async () => payload });
  assert.equal(stickerSetList(catalogPath)[0].sticker_count, 2);
  assert.equal(selectSticker(catalogPath, payload.name, 1).sticker.emoji, "😎");
  assert.equal("file_id" in selectSticker(catalogPath, payload.name, 1).sticker, false);
  assert.equal(readFileSync(catalogPath, "utf8").includes('"file_id"'), false);
  assert.deepEqual(knownStickerSetNames([
    { attachments: [{ set_name: "demo_pack" }] },
    { attachments: [{ set_name: "demo_pack" }, { set_name: "another_pack" }] },
  ]), ["demo_pack", "another_pack"]);

  const registrationCatalogPath = path.join(dir, "registration-catalog.json");
  const registrationCalls = [];
  const registration = await registerStickerSetNames({
    catalogPath: registrationCatalogPath,
    setNames: ["new_pack", "new_pack", ""],
    getStickerSet: async (setName) => {
      registrationCalls.push(setName);
      return { ...payload, name: setName, title: "New Pack" };
    },
  });
  assert.deepEqual(registrationCalls, ["new_pack"]);
  assert.deepEqual(registration.added.map((entry) => entry.name), ["new_pack"]);
  assert.deepEqual(registration.failed, []);
  await registerStickerSetNames({
    catalogPath: registrationCatalogPath,
    setNames: ["new_pack"],
    getStickerSet: async () => {
      throw new Error("registered sticker sets should not be fetched again");
    },
  });

  const preview = await cacheStickerPreviewWindow({
    catalogPath,
    cacheDir,
    setName: payload.name,
    offset: 1,
    limit: 1,
    getStickerSet: async () => payload,
    getTelegramFile: async (fileId) => ({ file_path: `${fileId}.webp` }),
    downloadFile: async ({ outputPath }) => writeFileSync(outputPath, "preview"),
  });
  assert.equal(preview.stickers.length, 1);
  assert.equal(preview.stickers[0].index, 1);
  assert.equal(existsSync(preview.stickers[0].preview_path), true);

  const resolved = await resolveStickerForSend({
    catalogPath,
    setName: payload.name,
    index: 1,
    getStickerSet: async () => ({
      ...payload,
      stickers: payload.stickers.map((sticker) => ({ ...sticker, file_id: `${sticker.file_id}-other-bot` })),
    }),
  });
  assert.equal(resolved.fileId, "f1-other-bot");
  assert.equal(resolved.sticker.file_unique_id, "u1");

  const visual = await prepareStickerVisualSelection({
    catalogPath,
    cacheDir,
    setName: payload.name,
    offset: 0,
    limit: 2,
    getStickerSet: async () => ({ ...payload, stickers: [payload.stickers[1], payload.stickers[0]] }),
    getTelegramFile: async (fileId) => ({ file_path: `${fileId}.webp` }),
    downloadFile: async ({ outputPath }) => writeFileSync(outputPath, "preview"),
    renderAtlas: async ({ manifest, outputPath }) => {
      assert.deepEqual(manifest.stickers.map((sticker) => sticker.file_unique_id), ["u1", "u0"]);
      writeFileSync(outputPath, "atlas");
    },
  });
  assert.equal(existsSync(visual.atlas_path), true);
  assert.equal(existsSync(visual.manifest_path), true);
  assert.deepEqual(visual.stickers.map((sticker) => sticker.index), [0, 1]);

  const stableResolved = await resolveStickerForSend({
    catalogPath,
    setName: payload.name,
    fileUniqueId: "u1",
    getStickerSet: async () => ({
      ...payload,
      stickers: [payload.stickers[0], { ...payload.stickers[1], file_id: "f1-stable" }],
    }),
  });
  assert.equal(stableResolved.fileId, "f1-stable");
  assert.equal(stableResolved.sticker.file_unique_id, "u1");

  const legacyRoot = path.join(dir, "legacy");
  const sharedRoot = path.join(dir, "shared");
  const legacyCatalogPath = path.join(legacyRoot, "catalog.json");
  const legacyCacheDir = path.join(legacyRoot, "cache");
  const migratedCatalogPath = path.join(sharedRoot, "catalog.json");
  const migratedCacheDir = path.join(sharedRoot, "cache");
  const legacyPreviewPath = path.join(legacyCacheDir, "demo_pack", "000-u0.webp");
  mkdirSync(path.dirname(legacyPreviewPath), { recursive: true });
  writeFileSync(legacyPreviewPath, "legacy-preview");
  writeFileSync(legacyCatalogPath, `${JSON.stringify({
    schema_version: 1,
    sets: {
      demo_pack: {
        ...payload,
        sticker_count: 2,
        stickers: payload.stickers.map((sticker, index) => ({
          ...sticker,
          index,
          preview_path: index === 0 ? legacyPreviewPath : null,
        })),
      },
    },
  }, null, 2)}\n`);
  const migrated = await migrateStickerLibraryStorage({
    catalogPath: migratedCatalogPath,
    cacheDir: migratedCacheDir,
    legacyCatalogPath,
    legacyCacheDir,
  });
  assert.equal(migrated.migrated, true);
  const migratedSticker = loadStickerCatalog(migratedCatalogPath).sets.demo_pack.stickers[0];
  assert.equal("file_id" in migratedSticker, false);
  assert.equal(migratedSticker.preview_path.startsWith(migratedCacheDir), true);
  assert.equal(existsSync(migratedSticker.preview_path), true);
  const migratedCatalogText = readFileSync(migratedCatalogPath, "utf8");
  const secondMigration = await migrateStickerLibraryStorage({
    catalogPath: migratedCatalogPath,
    cacheDir: migratedCacheDir,
    legacyCatalogPath,
    legacyCacheDir,
  });
  assert.equal(secondMigration.migrated, false);
  assert.equal(readFileSync(migratedCatalogPath, "utf8"), migratedCatalogText);

  const removed = await removeStickerSet({ catalogPath, cacheDir, setName: payload.name });
  assert.equal(removed.removed, true);
  assert.equal(stickerSetList(catalogPath).length, 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("telegram sticker library tests passed");
