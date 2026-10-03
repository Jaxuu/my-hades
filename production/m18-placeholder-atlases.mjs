#!/usr/bin/env node
/**
 * M18 · one-off procedural HD placeholder atlas generator.
 *
 * WHY THIS FILE EXISTS (and why it is NOT under assets/art/tools/)
 * ----------------------------------------------------------------
 * FR-017 removes the pixel-pipeline generator (`assets/art/tools/build-atlas.py`).
 * This script is the OPPOSITE of that one: it does not derive HD art from pixel
 * source packs — it draws 128-based HD frames from scratch and encodes them with
 * `node:zlib` alone. Keeping it out of `assets/art/tools/` avoids any ambiguity
 * with "the pixel derivation tool was removed" (tasks.md T003).
 *
 * It is DELETED again in T049 once real HD art lands (see tasks.md Phase 7).
 *
 * OUTPUT (9 world atlases, one loader unit each — research.md D15)
 * ---------------------------------------------------------------
 *   assets/art/hd/player.{png,json}         4 facings x 6 actions = 24 keys / 160 frames
 *   assets/art/hd/enemy-<type>.{png,json}   6 files, 4 facings x 5 actions = 20 keys / 128 frames
 *   assets/art/hd/tiles.{png,json}          8 floor variants + 47 wall autotile parts
 *   assets/art/hd/fx.{png,json}             spark / trail / hazard ring / 3 pickups
 *
 * Every frame carries >= 4px transparent gutter (research.md D8) and every frame
 * rectangle is exactly one framePx square, which is what makes the
 * "wall pixels never leave their cell" property constructive (research.md D9).
 *
 * Usage: node production/m18-placeholder-atlases.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'assets', 'art', 'hd');

/** Transparent padding between adjacent frames (research.md D8). */
const GUTTER = 4;

// ── PNG encoder (IHDR + IDAT + IEND, RGBA8, filter 0) ─────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Tiny raster canvas ───────────────────────────────────────────────────────

class Canvas {
  constructor(width, height = width) {
    this.w = width;
    this.h = height;
    this.data = Buffer.alloc(width * height * 4, 0);
  }

