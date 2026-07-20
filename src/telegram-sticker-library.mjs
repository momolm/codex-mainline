import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { extensionFromTelegramFile, safeFileName } from "./telegram-inbound-media.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_ATLAS_RENDERER = fileURLToPath(new URL("../scripts/render-telegram-sticker-atlas.py", import.meta.url));

function readJsonIfExists(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}
function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function emptyCatalog() {
  return { schema_version: 2, updated_at: null, sets: {} };
}

function storedSticker(sticker, index = 0) {
  return {
    index: Number.isInteger(sticker?.index) ? sticker.index : index,
    file_unique_id: sticker?.file_unique_id || null,
    emoji: sticker?.emoji || null,
    width: Number(sticker?.width || 0),
    height: Number(sticker?.height || 0),
    is_animated: Boolean(sticker?.is_animated),
    is_video: Boolean(sticker?.is_video),
    thumbnail_file_unique_id: sticker?.thumbnail_file_unique_id || null,
    preview_path: sticker?.preview_path || null,
    preview_error: sticker?.preview_error || null,
  };
}

function storedSet(entry, fallbackName = "") {
  const name = String(entry?.name || fallbackName);
  const stickers = Array.isArray(entry?.stickers)
    ? entry.stickers.map((sticker, index) => storedSticker(sticker, index))
    : [];
  return {
    name,
    title: String(entry?.title || name),
    sticker_type: String(entry?.sticker_type || "regular"),
    sticker_count: stickers.length,
    refreshed_at: entry?.refreshed_at || null,
    stickers,
  };
}

function normalizedCatalog(raw) {
  const catalog = emptyCatalog();
  if (!raw || typeof raw !== "object") return catalog;
  for (const [setName, entry] of Object.entries(raw.sets || {})) {
    const normalized = storedSet(entry, setName);
    if (normalized.name) catalog.sets[normalized.name] = normalized;
  }
  catalog.updated_at = raw.updated_at || null;
  return catalog;
}

function catalogNeedsRewrite(catalogPath) {
  if (!existsSync(catalogPath)) return false;
  const raw = readJsonIfExists(catalogPath, emptyCatalog());
  if (raw?.schema_version !== 2) return true;
  return Object.values(raw?.sets || {}).some((entry) => (
    (entry?.stickers || []).some((sticker) => (
      Object.hasOwn(sticker || {}, "file_id") || Object.hasOwn(sticker || {}, "thumbnail_file_id")
    ))
  ));
}

export function defaultStickerLibraryPaths(workspaceRoot) {
  const sharedRoot = path.join(workspaceRoot, "runtime", "telegram_shared", "sticker_sets");
  const legacyRoot = path.join(workspaceRoot, "runtime", "companion_inbox", "sticker_sets");
  return {
    catalogPath: path.join(sharedRoot, "catalog.json"),
    cacheDir: path.join(sharedRoot, "cache"),
    legacyCatalogPath: path.join(legacyRoot, "catalog.json"),
    legacyCacheDir: path.join(legacyRoot, "cache"),
  };
}

export function loadStickerCatalog(catalogPath) {
  return normalizedCatalog(readJsonIfExists(catalogPath, emptyCatalog()));
}

export async function saveStickerCatalog(catalogPath, catalog) {
  const value = {
    ...normalizedCatalog(catalog),
    schema_version: 2,
    updated_at: new Date().toISOString(),
  };
  writeJson(catalogPath, value);
  return value;
}

function rebasePreviewPaths(catalog, sourceDir, targetDir) {
  const sourcePrefix = `${path.resolve(sourceDir)}${path.sep}`.toLowerCase();
  for (const entry of Object.values(catalog.sets)) {
    for (const sticker of entry.stickers) {
      if (!sticker.preview_path) continue;
      const absolute = path.resolve(sticker.preview_path);
      if (!absolute.toLowerCase().startsWith(sourcePrefix)) continue;
      sticker.preview_path = path.join(targetDir, path.relative(sourceDir, absolute));
    }
  }
}

