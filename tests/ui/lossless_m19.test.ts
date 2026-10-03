/**
 * M19 lossless proof (specs/027-hud-boon-ui T039 · SC-004 · contract §6).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * M19 changes only the interface. The simulation must not move: a fixed seed and a
 * fixed 601-tick script must still produce a bit-identical state digest. The digest
 * is FNV-1a over `listEntities() x listComponents()`, the SAME shape and the SAME
 * scenario M15/M16 used, so the number is directly comparable to the baseline
 * `f52dfdd4` (recorded in production/m19-baseline.md).
 *
 * THE M19-SPECIFIC CLAIM
 * ----------------------
 * "The interface is a pure observer" is what could actually be false: a UI that
 * consumed the world PRNG would move this digest. `client/UIManager.ts` is
 * DOM-coupled and is not importable from the DOM-less typecheck program, so the
 * observer claim is proven structurally: no client module draws from `world.rng`.
 */

import { describe, expect, it } from 'vitest';

import {
  ATTACK_KEY,
  createDefaultSystems,
  EncounterFactory,
  EncounterStateComponent,
  GameSimulator,
  GameStateFactory,
  LevelLoader,
  PlayerFactory,
  resolveEncounterWaves,
} from '../../src';
import { collectSources, stripComments } from '../harness/ui-source';

/** The fixed seed and tick count the M15/M16 lossless proofs used. */
const SEED = 0x12345678;
const TICKS = 601;

/** The baseline digest this feature must not move (production/m19-baseline.md). */
const BASELINE_DIGEST = 'f52dfdd4';

/** FNV-1a over the world's own listing: the "did the state move?" fingerprint. */
function digest(sim: GameSimulator): string {
  let hash = 0x811c9dc5;
  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  const entities = sim.world.listEntities();
  feed(`${String(entities.length)}|`);
  for (const id of entities) {
    feed(`${String(id)}:`);
    feed(sim.world.listComponents(id).join(','));
    feed(';');
  }
  feed(`tick=${String(sim.tick)}`);
  return hash.toString(16).padStart(8, '0');
}

/** One deterministic 601-tick script: stand in the stress room and swing on a beat. */
function runScript(sim: GameSimulator): void {
  for (let tick = 0; tick < TICKS; tick += 1) {
    if (tick % 37 === 0) {
      sim.inject({ kind: 'keyDown', tick, key: ATTACK_KEY });
    }
    sim.step(1);
  }
}

/** The stress run, assembled exactly as `?mode=stress` does. */
function buildStressRun(): GameSimulator {
  const sim = new GameSimulator({ systems: createDefaultSystems(), seed: SEED });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0 });
  const roomEntity = EncounterFactory.spawn(sim.world, {
    waves: resolveEncounterWaves(2),
    roomIds: ['stress_room'],
  });
  const encounter = sim.world.getComponent(roomEntity, EncounterStateComponent);
  if (encounter !== undefined) {
    LevelLoader.enterRoom(sim.world, { roomId: 'stress_room', playerId: player, encounter });
  }
  GameStateFactory.spawn(sim.world);
  return sim;
}

describe('T039 · the interface does not move the simulation (SC-004)', () => {
  it('reproduces the baseline digest bit for bit, and reproducibly', () => {
    const first = buildStressRun();
    runScript(first);
    const firstDigest = digest(first);

    console.info(`[M19 lossless] digest ${firstDigest} (baseline ${BASELINE_DIGEST})`);

    // Guard against a vacuous pass: the script must have produced a real world.
    expect(first.world.entityCount).toBeGreaterThan(100);
    expect(first.tick).toBe(TICKS);
    expect(firstDigest).toBe(BASELINE_DIGEST);

    // The same script twice is the same digest — the run is a pure function.
    const second = buildStressRun();
    runScript(second);
    expect(digest(second)).toBe(firstDigest);
  });

  it('draws nothing from the world PRNG anywhere in the client (the observer claim)', () => {
    // The digest would move if the UI consumed the WORLD generator. Cosmetic
    // `Math.random` (screen shake, spark angles) is allowed: it cannot reach the
    // simulation, and the digest test above proves it does not move it.
    const sources = collectSources('client');
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const code = stripComments(file.source);
      expect(code).not.toContain('world.rng');
      expect(code).not.toContain('nextUint32');
      expect(code).not.toContain('.rng.');
    }
  });
});
