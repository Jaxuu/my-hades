/**
 * License + artifact audit (specs/026-hd-2d-art-assets T012, SC-013 / SC-014).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * `tests/assets/manifest.test.ts` checks the DECLARATION (ids, licenses, and that
 * every id appears in a `LICENSES.md`). This file checks the ARTIFACTS on disk —
 * the half a declaration can lie about:
 *
 *   - every spritesheet the manifest references exists as a real PNG whose pixels
 *     are big enough for the frame rectangles the JSON claims;
 *   - the atlas set stays inside the M18 budget (per file, per atlas, atlas count);
 *   - adjacent frames keep a >= 4px transparent gutter (mipmap bleeding);
 *   - `tiles.json`'s `meta.tilePx` equals `GameRenderer.TILE_NATURAL_PX`;
 *   - every source pack kept under `assets/**\/raw/` ships a `License.txt` that
 *     actually says CC0;
 *   - no license file mentions a proprietary tier or a commercial game publisher.
 *
 * WHAT M18 CHANGED (and why it is not a weakening — research.md R8)
 * -----------------------------------------------------------------
 * The pre-M18 form of this file encoded the PIXEL PIPELINE's shape, and that
 * pipeline is what M18 removes:
 *
 *   - "every spritesheet source is `X.png` + a same-directory `X.json`" — the HD
 *     atlases pair by EXPLICIT `SHEET_DATA` keys instead (contract §7), and the
 *     old rule would have been satisfied only by a naming accident.
 *   - "`raw/` keeps >= 5 pixel source packs" — those packs are deleted by FR-018,
 *     so the premise is gone. It is replaced by a LICENSE-REGISTRY COMPLETENESS
 *     assertion, which is strictly about the thing the rule existed to protect.
 *   - "single file <= 1 MB / total <= 6 MB" — HD frame sequences cannot fit those
 *     numbers (FR-024 authorises a re-set budget), so the numbers are re-stated AND
 *     two new same-strength ceilings are added (per-atlas pixels, atlas count) so
 *     the relaxation cannot degenerate into "no limit" (VR-24).
 *
 * The rectangle-in-bounds assertion is KEPT verbatim in strength — it is the one
 * old rule whose premise (a frame must fit its image) is pipeline-independent.
 *
 * The PNG header is parsed by hand rather than with an image library: adding a
 * runtime dependency to a test to read two integers would violate the project's
 * zero-dependency rule for no benefit.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MANIFEST, MANIFEST_IDS, SHEET_DATA, isHdWorldArt } from '../../client/assets/manifest';
import { TILE_NATURAL_PX } from '../../client/GameRenderer';

const REPO_ROOT = process.cwd();
const ART_DIR = resolve(REPO_ROOT, 'assets/art');
/**
 * Where an art file may live, in priority order. `hd/` is first because M18's world
 * atlases live there and a legacy `atlas/player.png` (the pixel atlas, deleted by
 * T044) would otherwise shadow them by basename.
 */
const ART_SEARCH_DIRS = [
  resolve(ART_DIR, 'hd'),
  resolve(ART_DIR, 'ui'),
  resolve(ART_DIR, 'atlas'),
];
const RAW_DIRS = [
  resolve(REPO_ROOT, 'assets/art/raw'),
  resolve(REPO_ROOT, 'assets/audio/raw'),
];

/** M18 budget (research.md D3 / contract §6). */
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_ATLAS_PX = 4096;
const MAX_ATLAS_COUNT = 12;
const MIN_GUTTER_PX = 4;

/** Width/height from a PNG's IHDR chunk (bytes 16..24), no image library needed. */
function pngSize(path: string): { readonly w: number; readonly h: number } {
  const bytes = readFileSync(path);
  const signature = bytes.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`${path} is not a PNG (bad signature)`);
  }
  const chunkType = bytes.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    throw new Error(`${path} has no IHDR chunk`);
  }
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