  /** Source-over put with an explicit alpha. */
  put(x, y, [r, g, b], a = 255) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.w || py >= this.h || a <= 0) return;
    const i = (py * this.w + px) * 4;
    const s = a / 255;
    const d = 1 - s;
    this.data[i] = Math.round(this.data[i] * d + r * s);
    this.data[i + 1] = Math.round(this.data[i + 1] * d + g * s);
    this.data[i + 2] = Math.round(this.data[i + 2] * d + b * s);
    this.data[i + 3] = Math.min(255, Math.round(this.data[i + 3] * d + 255 * s));
  }

  rect(x, y, w, h, colour, alpha = 255) {
    for (let j = 0; j < h; j += 1) {
      for (let i = 0; i < w; i += 1) this.put(x + i, y + j, colour, alpha);
    }
  }

  ellipse(cx, cy, rx, ry, colour, alpha = 255) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.put(x, y, colour, alpha);
      }
    }
  }

  ring(cx, cy, rOuter, thickness, colour, alpha = 255) {
    const inner = rOuter - thickness;
    for (let y = Math.floor(cy - rOuter); y <= Math.ceil(cy + rOuter); y += 1) {
      for (let x = Math.floor(cx - rOuter); x <= Math.ceil(cx + rOuter); x += 1) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= rOuter && d >= inner) this.put(x, y, colour, alpha);
      }
    }
  }

  /** Clear every pixel inside an ellipse back to fully transparent. */
  eraseEllipse(cx, cy, rx, ry) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy > 1) continue;
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        const i = (y * this.w + x) * 4;
        this.data[i] = 0;
        this.data[i + 1] = 0;
        this.data[i + 2] = 0;
        this.data[i + 3] = 0;
      }
    }
  }

  /** Mirrored copy in place (used to derive the `left` facing from `right`). */
  mirrorX() {
    for (let y = 0; y < this.h; y += 1) {
      for (let x = 0; x < (this.w >> 1); x += 1) {
        const a = (y * this.w + x) * 4;
        const b = (y * this.w + (this.w - 1 - x)) * 4;
        for (let k = 0; k < 4; k += 1) {
          const tmp = this.data[a + k];
          this.data[a + k] = this.data[b + k];
          this.data[b + k] = tmp;
        }
      }
    }
  }

  /** Vertical shift by `dy` (rows move down for positive dy). */
  shiftedY(dy) {
    const out = new Canvas(this.w);
    for (let y = 0; y < this.h; y += 1) {
      const src = y - dy;
      if (src < 0 || src >= this.h) continue;
      this.data.copy(out.data, y * this.w * 4, src * this.w * 4, (src + 1) * this.w * 4);
    }
    return out;
  }

  /** Vertical squash towards the bottom edge (death collapse). */
  squashed(factor) {
    const out = new Canvas(this.w);
    const height = Math.max(1, Math.round(this.h * factor));
    const offset = this.h - height;
    for (let y = 0; y < height; y += 1) {
      const src = Math.min(this.h - 1, Math.round((y / height) * this.h));
      this.data.copy(out.data, (offset + y) * this.w * 4, src * this.w * 4, (src + 1) * this.w * 4);
    }
    return out;
  }

  silhouette() {
    const bands = 8;
    const rows = new Array(bands).fill(0);
    let opaque = 0;
    const grid = [];
    for (let gy = 0; gy < bands; gy += 1) {
      for (let gx = 0; gx < bands; gx += 1) {
        let hit = false;
        for (let y = Math.floor((gy * this.h) / bands); y < Math.floor(((gy + 1) * this.h) / bands); y += 1) {
          for (let x = Math.floor((gx * this.w) / bands); x < Math.floor(((gx + 1) * this.w) / bands); x += 1) {
            if (this.data[(y * this.w + x) * 4 + 3] > 0) {
              hit = true;
              opaque += 1;
              rows[gy] += 1;
            }
          }
        }
        grid.push(hit ? '1' : '0');
      }
    }
    return { grid: grid.join(''), rows, opaque };
  }
}

// ── Palette ──────────────────────────────────────────────────────────────────

const OUTLINE = [0x14, 0x18, 0x22];
const SKIN = [0xe8, 0xc8, 0x9a];
const CLOTH = [0x4d, 0xa3, 0xff];
const STEEL = [0xc9, 0xd4, 0xe4];
const WOOD = [0x8a, 0x63, 0x3d];
const BONE = [0xe6, 0xe1, 0xd2];
const SLIME = [0x6f, 0xc9, 0x7a];
const GOBLIN = [0x9c, 0xc4, 0x5a];
const EMBER = [0xd8, 0x5a, 0x4a];
const GHOST = [0xa9, 0xb8, 0xe6];
const VOID = [0x7a, 0x5c, 0xc8];

const CAP = [0x6b, 0x74, 0x88];
const FACE = [0x4a, 0x52, 0x66];
const SHADOW = [0x2b, 0x30, 0x40];
const BRICK_LINE = [0x39, 0x40, 0x52];
const STONE = [0x6d, 0x66, 0x59];
const STONE_DARK = [0x59, 0x53, 0x48];
const STONE_LIGHT = [0x82, 0x7a, 0x6a];

const SPARK = [0xff, 0xf1, 0xa8];
const TRAIL = [0x8f, 0xd8, 0xff];
const HAZARD = [0xff, 0x2d, 0x2d];
const GOLD = [0xff, 0xd2, 0x4d];
const HEAL = [0x4d, 0xff, 0x88];
const DARKNESS = [0xb0, 0x7d, 0xff];

// ── Actor art ────────────────────────────────────────────────────────────────

/**
 * Draw one enemy/player body. Each type gets a DISTINCT silhouette language
 * (FR-004 / SC-002: distinguishable with the colour channel removed), which is
 * what `meta.silhouettes` later proves.
 */
