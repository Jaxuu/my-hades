#!/usr/bin/env python3
"""build-atlas.py — regenerate `assets/art/atlas/*.{png,json}` from the CC0 sources.

WHY THIS FILE IS COMMITTED
--------------------------
`assets/art/atlas/*` is the ONLY art the game imports, but it is a DERIVED
artifact: every pixel comes from a Kenney CC0 sheet (see `../LICENSES.md`) plus a
small, explicitly documented set of PROCEDURAL transforms defined below. Committing
the generator is what makes the atlas reproducible and auditable — a reviewer can
diff "what we claim to have done to the source" against "what the code does".

It is a BUILD-TIME tool. It needs `Pillow` and the extracted source sheets under
`assets/art/raw/**`; it is NOT part of `npm run build` and introduces no runtime
dependency (the constitution forbids runtime deps outside pixi.js/howler).

WHAT IT PRODUCES
----------------
    atlas/player.png  + .json   44 frames   player.base.<action>.<facing>.<n>
    atlas/enemies.png + .json  264 frames   enemy.<type>.<action>.<facing>.<n>
    atlas/tiles.png   + .json    2 frames   tile.floor / tile.wall
    atlas/fx.png      + .json    3 frames   fx.spark / fx.dash-trail / fx.hazard-ring
    atlas/ui.png      + .json    3 frames   ui.icon.gold / .heal / .darkness
    ui/*.png                    11 images   CSS-consumed panels, frames, buttons,
                                            overlays (9-slice friendly)

    + `assets/audio/sfx/*.ogg` are copied from the CC0 audio packs by
      `copy-sfx` (same script, different sub-command).

FRAME NAMING (the contract the renderer depends on)
---------------------------------------------------
An animation is addressed by `<spriteId>.<action>.<facing>` — exactly the
`SpriteSelection` of specs/024-real-assets/contracts/renderer-asset-mapping.md §2.
Frames inside it are `<animation>.<n>`, and the spritesheet JSON declares the
`animations` map explicitly, so no name-mangling convention has to hold.

PROCEDURAL TRANSFORMS (the honest part)
---------------------------------------
Kenney's Tiny Dungeon characters are drawn FRONT-FACING only, one still per
character. FR-002/003 need four facings and at least a two-frame cycle, so the
generator DERIVES them:

  facing   derivation
  -------  -----------------------------------------------------------------
  down     the source tile, unmodified
  up       `erase_face` — the face box is painted over with the head colour, so
           the character reads as seen from behind (standard pixel-art shorthand)
  right    `shift_head(+2)` — the top rows are nudged 2px right (head turned)
  left     `mirror` + `shift_head(-2)`

  action   derivation (applied to the facing frame `f`)
  -------  -----------------------------------------------------------------
  idle     [f, shift(f, 0, +1)]            a 1px breathe
  move     [f, shift(f, 0, -1)]            a 1px walk bob
  dash     [shift(f, +2·dir), f]           a 2px lunge along the facing
  attack   [f, shift(f, +1·dir)]           a 1px lean along the facing
  hit      [f]                             single frame — the tint carries the hit
  death    [f, squash(f)]                  a 2px vertical squash

Every one of those is recorded as a `modifications` entry in `../LICENSES.md`.
The base pixels are real CC0 art; the derivations are ours.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - tooling guard
    sys.exit("build-atlas.py needs Pillow: python -m pip install Pillow")

REPO = Path(__file__).resolve().parents[3]
RAW = REPO / "assets" / "art" / "raw"
ATLAS = REPO / "assets" / "art" / "atlas"
UI_OUT = REPO / "assets" / "art" / "ui"
SFX_OUT = REPO / "assets" / "audio" / "sfx"
SFX_RAW = REPO / "assets" / "audio" / "raw"

TILE = 16
HEAD_ROWS = 7
# How far the head slides for the `left` / `right` facings. Large enough to read
# at gameplay scale (the sprite is drawn at ~10px on screen), small enough that the
# head never separates from the shoulders.
HEAD_TURN_PX = 3
# The face box erased for the `up` facing, in tile-local pixels. Conservative on
# purpose: it must cover the eyes of every character/monster tile without eating
# the silhouette outline.
FACE_BOX = (5, 4, 11, 9)

# --------------------------------------------------------------------------- #
# Source sheets                                                                #
# --------------------------------------------------------------------------- #

TINY_DUNGEON = RAW / "tiny-dungeon" / "tilemap_packed.png"
TINY_DUNGEON_COLS = 12

# Tile indices into the Tiny Dungeon 12x11 packed sheet (row-major). Chosen by
# inspecting the sheet: see ../LICENSES.md for the mapping rationale.
PLAYER_TILE = 87  # winged-helm knight: warm body, reads against grey stone
ENEMY_TILES = {
    "grunt": 108,   # green slime  — round blob
    "elite": 109,   # skeleton     — ribbed humanoid
    "raider": 112,  # goblin       — small humanoid, headband
    "bomber": 110,  # red crab     — wide body, two claws
    "gunner": 121,  # ghost        — tall, wavy hem
    "unknown": 122,  # spider      — generic monster fallback
}
FLOOR_TILE = 49  # clean tan flagstone: tiles seamlessly, contrasts with grey walls
WALL_TILE = 40   # grey stone brick run: tiles seamlessly, reads as solid masonry

ACTIONS = (
    ("idle", 2),
    ("move", 2),
    ("dash", 2),
    ("attack", 2),
    ("hit", 1),
    ("death", 2),
)
FACINGS = ("down", "up", "left", "right")

FACING_DIR = {"down": (0, 1), "up": (0, -1), "left": (-1, 0), "right": (1, 0)}


# --------------------------------------------------------------------------- #
# Pixel helpers                                                                #
# --------------------------------------------------------------------------- #


def blank(size: int = TILE) -> Image.Image:
    return Image.new("RGBA", (size, size), (0, 0, 0, 0))


def shift(img: Image.Image, dx: int, dy: int) -> Image.Image:
    """Translate the whole sprite by `(dx, dy)` px, keeping the canvas size."""
    out = blank(img.size[0])
    out.alpha_composite(img, (dx, dy))
    return out


def shift_head(img: Image.Image, dx: int) -> Image.Image:
    """Translate the TOP `HEAD_ROWS` rows by `dx` px, leaving the body in place."""
    out = img.copy()
    w, h = img.size
    head = img.crop((0, 0, w, HEAD_ROWS))
    body = img.crop((0, HEAD_ROWS, w, h))
    out = blank(w)
    out.alpha_composite(shift(head, dx, 0), (0, 0))
    out.alpha_composite(body, (0, HEAD_ROWS))
    return out


def mirror(img: Image.Image) -> Image.Image:
    return img.transpose(Image.FLIP_LEFT_RIGHT)


def squash(img: Image.Image) -> Image.Image:
    """A 2px vertical squash anchored at the feet — the death 'collapse'."""
    w, h = img.size
    squashed = img.resize((w, h - 2), Image.NEAREST)
    out = blank(w)
    out.alpha_composite(squashed, (0, 2))
    return out


def head_color(img: Image.Image) -> tuple[int, int, int, int]:
    """The most common opaque colour in the head rows — the 'back of head' fill."""
    counts: dict[tuple[int, int, int, int], int] = {}
    for y in range(0, HEAD_ROWS):
        for x in range(img.size[0]):
            px = img.getpixel((x, y))
            if px[3] < 128:
                continue
            counts[px] = counts.get(px, 0) + 1
    if not counts:
        return (0, 0, 0, 0)
    return max(counts.items(), key=lambda kv: kv[1])[0]


def erase_face(img: Image.Image) -> Image.Image:
    """Paint the face box over with the head colour -> reads as the BACK of the head."""
    out = img.copy()
    fill = head_color(img)
    if fill[3] == 0:
        return out
    x0, y0, x1, y1 = FACE_BOX
    for y in range(y0, y1):
        for x in range(x0, x1):
            if out.getpixel((x, y))[3] < 128:
                continue
            out.putpixel((x, y), fill)
    return out


def facing_frame(base: Image.Image, facing: str) -> Image.Image:
    if facing == "down":
        return base.copy()
    if facing == "up":
        return erase_face(base)
    if facing == "right":
        return shift_head(base, HEAD_TURN_PX)
    return shift_head(mirror(base), -HEAD_TURN_PX)


def action_frames(frame: Image.Image, action: str, facing: str) -> list[Image.Image]:
    dx, dy = FACING_DIR[facing]
    if action == "idle":
        return [frame, shift(frame, 0, 1)]
    if action == "move":
        return [frame, shift(frame, 0, -1)]
    if action == "dash":
        return [shift(frame, dx * 2, dy * 2), frame]
    if action == "attack":
        return [frame, shift(frame, dx, dy)]
    if action == "hit":
        return [frame]
    if action == "death":
        return [frame, squash(frame)]
    raise ValueError(f"unknown action {action}")


# --------------------------------------------------------------------------- #
# Source sheets                                                                #
# --------------------------------------------------------------------------- #


def tile_from_sheet(sheet: Image.Image, cols: int, index: int, pitch: int = 16) -> Image.Image:
    """Crop tile `index` (row-major) out of a packed sheet with no spacing."""
    r, c = divmod(index, cols)
    return sheet.crop((c * pitch, r * pitch, c * pitch + TILE, r * pitch + TILE)).convert("RGBA")


# --------------------------------------------------------------------------- #
# Procedural art (fx + pickup icons)                                           #
# --------------------------------------------------------------------------- #

# Palette sampled from the Tiny Dungeon sheet so the procedural pieces sit in the
# same colour family as the imported ones.
INK = (26, 22, 34, 255)
GOLD = (255, 205, 74, 255)
GOLD_HI = (255, 240, 170, 255)
GOLD_LO = (196, 132, 30, 255)
HEAL = (226, 62, 74, 255)
HEAL_HI = (255, 150, 150, 255)
GLASS = (214, 236, 246, 255)
DARK = (170, 118, 226, 255)
DARK_HI = (226, 190, 255, 255)
SPARK_HI = (255, 248, 200, 255)
SPARK_LO = (255, 176, 64, 255)


def icon_coin() -> Image.Image:
    """GOLD — a filled disc with an inner ring. Round, solid: 'walk towards me'."""
    im = blank()
    px = im.load()
    cx = cy = 7.5
    for y in range(TILE):
        for x in range(TILE):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if d <= 6.4:
                px[x, y] = INK
            if d <= 5.6:
                px[x, y] = GOLD_LO
            if d <= 4.6:
                px[x, y] = GOLD
            if 2.4 <= d <= 3.2:
                px[x, y] = GOLD_LO
    for (x, y) in ((5, 4), (6, 4), (5, 5)):
        px[x, y] = GOLD_HI
    return im


def icon_flask() -> Image.Image:
    """HEAL — a narrow-necked flask. Tall silhouette: distinct from the disc."""
    im = blank()
    px = im.load()
    for y in range(TILE):
        for x in range(TILE):
            if 6 <= x <= 9 and 1 <= y <= 3:
                px[x, y] = INK
            if 6 <= x <= 9 and 2 <= y <= 3:
                px[x, y] = GLASS
            if 4 <= x <= 11 and 4 <= y <= 12:
                d = ((x - 7.5) ** 2 / 20.0 + (y - 9.0) ** 2 / 12.0) ** 0.5
                if d <= 1.35:
                    px[x, y] = INK
                if d <= 1.1:
                    px[x, y] = HEAL
                if d <= 0.55:
                    px[x, y] = HEAL_HI
    return im


def icon_gem() -> Image.Image:
    """DARKNESS — a faceted rhombus. Angular silhouette: distinct from disc+flask."""
    im = blank()
    px = im.load()
    for y in range(TILE):
        for x in range(TILE):
            # |x-7.5|/6 + |y-7.5|/6 <= 1 -> a diamond
            if abs(x - 7.5) / 6.2 + abs(y - 7.5) / 6.2 <= 1.0:
                px[x, y] = INK
            if abs(x - 7.5) / 5.4 + abs(y - 7.5) / 5.4 <= 1.0:
                px[x, y] = DARK
    for y in range(TILE):
        for x in range(TILE):
            if px[x, y] == DARK and x + y < 10:
                px[x, y] = DARK_HI
    return im


def icon_spark() -> Image.Image:
    """A 4-ray star: the hit spark."""
    im = blank()
    px = im.load()
    cx = cy = 7
    for (dx, dy, col) in (
        (0, 0, SPARK_HI),
        (1, 0, SPARK_HI), (-1, 0, SPARK_HI), (0, 1, SPARK_HI), (0, -1, SPARK_HI),
        (2, 0, SPARK_LO), (-2, 0, SPARK_LO), (0, 2, SPARK_LO), (0, -2, SPARK_LO),
        (1, 1, SPARK_LO), (-1, 1, SPARK_LO), (1, -1, SPARK_LO), (-1, -1, SPARK_LO),
        (3, 0, SPARK_LO), (-3, 0, SPARK_LO), (0, 3, SPARK_LO), (0, -3, SPARK_LO),
    ):
        x, y = cx + dx, cy + dy
        if 0 <= x < TILE and 0 <= y < TILE:
            px[x, y] = col
    return im


def icon_dash_trail() -> Image.Image:
    """A soft horizontal streak with a fading tail: the dash wake."""
    im = blank()
    px = im.load()
    for y in range(TILE):
        for x in range(TILE):
            if not (6 <= y <= 9):
                continue
            # taper towards the left (the tail) and at the vertical edges
            span = 11 - abs(y - 7.5) * 2.2
            if x < 4 or x > 4 + span:
                continue
            t = (x - 4) / max(1.0, span)
            px[x, y] = SPARK_LO if t < 0.6 else SPARK_HI
    return im


def icon_hazard_ring(size: int = 64) -> Image.Image:
    """A hollow ring — the danger telegraph's shape language (vs the solid coin)."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = im.load()
    cx = cy = (size - 1) / 2
    outer = size / 2 - 1
    inner = outer - 3
    for y in range(size):
        for x in range(size):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if inner <= d <= outer:
                px[x, y] = (255, 255, 255, 255)
    return im


