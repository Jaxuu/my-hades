/**
 * Boon selection chain (specs/027-hud-boon-ui T029 · FR-015 · contract §4).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * The UI DECLARES INTENT and the logic layer RE-VALIDATES it. A card click must
 * travel `UIManager.onSelect(id)` -> composition root -> a `selectReward` INPUT
 * EVENT, and the simulator is the only thing that grants the boon. A UI that
 * granted a reward directly would bypass the "the room re-checks the id it rolled"
 * rule (spec 11 AC-03) — and would be a write into `World` from the render layer.
 *
 * The proof is two-sided: the REAL simulator honours a `selectReward` event end to
 * end, and the client source never calls `grantReward`.
 */

import { describe, expect, it } from 'vitest';

import {
  createDefaultSystems,
  ENCOUNTER_WAVE_UNSCHEDULED,
  EncounterState,
  EncounterStateComponent,
  findRewardDraft,
  GameSimulator,
  GameStateFactory,
  hasModifier,
  PlayerFactory,
  ZEUS_STRIKE_MODIFIER,
} from '../../src';
import { collectSources, readRepoFile, stripComments } from '../harness/ui-source';

const UI_MANAGER = stripComments(readRepoFile('client/UIManager.ts'));
const MAIN = stripComments(readRepoFile('client/main.ts'));

/** A live run with an unsettled draft offering exactly `ids`. */
function makeDraftingSim(ids: readonly string[]): { sim: GameSimulator; player: number } {
  const sim = new GameSimulator({ fps: 60, systems: createDefaultSystems(), seed: 0x12345678 });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0 });
  GameStateFactory.spawn(sim.world);
  const room = sim.world.createEntity().id;
  sim.world.addComponent(
    room,
    new EncounterStateComponent(
      [],
      EncounterState.IN_PROGRESS,
      0,
      ENCOUNTER_WAVE_UNSCHEDULED,
      [],
      0,
      [...ids],
      [[], []], // two rooms, so settling descends instead of winning the run
      0,
      2,
      [],
      [],
    ),
  );
  return { sim, player };
}

describe('T029 · a selection travels as an input event and is granted by the simulator', () => {
  it('grants the chosen boon when a `selectReward` event names an offered id', () => {
    const { sim, player } = makeDraftingSim([ZEUS_STRIKE_MODIFIER, 'hp_up', 'dash_up']);

    // Anti-vacuous: the player does NOT have it before the click.
    expect(hasModifier(sim.world, player, ZEUS_STRIKE_MODIFIER)).toBe(false);
    expect(findRewardDraft(sim.world)).toBeDefined();

    sim.inject({ kind: 'selectReward', tick: sim.tick, rewardId: ZEUS_STRIKE_MODIFIER });
    sim.step(1);

    expect(hasModifier(sim.world, player, ZEUS_STRIKE_MODIFIER)).toBe(true);
    expect(findRewardDraft(sim.world)).toBeUndefined(); // the draft is settled
  });

  it('ignores a forged id the room never offered', () => {
    const { sim, player } = makeDraftingSim(['hp_up', 'dash_up']);
    sim.inject({ kind: 'selectReward', tick: sim.tick, rewardId: ZEUS_STRIKE_MODIFIER });
    sim.step(1);

    expect(hasModifier(sim.world, player, ZEUS_STRIKE_MODIFIER)).toBe(false);
    // The room keeps waiting: "that option was not on offer" is not a selection.
    expect(findRewardDraft(sim.world)).toBeDefined();
  });
});

describe('T029 · the UI only declares intent (contract §4)', () => {
  it('routes a card click through `onSelect(id)`', () => {
    expect(UI_MANAGER).toContain('this.onSelect(id)');
  });

  it('converts the intent to a `selectReward` input event in the composition root', () => {
    expect(MAIN).toContain("kind: 'selectReward'");
    expect(MAIN).toContain('sim.inject');
    // The click carries an ID, never an index.
    expect(MAIN).toContain('rewardId');
  });

  it('never grants a reward from anywhere in the client', () => {
    // A direct `grantReward` in `client/` would be the UI writing the world.
    for (const file of collectSources('client')) {
      expect(stripComments(file.source)).not.toContain('grantReward');
    }
  });
});