function drawActor(canvas, spriteId) {
  const n = canvas.w;
  const c = n / 2;
  // The dispatcher works on the BARE type (`grunt`), while ids are namespaced
  // (`enemy.grunt`) — normalise once here rather than at every comparison.
  const kind = spriteId === 'player.base' ? 'player.base' : spriteId.replace(/^enemy\./, '');
  const outline = (fn) => {
    // A cheap "draw twice, once offset in every direction" outline pass.
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
      fn(c + dx, c + dy, OUTLINE);
    }
  };
  const body = (fn) => {
    outline(fn);
    fn(c, c, null);
  };

  if (kind === 'player.base') {
    body((cx, cy, tint) => {
      const col = tint ?? CLOTH;
      canvas.ellipse(cx, cy + n * 0.30, n * 0.24, n * 0.14, tint ?? OUTLINE); // feet
      canvas.ellipse(cx, cy + n * 0.16, n * 0.26, n * 0.20, col); // torso
      canvas.ellipse(cx, cy - n * 0.14, n * 0.19, n * 0.19, tint ?? SKIN); // head
      canvas.rect(cx - n * 0.34, cy + n * 0.02, n * 0.68, n * 0.05, tint ?? STEEL); // shoulders
    });
    return;
  }
  if (kind === 'grunt') {
    // Low, wide slime blob: WIDER THAN TALL.
    body((cx, cy, tint) => {
      canvas.ellipse(cx, cy + n * 0.06, n * 0.34, n * 0.26, tint ?? SLIME);
      canvas.rect(cx - n * 0.10, cy - n * 0.34, n * 0.06, n * 0.12, tint ?? SLIME);
      canvas.rect(cx + n * 0.04, cy - n * 0.34, n * 0.06, n * 0.12, tint ?? SLIME);
    });
    return;
  }
  if (kind === 'elite') {
    // Tall humanoid with a WIDE shoulder bar (T-shape) and a helmet crest.
    body((cx, cy, tint) => {
      canvas.rect(cx - n * 0.30, cy - n * 0.06, n * 0.60, n * 0.12, tint ?? STEEL); // shoulder bar
      canvas.rect(cx - n * 0.15, cy - n * 0.06, n * 0.30, n * 0.36, tint ?? BONE); // torso
      canvas.ellipse(cx, cy - n * 0.20, n * 0.13, n * 0.13, tint ?? BONE); // skull
      canvas.rect(cx - n * 0.03, cy - n * 0.40, n * 0.06, n * 0.12, tint ?? STEEL); // crest
      canvas.rect(cx - n * 0.22, cy + n * 0.28, n * 0.16, n * 0.08, tint ?? BONE); // feet
      canvas.rect(cx + n * 0.06, cy + n * 0.28, n * 0.16, n * 0.08, tint ?? BONE);
    });
    return;
  }
  if (kind === 'raider') {
    // Lean, leaning body with a LONG DIAGONAL BLADE: strongly asymmetric.
    body((cx, cy, tint) => {
      canvas.ellipse(cx, cy + n * 0.06, n * 0.18, n * 0.26, tint ?? GOBLIN); // lean torso
      canvas.ellipse(cx, cy - n * 0.24, n * 0.13, n * 0.13, tint ?? GOBLIN); // head
      for (let i = 0; i < n * 0.46; i += 1) {
        canvas.rect(cx + n * 0.12 + i * 0.7, cy - n * 0.02 - i * 0.7, 3, 3, tint ?? STEEL);
      }
    });
    return;
  }
  if (kind === 'bomber') {
    // Round body ringed with spikes.
    body((cx, cy, tint) => {
      canvas.ellipse(cx, cy + n * 0.02, n * 0.26, n * 0.26, tint ?? EMBER);
      for (let a = 0; a < 12; a += 1) {
        const angle = (a / 12) * Math.PI * 2;
        const x = cx + Math.cos(angle) * n * 0.34;
        const y = cy + Math.sin(angle) * n * 0.34;
        canvas.rect(x - 2, y - 2, 4, 4, tint ?? EMBER);
      }
    });
    return;
  }
  if (kind === 'gunner') {
    // Tall body + a LONG HORIZONTAL BARREL extending far to the right.
    body((cx, cy, tint) => {
      canvas.ellipse(cx - n * 0.06, cy + n * 0.04, n * 0.19, n * 0.30, tint ?? GHOST);
      canvas.ellipse(cx - n * 0.06, cy - n * 0.26, n * 0.13, n * 0.13, tint ?? GHOST);
      canvas.rect(cx + n * 0.02, cy - n * 0.04, n * 0.46, n * 0.08, tint ?? STEEL); // barrel
    });
    return;
  }
  // unknown: amorphous blob with irregular bumps and a HOLLOW centre.
  body((cx, cy, tint) => {
    canvas.ellipse(cx, cy, n * 0.30, n * 0.30, tint ?? VOID);
    for (let a = 0; a < 8; a += 1) {
      const angle = (a / 8) * Math.PI * 2 + 0.4;
      canvas.ellipse(
        cx + Math.cos(angle) * n * 0.30,
        cy + Math.sin(angle) * n * 0.30,
        n * 0.08,
        n * 0.08,
        tint ?? VOID,
      );
    }
    canvas.eraseEllipse(cx, cy, n * 0.13, n * 0.13); // punch the hollow centre
  });
}

