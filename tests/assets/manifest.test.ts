/**
 * Asset-manifest contract tests (specs/024-real-art-assets, T011).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * `client/assets/manifest.ts` is the SINGLE source of truth for "does this asset
 * exist", and the contract (contracts/asset-manifest.md §3–§4) makes four promises
 * that are cheap to state and easy to break silently:
 *
 *   1. ids are unique (a duplicate would shadow an entry, not error);
 *   2. an AUDIO entry never falls back to `graphics` (silence is the only honest
 *      degradation for a sound);
 *   3. every id is traceable in `assets/**\/LICENSES.md` — SC-010's 100 %;
 *   4. every license is on the redistribution whitelist — FR-020's "no
 *      proprietary asset, ever".
 *
 * These are checked against the REAL files on disk, not a fixture: a new asset
 * added without a license row is exactly the mistake this suite exists to catch.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MANIFEST, MANIFEST_IDS, SHEET_DATA, type AssetEntry } from '../../client/assets/manifest';

/** Licenses we are allowed to redistribute under (FR-020). */
const LICENSE_WHITELIST = ['CC0-1.0', 'public-domain'];

const REPO_ROOT = process.cwd();

function readLicenseFiles(): string {
  return [
    readFileSync(resolve(REPO_ROOT, 'assets/art/LICENSES.md'), 'utf8'),
    readFileSync(resolve(REPO_ROOT, 'assets/audio/LICENSES.md'), 'utf8'),
  ].join('\n');
}

function entries(): readonly AssetEntry[] {
  return MANIFEST_IDS.map((id) => MANIFEST[id]).filter((e): e is AssetEntry => e !== undefined);
}

describe('manifest shape (contract §1)', () => {
  it('exposes a non-empty, frozen registry keyed by its own ids', () => {
    expect(MANIFEST_IDS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(MANIFEST)).toBe(true);
    for (const id of MANIFEST_IDS) {
      expect(MANIFEST[id]?.id).toBe(id);
    }
  });

  it('has GLOBALLY UNIQUE ids (a duplicate would shadow, not error)', () => {
    expect(new Set(MANIFEST_IDS).size).toBe(MANIFEST_IDS.length);
  });

  it('gives every entry a non-empty local source', () => {
    for (const entry of entries()) {
      expect(entry.source.length).toBeGreaterThan(0);
    }
  });

  it('namespaces every id under a frozen prefix (contract §2)', () => {
    const prefixes = ['player.', 'enemy.', 'tile.', 'fx.', 'ui.', 'sfx.'];
    for (const id of MANIFEST_IDS) {
      expect(prefixes.some((prefix) => id.startsWith(prefix))).toBe(true);
    }
  });
});

describe('fallback semantics (contract §3.2/§3.3)', () => {
  it('makes every AUDIO entry silent — never `graphics`', () => {
    const audio = entries().filter((e) => e.kind === 'audio');
    expect(audio.length).toBeGreaterThan(0);
    for (const entry of audio) {
      expect(entry.fallback).toBe('silent');
    }
  });

  it('makes every VISUAL entry fall back to the existing geometry', () => {
    for (const entry of entries().filter((e) => e.kind !== 'audio')) {
      expect(entry.fallback).toBe('graphics');
    }
  });

  it('only uses the three declared kinds', () => {
    for (const entry of entries()) {
      expect(['spritesheet', 'image', 'audio']).toContain(entry.kind);
    }
  });
});

describe('license whitelist (FR-020, contract §3.6)', () => {
  it('puts every entry on the redistribution whitelist', () => {
    for (const entry of entries()) {
      expect(LICENSE_WHITELIST).toContain(entry.license);
    }
  });

  it('contains NO proprietary or unknown license', () => {
    const bad = entries().filter((e) => !LICENSE_WHITELIST.includes(e.license));
    expect(bad.map((e) => `${e.id}=${e.license}`)).toEqual([]);
  });

  it('declares CC0-1.0 for every entry (this feature uses one license tier)', () => {
    for (const entry of entries()) {
      expect(entry.license).toBe('CC0-1.0');
    }
  });
});

