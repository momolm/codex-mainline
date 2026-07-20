from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


BACKGROUND = "#0F172A"
CARD = "#1E293B"
CARD_INNER = "#F8FAFC"
ACCENT = "#22D3EE"
TEXT = "#E2E8F0"
MUTED = "#94A3B8"


def font(size: int, *, bold: bool = False) -> ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def emoji_font(size: int) -> ImageFont.ImageFont:
    candidate = Path("C:/Windows/Fonts/seguiemj.ttf")
    if candidate.exists():
        return ImageFont.truetype(str(candidate), size)
    return font(size)


def load_preview(path_text: str, width: int, height: int) -> Image.Image | None:
    try:
        with Image.open(path_text) as source:
            source.seek(0)
            image = ImageOps.exif_transpose(source.convert("RGBA"))
            image.thumbnail((width, height), Image.Resampling.LANCZOS)
            return image.copy()
    except (OSError, ValueError):
        return None


def render(manifest_path: Path, output_path: Path) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    stickers = manifest.get("stickers", [])
    columns = 4
    tile_width = 232
    tile_height = 254
    margin = 28
    header_height = 96
    rows = max(1, math.ceil(len(stickers) / columns))
    width = margin * 2 + columns * tile_width
    height = header_height + margin + rows * tile_height + margin
    atlas = Image.new("RGB", (width, height), BACKGROUND)
    draw = ImageDraw.Draw(atlas)

    title = str(manifest.get("title") or manifest.get("set_name") or "Sticker Pack")
    page_start = int(manifest.get("offset", 0)) + 1
    page_end = page_start + max(0, len(stickers) - 1)
    draw.text((margin, 22), title, font=font(28, bold=True), fill=TEXT)
    draw.text(
        (margin, 61),
        f"Current order · #{page_start}–#{page_end} · choose by top-left number",
        font=font(16),
        fill=MUTED,
    )

    for position, sticker in enumerate(stickers):
        row, column = divmod(position, columns)
        left = margin + column * tile_width
        top = header_height + row * tile_height
        card = (left + 6, top + 6, left + tile_width - 8, top + tile_height - 8)
        draw.rounded_rectangle(card, radius=18, fill=CARD)

        inner = (left + 18, top + 18, left + tile_width - 20, top + 198)
        draw.rounded_rectangle(inner, radius=14, fill=CARD_INNER)
        preview = load_preview(str(sticker.get("preview_path") or ""), inner[2] - inner[0] - 16, inner[3] - inner[1] - 16)
        if preview is not None:
            x = inner[0] + (inner[2] - inner[0] - preview.width) // 2
            y = inner[1] + (inner[3] - inner[1] - preview.height) // 2
            atlas.paste(preview, (x, y), preview)
        else:
            draw.text((inner[0] + 28, inner[1] + 73), "Preview unavailable", font=font(16), fill="#64748B")

        label = int(sticker.get("label", position + 1))
        index = int(sticker.get("index", position))
        emoji = str(sticker.get("emoji") or "")
        draw.rounded_rectangle((left + 18, top + 16, left + 68, top + 58), radius=12, fill=ACCENT)
        draw.text((left + 31, top + 22), f"{label:02d}", font=font(18, bold=True), fill=BACKGROUND)
        draw.text((left + 20, top + 211), f"set #{index}", font=font(16, bold=True), fill=TEXT)
        if emoji:
            draw.text((left + tile_width - 52, top + 211), emoji, font=emoji_font(18), fill=TEXT)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(output_path, format="PNG", optimize=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: render-telegram-sticker-atlas.py <manifest.json> <output.png>")
    render(Path(sys.argv[1]), Path(sys.argv[2]))
