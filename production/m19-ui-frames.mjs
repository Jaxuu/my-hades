#!/usr/bin/env node
/**
 * M19 · procedural HD UI nine-slice frame generator.
 *
 * WHY THIS FILE EXISTS (and why it is NOT under assets/art/tools/)
 * ---------------------------------------------------------------
 * Feature `027-hud-boon-ui` upgrades the DOM HUD from plain text readouts to a
 * MATERIALISED HD interface. Six of the new surfaces are `border-image` nine-slice
 * frames and one is a divider rule; all seven are drawn here, from scratch, with
 * `node:zlib` alone (no image library, no runtime dependency — the repository keeps
 * its zero-dependency rule for tooling).
 *
 * It is the UI sibling of `production/m18-placeholder-atlases.mjs`: same hand-rolled
 * PNG encoder, same "draw from scratch, never derive from a source pack" stance, so
 * every byte it writes is original to this repository and registers as CC0. Keeping
 * it out of `assets/art/tools/` also avoids any ambiguity with the removed pixel
 * derivation tool (tasks.md T003).
 *
 * THE ONE THING THAT MUST NOT BE GOT WRONG
 * ----------------------------------------
 * `index.html` draws these with `border-image` + `border-image-slice: 12`, NEVER with
 * `background-size: 100% 100%` — stretching a 48px frame across a panel smears its
 * corners into huge bars (the T048 defect). Every frame here is therefore a 48x48
 * image whose CENTRE 24x24 region is FULLY TRANSPARENT and whose decoration lives in
 * the 12px corners and edge strips, so the nine-slice geometry survives any
 * border-width (10 / 12 / 14 px are all used by the feature).
 *
 * QUALITY COLOUR IS BAKED INTO THE LINES
 * --------------------------------------
 * When `border-image-source` is not `none` the browser does NOT paint `border-color`,
 * so a pure white stencil (the M16 approach) would hide the rarity colour entirely.
 * The three boon frames therefore bake their rarity hue into the line work — blue for
 * common, purple for epic, gold for legendary — and differ in LINE COUNT and CORNER
 * MOTIF as well, so the three stay distinguishable with the colour channel removed
 * (design/ui-art-direction.md §2.2 / §4.4).
 *
 * STONE FRAMES STAY IN THE M16 FAMILY
 * -----------------------------------
 * `frame-health` / `frame-dash` / `panel-status` keep the M16 language (48x48, slice
 * 12, double rule + bracketed corners, transparent centre) and bake the stone /
 * parchment tones so the frame reads as the same chiselled material as the world art
 * (§1.3). `rule-bronze` is a thin bronze divider consumed with an explicit
 * `background-size` (it is not a nine-slice).
 *
 * Output (48x48 RGBA8 PNG, one file per `--ui-*` slot):
 *   assets/art/ui/frame-health.png
 *   assets/art/ui/frame-dash.png
 *   assets/art/ui/frame-boon-common.png
 *   assets/art/ui/frame-boon-epic.png
 *   assets/art/ui/frame-boon-legendary.png
 *   assets/art/ui/panel-status.png
 *   assets/art/ui/rule-bronze.png
 *
 * Usage: node production/m19-ui-frames.mjs        (idempotent: byte-identical reruns)
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'assets', 'art', 'ui');

/** Nine-slice frame edge. 48 = 2 * 12 * 2, i.e. two full corner cells per axis. */
const SIZE = 48;
/** Must equal `border-image-slice: 12` in `index.html`; corners/edges are 12px. */
const SLICE = 12;
/** The centre that `border-image` discards. Asserted transparent before writing. */
const CENTRE_LO = SLICE;
const CENTRE_HI = SIZE - SLICE - 1;

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
  ihdr[9] = 6; // colour type: RGBA (matches assets/art/ui/slot.png)
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

  /** Source-over put with an explicit alpha. Alpha 255 writes the colour exactly. */
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

  hline(y, x0, x1, colour, alpha = 255) {
    for (let x = x0; x <= x1; x += 1) this.put(x, y, colour, alpha);
  }

  vline(x, y0, y1, colour, alpha = 255) {
    for (let y = y0; y <= y1; y += 1) this.put(x, y, colour, alpha);
  }

  /** 1px rectangle outline `inset` px from every edge. */
  strokeRect(inset, colour, alpha = 255) {
    const s = this.w - 1;
    this.hline(inset, inset, s - inset, colour, alpha);
    this.hline(s - inset, inset, s - inset, colour, alpha);
    this.vline(inset, inset, s - inset, colour, alpha);
    this.vline(s - inset, inset, s - inset, colour, alpha);
  }

  /** Bresenham line — used for corner miters and diamond edges. */
  line(x0, y0, x1, y1, colour, alpha = 255) {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.put(x, y, colour, alpha);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Hollow diamond (rotated square) of "radius" r centred on (cx, cy). */
  diamond(cx, cy, r, colour, alpha = 255) {
    this.line(cx, cy - r, cx + r, cy, colour, alpha);
    this.line(cx + r, cy, cx, cy + r, colour, alpha);
    this.line(cx, cy + r, cx - r, cy, colour, alpha);
    this.line(cx - r, cy, cx, cy - r, colour, alpha);
  }

  /** Archimedean spiral — the "laurel scroll" corner of the legendary frame. */
  spiral(cx, cy, maxR, turns, colour, alpha = 255) {
    const steps = Math.max(24, Math.round(turns * 2 * Math.PI * maxR));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const ang = t * turns * 2 * Math.PI;
      const r = t * maxR;
      this.put(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, colour, alpha);
    }
  }
}

