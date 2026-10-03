/**
 * Boon card contract (specs/027-hud-boon-ui T023 · FR-011/012/013/016/017).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * A card carries THREE things: a cosmetic quality, an icon glyph and a numeric
 * description. A card that silently dropped one of the three would still look
 * plausible in a screenshot, so the presence of all three is asserted per card.
 *
 * THE TAUTOLOGY TRAP, AND HOW IT IS DODGED
 * ----------------------------------------
 * "Rarity comes from boons.json" is trivially true if the test compares the parsed
 * table against itself. So the assignment is pinned against TWO INDEPENDENT
 * sources: the raw JSON FILE (read from disk) and a LITERAL table written here. A
 * re-tiered boon must break one of them — the file changed, or the pin did.
 *
 * The `boon-rarity-*` CLASS mapping is a DOM concern, so it is checked against the
 * DOM owner (`client/UIManager.ts`) rather than against `quality.ts`.
 */

import { describe, expect, it } from 'vitest';

import { BOON_TABLE, boonTableIds, getBoonMeta } from '../../client/ui/boon-catalog';
import { buildBoonCard } from '../../client/ui/boon-presentation';
import {
  RARITIES,
  RARITY_COLORS,
  RARITY_LABELS,
  RARITY_PIPS,
  RARITY_SHAPES,
  type Rarity,
} from '../../client/ui/quality';
import { REWARD_POOL } from '../../src';
import { readRepoFile } from '../harness/ui-source';

const UI_MANAGER = readRepoFile('client/UIManager.ts');
const TICK_SECONDS = 1 / 60;

/** Source 1 · the raw file on disk. */
const RAW_BOONS = JSON.parse(readRepoFile('client/assets/boons.json')) as Record<
  string,
  { readonly rarity: string; readonly icon: string; readonly description: string }
>;

/** Source 2 · a hand-written literal table, independent of the file and the parser. */
const EXPECTED_RARITY: Readonly<Record<string, Rarity>> = {
  zeus_strike: 'epic',
  dionysus_strike: 'epic',
  poseidon_dash: 'legendary',
  hp_up: 'common',
  dash_up: 'common',
};

describe('T023 · every card carries all three elements (FR-011/012/013)', () => {
  it('gives each reward id a quality, a glyph and a non-empty description', () => {
    const ids = REWARD_POOL.map((reward) => reward.id);
    expect(ids.length).toBeGreaterThanOrEqual(3); // guard against a vacuous loop
    for (const id of ids) {
      const card = buildBoonCard(id, TICK_SECONDS);
      expect(RARITIES).toContain(card.rarity);
      expect(card.iconGlyph.length).toBeGreaterThan(0);
      expect(card.description.length).toBeGreaterThan(0);
      expect(card.rarityLabel.length).toBeGreaterThan(0);
    }
  });

  it('maps each card rarity to the `boon-rarity-*` class the manager emits', () => {
    for (const id of REWARD_POOL.map((reward) => reward.id)) {
      const card = buildBoonCard(id, TICK_SECONDS);
      expect(UI_MANAGER).toContain(`boon-rarity-${card.rarity}`);
    }
    // The three hooks really are all three, so the mapping is not collapsed to one.
    for (const rarity of RARITIES) {
      expect(UI_MANAGER).toContain(`boon-rarity-${rarity}`);
    }
  });
});

describe('T023 · the rarity assignment is pinned against two independent sources', () => {
  it('agrees between the raw boons.json file and the literal table here', () => {
    const fileIds = Object.keys(RAW_BOONS).sort();
    const literalIds = Object.keys(EXPECTED_RARITY).sort();
    expect(fileIds).toEqual(literalIds);
    for (const id of literalIds) {
      expect(RAW_BOONS[id]?.rarity).toBe(EXPECTED_RARITY[id]);
    }
  });

  it('agrees with the module’s parsed table (a third, derived view)', () => {
    for (const [id, rarity] of Object.entries(EXPECTED_RARITY)) {
      expect(getBoonMeta(id)?.rarity).toBe(rarity);
    }
  });

  it('actually uses all three tiers (the mapping is not vacuous)', () => {
    const used = new Set(Object.values(EXPECTED_RARITY));
    expect([...used].sort()).toEqual([...RARITIES].sort());
    // The three tiers are pairwise distinct in every channel.
    expect(new Set(Object.values(RARITY_COLORS)).size).toBe(3);
    expect(new Set(Object.values(RARITY_LABELS)).size).toBe(3);
    expect(new Set(Object.values(RARITY_PIPS)).size).toBe(3);
    expect(new Set(Object.values(RARITY_SHAPES)).size).toBe(3);
  });

  it('covers every reward id (no dangling, no missing)', () => {
    const poolIds = REWARD_POOL.map((reward) => reward.id).sort();
    expect(boonTableIds()).toEqual(poolIds);
    expect(Object.keys(BOON_TABLE).sort()).toEqual(poolIds);
  });
});

describe('T023 · a card with missing metadata degrades, never throws (FR-017)', () => {
  it('falls back to the default tier, the default glyph and a safe description', () => {
    const card = buildBoonCard('totally_unknown_boon', TICK_SECONDS);
    expect(card.rarity).toBe('common');
    expect(card.rarityLabel).toBe(RARITY_LABELS.common);
    expect(card.pips).toBe(RARITY_PIPS.common);
    expect(card.shape).toBe(RARITY_SHAPES.common);
    expect(card.iconToken).toBe('default');
    expect(card.iconGlyph).toBe('◆');
    // No metadata AND no reward definition: the label is the raw id, and the
    // description falls back to that label — never `undefined` / `NaN`.
    expect(card.label).toBe('totally_unknown_boon');
    expect(card.description).toBe('totally_unknown_boon');
    expect(card.description).not.toContain('undefined');
    expect(card.description).not.toContain('NaN');
  });
});