/** Facing/action variation applied ON TOP of the base body. */
function actorFrame(spriteId, action, facing, index, count) {
  const bare = spriteId === 'player.base' ? 'player.base' : spriteId.replace(/^enemy\./, '');
  const size =
    bare === 'player.base' ? 128 : bare === 'elite' ? 160 : bare === 'raider' || bare === 'gunner' ? 128 : 96;
  const base = new Canvas(size);
  drawActor(base, spriteId);

  // `left` is the mirrored `right`; `down`/`up` differ only by the face dots.
  let canvas = base;
  if (facing === 'left') {
    canvas = new Canvas(size);
    base.data.copy(canvas.data);
    canvas.mirrorX();
  }

  const n = size;
  const bob = action === 'idle' ? (index % 2 === 0 ? 0 : -1) : action === 'move' ? (index % 2 === 0 ? -1 : 1) : 0;
  let frame = bob === 0 ? canvas : canvas.shiftedY(bob);

  if (facing === 'up') {
    // Erase the face: a 2px horizontal "visor" line in the head area.
    for (let x = Math.round(n * 0.38); x < n * 0.62; x += 1) {
      for (let y = Math.round(n * 0.30); y < n * 0.36; y += 1) {
        const i = (y * n + x) * 4;
        frame.data[i] = 0;
        frame.data[i + 1] = 0;
        frame.data[i + 2] = 0;
        frame.data[i + 3] = 0;
      }
    }
  }

  if (action === 'dash') {
    frame = frame.shiftedY(0);
    for (let x = 0; x < Math.round(n * 0.22); x += 1) {
      for (let y = 0; y < n; y += 1) {
        const i = (y * n + x) * 4 + 3;
        frame.data[i] = Math.round(frame.data[i] * 0.35);
      }
    }
  } else if (action === 'attack') {
    // Frames 2-3 are the HIT phase: push the body forward and flare it.
    const phase = index <= 1 ? -3 : index <= 3 ? 4 : 1;
    frame = frame.shiftedY(0);
    if (phase > 0) {
      for (let y = 0; y < n; y += 1) {
        for (let x = n - phase; x < n; x += 1) {
          const i = (y * n + x) * 4 + 3;
          frame.data[i] = Math.round(frame.data[i] * 0.5);
        }
      }
    }
  } else if (action === 'hit') {
    frame = index >= count - 1 ? frame.shiftedY(2) : frame.shiftedY(-2);
  } else if (action === 'death') {
    const t = count <= 1 ? 1 : index / (count - 1);
    frame = frame.squashed(1 - 0.75 * t);
  }

  return frame;
}

// ── Tiles ────────────────────────────────────────────────────────────────────