# --------------------------------------------------------------------------- #
# Packing + spritesheet JSON                                                   #
# --------------------------------------------------------------------------- #


class Packer:
    """A trivial shelf packer. The atlas is small and fixed, so no heuristic."""

    def __init__(self, width: int, height: int) -> None:
        self.width = width
        self.height = height
        self.x = 0
        self.y = 0
        self.row_h = 0
        self.rects: dict[str, tuple[int, int, int, int]] = {}

    def add(self, name: str, img: Image.Image) -> None:
        w, h = img.size
        if self.x + w > self.width:
            self.x = 0
            self.y += self.row_h
            self.row_h = 0
        if self.y + h > self.height:
            raise RuntimeError(f"atlas overflow while packing {name}")
        self.rects[name] = (self.x, self.y, w, h)
        self.x += w
        self.row_h = max(self.row_h, h)


def silhouette(img: Image.Image, cells: int = 8) -> dict:
    """A COLOUR-INDEPENDENT shape signature of one frame.

    FR-017 requires the three pickup icons to stay distinguishable with the colour
    channel removed ("应拾取" vs "应躲避", and gold vs heal vs darkness). Proving
    that needs the PIXELS, and the render tests run in node with no image decoder —
    so the generator measures the alpha channel here and records the result in the
    sheet JSON. Two descriptors are recorded, both derived purely from coverage:

      `grid`  — an `cells x cells` binarised coverage map ("is any of this cell
                filled?"). Distinguishes a diamond from a disc from a flask.
      `rows`  — the opaque-pixel COUNT of each of the 16 rows. A finer, ordered
                profile: two shapes can share a coarse grid and still differ here.

    Both are alpha-only, so they are identical for a shape and its greyscale
    rendering — which is exactly what "去色后仍可区分" means.
    """
    alpha = img.split()[3]
    w, h = img.size
    grid = []
    for gy in range(cells):
        for gx in range(cells):
            box = (gx * w // cells, gy * h // cells, (gx + 1) * w // cells, (gy + 1) * h // cells)
            region = alpha.crop(box)
            covered = sum(region.histogram()[128:])
            grid.append('1' if covered > 0 else '0')
    rows = []
    for y in range(h):
        rows.append(sum(alpha.crop((0, y, w, y + 1)).histogram()[128:]))
    return {"opaque": sum(rows), "grid": ''.join(grid), "rows": rows}


def build_atlas(
    out_name: str,
    groups: dict[str, list[Image.Image]],
    size: int,
) -> None:
    """Pack `groups` (animation name -> frames) and write `<out_name>.png/.json`.

    Frame names are `<animation>.<n>`; the `animations` map is written explicitly
    so the renderer can address an animation by name without parsing frame names.
    """
    packer = Packer(size, size)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    frames: dict[str, dict] = {}
    animations: dict[str, list[str]] = {}
    silhouettes: dict[str, dict] = {}

    for anim, imgs in groups.items():
        names: list[str] = []
        for i, img in enumerate(imgs):
            frame_name = f"{anim}.{i}"
            packer.add(frame_name, img)
            x, y, w, h = packer.rects[frame_name]
            canvas.alpha_composite(img, (x, y))
            frames[frame_name] = {
                "frame": {"x": x, "y": y, "w": w, "h": h},
                "sourceSize": {"w": w, "h": h},
                "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
            }
            names.append(frame_name)
        animations[anim] = names
        silhouettes[anim] = silhouette(imgs[0])

    png_path = ATLAS / f"{out_name}.png"
    json_path = ATLAS / f"{out_name}.json"
    canvas.save(png_path)
    json_path.write_text(
        json.dumps(
            {
                "frames": frames,
                "animations": animations,
                "meta": {
                    "app": "my-hades build-atlas.py",
                    "format": "RGBA8888",
                    "image": f"{out_name}.png",
                    "scale": 1,
                    "size": {"w": size, "h": size},
                    "silhouettes": silhouettes,
                },
            },
            indent=1,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    print(f"  {out_name}.png  {size}x{size}  {len(frames)} frames  "
          f"{png_path.stat().st_size / 1024:.1f} KB")


def character_groups(base: Image.Image) -> dict[str, list[Image.Image]]:
    groups: dict[str, list[Image.Image]] = {}
    for facing in FACINGS:
        f = facing_frame(base, facing)
        for action, _ in ACTIONS:
            groups[f"{action}.{facing}"] = action_frames(f, action, facing)
    return groups


def prefix(groups: dict[str, list[Image.Image]], sprite_id: str) -> dict[str, list[Image.Image]]:
    return {f"{sprite_id}.{anim}": imgs for anim, imgs in groups.items()}


# --------------------------------------------------------------------------- #
# UI pieces (CSS-consumed standalone images)                                   #
# --------------------------------------------------------------------------- #


def ui_sources() -> dict[str, Path]:
    base = RAW / "fantasy-ui-borders" / "PNG" / "Default"
    pixel = RAW / "kenney_pixel-ui-pack" / "9-Slice"
    return {
        "panel-hud": base / "Panel" / "panel-002.png",
        "panel-reward": base / "Panel" / "panel-000.png",
        "panel-camp": base / "Panel" / "panel-004.png",
        "frame-reward-card": base / "Border" / "panel-border-000.png",
        "frame-talent-card": base / "Border" / "panel-border-004.png",
        "button-primary": base / "Border" / "panel-border-018.png",
        "overlay-death": base / "Panel" / "panel-003.png",
        "overlay-win": base / "Panel" / "panel-001.png",
        "slot": pixel / "space.png",
        "slot-inlay": pixel / "space_inlay.png",
        "bar": base / "Divider" / "divider-000.png",
    }


def copy_ui() -> None:
    UI_OUT.mkdir(parents=True, exist_ok=True)
    for name, src in ui_sources().items():
        if not src.exists():
            raise SystemExit(f"missing UI source {src}")
        shutil.copyfile(src, UI_OUT / f"{name}.png")
    print(f"  ui/*.png  {len(ui_sources())} images")


# --------------------------------------------------------------------------- #
# Audio                                                                        #
# --------------------------------------------------------------------------- #

SFX_MAP = {
    "hit": ("kenney_rpg-audio", "knifeSlice.ogg"),
    "dash": ("kenney_digital-audio", "phaserUp1.ogg"),
    "coin": ("kenney_rpg-audio", "handleCoins.ogg"),
    "enemy-death": ("kenney_digital-audio", "spaceTrash1.ogg"),
    "hazard-blast": ("kenney_digital-audio", "lowRandom.ogg"),
    "ui-click": ("kenney_ui-audio", "click1.ogg"),
    "reward-select": ("kenney_digital-audio", "powerUp1.ogg"),
    "death": ("kenney_digital-audio", "lowDown.ogg"),
    "win": ("kenney_digital-audio", "threeTone1.ogg"),
}


def copy_sfx() -> None:
    SFX_OUT.mkdir(parents=True, exist_ok=True)
    for name, (pack, filename) in SFX_MAP.items():
        src = SFX_RAW / pack / "Audio" / filename
        if not src.exists():
            raise SystemExit(f"missing sfx source {src}")
        shutil.copyfile(src, SFX_OUT / f"{name}.ogg")
    total = sum(p.stat().st_size for p in SFX_OUT.glob("*.ogg"))
    print(f"  sfx/*.ogg  {len(SFX_MAP)} files  {total / 1024:.1f} KB")


# --------------------------------------------------------------------------- #
# Entry point                                                                  #
# --------------------------------------------------------------------------- #


def build_art() -> None:
    if not TINY_DUNGEON.exists():
        raise SystemExit(f"missing source sheet {TINY_DUNGEON}")
    ATLAS.mkdir(parents=True, exist_ok=True)
    sheet = Image.open(TINY_DUNGEON).convert("RGBA")

    player = tile_from_sheet(sheet, TINY_DUNGEON_COLS, PLAYER_TILE)
    build_atlas("player", prefix(character_groups(player), "player.base"), 256)

    enemies: dict[str, list[Image.Image]] = {}
    for enemy_type, index in ENEMY_TILES.items():
        base = tile_from_sheet(sheet, TINY_DUNGEON_COLS, index)
        enemies.update(prefix(character_groups(base), f"enemy.{enemy_type}"))
    build_atlas("enemies", enemies, 512)

    build_atlas(
        "tiles",
        {
            "tile.floor": [tile_from_sheet(sheet, TINY_DUNGEON_COLS, FLOOR_TILE)],
            "tile.wall": [tile_from_sheet(sheet, TINY_DUNGEON_COLS, WALL_TILE)],
        },
        64,
    )

    build_atlas(
        "fx",
        {
            "fx.spark": [icon_spark()],
            "fx.dash-trail": [icon_dash_trail()],
            "fx.hazard-ring": [icon_hazard_ring(64)],
        },
        128,
    )

    build_atlas(
        "ui",
        {
            "ui.icon.gold": [icon_coin()],
            "ui.icon.heal": [icon_flask()],
            "ui.icon.darkness": [icon_gem()],
        },
        64,
    )

    copy_ui()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=["all", "art", "sfx"],
        nargs="?",
        default="all",
    )
    args = parser.parse_args()
    if args.command in ("all", "art"):
        print("building atlases")
        build_art()
    if args.command in ("all", "sfx"):
        print("copying sfx")
        copy_sfx()
    print("done")


if __name__ == "__main__":
    main()
