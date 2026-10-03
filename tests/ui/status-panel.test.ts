/**
 * Status panel model (specs/027-hud-boon-ui T030 · SC-005 · FR-024).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * The Tab panel answers "what am I carrying?" and MUST equal the player's actual
 * owned-boon set, EXACTLY (SC-005). A panel that dropped an unknown id would lie
 * the moment the metadata table lagged the reward pool; a panel that invented an
 * empty box would leave the player unable to tell "nothing" from "broken".
 *
 * Rows reuse the card view, so a boon looks the same whether it is being chosen or
 * being reviewed — asserted by checking each row's quality / glyph / description.
 */

import { describe, expect, it } from 'vitest';

import {
  addModifier,
  createDefaultSystems,
  GameSimulator,
  PlayerFactory,
} from '../../src';
import { buildBoonCard } from '../../client/ui/boon-presentation';
import { RARITIES } from '../../client/ui/quality';
import {
  buildStatusPanel,
  readOwnedBoonIds,
  STATUS_PANEL_SCROLL_THRESHOLD,
} from '../../client/ui/status-panel';

const TICK_SECONDS = 1 / 60;

function makePlayerSim(): { sim: GameSimulator; player: number } {
  const sim = new GameSimulator({ fps: 60, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0 });
  return { sim, player };
}

describe('T030 · the panel set equals the owned set exactly (SC-005)', () => {
  it('reads the player’s modifiers, ascending and deduplicated', () => {
    const { sim, player } = makePlayerSim();
    addModifier(sim.world, player, 'zeus_strike');
    addModifier(sim.world, player, 'hp_up');
    addModifier(sim.world, player, 'dash_up');
    addModifier(sim.world, player, 'zeus_strike'); // duplicate -> no-op

    const owned = readOwnedBoonIds(sim.world);
    expect([...owned].sort()).toEqual(['dash_up', 'hp_up', 'zeus_strike']);

    const panel = buildStatusPanel(owned, TICK_SECONDS);
    expect(panel.rows.map((row) => row.id).sort()).toEqual(['dash_up', 'hp_up', 'zeus_strike']);
    expect(panel.isEmpty).toBe(false);
  });

  it('includes an UNKNOWN owned id (the set never silently shrinks)', () => {
    const { sim, player } = makePlayerSim();
    addModifier(sim.world, player, 'zeus_strike');
    addModifier(sim.world, player, 'a_boon_the_table_does_not_know');

    const owned = readOwnedBoonIds(sim.world);
    const panel = buildStatusPanel(owned, TICK_SECONDS);
    expect(panel.rows.map((row) => row.id).sort()).toEqual(
      ['a_boon_the_table_does_not_know', 'zeus_strike'].sort(),
    );
  });
});

describe('T030 · the empty state is explicit (FR-024)', () => {
  it('reports empty for a player with no boons, and for a world with no player', () => {
    const { sim } = makePlayerSim();
    expect(buildStatusPanel(readOwnedBoonIds(sim.world), TICK_SECONDS).isEmpty).toBe(true);

    const bare = new GameSimulator();
    expect(readOwnedBoonIds(bare.world)).toEqual([]);
    expect(buildStatusPanel(readOwnedBoonIds(bare.world), TICK_SECONDS).isEmpty).toBe(true);
  });
});

describe('T030 · the panel scrolls once it grows', () => {
  it('scrolls above the threshold and does not below it', () => {
    const small = Array.from({ length: STATUS_PANEL_SCROLL_THRESHOLD }, (_, i) => `boon_${String(i)}`);
    expect(buildStatusPanel(small, TICK_SECONDS).scrollable).toBe(false);

    const large = [...small, 'one_more'];
    expect(buildStatusPanel(large, TICK_SECONDS).scrollable).toBe(true);
  });
});

describe('T030 · every row carries quality / glyph / description', () => {
  it('gives each row the same three elements a card has', () => {
    const ids = ['zeus_strike', 'dionysus_strike', 'poseidon_dash', 'hp_up', 'dash_up'];
    const panel = buildStatusPanel(ids, TICK_SECONDS);
    expect(panel.rows).toHaveLength(ids.length);
    for (const row of panel.rows) {
      expect(RARITIES).toContain(row.rarity);
      expect(row.iconGlyph.length).toBeGreaterThan(0);
      expect(row.description.length).toBeGreaterThan(0);
      // A row is literally the card view, so it cannot drift from the draft.
      expect(row).toEqual(buildBoonCard(row.id, TICK_SECONDS));
    }
  });
});