/** Deterministic 32-bit hash — the floor variant selector must never be random. */
function hash2(x, y) {
  let h = (x * 0x1f1f1f1f) ^ (y * 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return (h ^ (h >>> 13)) >>> 0;
}

function drawFloorVariant(size, variant) {
  const c = new Canvas(size);
  c.rect(0, 0, size, size, STONE);
  // Mortar grid: every variant shifts the joints so large areas do not read as
  // one repeated stamp.
  const step = 32;
  const offset = (variant * 7) % step;
  for (let x = offset; x < size; x += step) c.rect(x, 0, 2, size, STONE_DARK);
  for (let y = (offset * 3) % step; y < size; y += step) c.rect(0, y, size, 2, STONE_DARK);
  // Speckle: deterministic, so two builds of the same room agree cell by cell.
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 2) {
      const h = hash2(x + variant * 977, y);
      if (h % 11 === 0) c.rect(x, y, 2, 2, STONE_LIGHT);
      else if (h % 13 === 0) c.rect(x, y, 2, 2, STONE_DARK);
    }
  }
  return c;
}

/** Canonical 8-neighbour blob mask (the 47-tile set, research.md D9). */
function canonicalMask(mask) {
  const N = mask & 1;
  const NE = mask & 2;
  const E = mask & 4;
  const SE = mask & 8;
  const S = mask & 16;
  const SW = mask & 32;
  const W = mask & 64;
  const NW = mask & 128;
  let out = N | E | S | W;
  if (N !== 0 && E !== 0 && NE !== 0) out |= 2;
  if (E !== 0 && S !== 0 && SE !== 0) out |= 8;
  if (S !== 0 && W !== 0 && SW !== 0) out |= 32;
  if (W !== 0 && N !== 0 && NW !== 0) out |= 128;
  return out;
}

/** The 47 canonical masks, ascending — index i is the part named `tile.wall.p<i>`. */
const CANONICAL_MASKS = (() => {
  const set = new Set();
  for (let m = 0; m < 256; m += 1) set.add(canonicalMask(m));
  return [...set].sort((a, b) => a - b);
})();

/**
 * One wall part: the SAME three bands in every part, with the mask only shaping
 * the exposed edges. Because the bands are baked into a single 128x128 frame the
 * part can never project outside its cell (research.md D9 / W1-W2), and the
 * renderer still needs exactly ONE sprite per cell — so the scene graph does not
 * grow (research.md D10).
 */
function drawWallPart(size, mask) {
  const c = new Canvas(size);
  const capH = Math.round(size * 0.55);
  const faceH = Math.round(size * 0.43);
  c.rect(0, 0, size, capH, CAP);
  c.rect(0, capH, size, faceH, FACE);
  c.rect(0, capH + faceH, size, size - capH - faceH, SHADOW);

  // Brick coursing on the face band (reads as masonry).
  for (let y = capH + 8; y < capH + faceH; y += 14) c.rect(0, y, size, 2, BRICK_LINE);
  for (let x = 0; x < size; x += 26) {
    c.rect(x, capH, 2, faceH, BRICK_LINE);
    c.rect(x + 13, capH + 8, 2, faceH - 8, BRICK_LINE);
  }

  const N = (mask & 1) !== 0;
  const E = (mask & 4) !== 0;
  const S = (mask & 16) !== 0;
  const W = (mask & 64) !== 0;
  // Exposed edges get a highlight; connected edges get a shadow seam, so the
  // 47 parts are all visibly different while keeping cap > face > shadow.
  if (!N) c.rect(0, 0, size, 3, STONE_LIGHT);
  else c.rect(0, 0, size, 2, BRICK_LINE);
  if (!W) c.rect(0, 0, 3, size, STONE_LIGHT);
  if (!E) c.rect(size - 3, 0, 3, size, BRICK_LINE);
  if (!S) c.rect(0, size - 4, size, 4, [0x1c, 0x20, 0x2b]);
  if (N && W) c.rect(0, 0, 8, 8, BRICK_LINE);
  if (N && E) c.rect(size - 8, 0, 8, 8, BRICK_LINE);
  if (S && W) c.rect(0, size - 8, 8, 8, BRICK_LINE);
  if (S && E) c.rect(size - 8, size - 8, 8, 8, BRICK_LINE);
  return c;
}

// ── FX ───────────────────────────────────────────────────────────────────────