/** Every file under `dir`, recursively, as absolute paths. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** Locate the on-disk art file whose basename matches a manifest `source`. */
function artFileFor(source: string): string | undefined {
  const basename = source.split(/[\\/]/).pop() ?? '';
  if (basename.length === 0) return undefined;
  for (const dir of ART_SEARCH_DIRS) {
    const hit = walk(dir).find((path) => path.endsWith(`/${basename}`) || path.endsWith(`\\${basename}`));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function readLicenseFiles(): string {
  return [
    readFileSync(resolve(REPO_ROOT, 'assets/art/LICENSES.md'), 'utf8'),
    readFileSync(resolve(REPO_ROOT, 'assets/audio/LICENSES.md'), 'utf8'),
  ].join('\n');
}

describe('atlas artifacts exist and match their declared frames', () => {
  it('resolves every spritesheet entry to a real, non-empty PNG', () => {
    const sheets = MANIFEST_IDS.filter((id) => MANIFEST[id]?.kind === 'spritesheet');
    expect(sheets.length).toBeGreaterThan(0);
    for (const id of sheets) {
      const entry = MANIFEST[id];
      const path = artFileFor(entry?.source ?? '');
      expect(path, `no PNG on disk for ${id}`).toBeDefined();
      if (path === undefined) continue;
      expect(statSync(path).size).toBeGreaterThan(0);
      // Contract §7.1: the id -> sheet association is EXPLICIT, not a filename
      // convention. `SHEET_DATA` is that statement, so a missing key is a defect.
      expect(SHEET_DATA[id], `${id} has no declared sheet data`).toBeDefined();
    }
  });

  it('keeps every declared frame INSIDE the PNG it points at', () => {
    // A frame rectangle that runs off the atlas renders as a blank or torn
    // sprite at run time and passes every type check — the only place it is
    // catchable is here.
    for (const id of MANIFEST_IDS) {
      const data = SHEET_DATA[id];
      if (data === undefined) continue;
      const entry = MANIFEST[id];
      const path = artFileFor(entry?.source ?? '');
      if (path === undefined) continue;
      const { w, h } = pngSize(path);
      for (const [name, frame] of Object.entries(data.frames)) {
        expect(frame.frame.x + frame.frame.w, `${id}:${name} exceeds atlas width`).toBeLessThanOrEqual(w);
        expect(frame.frame.y + frame.frame.h, `${id}:${name} exceeds atlas height`).toBeLessThanOrEqual(h);
      }
    }
  });

  it('keeps adjacent frames at least 4px apart, so mipmaps cannot bleed', () => {
    // Two frames that touch (or overlap) share texels at the low mip levels, which
    // paints a visible seam between tiles and a halo around a sprite. The check is
    // on the SEPARATING axis only: two frames whose x-ranges overlap are separated
    // by their vertical gap, and vice versa.
    //
    // Scope: HD WORLD art only. The gutter exists because those textures mipmap
    // (contract §6); the retained UI sheet samples `nearest` with no mipmaps, so
    // its frames may pack edge to edge — and they do.
    for (const id of MANIFEST_IDS) {
      if (!isHdWorldArt(id)) continue;
      const data = SHEET_DATA[id];
      if (data === undefined) continue;
      const rects = Object.entries(data.frames).map(([name, frame]) => ({
        name,
        x: frame.frame.x,
        y: frame.frame.y,
        w: frame.frame.w,
        h: frame.frame.h,
      }));
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const a = rects[i];
          const b = rects[j];
          if (a === undefined || b === undefined) continue;
          const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
          const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
          if (dx < 0 && dy < 0) {
            throw new Error(`${id}: frames ${a.name} and ${b.name} overlap`);
          }
          if (dx < 0) expect(dy, `${id}: ${a.name}/${b.name} vertical gutter`).toBeGreaterThanOrEqual(MIN_GUTTER_PX);
          else if (dy < 0) expect(dx, `${id}: ${a.name}/${b.name} horizontal gutter`).toBeGreaterThanOrEqual(MIN_GUTTER_PX);
        }
      }
    }
  });
});

describe('the atlas set stays inside the M18 budget (SC-014 / VR-24)', () => {
  it('keeps every art file under the single-file ceiling', () => {
    let largest = 0;
    for (const path of walk(ART_DIR)) {
      largest = Math.max(largest, statSync(path).size);
    }
    expect(largest).toBeLessThanOrEqual(MAX_FILE_BYTES);
  });

  it('keeps the whole art tree under the total ceiling', () => {
    let total = 0;
    for (const path of walk(ART_DIR)) total += statSync(path).size;
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });

  it('caps each atlas pixel size and the atlas count', () => {
    // VR-24: relaxing the byte ceilings is only allowed together with equivalent
    // structural ceilings, or the budget degrades into "no budget".
    const atlases = new Map<string, { readonly w: number; readonly h: number }>();
    for (const id of MANIFEST_IDS) {
      if (MANIFEST[id]?.kind !== 'spritesheet') continue;
      const path = artFileFor(MANIFEST[id]?.source ?? '');
      if (path === undefined || atlases.has(path)) continue;
      atlases.set(path, pngSize(path));
    }
    expect(atlases.size).toBeGreaterThan(0);
    expect(atlases.size).toBeLessThanOrEqual(MAX_ATLAS_COUNT);
    for (const [path, size] of atlases) {
      expect(size.w, `${path} width`).toBeLessThanOrEqual(MAX_ATLAS_PX);
      expect(size.h, `${path} height`).toBeLessThanOrEqual(MAX_ATLAS_PX);
    }
  });

  it('pins the tile base: tiles.json meta.tilePx === TILE_NATURAL_PX (and both are 128)', () => {
    // The literal is the point: a cross-check against a constant the implementation
    // also owns is only half a check, so the constant itself is pinned too.
    expect(TILE_NATURAL_PX).toBe(128);
    const tiles = SHEET_DATA['tile.floor'];
    expect(tiles).toBeDefined();
    expect(tiles?.meta.tilePx).toBe(TILE_NATURAL_PX);
  });
});

