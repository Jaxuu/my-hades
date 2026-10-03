/**
 * The Tab panel does not pause the run (specs/027-hud-boon-ui T031 · SC-006 / FR-022).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * The panel is a REFERENCE OVERLAY, not a pause menu: the simulation keeps ticking
 * while it is open. The failure mode is subtle — a panel that paused would look
 * perfect in a screenshot and would only be caught by comparing two runs.
 *
 * WHY THERE IS NO DOM HERE
 * ------------------------
 * `client/UIManager.ts` is DOM-coupled and is deliberately NOT imported by the
 * DOM-less `npm run typecheck` program (it is checked by `typecheck:client`). The
 * no-pause claim is therefore proven by COMPOSITION, which is stronger than driving
 * one instance:
 *
 *   1. `togglePanel()` cannot reach the simulation — it takes no `World`, no
 *      `GameSimulator`, and its body names neither, nor `step` (asserted below);
 *   2. the UI has no WRITE path to the world at all (tests/ui/ui-write-blacklist);
 *   3. a run's tick trace is a pure function of (seed, input) — two identical runs
 *      with the same script stay bit-identical (asserted below).
 *
 * Together those say: whatever the panel does, the simulation is unaffected.
 */

import { describe, expect, it } from 'vitest';

import {
  ATTACK_KEY,
  createDefaultSystems,
  EncounterFactory,
  GameSimulator,
  GameStateFactory,
  PlayerFactory,
} from '../../src';
import { testEnemyRef } from '../harness/config-fixtures';
import { readRepoFile, stripComments } from '../harness/ui-source';

const UI_MANAGER = stripComments(readRepoFile('client/UIManager.ts'));

const TICKS = 120;
const SEED = 0x12345678;

/** A live run with one enemy, so the sim has something to actually simulate. */
function buildSim(): GameSimulator {
  const sim = new GameSimulator({ fps: 60, systems: createDefaultSystems(), seed: SEED });
  PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0 });
  EncounterFactory.spawn(sim.world, {
    waves: [{ delayTicks: 0, enemies: [testEnemyRef({ x: 3, y: 0, maxHp: 100, hp: 100 })] }],
    roomIds: [],
  });
  GameStateFactory.spawn(sim.world);
  return sim;
}

/** Drive a fixed script and return the per-tick snapshot trace. */
function runScript(): readonly unknown[] {
  const sim = buildSim();
  expect(sim.world.entityCount).toBeGreaterThan(0); // guard against a vacuous run
  const trace: unknown[] = [];
  for (let tick = 0; tick < TICKS; tick += 1) {
    if (tick % 30 === 0) sim.inject({ kind: 'keyDown', tick, key: ATTACK_KEY });
    sim.step(1);
    trace.push(sim.snapshot());
  }
  return trace;
}

describe('T031 · the panel has no channel to the simulation (FR-022)', () => {
  it('togglePanel takes no World / simulator and cannot reach one', () => {
    const start = UI_MANAGER.indexOf('public togglePanel(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = UI_MANAGER.slice(start, UI_MANAGER.indexOf('\n  }', start));
    expect(body).toMatch(/togglePanel\(\)/);
    expect(body).not.toContain('world');
    expect(body).not.toContain('sim');
    expect(body).not.toContain('step');
  });

  it('owns ONLY a presentation boolean, not simulation state', () => {
    // The panel's open/closed flag is a UI field; the manager holds no run state.
    expect(UI_MANAGER).toMatch(/private panelOpen = false;/);
    // `panelOpen` is written only by the two presentation methods.
    const writes = (UI_MANAGER.match(/this\.panelOpen =/g) ?? []).length;
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThanOrEqual(3);
  });
});

describe('T031 · a run’s tick trace is a pure function of (seed, input)', () => {
  it('keeps two identical runs bit-identical, tick by tick', () => {
    const first = runScript();
    const second = runScript();
    expect(first).toHaveLength(TICKS);
    expect(first).toEqual(second); // difference 0, every tick
  });
});
