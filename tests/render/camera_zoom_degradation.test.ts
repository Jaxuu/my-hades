/**
 * M17 · US4 — the degraded paths are bit-for-bit the pre-M17 behaviour
 * (specs/025-camera-zoom-viewport, FR-014 / FR-021 and
 * contracts/camera-zoom-viewport `zoom-fit-and-degradation.md` §3/§7/§8).
 *
 * WHY THIS IS THE MOST IMPORTANT SUITE IN THE FEATURE
 * --------------------------------------------------
 * Every one of the 803 pre-M17 assertions is unchanged, and they keep passing
 * because of ONE mechanism: when the zoom is not active, the camera target is the
 * old formula, written with the same expressions. `x * 1 === x` in IEEE-754, so the
 * frozen `toBeCloseTo(..., 6)` convergence assertions do not move by a bit.
 *
 * The key is the PREDICATE, not the value of `z`. Two of the four degraded paths
 * have a perfectly readable viewport (a world with no walls, and the camp) — if the
 * predicate only asked "is there a viewport?", `camera_adversarial` C4 would start
 * failing, because it rigs a real 800x600 screen with no walls and asserts the old
 * `screen/2 - playerPx` target. That is why "no room extent" is a degradation in its
 * own right, and why it is tested here on both halves.
 *
 * The bit-identity claim is not asserted by "close to" — it is asserted by
 * REPLAYING the old recurrence in plain floats and demanding equality. A
 * `toBeCloseTo` there would hide exactly the drift this suite exists to catch.
 *
 * The final section pins the OTHER side of the boundary: `zoomActive === true` with
 * `z === 1` (a room big enough that the fit clamps up to the lower bound) is
 * deliberately NOT equivalent to the old behaviour — that is the case room mode
 * exists for, and requiring bit-identity there would make the feature impossible.
 */

import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { LevelLoader } from '../../src/core/LevelLoader';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { GameStateFactory } from '../../src/ecs/prefabs/GameStateFactory';
import { createWall } from '../../src/ecs/components/WallComponent';
import { GameRenderer, CAMERA_LERP_FACTOR, PX_PER_UNIT } from '../../client/GameRenderer';

/* ========================================================================== *
 * Rig                                                                         *
 * ========================================================================== */

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

/** The pre-M12 stand-in: no `screen` at all. */
function makeBareApp(deltaMs = 20): Application {
  const ticker: FakeTicker = { deltaMS: deltaMs, add: () => {}, remove: () => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

/** A stand-in with a real `screen` and a `renderer` getter that throws. */
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

function simWithStartRoom(): GameSimulator {
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
  LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
  return sim;
}

function simWithoutRoom(): GameSimulator {
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });
  return sim;
}

/** The player's interpolated render position in world pixels, as the camera reads it. */
function playerViewPx(renderer: GameRenderer): { x: number; y: number } {
  const root = renderer.camera.children[renderer.camera.children.length - 1];
  if (root === undefined) throw new Error('QA: no render root');
  const first = root.children[0];
  if (first === undefined) throw new Error('QA: no first view');
  return { x: first.x, y: first.y };
}

/**
 * Replay the PRE-M17 camera recurrence in plain floats: `x += (target - x) * 0.2`
 * with `target = screenWidth/2 - playerPx`.
 *
 * This is a re-implementation of the old code, not a call into the new one, so
 * comparing against it is a genuine bit-identity check rather than a tautology.
 */
function legacyCameraX(screenW: number, playerPxX: number, frames: number): number {
  let x = 0;
  const target = screenW / 2 - playerPxX;
  for (let i = 0; i < frames; i += 1) x += (target - x) * CAMERA_LERP_FACTOR;
  return x;
}

function legacyCameraY(screenH: number, playerPxY: number, frames: number): number {
  let y = 0;
  const target = screenH / 2 - playerPxY;
  for (let i = 0; i < frames; i += 1) y += (target - y) * CAMERA_LERP_FACTOR;
  return y;
}

/**
 * Mirror of the renderer's guarded read: a non-finite dimension becomes `0`, a
 * finite one is passed through (including `0` and negatives).
 *
 * This matters, and it is not pedantry: the PRE-M17 behaviour for `{width: 0,
 * height: 600}` is `screenW = 0, screenH = 600` — only the non-finite dimension is
 * zeroed. FR-014 requires the degraded camera to be bit-for-bit the OLD behaviour,
 * so the old behaviour has to be reproduced faithfully rather than assumed to be
 * "both axes zero".
 */