function drawFx(size, kind) {
  const c = new Canvas(size);
  const mid = size / 2;
  if (kind === 'fx.spark') {
    c.ellipse(mid, mid, size * 0.12, size * 0.12, SPARK);
    c.rect(mid - 1, mid - size * 0.42, 3, size * 0.84, SPARK);
    c.rect(mid - size * 0.42, mid - 1, size * 0.84, 3, SPARK);
  } else if (kind === 'fx.dash-trail') {
    for (let i = 0; i < size; i += 1) {
      const h = Math.max(2, Math.round((1 - i / size) * size * 0.34));
      c.rect(i, mid - h / 2, 1, h, TRAIL, Math.round(40 + 215 * (i / size)));
    }
  } else if (kind === 'fx.hazard-ring') {
    // HOLLOW: the centre is empty, which is the shape language of "run away".
    c.ring(mid, mid, size * 0.46, size * 0.10, HAZARD);
  } else if (kind === 'fx.pickup.gold') {
    // SOLID blob: the centre is filled, the shape language of "pick me up".
    c.ellipse(mid, mid, size * 0.34, size * 0.34, GOLD);
  } else if (kind === 'fx.pickup.heal') {
    c.rect(mid - size * 0.20, mid - size * 0.06, size * 0.40, size * 0.36, HEAL); // body
    c.rect(mid - size * 0.07, mid - size * 0.34, size * 0.14, size * 0.28, HEAL); // neck
    c.rect(mid - size * 0.12, mid - size * 0.40, size * 0.24, size * 0.08, HEAL); // cap
  } else if (kind === 'fx.pickup.darkness') {
    for (let y = 0; y < size; y += 1) {
      const half = Math.max(0, Math.round(size * 0.36 * (1 - Math.abs(y - mid) / mid)));
      c.rect(mid - half, y, half * 2, 1, DARKNESS);
    }
  }
  return c;
}

// ── Atlas assembly ───────────────────────────────────────────────────────────

/**
 * Pack `frames` (each an n x n Canvas) into a grid with `GUTTER` px between
 * cells, then emit the PNG plus the PixiJS spritesheet JSON.
 */
function packAtlas(name, frameSize, frames, metaExtra = {}, extraAnimations = {}) {
  const cell = frameSize + GUTTER;
  const maxSide = 2048;
  const cols = Math.max(1, Math.floor(maxSide / cell));
  const rows = Math.ceil(frames.length / cols);
  const width = cols * cell;
  const height = rows * cell;

  const sheet = new Canvas(width, height);

  const jsonFrames = {};
  const silhouettes = {};
  frames.forEach((entry, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = col * cell;
    const y = row * cell;
    // Row-by-row: the frame canvas and the atlas have different strides.
    for (let r = 0; r < frameSize; r += 1) {
      entry.canvas.data.copy(
        sheet.data,
        ((y + r) * width + x) * 4,
        r * frameSize * 4,
        (r + 1) * frameSize * 4,
      );
    }
    jsonFrames[entry.name] = {
      frame: { x, y, w: frameSize, h: frameSize },
      sourceSize: { w: frameSize, h: frameSize },
      spriteSourceSize: { x: 0, y: 0, w: frameSize, h: frameSize },
    };
    if (entry.silhouette !== undefined) silhouettes[entry.silhouette] = entry.canvas.silhouette();
  });

  const animations = {};
  for (const entry of frames) {
    const key = entry.animation;
    if (key === undefined) continue;
    if (animations[key] === undefined) animations[key] = [];
    animations[key].push(entry.name);
  }
  // Explicit aliases (the enemy `dash` -> `move` alias, research.md D6).
  for (const [key, value] of Object.entries(extraAnimations)) {
    animations[key] = [...value];
  }

  const json = {
    animations,
    frames: jsonFrames,
    meta: {
      app: 'my-hades m18-placeholder-atlases.mjs',
      format: 'RGBA8888',
      image: `${name}.png`,
      scale: 1,
      size: { w: width, h: height },
      ...metaExtra,
    },
  };
  if (Object.keys(silhouettes).length > 0) json.meta.silhouettes = silhouettes;

  writeFileSync(resolve(OUT_DIR, `${name}.png`), encodePng(width, height, sheet.data));
  writeFileSync(resolve(OUT_DIR, `${name}.json`), `${JSON.stringify(json, null, 1)}\n`);
  return { name, width, height, frames: frames.length };
}