export async function migrateStickerLibraryStorage({
  catalogPath,
  cacheDir,
  legacyCatalogPath,
  legacyCacheDir,
}) {
  const sameCatalog = path.resolve(catalogPath).toLowerCase() === path.resolve(legacyCatalogPath).toLowerCase();
  const sameCache = path.resolve(cacheDir).toLowerCase() === path.resolve(legacyCacheDir).toLowerCase();
  const targetNeedsRewrite = catalogNeedsRewrite(catalogPath);
  const legacyExists = !sameCatalog && existsSync(legacyCatalogPath);
  const target = loadStickerCatalog(catalogPath);
  const legacy = legacyExists ? loadStickerCatalog(legacyCatalogPath) : emptyCatalog();
  const merged = {
    ...emptyCatalog(),
    sets: { ...legacy.sets, ...target.sets },
  };

  if (!sameCache && existsSync(legacyCacheDir)) {
    mkdirSync(path.dirname(cacheDir), { recursive: true });
    if (!existsSync(cacheDir)) {
      renameSync(legacyCacheDir, cacheDir);
    } else {
      cpSync(legacyCacheDir, cacheDir, { recursive: true, force: false, errorOnExist: false });
      rmSync(legacyCacheDir, { recursive: true, force: true });
    }
    rebasePreviewPaths(merged, legacyCacheDir, cacheDir);
  }

  if (legacyExists || targetNeedsRewrite) await saveStickerCatalog(catalogPath, merged);
  if (legacyExists) rmSync(legacyCatalogPath, { force: true });
  if (!sameCatalog && !sameCache && existsSync(path.dirname(legacyCatalogPath))) {
    rmSync(path.dirname(legacyCatalogPath), { recursive: true, force: true });
  }
  return {
    migrated: legacyExists,
    catalog_path: catalogPath,
    cache_dir: cacheDir,
    set_count: Object.keys(merged.sets).length,
  };
}

function normalizedLiveSticker(sticker, index, previousByUniqueId) {
  const uniqueId = sticker?.file_unique_id || null;
  const previous = uniqueId ? previousByUniqueId.get(uniqueId) : null;
  const thumbnail = sticker?.thumbnail || sticker?.thumb || null;
  return storedSticker({
    index,
    file_unique_id: uniqueId,
    emoji: sticker?.emoji || null,
    width: sticker?.width,
    height: sticker?.height,
    is_animated: sticker?.is_animated,
    is_video: sticker?.is_video,
    thumbnail_file_unique_id: thumbnail?.file_unique_id || null,
    preview_path: previous?.preview_path || null,
    preview_error: null,
  }, index);
}

async function storeLiveStickerSet({ catalogPath, requestedSetName, payload }) {
  const catalog = loadStickerCatalog(catalogPath);
  const previous = catalog.sets[requestedSetName] || catalog.sets[payload?.name];
  const previousByUniqueId = new Map((previous?.stickers || [])
    .filter((item) => item.file_unique_id)
    .map((item) => [item.file_unique_id, item]));
  const stickers = Array.isArray(payload?.stickers)
    ? payload.stickers.map((sticker, index) => normalizedLiveSticker(sticker, index, previousByUniqueId))
    : [];
  const entry = storedSet({
    name: String(payload?.name || requestedSetName),
    title: String(payload?.title || requestedSetName),
    sticker_type: String(payload?.sticker_type || "regular"),
    refreshed_at: new Date().toISOString(),
    stickers,
  }, requestedSetName);
  if (requestedSetName !== entry.name) delete catalog.sets[requestedSetName];
  catalog.sets[entry.name] = entry;
  await saveStickerCatalog(catalogPath, catalog);
  return entry;
}

export async function refreshStickerSet({ catalogPath, setName, getStickerSet }) {
  const payload = await getStickerSet(setName);
  return await storeLiveStickerSet({ catalogPath, requestedSetName: setName, payload });
}

export async function registerStickerSetNames({ catalogPath, setNames, getStickerSet }) {
  const registered = new Set(stickerSetList(catalogPath).map((entry) => entry.name));
  const requested = [...new Set((setNames || []).map((name) => String(name || "").trim()).filter(Boolean))];
  const added = [];
  const failed = [];

  for (const setName of requested) {
    if (registered.has(setName)) continue;
    try {
      const entry = await refreshStickerSet({ catalogPath, setName, getStickerSet });
      registered.add(entry.name);
      added.push(entry);
    } catch (error) {
      failed.push({ set_name: setName, error: error?.message || String(error) });
    }
  }
  return { added, failed };
}

