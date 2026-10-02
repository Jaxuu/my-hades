/**
 * M17 · US4 — an ACTIVE zoom does not move the simulation
 * (specs/025-camera-zoom-viewport, SC-004 / FR-013, contract §4).
 *
 * WHY THIS IS A SEPARATE PROOF FROM THE M16 ONE
 * --------------------------------------------
 * `tests/harness/render_art_lossless.test.ts` already proves the art layer is a pure
 * observer — but it does so on a rig with NO `screen`, i.e. the DEGRADED path where
 * the zoom is exactly `1` and the framing is the pre-M17 formula. That proves
 * nothing about the zoom: a zoom of `1` is not a zoom.
 *
 * This suite is the one that matters for SC-004: it runs the 601-tick 150-enemy
 * script with a renderer whose zoom is genuinely ACTIVE (`zoomActive === true`,
 * `z = 2.88` on the 30x30 stress room) and demands the SAME digest the un-rendered
 * runs produce.
 *
 * WHY THE UN-RENDERED CONTROL IS A LITERAL RATHER THAN A SECOND RUN
 * ----------------------------------------------------------------
 * `f52dfdd4` is not a number this file invented: it is the digest that M15 and M16
 * independently computed for this exact scenario (seed `0x12345678`, this script,
 * 601 ticks) and that `render_art_lossless.test.ts` still asserts on every run. So
 * "the rendered digest equals `f52dfdd4`" IS the statement "the rendered digest
 * equals the un-rendered digest" — with the control computed by a different
 * milestone, on a different day, rather than by a second copy of the same loop.
 *
 * That matters beyond elegance: a 601-tick 150-enemy run costs ~0.4 s of solid CPU,
 * and `tests/performance/stress.test.ts` (M15) asserts a WALL-CLOCK scaling ratio, so
 * it is the suite member that suffers most from a busy neighbour — the M16 report
 * already registered that risk. Paying for a redundant control run made this file
 * the neighbour in question. One run, and the strongest available control.
 *
 * A second, deliberately CHEAP in-file control is kept below so the file is still
 * self-contained: a small world run both ways, asserting the two digests agree.
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

/** The same seed, script and tick count M15 / M16 used. */
const SEED = 0x12345678;
const TICKS = 601;

/**
 * The digest M15 and M16 independently computed for this exact scenario, and that
 * `render_art_lossless.test.ts` still pins. Asserted as a LITERAL — comparing it
 * against a value this file computed itself would be the tautology INVARIANTS §3
 * warns about.
 */
const PINNED_STRESS_DIGEST = 'f52dfdd4';

/** A rig WITH a screen, so the zoom is active rather than degraded. */
function makeScreenApp(width = 1920, height = 1080): Application {
  const ticker = { deltaMS: 16, add: (): void => {}, remove: (): void => {} };
  const app = {
    stage: new Container(),
    ticker,
    screen: { width, height },
    get renderer(): never {
      throw new Error('QA: the render layer read app.renderer, which it must never do');
    },
  };
  return app as unknown as Application;
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

/** One deterministic script of `ticks`, swinging on a beat. */
function runScript(sim: GameSimulator, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    if (tick % 37 === 0) sim.inject({ kind: 'keyDown', tick, key: ATTACK_KEY });
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

/** A small world in a real room — the cheap in-file control. */
function buildSmallRun(): GameSimulator {
  const sim = new GameSimulator({ systems: createDefaultSystems(), seed: SEED });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0 });
  const roomEntity = EncounterFactory.spawn(sim.world, {
    waves: resolveEncounterWaves(1),
    roomIds: ['start_room'],
  });
  const encounter = sim.world.getComponent(roomEntity, EncounterStateComponent);
  if (encounter !== undefined) {
    LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player, encounter });
  }
  GameStateFactory.spawn(sim.world);
  return sim;
}

describe('T023 · an ACTIVE zoom does not move the simulation (SC-004 / FR-013)', () => {
  it('the 601-tick 150-enemy stress run under an active zoom keeps the PINNED digest', () => {
    const sim = buildStressRun();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();

    let zoomActiveFrames = 0;
    for (let tick = 0; tick < TICKS; tick += 1) {
      if (tick % 37 === 0) sim.inject({ kind: 'keyDown', tick, key: ATTACK_KEY });
      sim.step(1);
      // A real frame: transforms, animation advance, VFX, camera, zoom.
      renderer.syncWorld(sim.world, 0.5);
      if (renderer.zoomActive) zoomActiveFrames += 1;
    }
    const renderedDigest = digest(sim);
    const finalZoom = renderer.zoom;

    console.info(
      `[M17 lossless] zooming digest ${renderedDigest} vs pinned ${PINNED_STRESS_DIGEST} ` +
        `(zoomActive on ${String(zoomActiveFrames)}/${String(TICKS)} frames, z = ${finalZoom.toFixed(3)})`,
    );

    // ANTI-VACUITY FIRST: the zoom really was live, on every frame, at a factor that
    // is neither 1 nor a rounding artefact, over a world that really was populated.
    expect(zoomActiveFrames).toBe(TICKS);
    expect(finalZoom).toBeCloseTo(2.88, 9); // 30x30 room at 1920x1080
    expect(renderer.camera.scale.x).toBeCloseTo(2.88, 9);
    expect(renderer.roomFits).toBe(true);
    expect(sim.world.entityCount).toBeGreaterThan(100);
    expect(sim.tick).toBe(TICKS);

    // THE CLAIM: identical to the digest the UN-RENDERED runs of this scenario
    // produce (M15 / M16, re-asserted every run by render_art_lossless.test.ts).
    expect(renderedDigest).toBe(PINNED_STRESS_DIGEST);
    renderer.destroy();
  });

  it('a small world run BOTH ways gives the same digest (the in-file control)', () => {
    const plain = buildSmallRun();
    runScript(plain, 121);
    const plainDigest = digest(plain);

    const rendered = buildSmallRun();
    const renderer = new GameRenderer(makeScreenApp(2560, 1440));
    renderer.init();
    for (let tick = 0; tick < 121; tick += 1) {
      if (tick % 37 === 0) rendered.inject({ kind: 'keyDown', tick, key: ATTACK_KEY });
      rendered.step(1);
      renderer.syncWorld(rendered.world, 0.5);
    }
    const renderedDigest = digest(rendered);

    expect(renderer.zoomActive).toBe(true);
    expect(renderedDigest).toBe(plainDigest);
    expect(rendered.world.rng.nextUint32()).toBe(plain.world.rng.nextUint32());
    renderer.destroy();
  });

  it('leaves the snapshot deep-frozen and unchanged by a zooming render pass', () => {
    const sim = buildSmallRun();
    sim.step(60);

    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    for (let i = 0; i < 30; i += 1) renderer.syncWorld(sim.world, 0.5);
    expect(renderer.zoomActive).toBe(true);

    const before = sim.snapshot();
    for (let i = 0; i < 30; i += 1) renderer.syncWorld(sim.world, 0.5);
    const after = sim.snapshot();
    expect(after).toEqual(before);
    expect(Object.isFrozen(before)).toBe(true);
    renderer.destroy();
  });
});

