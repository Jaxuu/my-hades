/**
 * M17 · The zoom primitives: read-only inputs and pure functions
 * (specs/025-camera-zoom-viewport, contracts/zoom-fit-and-degradation.md §1/§2/§3).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * Every later user story is built on four things, and each of them is a place a
 * "make the room bigger" change goes wrong in a way the browser will not tell you
 * about:
 *
 *  1. **`viewport` is a GUARDED read of `app.screen` only.** The render rigs are
 *     duck-typed `Application`s, so `app.screen` is `undefined` at runtime. Reading
 *     `app.renderer.*` instead — the other place a size might live — throws in the
 *     rigs that define it as a throwing getter, and that rig is reused here.
 *  2. **`roomExtent` is DERIVED, never assumed.** No walls, a room that is not a
 *     room (the camp keeps the previous room's walls alive — spec 21), and a
 *     non-positive extent must all read as "not determinable", because that is what
 *     makes the zoom degrade to identity instead of dividing by zero.
 *  3. **`zoom` is a PURE function of `(roomExtent, viewport)`.** Same inputs, same
 *     output, always — no wall clock, no randomness, no history (FR-020).
 *  4. **`roomFits` depends on exactly three inputs** and never on the player's
 *     position (FR-004). That is what lets the camera hold still in room mode.
 *
 * The expected numbers are pinned as LITERALS (`8.64`, `16`, `1`) rather than as
 * "whatever `computeZoom` returns" — asserting a value equals the constant that
 * produced it is a tautology, not a test (INVARIANTS §3).
 *
 * NOTE ON THE FIXTURE: `LevelLoader.enterRoom` is the ONLY thing that puts walls in
 * a world, so the room fixtures here are real rooms from `assets/data/rooms.json`
 * (10x10 / 12x10 / 30x30), not hand-placed blocks.
 */

