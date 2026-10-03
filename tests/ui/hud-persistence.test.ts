/**
 * HUD persistence across overlays (specs/027-hud-boon-ui T017 · FR-005 / FR-007).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * The material HUD is an ALWAYS-ON surface: it must read the player correctly
 * whether the run is playing, a draft is open, the player is dead, the run is won,
 * or the camp is up. A HUD that only updated on the "playing" branch would look
 * right in every screenshot the author took and freeze the moment a draft opened.
 *
 * It also pins FR-007 ("the three read-outs never duplicate or contradict"):
 * `#gold` and `#hud-material` both derive gold from the ONE logic-layer read
 * (`readGold`), and the diagnostics block shows a DIFFERENT pair (hp / run
 * darkness), so no two surfaces can disagree.
 *
 * There is no DOM, so "the HUD is correct under an overlay" is asserted against
 * the pure model (`readHudState` / `buildHudView`) the manager renders from, plus
 * a source scan proving `sync` updates the HUD surfaces BEFORE it branches on any
 * overlay.
 */

import { describe, expect, it } from 'vitest';

import {
  applyDamage,
  addGold,
  createDefaultSystems,
  DashStatsComponent,
  ENCOUNTER_WAVE_UNSCHEDULED,
  EncounterState,
  EncounterStateComponent,
  GameSimulator,
  GameStateFactory,
  markRunFailed,
  markRunHub,
  markRunWon,
  PlayerFactory,
  readGold,
} from '../../src';
import { buildHudView, readHudState } from '../../client/ui/hud-model';
import { readRepoFile, stripComments } from '../harness/ui-source';

const UI_MANAGER = stripComments(readRepoFile('client/UIManager.ts'));
const HUD_MODEL = readRepoFile('client/ui/hud-model.ts');

interface Rig {
  readonly sim: GameSimulator;
  readonly player: number;
  readonly dash: DashStatsComponent;
}

/** A player + a game-state singleton — the minimum a live HUD needs. */
function makeRig(): Rig {
  const sim = new GameSimulator({ fps: 60, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0 });
  GameStateFactory.spawn(sim.world);
  const dash = sim.world.getComponent(player, DashStatsComponent);
  if (dash === undefined) throw new Error('QA: player is missing DashStatsComponent');
  return { sim, player, dash };
}

/** Mount a room singleton carrying an unsettled draft (so `findRewardDraft` fires). */
function openDraft(sim: GameSimulator, ids: readonly string[]): void {
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
      [[], []],
      0,
      2,
      [],
      [],
    ),
  );
}

describe('T017 · the HUD reads the player under every overlay (FR-005)', () => {
  it('reports the same health / dash / gold whether playing or under an overlay', () => {
    const { sim, player, dash } = makeRig();
    applyDamage(sim.world, player, 30); // 100 -> 70
    addGold(sim.world, player, 42);
    dash.cooldownRemaining = 15;

    const playing = buildHudView(readHudState(sim.world));

    // Sanity: the readings are real, not the zeroes of a missing player.
    expect(playing.hp).toBe(70);
    expect(playing.maxHp).toBe(100);
    expect(playing.gold).toBe(42);
    expect(playing.dashState).toBe('cooling');

    // The draft overlay.
    openDraft(sim, ['zeus_strike', 'hp_up', 'dash_up']);
    expect(buildHudView(readHudState(sim.world))).toEqual(playing);

    // The three terminal states, one after another.
    markRunFailed(sim.world);
    expect(buildHudView(readHudState(sim.world))).toEqual(playing);

    markRunWon(sim.world);
    expect(buildHudView(readHudState(sim.world))).toEqual(playing);

    markRunHub(sim.world);
    expect(buildHudView(readHudState(sim.world))).toEqual(playing);
  });

  it('updates the HUD surfaces BEFORE branching on any overlay', () => {
    // The always-on surfaces are synced first and unconditionally; the overlay
    // branches (terminal / hub / draft) come after. A HUD synced inside the
    // playing branch would freeze under a draft.
    const syncBody = UI_MANAGER.slice(UI_MANAGER.indexOf('public sync('));
    const hudAt = syncBody.indexOf('this.syncHud(world);');
    const materialAt = syncBody.indexOf('this.syncHudMaterial(world);');
    const overlayAt = syncBody.indexOf('isRunFailed(');

    expect(hudAt).toBeGreaterThanOrEqual(0);
    expect(materialAt).toBeGreaterThan(hudAt);
    expect(overlayAt).toBeGreaterThan(materialAt);
  });
});

describe('T017 · the three read-outs never contradict each other (FR-007)', () => {
  it('derives the gold plate and the material HUD from the ONE logic-layer read', () => {
    // Both surfaces read `readGold` — the plate directly, the material HUD through
    // `readHudState`. Neither keeps a second copy of the number.
    expect(UI_MANAGER).toContain('readGold(world)');
    expect(HUD_MODEL).toContain('readGold(world)');
  });

  it('agrees on gold for every value a run can reach', () => {
    const { sim, player } = makeRig();
    for (const gold of [0, 1, 7, 999, 1_000_000]) {
      const before = readGold(sim.world);
      addGold(sim.world, player, gold - before); // set the wallet to `gold`
      const view = buildHudView(readHudState(sim.world));
      expect(view.gold).toBe(readGold(sim.world));
      expect(view.gold).toBe(gold);
    }
  });

  it('keeps the diagnostics block on a DIFFERENT pair (hp + run darkness), not gold', () => {
    // `#hud` (main.ts::installHud) shows hp / maxHp and the run's darkness. Showing
    // gold there too would be the one honest way to make the two surfaces
    // contradict. This pins that the diagnostics block never writes a gold read.
    const main = stripComments(readRepoFile('client/main.ts'));
    const installHud = main.slice(main.indexOf('function installHud('));
    const body = installHud.slice(0, installHud.indexOf('\n}'));
    expect(body).not.toContain('readGold');
    expect(body).toContain('readDarkness');
  });
});