export function knownStickerSetNames(messages) {
  return [...new Set((messages || [])
    .flatMap((message) => message?.attachments || [])
    .map((attachment) => String(attachment?.set_name || "").trim())
    .filter(Boolean))];
}

export function stickerSetList(catalogPath) {
  const catalog = loadStickerCatalog(catalogPath);
  return Object.values(catalog.sets).sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-CN"));
}

export async function removeStickerSet({ catalogPath, cacheDir, setName }) {
  const catalog = loadStickerCatalog(catalogPath);
  if (!catalog.sets[setName]) return { removed: false, set_name: setName };
  delete catalog.sets[setName];
  await saveStickerCatalog(catalogPath, catalog);
  const setDir = path.join(cacheDir, safeFileName(setName, "sticker-set"));
  rmSync(setDir, { recursive: true, force: true });
  return { removed: true, set_name: setName };
}

export function selectSticker(catalogPath, setName, index) {
  const catalog = loadStickerCatalog(catalogPath);
  const entry = catalog.sets[setName];
  if (!entry) throw new Error(`unknown sticker set: ${setName}`);
  const selected = entry.stickers?.[index];
  if (!selected) throw new Error(`sticker index out of range: ${index}`);
  return { set: entry, sticker: selected };
}

export async function resolveStickerForSend({ catalogPath, setName, index, fileUniqueId = null, getStickerSet }) {
  const registered = loadStickerCatalog(catalogPath).sets[setName];
  if (!registered) throw new Error(`unknown sticker set: ${setName}`);
  const payload = await getStickerSet(setName);
  const liveStickers = Array.isArray(payload?.stickers) ? payload.stickers : [];
  const liveIndex = fileUniqueId
    ? liveStickers.findIndex((sticker) => sticker?.file_unique_id === fileUniqueId)
    : index;
  const liveSticker = Number.isInteger(liveIndex) && liveIndex >= 0 ? liveStickers[liveIndex] : null;
  if (!liveSticker?.file_id) {
    if (fileUniqueId) throw new Error(`selected sticker is no longer in set: ${fileUniqueId}`);
    throw new Error(`sticker index out of range: ${index}`);
  }
  const entry = await storeLiveStickerSet({ catalogPath, requestedSetName: setName, payload });
  return {
    set: entry,
    sticker: entry.stickers[liveIndex],
    fileId: liveSticker.file_id,
  };
}

function previewSource(sticker) {
  const thumbnail = sticker?.thumbnail || sticker?.thumb || null;
  if ((sticker?.is_animated || sticker?.is_video) && thumbnail?.file_id) {
    return { fileId: thumbnail.file_id, fallbackExt: ".jpg" };
  }
  if (sticker?.file_id) {
    return { fileId: sticker.file_id, fallbackExt: sticker.is_animated ? ".tgs" : sticker.is_video ? ".webm" : ".webp" };
  }
  return null;
}

