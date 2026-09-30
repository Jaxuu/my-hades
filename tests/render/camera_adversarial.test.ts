/**
 * M12-T02 · INDEPENDENT adversarial probes for the presentation-layer camera
 * (spec 20 AC-03 / I11–I14 / §4.3).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The shipped `tests/render/camera_follow.test.ts` drives the camera ONLY against a
 * fake `Application` that has NO `screen` — i.e. the degradation path where the
 * target is `-playerPx`. The REAL screen-size path (`screenWidth()/2 - playerPx`) is
 * therefore UNTESTED, and that is the most likely hole. This file closes it, and
 * probes the four other things a naive camera wiring gets wrong:
 *
 *  - convergence from an ABSURD offset (does a 0.2 lerp ever stall at non-zero?);
 *  - `destroy()` / `reset()` completeness (is the camera really detached?);
 *  - `init()` twice, and `syncWorld` before `init()`;
 *  - the `NaN` alpha path (INVARIANTS M5 records one NaN channel — is there a second?).
 *
 * The rig drives the REAL `GameSimulator` + the REAL `GameRenderer` against
 * duck-typed `Application` stand-ins. PixiJS v8 cannot be driven from plain Node;
 * the renderer only ever needs `stage` / `ticker` / `screen`.
 *
 * PixiJS v8 under plain Node: NEVER read `.width` / `.height` / bounds on a `Text`
 * (lazy canvas measurement ⇒ `document is not defined`). Only `.text` / `.x` / `.y`
 * / `.parent` are touched.
 */

import { describe, expect, it } from 'vitest';
import { Container, Text } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { LevelLoader } from '../../src/core/LevelLoader';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { applyDamage } from '../../src/ecs/components/HealthComponent';
import { GameRenderer, PX_PER_UNIT, CAMERA_LERP_FACTOR } from '../../client/GameRenderer';
import { testEnemy } from '../harness/config-fixtures';

/* ========================================================================== *
 * Stand-ins                                                                   *
 * ========================================================================== */

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

/** The pre-M12 stand-in: a real Container stage + a controllable ticker, NO screen. */
function makeBareApp(deltaMs = 20): Application {
  const ticker: FakeTicker = { deltaMS: deltaMs, add: () => {}, remove: () => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

/**
 * A stand-in WITH a real `screen` — the path no shipped test covers — and a
 * `renderer` property that THROWS on access.
 *
 * The throwing getter is the adversarial part: `screenWidth()` / `screenHeight()`
 * are only allowed to read `app.screen`; if any code path reached for
 * `app.renderer.*` (the other place a size might live) this rig would blow up rather
 * than silently pass.
 */
function makeScreenApp(width: number, height: number, deltaMs = 20): Application {
  const ticker: FakeTicker = { deltaMS: deltaMs, add: () => {}, remove: () => {} };
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

/** The render root: the CAMERA's LAST child (the static layer, if any, is index 0). */
function renderRoot(renderer: GameRenderer): Container {
  const camera = renderer.camera;
  const root = camera.children[camera.children.length - 1];
  if (root === undefined) throw new Error('QA: no render root under the camera');
  return root;
}

/** Every `Text` node anywhere under `container`, depth-first. */
function findTexts(container: Container): Text[] {
  const out: Text[] = [];
  for (const child of container.children) {
    if (child instanceof Text) out.push(child);
    out.push(...findTexts(child));
  }
  return out;
}

/* ========================================================================== *
 * C1 · convergence from an absurd offset                                      *
 * ========================================================================== */
describe('C1 · the lerp converges from a 1e6 offset (no float stall above 1e-9)', () => {
  /** Sync until `|camera.x - target| <= 1e-9`; return the frame count (cap 5000). */
  function framesToConverge(renderer: GameRenderer, world: GameSimulator['world'], target: number): number {
    for (let frame = 0; frame < 5000; frame += 1) {
      if (Math.abs(renderer.camera.x - target) <= 1e-9) return frame;
      renderer.syncWorld(world);
    }
    return 5000;
  }

  it('converges from +1e6 and from -1e6 within a few hundred frames', () => {
    for (const start of [1e6, -1e6]) {
      const app = makeBareApp();
      const sim = new GameSimulator({ systems: createDefaultSystems() });
      PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 }); // px (15, 15)
      const renderer = new GameRenderer(app);
      renderer.init();
      renderer.syncWorld(sim.world); // build the view

      renderer.camera.x = start;
      const target = -1.5 * PX_PER_UNIT; // no screen ⇒ target = -playerPx = -15

      const frames = framesToConverge(renderer, sim.world, target);
      // The geometric decay `0.8^n` needs ~155 frames to clear 1e-9 from 1e6; a few
      // hundred is a generous bound that still fails loudly on a true stall.
      expect(frames).toBeLessThan(400);
      expect(Math.abs(renderer.camera.x - target)).toBeLessThanOrEqual(1e-9);
      expect(Number.isFinite(renderer.camera.x)).toBe(true);
    }
  });

  it('the residual after a long run is finite and tiny (measured, not assumed)', () => {
    const app = makeBareApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);

    renderer.camera.x = 1e6;
    for (let i = 0; i < 2000; i += 1) renderer.syncWorld(sim.world);

    const target = -1.5 * PX_PER_UNIT;
    // The lerp is a first-order decay: `camera.x` may never be BIT-exactly the
    // target (it stalls once `0.2 * diff` drops below one ULP), but the residual is
    // far below any observable threshold. This is the characterisation, asserted.
    expect(Math.abs(renderer.camera.x - target)).toBeLessThan(1e-12);
    expect(Number.isFinite(renderer.camera.x)).toBe(true);
  });

  it('CAMERA_LERP_FACTOR is the documented 0.2 (a literal pin)', () => {
    expect(CAMERA_LERP_FACTOR).toBe(0.2);
  });
});

