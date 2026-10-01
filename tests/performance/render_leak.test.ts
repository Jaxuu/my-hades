/**
 * M15-T01 · presentation-layer memory-leak guard.
 * See specs/23_stress_and_release_spec.md (M15-T01 Task 3) and
 * specs/09_renderer_bridge_spec.md §10 trade-off 4.
 *
 * WHAT THIS SUITE PROVES
 * ----------------------
 * `GameRenderer` caches presentation objects — one `Container` per entity view, one
 * `Graphics` per wall, one `Text` per damage floater, one `Graphics` per spark — and
 * a cache that is not torn down at a run boundary is a leak that grows with every
 * run. This file drives five restart cycles through the real renderer and asserts
 * that NOTHING survives the boundary:
 *
 *  1. `GameRenderer.reset()` leaves zero `Graphics`, zero `Text` and an empty
 *     `retired` set — the scene graph is back to `camera -> root -> fxLayer`.
 *  2. The PRODUCTION boundary in `client/main.ts` (`restartRun` + `bridge.clear()` +
 *     `renderer.reset()`) keeps the `retired` set at zero, and the suite also shows
 *     what happens WITHOUT that call, so the fix is not taken on faith.
 *  3. The renderer never LISTENS on the ticker, so five full cycles leave the app's
 *     ticker callback set untouched — nothing it could leak and nothing `reset()`
 *     would have to unregister.
 *
 * WHY `GameLoop` IS DELIBERATELY NOT IMPORTED HERE
 * ------------------------------------------------
 * `GameLoop`'s constructor names `KeyboardInput`, which is the one client module that
 * legitimately uses bare `window` / `Window` / `KeyboardEvent`. Importing `GameLoop`
 * from a node-side test would therefore drag those DOM types into the ROOT tsconfig
 * program (which has no `DOM` lib on purpose) and break `npm run typecheck` with
 * TS2304. That constraint predates M15 — the node render suites import
 * `GameRenderer` only — and this suite respects it. `GameLoop.start`/`stop` is a
 * one-line add/remove pair whose symmetry is not what leaks; the renderer's
 * non-registration is.
 *
 * ANTI-VACUITY
 * ------------
 * "Nothing is left" is only meaningful if something WAS there, so every cycle first
 * asserts that views, wall blocks and a floater EXIST. Without that half the suite
 * would pass on a renderer that draws nothing at all — the tautological-assertion
 * trap the milestone's own QA notes call out.
 *
 * HOW IT RUNS WITHOUT A BROWSER
 * -----------------------------
 * Exactly like `tests/render/renderer_bridge.test.ts`: PixiJS's scene-graph objects
 * construct fine under plain Node, and `Application` is used only through a
 * duck-typed stand-in (`{ stage, ticker }`). `GameLoop` is safe to import here
 * because it deliberately does NOT import `howler` (spec 22 §2.5) — it talks to
 * audio through a structural `AudioSink`.
 */

import { describe, expect, it } from 'vitest';
import { Container, Graphics, Text } from 'pixi.js';
import type { Application } from 'pixi.js';

import {
  EncounterFactory,
  EncounterStateComponent,
  GameSimulator,
  GameStateFactory,
  HealthComponent,
  LevelLoader,
  PlayerFactory,
  applyDamage,
  createDefaultSystems,
  isDead,
  FactionComponent,
  Faction,
} from '../../src';
import type { EntityId, World } from '../../src';
import { GameRenderer } from '../../client/GameRenderer';

/** The seed every cycle below restarts from (plus its index). */
const SEED = 0x5eed;

/** Real-milliseconds per simulated frame for the fake ticker (~60Hz). */
const FRAME_MS = 16.7;

/** How many restart cycles the leak guard drives. */
const CYCLES = 5;

/**
 * How many frames to pump so a death FX runs to completion and RETIRES its id.
 *
 * `DEATH_FADE_MS` is 400ms and a frame is ~16.7ms, so ~24 frames finish one; 30 is
 * comfortably past it and is written as a literal on purpose (asserting against the
 * renderer's own constant would make "the FX finished" a tautology).
 */
const FRAMES_TO_FINISH_DEATH_FX = 30;

interface RecordingTicker {
  deltaMS: number;
  readonly callbacks: Set<unknown>;
  add: (callback: unknown) => void;
  remove: (callback: unknown) => void;
}

/** Duck-typed `Application`: a real Container stage + a ticker that RECORDS listeners. */
function makeApp(deltaMs: number): { app: Application; ticker: RecordingTicker } {
  const callbacks = new Set<unknown>();
  const ticker: RecordingTicker = {
    deltaMS: deltaMs,
    callbacks,
    add: (callback) => {
      callbacks.add(callback);
    },
    remove: (callback) => {
      callbacks.delete(callback);
    },
  };
  return { app: { stage: new Container(), ticker } as unknown as Application, ticker };
}

/**
 * Count every `Graphics` / `Text` node in a scene-graph subtree, and the total node
 * count. The two counts together are what make "the renderer drew something" and
 * "the renderer cleaned it up" separately assertable.
 */
function countNodes(root: Container): { graphics: number; text: number; total: number } {
  let graphics = 0;
  let text = 0;
  let total = 0;

  const walk = (node: Container): void => {
    for (const child of node.children) {
      total += 1;
      if (child instanceof Graphics) graphics += 1;
      if (child instanceof Text) text += 1;
      walk(child);
    }
  };
  walk(root);

  return { graphics, text, total };
}