export async function cacheStickerPreviewWindow({
  catalogPath,
  cacheDir,
  setName,
  offset = 0,
  limit = 12,
  getStickerSet,
  getTelegramFile,
  downloadFile,
}) {
  if (!loadStickerCatalog(catalogPath).sets[setName]) throw new Error(`unknown sticker set: ${setName}`);
  const payload = await getStickerSet(setName);
  let entry = await storeLiveStickerSet({ catalogPath, requestedSetName: setName, payload });
  const start = Math.max(0, Math.trunc(offset));
  const count = Math.max(1, Math.trunc(limit));
  const liveWindow = Array.isArray(payload?.stickers) ? payload.stickers.slice(start, start + count) : [];
  const setDir = path.join(cacheDir, safeFileName(setName, "sticker-set"));
  mkdirSync(setDir, { recursive: true });

  for (let relativeIndex = 0; relativeIndex < liveWindow.length; relativeIndex += 1) {
    const index = start + relativeIndex;
    const sticker = entry.stickers[index];
    const source = previewSource(liveWindow[relativeIndex]);
    if (!source) {
      sticker.preview_error = "sticker has no downloadable preview";
      continue;
    }
    try {
      const file = await getTelegramFile(source.fileId);
      const ext = extensionFromTelegramFile(file.file_path, source.fallbackExt);
      const uniquePart = safeFileName(sticker.file_unique_id || `sticker-${index}`, `sticker-${index}`);
      const outputPath = path.join(setDir, `${uniquePart}${ext}`);
      if (!existsSync(outputPath) || statSync(outputPath).size <= 0) {
        await downloadFile({ filePath: file.file_path, outputPath });
      }
      sticker.preview_path = outputPath;
      sticker.preview_error = null;
    } catch (error) {
      sticker.preview_error = error?.message || String(error);
    }
  }

  const catalog = loadStickerCatalog(catalogPath);
  catalog.sets[entry.name] = entry;
  await saveStickerCatalog(catalogPath, catalog);
  entry = loadStickerCatalog(catalogPath).sets[entry.name];
  return { set: entry, stickers: entry.stickers.slice(start, start + count), offset: start, limit: count };
}

async function renderStickerAtlasWithPython({ manifestPath, outputPath, rendererPath = DEFAULT_ATLAS_RENDERER }) {
  try {
    await execFileAsync("python", [rendererPath, manifestPath, outputPath], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`sticker atlas rendering failed: ${detail}`);
  }
}

export async function prepareStickerVisualSelection({
  catalogPath,
  cacheDir,
  setName,
  offset = 0,
  limit = 12,
  getStickerSet,
  getTelegramFile,
  downloadFile,
  renderAtlas = renderStickerAtlasWithPython,
}) {
  const window = await cacheStickerPreviewWindow({
    catalogPath,
    cacheDir,
    setName,
    offset,
    limit,
    getStickerSet,
    getTelegramFile,
    downloadFile,
  });
  if (window.stickers.length === 0) throw new Error("sticker preview window is empty");
  const setDir = path.join(cacheDir, safeFileName(window.set.name, "sticker-set"));
  const visualDir = path.join(setDir, "_visual");
  mkdirSync(visualDir, { recursive: true });
  const pageKey = `${window.offset}-${window.stickers.length}`;
  const atlasPath = path.join(visualDir, `atlas-${pageKey}.png`);
  const manifestPath = path.join(visualDir, `atlas-${pageKey}.json`);
  const tempAtlasPath = `${atlasPath}.tmp-${process.pid}-${Date.now()}.png`;
  const tempManifestPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    set_name: window.set.name,
    title: window.set.title,
    sticker_count: window.set.sticker_count,
    offset: window.offset,
    stickers: window.stickers.map((sticker, position) => ({
      label: position + 1,
      index: sticker.index,
      file_unique_id: sticker.file_unique_id,
      emoji: sticker.emoji,
      preview_path: sticker.preview_path,
      preview_error: sticker.preview_error,
    })),
  };
  writeJson(tempManifestPath, manifest);
  try {
    await renderAtlas({ manifest, manifestPath: tempManifestPath, outputPath: tempAtlasPath });
    if (!existsSync(tempAtlasPath) || statSync(tempAtlasPath).size <= 0) {
      throw new Error("sticker atlas renderer produced no image");
    }
    renameSync(tempAtlasPath, atlasPath);
    renameSync(tempManifestPath, manifestPath);
  } finally {
    rmSync(tempAtlasPath, { force: true });
    rmSync(tempManifestPath, { force: true });
  }
  return {
    set: {
      name: window.set.name,
      title: window.set.title,
      sticker_type: window.set.sticker_type,
      sticker_count: window.set.sticker_count,
      refreshed_at: window.set.refreshed_at,
    },
    offset: window.offset,
    limit: window.limit,
    atlas_path: atlasPath,
    manifest_path: manifestPath,
    stickers: manifest.stickers.map((sticker) => ({
      label: sticker.label,
      index: sticker.index,
      file_unique_id: sticker.file_unique_id,
      emoji: sticker.emoji,
      ...(sticker.preview_error ? { preview_error: sticker.preview_error } : {}),
    })),
  };
}