/* ========================================================================== *
 * C2 · destroy() / reset() completeness                                       *
 * ========================================================================== */
describe('C2 · destroy() detaches the camera; reset() zeroes it (AC-03)', () => {
  it('after destroy() the stage has no children left', () => {
    const app = makeBareApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);
    expect(app.stage.children).toHaveLength(1);

    renderer.destroy();

    // The camera is now the thing ON the stage, so `root.destroy()` alone would
    // leak it. A complete teardown removes it from the stage.
    expect(app.stage.children).toHaveLength(0);
  });

  it('reset() zeroes the camera and the scene graph is reusable afterwards', () => {
    const app = makeBareApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 4, y: 4 });
    const renderer = new GameRenderer(app);
    renderer.init();
    for (let i = 0; i < 60; i += 1) renderer.syncWorld(sim.world);
    expect(renderer.camera.x).not.toBe(0);

    renderer.reset();
    expect(renderer.camera.x).toBe(0);
    expect(renderer.camera.y).toBe(0);

    // Reusable: a fresh sync rebuilds the views and moves the camera again, and the
    // scene-graph contract (camera is the ONE stage child) still holds.
    expect(() => renderer.syncWorld(sim.world)).not.toThrow();
    expect(app.stage.children).toHaveLength(1);
    expect(app.stage.children[0]).toBe(renderer.camera);
    expect(renderer.viewCount).toBe(1);
  });
});

/* ========================================================================== *
 * C3 · init() twice / syncWorld before init()                                 *
 * ========================================================================== */
describe('C3 · init() is idempotent; syncWorld before init() does not throw', () => {
  it('calling init() twice keeps exactly one camera on the stage', () => {
    const app = makeBareApp();
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.init();

    expect(app.stage.children).toHaveLength(1);
    expect(app.stage.children[0]).toBe(renderer.camera);
    // The root is still the camera's last (and only) child, not duplicated.
    expect(renderer.camera.children).toHaveLength(1);
  });

  it('syncWorld before init() does not throw (addChildAt on an empty container appends)', () => {
    const app = makeBareApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 2, y: 2 });
    const renderer = new GameRenderer(app);

    // No init(): the root has no fxLayer yet. `createMissingViews` must not index out
    // of bounds, and `syncCamera` must still run (the player view exists).
    expect(() => renderer.syncWorld(sim.world)).not.toThrow();
    expect(renderer.viewCount).toBe(1);
  });
});

/* ========================================================================== *
 * C4 · the REAL screen-size path (the uncovered hole)                         *
 * ========================================================================== */
describe('C4 · with a real screen the target is screen/2 - playerPx (AC-03)', () => {
  it('centres the player: target = (400 - playerPxX, 300 - playerPyY)', () => {
    const app = makeScreenApp(800, 600);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 }); // px (15, 15)

    const renderer = new GameRenderer(app);
    renderer.init();
    for (let i = 0; i < 200; i += 1) renderer.syncWorld(sim.world);

    // 800/2 - 15 = 385; 600/2 - 15 = 285.
    expect(renderer.camera.x).toBeCloseTo(385, 6);
    expect(renderer.camera.y).toBeCloseTo(285, 6);
  });

  it('reads app.screen ONLY — never app.renderer (throwing getter proves it)', () => {
    // `makeScreenApp` throws from `renderer`; a successful sync is the proof that no
    // code path touched it.
    const app = makeScreenApp(640, 480);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const renderer = new GameRenderer(app);
    renderer.init();
    expect(() => renderer.syncWorld(sim.world)).not.toThrow();
    // 640/2 - 0 = 320.
    for (let i = 0; i < 200; i += 1) renderer.syncWorld(sim.world);
    expect(renderer.camera.x).toBeCloseTo(320, 6);
  });

  it('a non-finite screen dimension degrades to 0 rather than NaN', () => {
    const app = makeScreenApp(Number.NaN, Number.POSITIVE_INFINITY);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 2, y: 2 }); // px (20, 20)
    const renderer = new GameRenderer(app);
    renderer.init();
    for (let i = 0; i < 200; i += 1) renderer.syncWorld(sim.world);

    // Both dimensions degrade to 0 ⇒ target = -playerPx = (-20, -20).
    expect(renderer.camera.x).toBeCloseTo(-20, 6);
    expect(renderer.camera.y).toBeCloseTo(-20, 6);
    expect(Number.isFinite(renderer.camera.x)).toBe(true);
    expect(Number.isFinite(renderer.camera.y)).toBe(true);
  });
});