import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { LevelLoader } from '../../src/core/LevelLoader';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { GameStateFactory } from '../../src/ecs/prefabs/GameStateFactory';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { WallComponent, createWall } from '../../src/ecs/components/WallComponent';
import { vec2 } from '../../src/core/math';
import {
  GameRenderer,
  PX_PER_UNIT,
  ZOOM_FIT_MARGIN,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../../client/GameRenderer';

/* ========================================================================== *
 * Stand-ins (the same shapes the M12 render suites use)                       *
 * ========================================================================== */

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

/** A duck-typed `Application` with NO `screen` — the degradation rig. */
function makeBareApp(deltaMs = 20): Application {
  const ticker: FakeTicker = { deltaMS: deltaMs, add: () => {}, remove: () => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

/**
 * A duck-typed `Application` WITH a `screen`, and a `renderer` property that THROWS
 * on access. The throwing getter is the machine guard for "read `app.screen` only".
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

/** A sim with a real room loaded from `assets/data/rooms.json`. */
function simWithRoom(roomId: string): GameSimulator {
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
  LevelLoader.enterRoom(sim.world, { roomId, playerId: player });
  return sim;
}

/** A sim with no walls at all. */
function simWithoutRoom(): GameSimulator {
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });
  return sim;
}

/* ========================================================================== *
 * Constants — the three numbers the whole feature is built on                 *
 * ========================================================================== */
describe('the zoom constants are frozen literals (FR-003)', () => {
  it('ZOOM_FIT_MARGIN / ZOOM_MIN / ZOOM_MAX are 0.8 / 1.0 / 16.0', () => {
    expect(ZOOM_FIT_MARGIN).toBe(0.8);
    expect(ZOOM_MIN).toBe(1);
    expect(ZOOM_MAX).toBe(16);
  });

  it('ZOOM_MIN is the pre-M17 world->pixel baseline, i.e. the zoom never SHRINKS', () => {
    // The lower bound is not an arbitrary "small number": it is `1`, the identity,
    // so this feature can only ever enlarge the world (FR-003). Pinned against
    // PX_PER_UNIT's own baseline by construction, not by copying a constant.
    expect(ZOOM_MIN).toBe(1);
    expect(PX_PER_UNIT).toBe(10);
  });
});

/* ========================================================================== *
 * E1 · viewport — a guarded read of `app.screen`                              *
 * ========================================================================== */
describe('E1 · viewport is a guarded read of app.screen only (FR-014)', () => {
  it('an app with no `screen` reads as NOT readable, with zeroed dimensions', () => {
    const renderer = new GameRenderer(makeBareApp());
    const viewport = renderer.viewport;
    expect(viewport.readable).toBe(false);
    expect(viewport.width).toBe(0);
    expect(viewport.height).toBe(0);
  });

  it('a real screen is read verbatim (CSS pixels)', () => {
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    expect(renderer.viewport.readable).toBe(true);
    expect(renderer.viewport.width).toBe(1920);
    expect(renderer.viewport.height).toBe(1080);
  });

  it.each([
    ['NaN / Infinity', Number.NaN, Number.POSITIVE_INFINITY],
    ['zero width', 0, 600],
    ['negative height', 800, -1],
    ['negative infinity', Number.NEGATIVE_INFINITY, 600],
  ])('a %s viewport degrades to (0, 0, readable=false) with no NaN', (_label, w, h) => {
    const renderer = new GameRenderer(makeScreenApp(w, h));
    const viewport = renderer.viewport;
    expect(viewport.readable).toBe(false);
    expect(viewport.width).toBe(0);
    expect(viewport.height).toBe(0);
    expect(Number.isFinite(viewport.width)).toBe(true);
    expect(Number.isFinite(viewport.height)).toBe(true);
  });

  it('reading the viewport NEVER touches app.renderer (throwing getter proves it)', () => {
    // `makeScreenApp` throws from `renderer`; a successful read is the proof.
    const renderer = new GameRenderer(makeScreenApp(640, 480));
    expect(() => renderer.viewport).not.toThrow();
    expect(() => renderer.zoom).not.toThrow();
    expect(() => renderer.roomFits).not.toThrow();
  });

  it('the viewport is re-read every time, never cached across frames (FR-010)', () => {
    // A single app whose `screen` is mutated in place — exactly what PixiJS's
    // `resizeTo: window` does between frames. A cached viewport would keep reporting
    // the old size; a per-frame read reports the new one with no event wiring.
    const app = makeScreenApp(800, 600);
    const renderer = new GameRenderer(app);
    expect(renderer.viewport.width).toBe(800);

    const screen = (app as unknown as { screen: { width: number; height: number } }).screen;
    screen.width = 1920;
    screen.height = 1080;

    expect(renderer.viewport.width).toBe(1920);
    expect(renderer.viewport.height).toBe(1080);
  });
});

/* ========================================================================== *
 * E3 · roomExtent — derived from the wall AABB, never assumed                 *
 * ========================================================================== */
describe('E3 · roomExtent is derived from the walls (FR-002 / FR-021)', () => {
  it('a world with no walls is NOT determinable, and has a non-positive extent', () => {
    const sim = simWithoutRoom();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(sim.world.query(WallComponent)).toHaveLength(0);
    const extent = renderer.roomExtent;
    expect(extent.determinable).toBe(false);
    // Non-positive, NOT NaN: the divide-by-zero guard depends on this.
    expect(extent.pxW).toBeLessThanOrEqual(0);
    expect(extent.pxH).toBeLessThanOrEqual(0);
  });

  it('a real 10x10 room is determinable with a 100x100 px extent', () => {
    const sim = simWithRoom('start_room');
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);

    const extent = renderer.roomExtent;
    expect(extent.determinable).toBe(true);
    // 10 world units x PX_PER_UNIT = 100 px on both axes.
    expect(extent.pxW).toBe(100);
    expect(extent.pxH).toBe(100);
    expect(extent.minX).toBe(0);
    expect(extent.minY).toBe(0);
    expect(extent.maxX).toBe(10);
    expect(extent.maxY).toBe(10);
  });

  it('the extent is read from the room data, not hard-coded per room', () => {
    for (const [roomId, expected] of [
      ['start_room', 100],
      ['arena_room', 120],
      ['stress_room', 300],
    ] as const) {
      const sim = simWithRoom(roomId);
      const renderer = new GameRenderer(makeScreenApp(1920, 1080));
      renderer.init();
      renderer.syncWorld(sim.world);
      expect(renderer.roomExtent.determinable).toBe(true);
      expect(renderer.roomExtent.pxW).toBe(expected);
    }
  });

  it('the CAMP is not determinable even though the previous room walls are still alive (FR-021)', () => {
    // `GameSimulator.enterHub` deliberately does NOT rebuild the world (spec 21: the
    // camp shows the run that just ended), so the walls are still there. A predicate
    // that only asked "are there walls?" would keep zooming in the camp.
    const sim = simWithRoom('start_room');
    GameStateFactory.spawn(sim.world);
    sim.enterHub();

    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(sim.world.query(WallComponent).length).toBeGreaterThan(0);
    expect(renderer.roomExtent.determinable).toBe(false);
    expect(renderer.zoom).toBe(1);
  });

  it('the renderer never writes to the world while deriving the extent (FR-012)', () => {
    const sim = simWithRoom('start_room');
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);

    const entitiesBefore = sim.world.listEntities().length;
    const wallsBefore = sim.world.query(WallComponent).length;
    for (let i = 0; i < 10; i += 1) renderer.syncWorld(sim.world);
    expect(sim.world.listEntities().length).toBe(entitiesBefore);
    expect(sim.world.query(WallComponent).length).toBe(wallsBefore);
  });
});

