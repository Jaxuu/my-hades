/**
 * License + artifact audit (specs/024-real-art-assets SC-010, T031).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * `tests/assets/manifest.test.ts` checks the DECLARATION (ids, licenses, and that
 * every id appears in a `LICENSES.md`). This file checks the ARTIFACTS on disk —
 * the half a declaration can lie about:
 *
 *   - every spritesheet the manifest references exists as a real PNG whose pixels
 *     are big enough for the frame rectangles the JSON claims;
 *   - every source pack kept under `assets/**\/raw/` ships a `License.txt` that
 *     actually says CC0 (SC-010's "traceable", verified against the upstream text
 *     rather than against our own summary of it);
 *   - no license file mentions a proprietary tier.
 *
 * The PNG header is parsed by hand rather than with an image library: adding a
 * runtime dependency to a test to read two integers would violate the project's
 * zero-dependency rule for no benefit.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MANIFEST, MANIFEST_IDS, SHEET_DATA } from '../../client/assets/manifest';

const REPO_ROOT = process.cwd();
const ATLAS_DIR = resolve(REPO_ROOT, 'assets/art/atlas');
const RAW_DIRS = [
  resolve(REPO_ROOT, 'assets/art/raw'),
  resolve(REPO_ROOT, 'assets/audio/raw'),
];

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

describe('atlas artifacts exist and match their declared frames', () => {
  it('has a PNG and a JSON for every spritesheet source, both non-empty', () => {
    const sources = new Set(
      MANIFEST_IDS.filter((id) => MANIFEST[id]?.kind === 'spritesheet').map((id) => {
        const source = MANIFEST[id]?.source ?? '';
        // The Vite URL is opaque; the atlas is identified by its basename.
        return source.split(/[\\/]/).pop() ?? '';
      }),
    );
    expect(sources.size).toBeGreaterThan(0);
    for (const file of sources) {
      const png = join(ATLAS_DIR, file);
      expect(existsSync(png), `missing atlas ${file}`).toBe(true);
      expect(statSync(png).size).toBeGreaterThan(0);
      expect(existsSync(png.replace(/\.png$/, '.json'))).toBe(true);
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
      const file = (entry?.source ?? '').split(/[\\/]/).pop() ?? '';
      const { w, h } = pngSize(join(ATLAS_DIR, file));
      for (const [name, frame] of Object.entries(data.frames)) {
        expect(frame.frame.x + frame.frame.w, `${id}:${name} exceeds atlas width`).toBeLessThanOrEqual(w);
        expect(frame.frame.y + frame.frame.h, `${id}:${name} exceeds atlas height`).toBeLessThanOrEqual(h);
      }
    }
  });

  it('keeps the whole asset set inside the SC-011 size budget', () => {
    let total = 0;
    let largest = 0;
    for (const id of MANIFEST_IDS) {
      const entry = MANIFEST[id];
      if (entry === undefined || entry.kind === 'audio') continue;
      const file = entry.source.split(/[\\/]/).pop() ?? '';
      const path = join(ATLAS_DIR, file);
      if (!existsSync(path)) continue;
      const size = statSync(path).size;
      total += size;
      largest = Math.max(largest, size);
    }
    expect(largest).toBeLessThan(1024 * 1024); // single file <= 1 MB
    expect(total).toBeLessThan(6 * 1024 * 1024); // whole set <= 6 MB
  });
});

describe('source packs keep their upstream CC0 text (SC-010)', () => {
  it('ships a CC0 License.txt with every pack kept under raw/', () => {
    const packs: string[] = [];
    for (const raw of RAW_DIRS) {
      if (!existsSync(raw)) continue;
      for (const name of readdirSync(raw)) {
        const dir = join(raw, name);
        if (!statSync(dir).isDirectory()) continue;
        const license = join(dir, 'License.txt');
        expect(existsSync(license), `pack ${name} keeps no License.txt`).toBe(true);
        const text = readFileSync(license, 'utf8');
        expect(text.toLowerCase(), `pack ${name} is not CC0`).toContain('cc0');
        packs.push(name);
      }
    }
    // Guard against a vacuous pass: the audit must have had packs to audit.
    expect(packs.length).toBeGreaterThanOrEqual(5);
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
    const artLicenses = readFileSync(resolve(REPO_ROOT, 'assets/art/LICENSES.md'), 'utf8');
    const audioLicenses = readFileSync(resolve(REPO_ROOT, 'assets/audio/LICENSES.md'), 'utf8');
    const combined = `${artLicenses}\n${audioLicenses}`;
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
});