/* ========================================================================== *
 * C5 · the NaN alpha path                                                     *
 * ========================================================================== */
describe('C5 · syncWorld(world, NaN) — is there a SECOND NaN channel?', () => {
  it('NaN alpha propagates into camera.x/y as well as the entity view (measured)', () => {
    const app = makeBareApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 2, y: 2 });
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world); // build view at finite alpha

    renderer.syncWorld(sim.world, Number.NaN);

    // CHARACTERISATION (INVARIANTS M5 records ONE NaN channel — the entity view).
    // Measured here: the camera is a SECOND one. syncTransforms writes a NaN into the
    // player view, and syncCamera then computes target = screen/2 - NaN = NaN, so
    // camera.x/y become NaN too. Pinned so a future fix is a deliberate change.
    const view = renderRoot(renderer).children[0];
    if (view === undefined) throw new Error('QA: no player view');
    expect(Number.isNaN(view.x)).toBe(true);
    expect(Number.isNaN(renderer.camera.x)).toBe(true);
    expect(Number.isNaN(renderer.camera.y)).toBe(true);
  });

  it('+/-Infinity alpha clamps (no NaN, no extrapolation)', () => {
    const app = makeBareApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 2, y: 2 });
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(renderer.camera.x)).toBe(true);
    renderer.syncWorld(sim.world, Number.NEGATIVE_INFINITY);
    expect(Number.isFinite(renderer.camera.x)).toBe(true);
  });
});

/* ========================================================================== *
 * C6 · the floating-text chain rides the camera                                *
 * ========================================================================== */
describe('C6 · floaters carry WORLD pixels and ride the whole chain (AC-03)', () => {
  it('stage -> camera -> root -> fxLayer -> floater, with world-pixel coords', () => {
    const app = makeBareApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const enemyId = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 3, y: 0, hp: 100, maxHp: 100 }));
    sim.step(1);

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1); // seed lastHp
    applyDamage(sim.world, enemyId, 10);
    renderer.syncWorld(sim.world, 1); // spawn the floater

    const camera = renderer.camera;
    const root = renderRoot(renderer);
    const fxLayer = root.children[root.children.length - 1];
    if (fxLayer === undefined) throw new Error('QA: no FX layer');

    // The FULL parent chain, all the way up to the stage.
    expect(camera.parent).toBe(app.stage);
    expect(root.parent).toBe(camera);
    expect(fxLayer.parent).toBe(root);

    const texts = findTexts(root);
    expect(texts).toHaveLength(1);
    const floater = texts[0];
    if (floater === undefined) throw new Error('QA: no floater');
    expect(floater.parent).toBe(fxLayer);
    // The floater's x is the enemy's WORLD pixel x, unmodified by the camera.
    expect(floater.x).toBe(3 * PX_PER_UNIT);
  });
});

/* ========================================================================== *
 * C7 · the static layer's index on the camera                                  *
 * ========================================================================== */
describe('C7 · the static layer is camera index 0 and disappears with the room (AC-03)', () => {
  it('with walls: children[0] is the static layer, last is the root; after teardown only the root remains', () => {
    const app = makeBareApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });
    const renderer = new GameRenderer(app);
    renderer.init();

    // No walls yet: the camera holds only the root.
    renderer.syncWorld(sim.world);
    expect(renderer.camera.children).toHaveLength(1);
    const root = renderRoot(renderer);

    const result = LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
    expect(result.wallCount).toBeGreaterThan(0);
    renderer.syncWorld(sim.world);

    const camera = renderer.camera;
    expect(camera.children).toHaveLength(2);
    expect(camera.children[0]).not.toBe(root); // the static layer, behind the root
    expect(camera.children[camera.children.length - 1]).toBe(root);

    // Tear the room down: the static layer goes, the root stays.
    LevelLoader.clearRoomEntities(sim.world);
    renderer.syncWorld(sim.world);
    expect(renderer.wallViewCount).toBe(0);
    expect(camera.children).toHaveLength(1);
    expect(camera.children[0]).toBe(root);
  });
});