// ── Palette (all hues derived from the frozen index.html palette) ─────────────

/** Stone / parchment (M16 family). `--parchment #e8d9b8`, `--parchment-dim #b9a982`. */
const STONE = {
  base: [0xb9, 0xa9, 0x82],
  bright: [0xe8, 0xd9, 0xb8],
  deep: [0x6b, 0x62, 0x50],
};

/** Rarity hues (design §2.1). Baked into the lines so border-image cannot hide them. */
const RARITY = {
  common: { base: [0x3f, 0x6e, 0xa8], bright: [0x7f, 0xb0, 0xe6], deep: [0x1c, 0x33, 0x50] },
  epic: { base: [0x8a, 0x5c, 0xd0], bright: [0xc9, 0xa4, 0xff], deep: [0x3d, 0x2a, 0x63] },
  legendary: { base: [0xff, 0xcd, 0x4a], bright: [0xff, 0xf0, 0xb8], deep: [0x8a, 0x6a, 0x1e] },
};

/** Bronze rule (design §7 `--ui-rule`). */
const BRONZE = {
  base: [0xb9, 0x8a, 0x3c],
  bright: [0xe6, 0xc3, 0x7a],
  deep: [0x5c, 0x44, 0x18],
};

// ── Frame construction ───────────────────────────────────────────────────────

/**
 * Directional bevel: 1px highlight on the top/left edge, 1px shadow on the
 * bottom/right, drawn one pixel OUTSIDE the outer line. This is the "chiselled out
 * of stone, lit from the top-left" rule (design §1.3) and keeps the highlight <= 1px.
 */
function bevel(canvas, outerInset, bright, deep) {
  const i = outerInset - 1;
  const s = canvas.w - 1 - i;
  canvas.hline(i, i, s, bright); // top
  canvas.vline(i, i, s, bright); // left
  canvas.hline(canvas.w - 1 - i, i, s, deep); // bottom
  canvas.vline(canvas.w - 1 - i, i, s, deep); // right
}

/**
 * Build a nine-slice frame from N concentric 1px rules plus a corner motif.
 * `insets` are 1px offsets from the edge (outermost first); every inset stays <
 * SLICE so the centre stays clear.
 */
function buildFrame({ insets, palette, corner }) {
  const c = new Canvas(SIZE);
  for (const inset of insets) c.strokeRect(inset, palette.base);
  bevel(c, insets[0], palette.bright, palette.deep);
  corner(c, { insets, palette });
  assertCentreClear(c);
  return c;
}

/**
 * Stone frames: the concentric rules are joined at each corner by 45° miters, so the
 * corner reads as one bracketed joint rather than N floating rectangles (M16 family).
 */
function cornerMiter(canvas, { insets, palette }) {
  const s = canvas.w - 1;
  for (let k = 0; k + 1 < insets.length; k += 1) {
    const a = insets[k];
    const b = insets[k + 1];
    canvas.line(a, a, b, b, palette.base);
    canvas.line(s - a, a, s - b, b, palette.base);
    canvas.line(a, s - a, b, s - b, palette.base);
    canvas.line(s - a, s - a, s - b, s - b, palette.base);
  }
}