describe('traceability (SC-010, contract §3.5)', () => {
  it('finds every id in assets/art/LICENSES.md or assets/audio/LICENSES.md', () => {
    const text = readLicenseFiles();
    const missing = MANIFEST_IDS.filter((id) => !text.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  it('keeps the license files free of any Supergiant / Hades asset mention', () => {
    const text = readLicenseFiles();
    expect(text).not.toMatch(/Supergiant/i);
  });
});

describe('spritesheet data (contract §5: frame layout is the sheet JSON own business)', () => {
  it('provides parsed JSON data for every spritesheet entry', () => {
    const sheets = entries().filter((e) => e.kind === 'spritesheet');
    expect(sheets.length).toBeGreaterThan(0);
    for (const entry of sheets) {
      expect(SHEET_DATA[entry.id]).toBeDefined();
    }
  });

  it('declares at least one animation per spritesheet, with frames that exist', () => {
    for (const entry of entries().filter((e) => e.kind === 'spritesheet')) {
      const data = SHEET_DATA[entry.id];
      expect(data).toBeDefined();
      if (data === undefined) continue;
      const animations = Object.keys(data.animations ?? {});
      expect(animations.length).toBeGreaterThan(0);
      for (const name of animations) {
        const frames = data.animations?.[name] ?? [];
        expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) {
          expect(data.frames[frame]).toBeDefined();
        }
      }
    }
  });

  it('pins the animation names the renderer looks up (E4 + contract §3.6)', () => {
    // The renderer builds `<spriteId>.<action>.<facing>` and falls back to
    // `<spriteId>.<action>.down` then `<spriteId>.idle.down`. The player sheet must
    // therefore carry the full cross-product, or every fallback would be exercised
    // on the happy path and mask a missing animation.
    const player = SHEET_DATA['player.base'];
    expect(player).toBeDefined();
    for (const action of ['idle', 'move', 'dash', 'attack', 'hit', 'death']) {
      for (const facing of ['down', 'up', 'left', 'right']) {
        expect(Object.keys(player?.animations ?? {})).toContain(
          `player.base.${action}.${facing}`,
        );
      }
    }
  });

  it('gives all five declared enemy types their own sheet animation set', () => {
    for (const type of ['grunt', 'elite', 'raider', 'bomber', 'gunner', 'unknown']) {
      const data = SHEET_DATA[`enemy.${type}`];
      expect(data).toBeDefined();
      expect(Object.keys(data?.animations ?? {})).toContain(`enemy.${type}.idle.down`);
    }
  });
});

describe('the asset set covers the whole feature (FR-022: 全量)', () => {
  it('declares the player, the five enemies, the tiles, the fx and the UI slots', () => {
    const required = [
      'player.base',
      'enemy.grunt',
      'enemy.elite',
      'enemy.raider',
      'enemy.bomber',
      'enemy.gunner',
      'enemy.unknown',
      'tile.floor',
      'tile.wall',
      'fx.spark',
      'fx.dash-trail',
      'fx.hazard-ring',
      'ui.icon.gold',
      'ui.icon.heal',
      'ui.icon.darkness',
      'ui.panel.hud',
      'ui.panel.reward',
      'ui.panel.camp',
      'ui.frame.reward-card',
      'ui.frame.talent-card',
      'ui.button.primary',
      'ui.overlay.death',
      'ui.overlay.win',
      'sfx.hit',
      'sfx.dash',
      'sfx.coin',
      'sfx.enemy-death',
      'sfx.hazard-blast',
      'sfx.ui-click',
      'sfx.reward-select',
      'sfx.death',
      'sfx.win',
    ];
    const missing = required.filter((id) => !MANIFEST_IDS.includes(id));
    expect(missing).toEqual([]);
  });
});