function guarded(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

const FRAMES = 400;

/* ========================================================================== *
 * The four degradation paths, each asserted against the same four claims      *
 * ========================================================================== */

/**
 * Assert the full degradation contract for a rig: `z === 1`, no framing mode, the
 * target is the legacy formula BIT-FOR-BIT, nothing throws, the camera still moves.
 */
function expectDegraded(
  renderer: GameRenderer,
  sim: GameSimulator,
  screenW: number,
  screenH: number,
): void {
  // (a) z is the literal identity, not "whatever ZOOM_MIN is".
  expect(renderer.zoom).toBe(1);
  expect(renderer.camera.scale.x).toBe(1);
  expect(renderer.camera.scale.y).toBe(1);
  expect(renderer.zoomActive).toBe(false);

  // (b) no framing mode is entered.
  expect(renderer.roomFits).toBe(false);

  // (c) no throw, no render block.
  expect(() => renderer.syncWorld(sim.world)).not.toThrow();
  for (let i = 0; i < FRAMES; i += 1) renderer.syncWorld(sim.world);

  // (d) the target is the legacy formula, bit for bit.
  const view = playerViewPx(renderer);
  expect(renderer.camera.x).toBe(legacyCameraX(screenW, view.x, FRAMES));
  expect(renderer.camera.y).toBe(legacyCameraY(screenH, view.y, FRAMES));
  expect(Number.isFinite(renderer.camera.x)).toBe(true);
  expect(Number.isFinite(renderer.camera.y)).toBe(true);
}

describe('D1 · an unreadable viewport degrades to identity (FR-014)', () => {
  it('no `screen` at all: z === 1, no framing mode, legacy target bit-for-bit', () => {
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeBareApp());
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(renderer.viewport.readable).toBe(false);
    // screenWidth()/screenHeight() are 0 here, so the legacy target is `-playerPx`.
    expectDegraded(renderer, sim, 0, 0);
  });
});

describe('D2 · a non-finite or non-positive viewport degrades to identity (FR-014)', () => {
  it.each([
    ['NaN x Infinity', Number.NaN, Number.POSITIVE_INFINITY],
    ['zero width', 0, 600],
    ['negative height', 800, -1],
    ['negative infinity', Number.NEGATIVE_INFINITY, 600],
    ['both zero', 0, 0],
  ])('%s: z === 1, no NaN, no divide-by-zero', (_label, w, h) => {
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeScreenApp(w, h));
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(renderer.viewport.readable).toBe(false);
    // The zoom's own viewport type zeroes BOTH axes, which is what makes the fit
    // safe; the legacy camera formula below uses the per-axis guarded read instead.
    expect(renderer.viewport.width).toBe(0);
    expect(renderer.viewport.height).toBe(0);
    expectDegraded(renderer, sim, guarded(w), guarded(h));
  });
});

describe('D3 · a world with no room degrades to identity (FR-021)', () => {
  it('no walls: z === 1 even though the viewport IS readable', () => {
    const sim = simWithoutRoom();
    const renderer = new GameRenderer(makeScreenApp(800, 600));
    renderer.init();
    renderer.syncWorld(sim.world);

    // This is the `camera_adversarial` C4 shape: a real screen, no walls. A predicate
    // that only asked "is there a viewport?" would zoom here and break C4.
    expect(renderer.viewport.readable).toBe(true);
    expect(renderer.roomExtent.determinable).toBe(false);
    expectDegraded(renderer, sim, 800, 600);

    // And the legacy target for a player at (1.5, 1.5) is (385, 285) — the exact
    // numbers C4 pins.
    expect(renderer.camera.x).toBeCloseTo(385, 6);
    expect(renderer.camera.y).toBeCloseTo(285, 6);
  });
});

describe('D4 · the camp degrades to identity even though the walls are alive (FR-021)', () => {
  it('isInHub(world) true: z === 1 despite the previous room still existing', () => {
    const sim = simWithStartRoom();
    GameStateFactory.spawn(sim.world);
    sim.enterHub();

    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);

    // The walls really are still in the world — `enterHub` does not rebuild it.
    expect(renderer.wallViewCount).toBeGreaterThan(0);
    expect(renderer.roomExtent.determinable).toBe(false);
    expectDegraded(renderer, sim, 1920, 1080);
  });
});

