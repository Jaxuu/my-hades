/**
 * A minimal, dependency-free PNG decoder for the render tests (M18).
 *
 * WHY THIS EXISTS
 * ---------------
 * Two M18 acceptance criteria are PIXEL claims, not structural ones:
 *
 *   - T032 / FR-008: a wall part's opaque pixels must not leave its own cell;
 *   - T033 / FR-010: a wall part's pixels must not project onto a walkable cell.
 *
 * A frame-RECTANGLE check cannot express either (a rectangle is inside itself by
 * definition), so the tests need the actual alpha channel. Adding an image library
 * would violate the project's zero-runtime-dependency rule for a test-only need, and
 * `node:zlib` is already in the standard library — so the ~60 lines below are the
 * honest cheapest option.
 *
 * SUPPORTED SUBSET: 8-bit RGBA (colour type 6), no interlacing — exactly what
 * `production/m18-placeholder-atlases.mjs` emits. Anything else throws loudly rather
 * than returning silently wrong pixels.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA bytes, `width * height * 4` long. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Undo the per-scanline filters (PNG spec §9). */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x] ?? 0;
      const a = x >= bpp ? (out[dst + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[up + x] ?? 0) : 0;
      const c = y > 0 && x >= bpp ? (out[up + x - bpp] ?? 0) : 0;
      let restored: number;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + a;
      else if (filter === 2) restored = value + b;
      else if (filter === 3) restored = value + ((a + b) >> 1);
      else if (filter === 4) restored = value + paeth(a, b, c);
      else throw new Error(`unsupported PNG filter type ${String(filter)}`);
      out[dst + x] = restored & 0xff;
    }
  }
  return out;
}

/** Decode an 8-bit RGBA, non-interlaced PNG into raw RGBA bytes. */
export function decodePng(path: string): DecodedPng {
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error(`${path} is not a PNG`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colourType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
    throw new Error(
      `${path}: unsupported PNG (bitDepth=${String(bitDepth)} colourType=${String(colourType)} interlace=${String(interlace)})`,
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const pixels = unfilter(raw, width, height, 4);
  return { width, height, rgba: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length) };
}

/** The RGBA of one pixel. */
export function pixelAt(png: DecodedPng, x: number, y: number): readonly [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.rgba[i] ?? 0, png.rgba[i + 1] ?? 0, png.rgba[i + 2] ?? 0, png.rgba[i + 3] ?? 0];
}

/** Relative luminance of one pixel (0..255), alpha-weighted over white. */
export function luminanceAt(png: DecodedPng, x: number, y: number): number {
  const [r, g, b, a] = pixelAt(png, x, y);
  const alpha = a / 255;
  const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return value * alpha + 255 * (1 - alpha);
}

/** Mean luminance over a rectangle, or `undefined` when it has no pixels. */
export function meanLuminance(
  png: DecodedPng,
  x: number,
  y: number,
  w: number,
  h: number,
): number | undefined {
  let total = 0;
  let count = 0;
  for (let j = y; j < y + h; j += 1) {
    for (let i = x; i < x + w; i += 1) {
      if (i < 0 || j < 0 || i >= png.width || j >= png.height) continue;
      total += luminanceAt(png, i, j);
      count += 1;
    }
  }
  return count === 0 ? undefined : total / count;
}

/**
 * True when every pixel of a rectangle is fully transparent.
 *
 * An out-of-bounds rectangle THROWS rather than returning `true`. That matters: the
 * gutter check asks "is the strip between two frames empty?", and a strip that fell
 * off the edge of the image would otherwise report "empty" without having looked at
 * a single pixel — a silent vacuous pass in the one assertion that guards mipmap
 * bleeding. A probe that leaves the image is a test bug, and it should be loud.
 */
export function isTransparent(
  png: DecodedPng,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  if (x < 0 || y < 0 || x + w > png.width || y + h > png.height) {
    throw new RangeError(
      `rect (${String(x)},${String(y)},${String(w)},${String(h)}) leaves the ${String(png.width)}x${String(png.height)} image`,
    );
  }
  for (let j = y; j < y + h; j += 1) {
    for (let i = x; i < x + w; i += 1) {
      if ((pixelAt(png, i, j)[3] ?? 0) > 0) return false;
    }
  }
  return true;
}

/**
 * The 8x8 coverage grid, the 8-band opaque-pixel row profile and the opaque total of
 * a rectangle — the SAME algorithm `production/m18-placeholder-atlases.mjs` uses to
 * fill `meta.silhouettes`.
 *
 * It lives here so the shape tests can recompute a silhouette from the PNG's actual
 * alpha channel and compare it against the declared metadata, instead of trusting the
 * declaration. Without that cross-check, a generator that wrote stale metadata would
 * pass every distinctness assertion while shipping the wrong art.
 */
export interface Silhouette {
  readonly grid: string;
  readonly rows: readonly number[];
  readonly opaque: number;
}

export function silhouetteOf(
  png: DecodedPng,
  x: number,
  y: number,
  w: number,
  h: number,
  bands = 8,
): Silhouette {
  const rows: number[] = new Array<number>(bands).fill(0);
  const grid: string[] = [];
  let opaque = 0;
  for (let gy = 0; gy < bands; gy += 1) {
    const y0 = y + Math.floor((gy * h) / bands);
    const y1 = y + Math.floor(((gy + 1) * h) / bands);
    for (let gx = 0; gx < bands; gx += 1) {
      const x0 = x + Math.floor((gx * w) / bands);
      const x1 = x + Math.floor(((gx + 1) * w) / bands);
      let hit = false;
      for (let j = y0; j < y1; j += 1) {
        for (let i = x0; i < x1; i += 1) {
          if ((pixelAt(png, i, j)[3] ?? 0) > 0) {
            hit = true;
            opaque += 1;
            rows[gy] = (rows[gy] ?? 0) + 1;
          }
        }
      }
      grid.push(hit ? '1' : '0');
    }
  }
  return { grid: grid.join(''), rows, opaque };
}