const FACINGS = ['down', 'up', 'left', 'right'];

function buildActorFrames(spriteId, actions) {
  const out = [];
  for (const [action, count] of actions) {
    for (const facing of FACINGS) {
      const animation = `${spriteId}.${action}.${facing}`;
      for (let i = 0; i < count; i += 1) {
        out.push({
          name: `${animation}.${i}`,
          animation,
          canvas: actorFrame(spriteId, action, facing, i, count),
          silhouette: action === 'idle' && facing === 'down' && i === 0 ? spriteId : undefined,
        });
      }
    }
  }
  return out;
}

const PLAYER_ACTIONS = [
  ['idle', 8],
  ['move', 8],
  ['dash', 6],
  ['attack', 6],
  ['hit', 4],
  ['death', 8],
];

const ENEMY_ACTIONS = [
  ['idle', 8],
  ['move', 8],
  ['attack', 6],
  ['hit', 4],
  ['death', 6],
];

const ENEMY_TYPES = ['grunt', 'elite', 'raider', 'bomber', 'gunner', 'unknown'];
const ENEMY_FRAME_PX = { grunt: 96, elite: 160, raider: 128, bomber: 96, gunner: 128, unknown: 96 };

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const report = [];

  // Player ------------------------------------------------------------------
  report.push(packAtlas('player', 128, buildActorFrames('player.base', PLAYER_ACTIONS), { tilePx: 128 }));

  // Enemies -----------------------------------------------------------------
  for (const type of ENEMY_TYPES) {
    const spriteId = `enemy.${type}`;
    const frames = buildActorFrames(spriteId, ENEMY_ACTIONS);
    // `dash` aliases `move` (research.md D6): the SAME frame names, zero extra art.
    const aliases = {};
    for (const facing of FACINGS) {
      aliases[`${spriteId}.dash.${facing}`] = frames
        .filter((f) => f.animation === `${spriteId}.move.${facing}`)
        .map((f) => f.name);
    }
    report.push(
      packAtlas(`enemy-${type}`, ENEMY_FRAME_PX[type], frames, { tilePx: 128 }, aliases),
    );
  }

  // Tiles -------------------------------------------------------------------
  const tileFrames = [];
  for (let v = 0; v < 8; v += 1) {
    tileFrames.push({
      name: `tile.floor.${v}`,
      animation: 'tile.floor',
      canvas: drawFloorVariant(128, v),
    });
  }
  CANONICAL_MASKS.forEach((mask, index) => {
    tileFrames.push({
      name: `tile.wall.p${index}`,
      animation: `tile.wall.p${index}`,
      canvas: drawWallPart(128, mask),
    });
  });
  // `tile.wall` is the id-level animation (the same-name lookup) and doubles as
  // the fallback part for any mask that somehow resolves to nothing.
  tileFrames.push({ name: 'tile.wall.0', animation: 'tile.wall', canvas: drawWallPart(128, 0) });
  report.push(packAtlas('tiles', 128, tileFrames, { tilePx: 128 }));

  // FX ----------------------------------------------------------------------
  const fxFrames = [];
  // Every fx frame is the atlas cell size so the packer never reads past a
  // canvas edge; the renderer scales each decal to its own drawn size.
  for (const kind of [
    'fx.spark',
    'fx.dash-trail',
    'fx.hazard-ring',
    'fx.pickup.gold',
    'fx.pickup.heal',
    'fx.pickup.darkness',
  ]) {
    const canvas = drawFx(128, kind);
    fxFrames.push({ name: `${kind}.0`, animation: kind, canvas, silhouette: kind });
  }
  // The damage numerals stay PixiJS `Text` (the frozen juice suites pin them),
  // so no glyph atlas is produced here — see production/m18-evidence.md.
  report.push(packAtlas('fx', 128, fxFrames, {}));

  for (const r of report) {
    console.log(`${r.name}: ${r.frames} frames, ${r.width}x${r.height}`);
  }
}

main();