/* ========================================================================== *
 * E2 · zoom — the fit formula, pinned as literals                             *
 * ========================================================================== */
describe('E2 · zoom = clamp(min(vw/pxW, vh/pxH) x 0.8, 1, 16) (FR-002 / FR-003)', () => {
  it('1920x1080 + a 10x10 room gives EXACTLY 8.64 (literal pin, not a constant echo)', () => {
    const sim = simWithRoom('start_room');
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);

    // min(1920/100, 1080/100) * 0.8 = 10.8 * 0.8 = 8.64 — bit-exact in IEEE-754.
    expect(renderer.zoom).toBe(8.64);
  });

  it('2560x1440 + a 10x10 room gives 11.52 (within 1e-9)', () => {
    const sim = simWithRoom('start_room');
    const renderer = new GameRenderer(makeScreenApp(2560, 1440));
    renderer.init();
    renderer.syncWorld(sim.world);
    expect(renderer.zoom).toBeCloseTo(11.52, 9);
  });

  it('uses the CONSTRAINED axis (min), so the room always fits', () => {
    // A very wide viewport: the height is the constrained axis. Using `max` (or a
    // naive "short side" ratio) would overflow vertically.
    const sim = simWithRoom('start_room');
    const renderer = new GameRenderer(makeScreenApp(3840, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);

    // min(3840/100, 1080/100) = 10.8 -> x 0.8 = 8.64 (height-constrained, NOT 30.72).
    expect(renderer.zoom).toBe(8.64);
    expect(renderer.roomExtent.pxH * renderer.zoom).toBeLessThanOrEqual(1080);
  });

  it('a small viewport gives 4.8 (800x600 + 10x10 room)', () => {
    const sim = simWithRoom('start_room');
    const renderer = new GameRenderer(makeScreenApp(800, 600));
    renderer.init();
    renderer.syncWorld(sim.world);
    expect(renderer.zoom).toBeCloseTo(4.8, 9);
  });

  it('the 30x30 stress room is zoomed to 2.88, not shrunk to nothing', () => {
    const sim = simWithRoom('stress_room');
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);
    expect(renderer.zoom).toBeCloseTo(2.88, 9);
  });

  it('4K clamps at the upper bound: EXACTLY 16', () => {
    const sim = simWithRoom('start_room');
    const renderer = new GameRenderer(makeScreenApp(3840, 2160));
    renderer.init();
    renderer.syncWorld(sim.world);
    // fitZoom = 21.6 -> x 0.8 = 17.28 -> clamped to 16.
    expect(renderer.zoom).toBe(16);
  });

  it('a tiny room clamps at the upper bound and NEVER fills the screen', () => {
    // The 3x3 case from the spec's edge cases: fitZoom = 36 -> clamped to 16, so one
    // 1x1 cell is at most 160 CSS px, never "one cell fills the screen".
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });
    // A hand-built 3x3 room: four 3x1 / 1x3 border runs, exactly as the loader would
    // have produced from a 3x3 grid of `1` tiles.
    for (const wall of [
      { x: 0, y: 0, width: 3, height: 1 },
      { x: 0, y: 2, width: 3, height: 1 },
      { x: 0, y: 1, width: 1, height: 1 },
      { x: 2, y: 1, width: 1, height: 1 },
    ]) {
      createWall(sim.world, wall);
    }
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(renderer.roomExtent.pxW).toBe(30);
    expect(renderer.zoom).toBe(16);
    expect(renderer.roomExtent.pxW * renderer.zoom).toBeLessThanOrEqual(1920);
    // 3x3 at z=16 => 480 px of 1920 = 25% of the LONG side, and 480/1080 = 44.4% of
    // the short side — below SC-001's 55% floor, which the spec explicitly ALLOWS for
    // this case. The thing that must NOT happen is "one cell fills the screen".
    expect(renderer.roomExtent.pxW * renderer.zoom).toBeLessThan(1920);
  });

  it('is a PURE function: identical inputs give bit-identical output (FR-020)', () => {
    const first = new GameRenderer(makeScreenApp(1920, 1080));
    first.init();
    first.syncWorld(simWithRoom('start_room').world);

    const second = new GameRenderer(makeScreenApp(1920, 1080));
    second.init();
    second.syncWorld(simWithRoom('start_room').world);

    expect(first.zoom).toBe(second.zoom);
    expect(Object.is(first.zoom, second.zoom)).toBe(true);
  });

  it('the zoom NEVER goes below 1 for a huge room (FR-003 lower bound)', () => {
    // A 200x200 room at 1920x1080: fitZoom = min(0.96, 0.54) = 0.54 -> x 0.8 = 0.432,
    // which the lower bound lifts to 1. The world is never drawn smaller than before.
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 100, y: 100 });
    createWall(sim.world, { x: 0, y: 0, width: 200, height: 200 });

    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);
    expect(renderer.zoom).toBe(1);
    expect(renderer.zoom).toBeGreaterThanOrEqual(ZOOM_MIN);
  });
});

