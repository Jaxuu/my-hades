/**
 * Lossless proof for the art milestone (specs/024-real-art-assets T044, SC-004/FR-014).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * M16 replaces every placeholder with real art. The one thing that must NOT change
 * is the SIMULATION: same seed + same input must still produce the same state,
 * tick for tick. Two independent proofs are recorded here, because they fail for
 * different reasons:
 *
 *  1. **`src/` is untouched.** Proven outside this file by `git status --short src/`
 *     being empty — the simulation core is byte-identical to the pre-M16 commit, so
 *     no digest can have moved. (Recorded in the M16 verification report.)
 *  2. **Rendering is a pure observer.** Proven HERE, and it is the claim that could
 *     actually be false: the renderer now READS more state (enemy capability
 *     components, animation state, pickup kinds) and could, in principle, consume
 *     randomness or write a component. The digest is computed over
 *     `listEntities() x listComponents()` for a fixed seed and a fixed 601-tick
 *     script, with and without a live renderer attached, and must be identical.
 *
 * The digest is FNV-1a over the entity/component listing — the same shape M15 used,
 * so the numbers are comparable across milestones.
 */

import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { EncounterFactory, resolveEncounterWaves } from '../../src/ecs/prefabs/EncounterFactory';
import { GameStateFactory } from '../../src/ecs/prefabs/GameStateFactory';
import { LevelLoader } from '../../src/core/LevelLoader';
import { EncounterStateComponent } from '../../src/ecs/components/EncounterStateComponent';
import { ATTACK_KEY } from '../../src/ecs/components/PlayerInputComponent';
import { GameRenderer } from '../../client/GameRenderer';
import { NULL_SPRITE_PROVIDER } from '../../client/assets/AssetCatalog';
import { WHITE_LOADER, loadedCatalog } from '../harness/art-fixtures';
import { AssetCatalog } from '../../client/assets/AssetCatalog';

/** The fixed seed and tick count the M15 lossless proof used. */
const SEED = 0x12345678;
const TICKS = 601;

function makeApp(): Application {
  const ticker = { deltaMS: 16, add: (): void => {}, remove: (): void => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

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

describe('T044 · the art layer does not move the simulation (SC-004 / FR-014)', () => {
  it('produces a bit-identical digest with and without a live renderer', async () => {
    // --- run A: no renderer at all (the pre-M16 measurement) -------------------
    const plain = buildStressRun();
    runScript(plain);
    const plainDigest = digest(plain);

    // --- run B: the SAME script, with a renderer + the real atlas attached -----
    const catalog = new AssetCatalog(WHITE_LOADER);
    await catalog.load();
    const rendered = buildStressRun();
    const app = makeApp();
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    for (let tick = 0; tick < TICKS; tick += 1) {
      if (tick % 37 === 0) {
        rendered.inject({ kind: 'keyDown', tick, key: ATTACK_KEY });
      }
      rendered.step(1);
      // A real frame: transforms, animation advance, VFX, camera — everything the
      // browser would do between two ticks.
      renderer.syncWorld(rendered.world, 0.5);
    }
    const renderedDigest = digest(rendered);

    console.info(
      `[M16 lossless] no-renderer digest ${plainDigest}, rendered digest ${renderedDigest}`,
    );
    expect(plainDigest).toBe(renderedDigest);
    // Guard against a vacuous pass: the script must have produced a real world.
    expect(plain.world.entityCount).toBeGreaterThan(100);
    expect(plain.tick).toBe(TICKS);
    renderer.destroy();
  });

  it('is reproducible: the same script twice gives the same digest', () => {
    const first = buildStressRun();
    runScript(first);
    const second = buildStressRun();
    runScript(second);
    expect(digest(first)).toBe(digest(second));
  });

  it('does not consume the world PRNG (the renderer never draws)', () => {
    // The honest form of "the renderer consumed no randomness": compare the
    // generator's NEXT value against an untouched twin after a full rendered run.
    const twin = buildStressRun();
    runScript(twin);

    const rendered = buildStressRun();
    const app = makeApp();
    const renderer = new GameRenderer(app, NULL_SPRITE_PROVIDER);
    renderer.init();
    for (let tick = 0; tick < TICKS; tick += 1) {
      if (tick % 37 === 0) {
        rendered.inject({ kind: 'keyDown', tick, key: ATTACK_KEY });
      }
      rendered.step(1);
      renderer.syncWorld(rendered.world, 0.5);
    }

    expect(rendered.world.rng.nextUint32()).toBe(twin.world.rng.nextUint32());
    renderer.destroy();
  });

  it('leaves the snapshot deep-frozen and unchanged by a render pass', async () => {
    const catalog = await loadedCatalog();
    const sim = buildStressRun();
    sim.step(120);

    const app = makeApp();
    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    for (let i = 0; i < 30; i += 1) renderer.syncWorld(sim.world, 0.5);

    const before = sim.snapshot();
    for (let i = 0; i < 30; i += 1) renderer.syncWorld(sim.world, 0.5);
    const after = sim.snapshot();
    expect(after).toEqual(before);
    expect(Object.isFrozen(before)).toBe(true);
    renderer.destroy();
  });
});