describe('source packs keep their upstream CC0 text', () => {
  it('ships a CC0 License.txt with every pack kept under raw/', () => {
    for (const raw of RAW_DIRS) {
      if (!existsSync(raw)) continue;
      for (const name of readdirSync(raw)) {
        const dir = join(raw, name);
        if (!statSync(dir).isDirectory()) continue;
        const license = join(dir, 'License.txt');
        expect(existsSync(license), `pack ${name} keeps no License.txt`).toBe(true);
        const text = readFileSync(license, 'utf8');
        expect(text.toLowerCase(), `pack ${name} is not CC0`).toContain('cc0');
      }
    }
  });

  it('never mentions a proprietary or "all rights reserved" tier', () => {
    for (const raw of RAW_DIRS) {
      if (!existsSync(raw)) continue;
      for (const name of readdirSync(raw)) {
        const license = join(raw, name, 'License.txt');
        if (!existsSync(license)) continue;
        const text = readFileSync(license, 'utf8');
        expect(text).not.toMatch(/all rights reserved/i);
        expect(text).not.toMatch(/proprietary/i);
      }
    }
  });
});

describe('the license registry stays in step with the manifest', () => {
  it('names every pack the raw tree actually keeps', () => {
    const combined = readLicenseFiles();
    for (const raw of RAW_DIRS) {
      if (!existsSync(raw)) continue;
      for (const name of readdirSync(raw)) {
        if (!statSync(join(raw, name)).isDirectory()) continue;
        // Pack directory names are the vendor's own slug, e.g. `tiny-dungeon`.
        const slug = name.replace(/^kenney_/, '').replace(/_/g, '-');
        expect(combined.toLowerCase(), `pack ${name} is not registered`).toContain(slug.toLowerCase());
      }
    }
  });

  it('replaces the retired "raw/ keeps >= 5 packs" rule with registry completeness', () => {
    // The old rule existed to stop the audit from passing vacuously. Its premise
    // (pixel source packs are archived in `raw/`) is removed by FR-018, so the
    // replacement must protect the same thing by a stronger route: EVERY id has a
    // traceable row, and the registry explicitly accounts for the retired pipeline.
    const combined = readLicenseFiles();
    const missing = MANIFEST_IDS.filter((id) => !combined.includes(`\`${id}\``));
    expect(missing).toEqual([]);
    expect(combined).toMatch(/build-atlas/);
  });

  it('never mentions a commercial game or publisher (FR-023 bottom line)', () => {
    const text = readLicenseFiles();
    const publishers = [
      /Supergiant/i,
      /Nintendo/i,
      /Square ?Enix/i,
      /Capcom/i,
      /Blizzard/i,
      /Riot Games/i,
      /Ubisoft/i,
      /Electronic Arts/i,
      /Bethesda/i,
      /FromSoftware/i,
      /Konami/i,
      /Bandai Namco/i,
      /CD Projekt/i,
    ];
    for (const pattern of publishers) {
      expect(text, `registry mentions ${String(pattern)}`).not.toMatch(pattern);
    }
  });
});

describe('the HD art tree replaces the pixel pipeline (SC-008)', () => {
  it('no longer keeps the pixel atlas, the pixel generator or the pixel source packs', () => {
    // SC-008's "residual count = 0", scoped by research.md D19 to the in-scope world
    // art. `assets/art/ui/**` and `assets/audio/**` are RETAINED by FR-030 and are
    // therefore not counted here — the exclusion is explicit, not silent.
    expect(existsSync(resolve(ART_DIR, 'atlas'))).toBe(false);
    expect(existsSync(resolve(ART_DIR, 'raw'))).toBe(false);
    expect(existsSync(resolve(ART_DIR, 'tools', 'build-atlas.py'))).toBe(false);
    // FR-030's retained half really is retained.
    expect(existsSync(resolve(ART_DIR, 'ui'))).toBe(true);
  });

  it('keeps the nine world HD atlases and no longer references the pixel atlas', () => {
    const hd = walk(resolve(ART_DIR, 'hd')).filter((path) => extname(path) === '.png');
    expect(hd.length).toBe(9);
    for (const id of MANIFEST_IDS) {
      const entry = MANIFEST[id];
      if (entry === undefined || entry.kind !== 'spritesheet') continue;
      if (id.startsWith('ui.')) continue;
      expect(entry.source, `${id} still points at the pixel atlas`).not.toContain('art/atlas');
    }
  });
});
