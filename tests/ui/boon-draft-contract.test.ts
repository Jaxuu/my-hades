/**
 * Draft trigger + count contract (specs/027-hud-boon-ui T025 · FR-010).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * M19 upgrades how a draft LOOKS. It must not change WHEN a draft appears or HOW
 * MANY options it offers — those are the logic layer's (`EncounterSystem` +
 * `findRewardDraft`), and a presentation-layer refactor that quietly re-rolled the
 * options would break determinism (ADR-004) and the roguelike loop (spec 11).
 *
 * The proof is two-sided:
 *  - the REAL simulator clears a room and rolls exactly `DEFAULT_REWARD_DRAFT_COUNT`
 *    DISTINCT options, all drawn from the shipped pool;
 *  - the UI source contains no draw call at all — it reads `pendingRewards`, it
 *    never samples.
 */

import { describe, expect, it } from 'vitest';

import {
  applyDamage,
  createDefaultSystems,
  DEFAULT_REWARD_DRAFT_COUNT,
  ENCOUNTER_WAVE_UNSCHEDULED,
  EncounterState,
  EncounterStateComponent,
  findRewardDraft,
  GameSimulator,
  GameStateFactory,
  PlayerFactory,
  REWARD_POOL,
} from '../../src';
import { testEnemyRef } from '../harness/config-fixtures';
import { readRepoFile, stripComments } from '../harness/ui-source';

const UI_MANAGER = stripComments(readRepoFile('client/UIManager.ts'));

const SEED = 0x12345678;

/**
 * A TWO-room run whose first room's single wave dies to a tap, so a draft is
 * reachable fast. Two rooms matter: `EncounterSystem` wins the run instead of
 * rolling a draft on the FINAL room (spec 15 AC-04), so a one-room run would never
 * open one.
 */
function buildClearableRoom(): GameSimulator {
  const sim = new GameSimulator({ fps: 60, systems: createDefaultSystems(), seed: SEED });
  PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0 });
  const wave = { delayTicks: 0, enemies: [testEnemyRef({ x: 1.5, y: 0, maxHp: 1, hp: 1 })] };
  const room = sim.world.createEntity().id;
  sim.world.addComponent(
    room,
    new EncounterStateComponent(
      [wave],
      EncounterState.IN_PROGRESS,
      0,
      ENCOUNTER_WAVE_UNSCHEDULED,
      [],
      0,
      null,
      [[wave], []], // room 0 rolls a draft; room 1 would win the run
      0,
      2,
      [],
      [],
    ),
  );
  GameStateFactory.spawn(sim.world);
  return sim;
}

/** Step until a draft is open (bounded), then return it. */
function stepUntilDraft(sim: GameSimulator): EncounterStateComponent {
  for (let i = 0; i < 20; i += 1) {
    sim.step(1);
    const room = sim.world.query(EncounterStateComponent)[0];
    if (room === undefined) continue;
    const encounter = sim.world.getComponent(room, EncounterStateComponent);
    if (encounter === undefined) continue;
    // Kill whatever the room spawned, so the wave reads as cleared.
    for (const id of encounter.trackedEntityIds) applyDamage(sim.world, id, 9999);
    const draft = findRewardDraft(sim.world);
    if (draft !== undefined) return draft;
  }
  throw new Error('QA: a draft never opened');
}

describe('T025 · clearing a room rolls exactly three distinct options (FR-010)', () => {
  it('offers DEFAULT_REWARD_DRAFT_COUNT distinct ids, all from the shipped pool', () => {
    const sim = buildClearableRoom();
    const draft = stepUntilDraft(sim);

    const pending = draft.pendingRewards;
    expect(pending).not.toBeNull();
    if (pending === null) return;

    expect(pending).toHaveLength(DEFAULT_REWARD_DRAFT_COUNT);
    expect(DEFAULT_REWARD_DRAFT_COUNT).toBe(3); // pin the genre convention
    // Three REAL options: sampling without replacement means no duplicates.
    expect(new Set(pending).size).toBe(DEFAULT_REWARD_DRAFT_COUNT);

    const poolIds = new Set(REWARD_POOL.map((reward) => reward.id));
    for (const id of pending) expect(poolIds.has(id)).toBe(true);
  });

  it('is reproducible for a fixed seed (the draft is the logic layer’s, not the UI’s)', () => {
    const first = stepUntilDraft(buildClearableRoom()).pendingRewards;
    const second = stepUntilDraft(buildClearableRoom()).pendingRewards;
    expect(first).toEqual(second);
  });
});

describe('T025 · the UI never draws or re-counts the draft', () => {
  it('reads the pending options instead of sampling them', () => {
    // The UI DOES read the draft (to render it)...
    expect(UI_MANAGER).toContain('findRewardDraft');
    expect(UI_MANAGER).toContain('pendingRewards');
    // ...but it owns no draw path and no second count.
    expect(UI_MANAGER).not.toContain('draftRewards');
    expect(UI_MANAGER).not.toContain('nextUint32');
    expect(UI_MANAGER).not.toContain('.sample(');
    expect(UI_MANAGER).not.toContain('DEFAULT_REWARD_DRAFT_COUNT');
  });
});