/* ========================================================================== *
 * The boundary's OTHER side: active zoom with z === 1                         *
 * ========================================================================== */
describe('the boundary is the PREDICATE, not the value of z', () => {
  /**
   * A room big enough that `fitZoom <= 1.25`, so the fit is clamped up to the lower
   * bound and `z === 1` — while the room still FITS, so the zoom is active and room
   * mode applies. 100x100 world units = 1000 px at 1920x1080:
   * `fitZoom = min(1.92, 1.08) = 1.08`, `z = clamp(0.864, 1, 16) = 1`.
   */
  function simWithBigFittingRoom(playerX: number, playerY: number): GameSimulator {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: playerX, y: playerY });
    createWall(sim.world, { x: 0, y: 0, width: 100, height: 100 });
    return sim;
  }

  it('zoomActive === true with z === 1 does NOT reproduce the legacy framing', () => {
    const sim = simWithBigFittingRoom(10, 10);
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    for (let i = 0; i < FRAMES; i += 1) renderer.syncWorld(sim.world);

    // The predicate is true and the factor is the identity...
    expect(renderer.zoomActive).toBe(true);
    expect(renderer.zoom).toBe(1);
    // ...and the room fits, so ROOM mode is in force.
    expect(renderer.roomFits).toBe(true);

    // Room mode pins the ROOM centre (500, 500 px) to the screen centre:
    // 960 - 500 = 460 and 540 - 500 = 40.
    expect(renderer.camera.x).toBeCloseTo(460, 6);
    expect(renderer.camera.y).toBeCloseTo(40, 6);

    // The legacy formula would have been screen/2 - playerPx = (960 - 100, 540 - 100)
    // = (860, 440) — deliberately NOT what happened.
    const view = playerViewPx(renderer);
    expect(renderer.camera.x).not.toBe(legacyCameraX(1920, view.x, FRAMES));
    expect(renderer.camera.y).not.toBe(legacyCameraY(1080, view.y, FRAMES));
    expect(renderer.camera.x).toBeLessThan(860);
  });

  it('the same room at a viewport too small to hold it enters FOLLOW mode, clamped', () => {
    // 1000 px of room in a 700 px viewport: it cannot fit, and z is still 1 because
    // the fit is below the lower bound.
    const sim = simWithBigFittingRoom(50, 50);
    const renderer = new GameRenderer(makeScreenApp(700, 700));
    renderer.init();
    for (let i = 0; i < FRAMES; i += 1) renderer.syncWorld(sim.world);

    expect(renderer.zoomActive).toBe(true);
    expect(renderer.zoom).toBe(1);
    expect(renderer.roomFits).toBe(false);

    const extent = renderer.roomExtent;
    const leftEdge = renderer.camera.x + extent.minX * PX_PER_UNIT * renderer.zoom;
    const rightEdge = renderer.camera.x + extent.maxX * PX_PER_UNIT * renderer.zoom;
    // Nothing outside the room enters the viewport, and the room fills it.
    expect(leftEdge).toBeLessThanOrEqual(1e-6);
    expect(rightEdge).toBeGreaterThanOrEqual(700 - 1e-6);
  });
});

/* ========================================================================== *
 * The reset boundary                                                          *
 * ========================================================================== */
describe('reset() forgets the zoom as well as the camera position (contract §3.8)', () => {
  it('scale returns to 1 and the extent cache is dropped', () => {
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    for (let i = 0; i < 10; i += 1) renderer.syncWorld(sim.world);
    expect(renderer.camera.scale.x).toBe(8.64);

    renderer.reset();

    expect(renderer.camera.scale.x).toBe(1);
    expect(renderer.camera.scale.y).toBe(1);
    expect(renderer.camera.x).toBe(0);
    expect(renderer.camera.y).toBe(0);
    // The cached extent belonged to the run being thrown away.
    expect(renderer.roomExtent.determinable).toBe(false);
    expect(renderer.zoom).toBe(1);

    // Reusable: the next sync re-derives everything.
    expect(() => renderer.syncWorld(sim.world)).not.toThrow();
    expect(renderer.camera.scale.x).toBe(8.64);
    expect(renderer.roomFits).toBe(true);
  });
});