/* ========================================================================== *
 * E4 · roomFits — a three-input predicate with no player dependency           *
 * ========================================================================== */
describe('E4 · roomFits depends only on (extent, viewport, zoom) (FR-004)', () => {
  it('is true when the room fits and false when it does not', () => {
    const fitting = new GameRenderer(makeScreenApp(1920, 1080));
    fitting.init();
    fitting.syncWorld(simWithRoom('start_room').world);
    expect(fitting.roomFits).toBe(true); // 864 <= 1920 and 864 <= 1080

    // A room far larger than the viewport, at the z=1 lower bound: 2000x2000 px.
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 100, y: 100 });
    createWall(sim.world, { x: 0, y: 0, width: 200, height: 200 });
    const overflowing = new GameRenderer(makeScreenApp(1920, 1080));
    overflowing.init();
    overflowing.syncWorld(sim.world);
    expect(overflowing.zoom).toBe(1);
    expect(overflowing.roomFits).toBe(false);
  });

  it('does NOT change when the player moves around inside the room (FR-004)', () => {
    const sim = simWithRoom('start_room');
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    renderer.syncWorld(sim.world);
    const before = renderer.roomFits;
    expect(before).toBe(true);

    // Actually MOVE the player (a real `move` input through the real pipeline), then
    // re-read. A player-dependent predicate would flip here — which is exactly the
    // bug FR-004 forbids.
    const playerId = sim.world.query(TransformComponent)[0];
    if (playerId === undefined) throw new Error('QA: no player');
    const startX = sim.world.getComponent(playerId, TransformComponent)?.x ?? 0;
    sim.inject({ kind: 'move', tick: sim.tick, vector: vec2(1, 0) });
    for (let i = 0; i < 120; i += 1) {
      sim.step(1);
      renderer.syncWorld(sim.world);
    }
    const endX = sim.world.getComponent(playerId, TransformComponent)?.x ?? 0;
    expect(endX).not.toBe(startX); // the player really did move

    expect(renderer.roomFits).toBe(before);
    expect(renderer.roomFits).toBe(true);
    expect(renderer.zoom).toBe(8.64); // and the zoom did not move either
  });

  it('is false on a degraded path (no viewport, or no room) — i.e. no framing mode', () => {
    const noViewport = new GameRenderer(makeBareApp());
    noViewport.init();
    noViewport.syncWorld(simWithRoom('start_room').world);
    expect(noViewport.roomFits).toBe(false);

    const noRoom = new GameRenderer(makeScreenApp(1920, 1080));
    noRoom.init();
    noRoom.syncWorld(simWithoutRoom().world);
    expect(noRoom.roomFits).toBe(false);
  });

  it('zoomActive is the conjunction of "readable viewport" and "determinable extent"', () => {
    const active = new GameRenderer(makeScreenApp(1920, 1080));
    active.init();
    active.syncWorld(simWithRoom('start_room').world);
    expect(active.zoomActive).toBe(true);

    const noViewport = new GameRenderer(makeBareApp());
    noViewport.init();
    noViewport.syncWorld(simWithRoom('start_room').world);
    expect(noViewport.zoomActive).toBe(false);

    const noRoom = new GameRenderer(makeScreenApp(1920, 1080));
    noRoom.init();
    noRoom.syncWorld(simWithoutRoom().world);
    expect(noRoom.zoomActive).toBe(false);
  });
});
