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

/** Licenses we are allowed to redistribute under (FR-023, contract §5). */
// M18 · an EXPLICIT literal list (contract §5: "MUST NOT 用「非空字符串」之类的空真
// 断言替代"). The pre-M18 form was `['CC0-1.0', 'public-domain']` plus a separate
// "every entry is exactly CC0-1.0" rule; FR-023/FR-029 authorise widening the
// whitelist to the open tiers the HD asset libraries actually use, so the exact-CC0
// rule is replaced by membership in this list — and the "no commercial game
// publisher, ever" bottom line is kept and EXTENDED (D17).
const LICENSE_WHITELIST = ['CC0-1.0', 'Public Domain', 'CC-BY-4.0'];

/** Commercial game publishers whose assets MUST NOT appear anywhere (FR-023). */
const PROPRIETARY_PUBLISHERS = [
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

  it('declares the whitelist as an explicit literal list of open tiers', () => {
    // The list itself is pinned, so "the whitelist" cannot quietly become
    // "anything non-empty" — which is the failure mode a relaxed assertion has.
    expect(LICENSE_WHITELIST).toEqual(['CC0-1.0', 'Public Domain', 'CC-BY-4.0']);
    expect(LICENSE_WHITELIST.every((tier) => tier.trim().length > 0)).toBe(true);
    for (const entry of entries()) {
      expect(LICENSE_WHITELIST, `${entry.id}=${entry.license}`).toContain(entry.license);
    }
  });
});

describe('traceability (SC-010, contract §3.5)', () => {
  it('finds every id in assets/art/LICENSES.md or assets/audio/LICENSES.md', () => {
    const text = readLicenseFiles();
    const missing = MANIFEST_IDS.filter((id) => !text.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  it('keeps the license files free of any commercial game or publisher mention', () => {
    const text = readLicenseFiles();
    for (const pattern of PROPRIETARY_PUBLISHERS) {
      expect(text, `license registry mentions ${String(pattern)}`).not.toMatch(pattern);
    }
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
  it('declares the player, the five enemies, the tiles, the fx, the pickups and the UI slots', () => {
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
      'fx.pickup.gold',
      'fx.pickup.heal',
      'fx.pickup.darkness',
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

  it('keeps every `ui.` and `sfx.` entry — FR-030 is a scope BOUND, not a deletion licence', () => {
    // M18's coverage is the in-run WORLD art. The temptation is to "simplify" by
    // dropping the interface and audio entries; that would silently break the HUD
    // and the soundtrack while every remaining assertion stayed green.
    const uiAndSfx = MANIFEST_IDS.filter((id) => id.startsWith('ui.') || id.startsWith('sfx.'));
    expect(uiAndSfx.length).toBeGreaterThan(0);
    for (const id of uiAndSfx) {
      const entry = MANIFEST[id];
      expect(entry, `${id} disappeared`).toBeDefined();
      expect((entry?.source ?? '').length).toBeGreaterThan(0);
    }
    // The three HUD icon slots and the nine sounds are named individually, so a
    // rename cannot masquerade as "still present".
    for (const id of [
      'ui.icon.gold',
      'ui.icon.heal',
      'ui.icon.darkness',
      'ui.panel.hud',
      'ui.overlay.death',
      'ui.overlay.win',
      'sfx.hit',
      'sfx.dash',
      'sfx.coin',
      'sfx.win',
    ]) {
      expect(MANIFEST_IDS).toContain(id);
    }
  });

  it('gives the six enemies six DISTINCT atlases (one loader unit each)', () => {
    const sources = ['grunt', 'elite', 'raider', 'bomber', 'gunner', 'unknown'].map(
      (type) => MANIFEST[`enemy.${type}`]?.source ?? '',
    );
    expect(new Set(sources).size).toBe(6);
    for (const source of sources) expect(source.length).toBeGreaterThan(0);
  });
});