/** Common: single rule + a solid right-angle block at each corner. */
function cornerAngle(canvas, { insets, palette }) {
  const s = canvas.w - 1;
  const o = insets[0];
  for (const [cx, cy] of [
    [o, o],
    [s - o, o],
    [o, s - o],
    [s - o, s - o],
  ]) {
    canvas.rect(cx - 1, cy - 1, 3, 3, palette.base);
  }
}

/** Epic: double rule + a bright diamond notch biting into each corner. */
function cornerDiamond(canvas, { insets, palette }) {
  const s = canvas.w - 1;
  const o = insets[0];
  const cx = o + 2;
  const cy = o + 2;
  const r = 2;
  canvas.diamond(cx, cy, r, palette.bright);
  canvas.diamond(s - cx, cy, r, palette.bright);
  canvas.diamond(cx, s - cy, r, palette.bright);
  canvas.diamond(s - cx, s - cy, r, palette.bright);
}

/** Legendary: triple rule + a bright laurel scroll curl in each corner. */
function cornerScroll(canvas, { insets, palette }) {
  const s = canvas.w - 1;
  const o = insets[0];
  const cx = o + 3;
  const cy = o + 3;
  for (const [x, y] of [
    [cx, cy],
    [s - cx, cy],
    [cx, s - cy],
    [s - cx, s - cy],
  ]) {
    canvas.spiral(x, y, 3, 1.5, palette.bright);
    canvas.put(x, y, palette.deep); // darker eye so the curl reads at small sizes
  }
}

/**
 * Bronze divider rule: a centred horizontal band with a 1px highlight, a bronze core
 * and a 1px shadow, transparent everywhere else. It is consumed with an explicit
 * `background-size` (see production/m19-ui-volume.md), never as a nine-slice.
 */
function buildRule() {
  const c = new Canvas(SIZE);
  const top = Math.round(SIZE / 2) - 3; // 6px band, vertically centred
  c.hline(top, 0, SIZE - 1, BRONZE.bright);
  c.rect(0, top + 1, SIZE, 4, BRONZE.base);
  c.hline(top + 5, 0, SIZE - 1, BRONZE.deep);
  return c;
}

/** The nine-slice contract: the centre the browser discards MUST be transparent. */
function assertCentreClear(canvas) {
  for (let y = CENTRE_LO; y <= CENTRE_HI; y += 1) {
    for (let x = CENTRE_LO; x <= CENTRE_HI; x += 1) {
      if (canvas.data[(y * canvas.w + x) * 4 + 3] !== 0) {
        throw new Error(`nine-slice centre is not transparent at (${x},${y})`);
      }
    }
  }
}

// ── The seven slots ──────────────────────────────────────────────────────────

const FRAMES = [
  {
    file: 'frame-health.png',
    draw: () => buildFrame({ insets: [4, 8], palette: STONE, corner: cornerMiter }),
  },
  {
    file: 'frame-dash.png',
    draw: () => buildFrame({ insets: [4, 8], palette: STONE, corner: cornerMiter }),
  },
  {
    file: 'frame-boon-common.png',
    draw: () => buildFrame({ insets: [3], palette: RARITY.common, corner: cornerAngle }),
  },
  {
    file: 'frame-boon-epic.png',
    draw: () => buildFrame({ insets: [2, 6], palette: RARITY.epic, corner: cornerDiamond }),
  },
  {
    file: 'frame-boon-legendary.png',
    draw: () => buildFrame({ insets: [2, 5, 8], palette: RARITY.legendary, corner: cornerScroll }),
  },
  {
    file: 'panel-status.png',
    // Heavier than the HUD pair so the Tab plate reads as a panel, not a bar frame.
    draw: () => buildFrame({ insets: [3, 6, 9], palette: STONE, corner: cornerMiter }),
  },
  {
    file: 'rule-bronze.png',
    draw: () => buildRule(),
  },
];

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const report = [];
  for (const spec of FRAMES) {
    const canvas = spec.draw();
    const bytes = encodePng(canvas.w, canvas.h, canvas.data);
    writeFileSync(resolve(OUT_DIR, spec.file), bytes);
    report.push({ file: spec.file, bytes: bytes.length });
  }
  for (const r of report) {
    console.log(`${r.file.padEnd(28)} ${String(r.bytes).padStart(5)} bytes  48x48 RGBA8`);
  }
  console.log(`${'TOTAL'.padEnd(28)} ${String(report.reduce((n, r) => n + r.bytes, 0)).padStart(5)} bytes`);
}

main();
