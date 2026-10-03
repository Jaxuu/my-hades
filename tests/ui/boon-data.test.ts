/**
 * Boon data-table integrity (M19 · specs/027-hud-boon-ui T010).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * `client/assets/boons.json` is the presentation layer's OWN metadata table. Four
 * things can go wrong silently, so each gets a named check:
 *
 *   V1  the table's ids must EXACTLY equal the logic layer's reward pool (no dangling
 *       id, no missing reward) — a drifted table renders a boon with the wrong look;
 *   V2  every `rarity` is one of the three tiers;
 *   V3  every `icon` is a known CSS glyph token (U3: NOT an asset id);
 *   V4  every `{placeholder}` in a description resolves to a number;
 *   V5  `src/**` never imports the table (the logic core must stay blind to it);
 *   V6  the table is not in the logic core's named load list.
 *
 * The validation lives in TESTS rather than at run time on purpose: the engine's
 * `step()` may not validate, and the interface must degrade rather than crash.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ICON_GLYPHS,
  boonTableIds,
  getBoonMeta,
  validateBoonTable,
} from '../../client/ui/boon-catalog';
import { boonEffectNumbers, renderBoonDescription } from '../../client/ui/boon-presentation';
import { RARITIES } from '../../client/ui/quality';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { REWARD_POOL } from '../../src/ecs/rewards/RewardPool';

const REPO_ROOT = process.cwd();

/** The engine's own frame duration — used only to render a tick count as seconds. */
const sim = new GameSimulator({ systems: createDefaultSystems() });
const TICK_SECONDS = sim.fixedDeltaSeconds;

const POOL_IDS = REWARD_POOL.map((reward) => reward.id);

/** Every `.ts` file under `src/`, recursively. */
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...srcFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('V1 · the table covers exactly the reward pool', () => {
  it('has no dangling id and no missing reward', () => {
    const validation = validateBoonTable(POOL_IDS);
    expect(validation.dangling).toEqual([]);
    expect(validation.missing).toEqual([]);
  });

  it('agrees with the pool as SETS (both directions)', () => {
    // Anti-vacuous: the pool really is non-empty, so "both empty" cannot pass on
    // two empty sets.
    expect(POOL_IDS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(boonTableIds())).toEqual(new Set(POOL_IDS));
  });
});

describe('V2 · every rarity is a declared tier', () => {
  it.each(boonTableIds())('`%s` declares a valid rarity', (id) => {
    const meta = getBoonMeta(id);
    expect(meta).toBeDefined();
    expect(RARITIES).toContain(meta?.rarity);
  });

  it('uses all three tiers somewhere (so a two-colour table cannot pass)', () => {
    const used = new Set(boonTableIds().map((id) => getBoonMeta(id)?.rarity));
    expect(used).toEqual(new Set(RARITIES));
  });
});

describe('V3 · every icon is a known CSS glyph token', () => {
  it.each(boonTableIds())('`%s` names a known token', (id) => {
    const token = getBoonMeta(id)?.icon;
    expect(token).toBeDefined();
    expect(Object.keys(ICON_GLYPHS)).toContain(token);
  });

  it('never names an asset id (U3: the icon is a glyph, not a file)', () => {
    for (const id of boonTableIds()) {
      expect(getBoonMeta(id)?.icon ?? '').not.toContain('ui.');
      expect(getBoonMeta(id)?.icon ?? '').not.toContain('.png');
    }
  });
});

describe('V4 · every description placeholder resolves', () => {
  it.each(boonTableIds())('`%s` renders without leaking a marker', (id) => {
    const meta = getBoonMeta(id);
    const numbers = boonEffectNumbers(id, TICK_SECONDS);
    const rendered = renderBoonDescription(meta?.description ?? '', numbers, '__FALLBACK__');
    expect(rendered).not.toBe('__FALLBACK__');
    expect(rendered).not.toContain('{');
    expect(rendered).not.toContain('NaN');
    expect(rendered).not.toContain('undefined');
  });

  it('actually contains a placeholder in the template (so V4 is not vacuous)', () => {
    const withSlots = boonTableIds().filter((id) =>
      (getBoonMeta(id)?.description ?? '').includes('{'),
    );
    expect(withSlots.length).toBe(boonTableIds().length);
  });
});

describe('V5 · the logic core never imports the table', () => {
  it('finds no `boons.json` reference anywhere under src/', () => {
    const offenders = srcFiles(resolve(REPO_ROOT, 'src')).filter((path) =>
      readFileSync(path, 'utf8').includes('boons.json'),
    );
    expect(offenders).toEqual([]);
  });
});

describe('V6 · the table is not in the logic core load list', () => {
  it('is absent from src/data/bundled.ts', () => {
    const bundled = readFileSync(resolve(REPO_ROOT, 'src/data/bundled.ts'), 'utf8');
    expect(bundled).not.toContain('boons.json');
  });
});