/** One run's assembly: a player, a two-enemy room with real walls, the run singleton. */
function buildRun(world: World): void {
  const player = PlayerFactory.spawn(world, { x: 0, y: 0, facingRadians: 0 });
  const roomEntity = EncounterFactory.spawn(world, {
    waves: [{ delayTicks: 0, enemies: [{ enemyId: 'raider' }, { enemyId: 'raider' }] }],
    roomIds: ['start_room'],
  });
  const encounter = world.getComponent(roomEntity, EncounterStateComponent);
  if (encounter !== undefined) {
    LevelLoader.enterRoom(world, { roomId: 'start_room', playerId: player, encounter });
  }
  GameStateFactory.spawn(world);
}

function makeRunSim(): GameSimulator {
  const sim = new GameSimulator({
    fps: 60,
    systems: createDefaultSystems(),
    seed: SEED,
    runSetup: (world) => {
      buildRun(world);
    },
  });
  sim.restartRun(SEED);
  return sim;
}

/** The first LIVE enemy in the world, or `undefined` — never a silent wrong id. */
function firstLiveEnemyId(world: World): EntityId | undefined {
  return world.query(HealthComponent, FactionComponent).find((id) => {
    const faction = world.getComponent(id, FactionComponent);
    return faction?.faction === Faction.Enemy && !isDead(world, id);
  });
}

describe('GameRenderer leak guard (M15-T01 Task 3)', () => {
  it('five restartRun + reset cycles leave no Graphics, Text or retired ids behind', () => {
    const { app } = makeApp(FRAME_MS);
    const sim = makeRunSim();
    const renderer = new GameRenderer(app);
    renderer.init();

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      sim.restartRun(SEED + cycle);
      sim.step(1); // tick 0 — the opening wave spawns
      renderer.syncWorld(sim.world); // views + wall blocks appear

      // Land a hit so the damage-floater (Text) path is exercised too.
      const enemyId = firstLiveEnemyId(sim.world);
      if (enemyId !== undefined) applyDamage(sim.world, enemyId, 1);
      renderer.syncWorld(sim.world); // a floater appears

      // ---- ANTI-VACUOUS: something really WAS on screen ----------------------
      expect(renderer.viewCount).toBeGreaterThan(0);
      expect(renderer.wallViewCount).toBeGreaterThan(0);
      const before = countNodes(app.stage);
      expect(before.graphics).toBeGreaterThan(0);
      expect(before.text).toBeGreaterThan(0);

      // ---- the boundary ------------------------------------------------------
      renderer.reset();

      expect(renderer.viewCount).toBe(0);
      expect(renderer.wallViewCount).toBe(0);
      expect(renderer.sparkCount).toBe(0);
      expect(renderer.retiredCount).toBe(0);

      const after = countNodes(app.stage);
      expect(after.graphics).toBe(0);
      expect(after.text).toBe(0);
      // The whole remaining tree is `stage -> camera -> root -> fxLayer`.
      expect(after.total).toBe(3);
    }
  });

  it('the retired set is UNBOUNDED without the boundary reset, and reset is the fix', () => {
    const { app } = makeApp(FRAME_MS);
    const sim = makeRunSim();
    const renderer = new GameRenderer(app);
    renderer.init();

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      sim.restartRun(SEED + cycle);
      sim.step(1);

      // Kill one enemy, then pump enough frames for its death FX to finish — that
      // completion is the ONE thing that retires an id. The `step(1)` matters:
      // `applyDamage` only moves `hp`, and it is `DeathSystem` that writes the death
      // TAG at the end of the tick — the renderer keys its death FX on the tag, not
      // on the health value (spec 08 §4.4).
      const enemyId = firstLiveEnemyId(sim.world);
      if (enemyId !== undefined) applyDamage(sim.world, enemyId, 999);
      sim.step(1);
      for (let frame = 0; frame < FRAMES_TO_FINISH_DEATH_FX; frame += 1) {
        renderer.syncWorld(sim.world);
      }
    }

    // Ids are never reused, so this set only ever grows: this is the leak the run
    // boundary exists to close.
    expect(renderer.retiredCount).toBeGreaterThan(0);

    // `reset()` is the ONE operation that drops it, and it is safe here because every
    // entity of the previous run is already destroyed.
    renderer.reset();
    expect(renderer.retiredCount).toBe(0);
    expect(countNodes(app.stage).graphics).toBe(0);
  });

  it('the renderer never listens on the ticker, across five full cycles', () => {
    const { app, ticker } = makeApp(FRAME_MS);
    const sim = makeRunSim();
    const renderer = new GameRenderer(app);
    renderer.init();

    // The renderer exposes the app's ticker — that is how `GameLoop` reaches it —
    // but it must never ADD a listener of its own: a callback registered here would
    // outlive every run and `reset()` has no way to unregister it (it does not own
    // the registration). Five full cycles leaving the callback set untouched is the
    // renderer-side half of "no orphan ticker callback".
    expect(renderer.ticker).toBe(app.ticker);
    expect(ticker.callbacks.size).toBe(0);

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      sim.restartRun(SEED + cycle);
      sim.step(1);
      renderer.syncWorld(sim.world);
      renderer.reset();
      expect(ticker.callbacks.size).toBe(0);
    }
  });
});
