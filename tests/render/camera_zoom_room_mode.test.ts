/**
 * M17 · US1 — the room and its contents scale up, and the room holds STILL
 * (specs/025-camera-zoom-viewport, US1 / FR-004 / FR-005 / FR-019 / SC-001).
 *
 * THE PROBLEM THIS SUITE EXISTS FOR
 * ---------------------------------
 * Before M17 the world was drawn 1 world unit = 10 screen pixels, so a 10x10 room
 * was 100x100 px — under 0.5% of a 1080p screen. Making it bigger is the easy half.
 * The half that goes wrong is the FRAMING: the player spawns at `(4.5, 8.5)`, which
 * is NOT the room's centre `(5, 5)`, so any framing that centres the PLAYER slides
 * the room around (or crops it) while the player walks. FR-004 therefore splits the
 * framing in two, and this suite pins both:
 *
 *  - **room mode** (the room fits): the ROOM's centre is pinned to the screen's
 *    centre and the player is not an input at all — the room is still;
 *  - **follow mode** (the room is larger than the viewport): the pre-M17
 *    player-centred framing returns, clamped to the room.
 *
 * Plus three things that are easy to get subtly wrong: the two axes must share one
 * factor (FR-005), the screen shake must stay in SCREEN pixels and not be scaled by
 * the zoom (FR-019), and a tiny room must be clamped rather than blown up to fill
 * the screen.
 *
 * The numbers are pinned as LITERALS (`8.64`, `16`, `528`, `108`, `864`) rather than
 * recomputed from the constants that produce them — an assertion of the form
 * `expect(x).toBe(theConstantThatMadeIt)` is a tautology (INVARIANTS §3).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Container } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { LevelLoader } from '../../src/core/LevelLoader';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { createWall } from '../../src/ecs/components/WallComponent';
import { vec2 } from '../../src/core/math';
import { GameRenderer, PX_PER_UNIT } from '../../client/GameRenderer';
import type { FrameEvents } from '../../client/ClientEventBridge';
import { EMPTY_FRAME_EVENTS } from '../../client/ClientEventBridge';

/* ========================================================================== *
 * Stand-ins + helpers                                                         *
 * ========================================================================== */

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

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

/** A real 10x10 `start_room` from `assets/data/rooms.json`. */
function simWithStartRoom(): GameSimulator {
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
  LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
  return sim;
}

/**
 * A room far larger than the viewport, built at explicit coordinates so the
 * follow-mode clamp can be probed at a chosen corner. A 200x200 world-unit room is
 * 2000x2000 px, i.e. bigger than 1920x1080 on BOTH axes, so the fit clamps to the
 * lower bound (`z = 1`) and the room cannot be contained — follow mode, by
 * construction rather than by luck.
 */
function simWithHugeRoom(playerX: number, playerY: number): GameSimulator {
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  PlayerFactory.spawn(sim.world, { x: playerX, y: playerY });
  createWall(sim.world, { x: 0, y: 0, width: 200, height: 200 });
  return sim;
}

/** A hand-built 3x3 room: the four border runs a 3x3 grid of `1` tiles produces. */
function simWithTinyRoom(): GameSimulator {
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });
  for (const wall of [
    { x: 0, y: 0, width: 3, height: 1 },
    { x: 0, y: 2, width: 3, height: 1 },
    { x: 0, y: 1, width: 1, height: 1 },
    { x: 2, y: 1, width: 1, height: 1 },
  ]) {
    createWall(sim.world, wall);
  }
  return sim;
}

/** Sync `frames` times and return the renderer, so callers read a settled camera. */
function settle(renderer: GameRenderer, world: GameSimulator['world'], frames: number): void {
  for (let i = 0; i < frames; i += 1) renderer.syncWorld(world);
}

/**
 * Frames needed for the first-order lerp to FULLY stall (not merely get close).
 *
 * `diff_{n+1} = 0.8 * diff_n`, so from a ~528 px gap the residual drops below one
 * ULP of 528 (≈1.1e-13) after ~158 frames. `250` is that with margin, and the
 * exact-equality assertions below ("the camera did not move at all") depend on the
 * lerp having genuinely stopped, so this is a contract, not a tuning knob.
 */
const CONVERGED_FRAMES = 250;

/** A frame payload carrying one hit, which arms the screen shake. */
function hitFrame(): FrameEvents {
  return {
    ...EMPTY_FRAME_EVENTS,
    hits: [
      {
        tick: 0,
        attackerId: 1,
        targetId: 2,
        hitboxEntityId: 3,
        position: vec2(0, 0),
        damage: 1,
        modifierId: null,
      } as unknown as FrameEvents['hits'][number],
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== *
 * ① FR-005 · equally scaled                                                   *
 * ========================================================================== */
describe('① the camera scales BOTH axes by the same factor (FR-005)', () => {
  it('camera.scale.x === camera.scale.y === renderer.zoom', () => {
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, 5);

    expect(renderer.camera.scale.x).toBe(renderer.camera.scale.y);
    expect(renderer.camera.scale.x).toBe(renderer.zoom);
    // And the zoom is the literal the formula gives for this rig.
    expect(renderer.camera.scale.x).toBe(8.64);
  });

  it('the zoom is written every frame, so a resize is picked up without an event', () => {
    const sim = simWithStartRoom();
    const app = makeScreenApp(800, 600);
    const renderer = new GameRenderer(app);
    renderer.init();
    settle(renderer, sim.world, 5);
    expect(renderer.camera.scale.x).toBeCloseTo(4.8, 9);

    // Mutate the screen in place, exactly as `resizeTo: window` does.
    const screen = (app as unknown as { screen: { width: number; height: number } }).screen;
    screen.width = 1920;
    screen.height = 1080;
    renderer.syncWorld(sim.world);

    expect(renderer.camera.scale.x).toBe(8.64);
  });
});

/* ========================================================================== *
 * ② SC-001 · the room reads at a sensible size                                *
 * ========================================================================== */
describe('② SC-001 · a 10x10 room fills 55%-85% of the viewport short side', () => {
  it('1920x1080: the room is 864 px of a 1080 px short side = 80%', () => {
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, 5);

    const roomPx = renderer.roomExtent.pxW * renderer.zoom;
    expect(roomPx).toBe(864);
    const occupancy = roomPx / 1080;
    expect(occupancy).toBeGreaterThanOrEqual(0.55);
    expect(occupancy).toBeLessThanOrEqual(0.85);
    expect(occupancy).toBeCloseTo(0.8, 9);
  });

  it('2560x1440 stays in the same band (SC-002)', () => {
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeScreenApp(2560, 1440));
    renderer.init();
    settle(renderer, sim.world, 5);

    const occupancy = (renderer.roomExtent.pxW * renderer.zoom) / 1440;
    expect(occupancy).toBeGreaterThanOrEqual(0.55);
    expect(occupancy).toBeLessThanOrEqual(0.85);
  });

  it('the room never overflows the viewport on either axis (no crop)', () => {
    for (const [w, h] of [
      [800, 600],
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ] as const) {
      const sim = simWithStartRoom();
      const renderer = new GameRenderer(makeScreenApp(w, h));
      renderer.init();
      settle(renderer, sim.world, 5);

      expect(renderer.roomExtent.pxW * renderer.zoom).toBeLessThanOrEqual(w);
      expect(renderer.roomExtent.pxH * renderer.zoom).toBeLessThanOrEqual(h);
      expect(renderer.roomFits).toBe(true);
    }
  });
});

/* ========================================================================== *
 * ③ FR-004 / US1 AS3 · room mode holds the room still                         *
 * ========================================================================== */
describe('③ in room mode the room is centred and STILL while the player walks (FR-004)', () => {
  it('converges to the ROOM centre, not the player: camera = (528, 108)', () => {
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, CONVERGED_FRAMES);

    // z = 8.64; room centre px = (5, 5) * 10 = (50, 50).
    // 1920/2 - 50*8.64 = 960 - 432 = 528 ; 1080/2 - 50*8.64 = 540 - 432 = 108.
    expect(renderer.roomFits).toBe(true);
    expect(renderer.camera.x).toBeCloseTo(528, 6);
    expect(renderer.camera.y).toBeCloseTo(108, 6);
  });

  it('the room centre lands EXACTLY on the viewport centre', () => {
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, CONVERGED_FRAMES);

    const extent = renderer.roomExtent;
    const z = renderer.zoom;
    const centreScreenX = renderer.camera.x + ((extent.minX + extent.maxX) / 2) * PX_PER_UNIT * z;
    const centreScreenY = renderer.camera.y + ((extent.minY + extent.maxY) / 2) * PX_PER_UNIT * z;

    expect(centreScreenX).toBeCloseTo(1920 / 2, 6);
    expect(centreScreenY).toBeCloseTo(1080 / 2, 6);
  });

  it('the camera does NOT move when the player walks across the room', () => {
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, CONVERGED_FRAMES);

    const cameraXBefore = renderer.camera.x;
    const cameraYBefore = renderer.camera.y;

    // Genuinely walk the player to the far side of the room through the real
    // pipeline — a player-dependent framing would drag the camera with them.
    const playerId = sim.world.query(TransformComponent)[0];
    if (playerId === undefined) throw new Error('QA: no player');
    const playerXBefore = sim.world.getComponent(playerId, TransformComponent)?.x ?? 0;
    sim.inject({ kind: 'move', tick: sim.tick, vector: vec2(1, 0) });
    for (let i = 0; i < 60; i += 1) {
      sim.step(1);
      renderer.syncWorld(sim.world);
    }
    const playerXAfter = sim.world.getComponent(playerId, TransformComponent)?.x ?? 0;

    // Anti-vacuity: the player really did move (by at least one world unit).
    expect(playerXAfter - playerXBefore).toBeGreaterThan(1);
    // ...and the room did not.
    expect(renderer.camera.x).toBe(cameraXBefore);
    expect(renderer.camera.y).toBe(cameraYBefore);
    expect(renderer.roomFits).toBe(true);
  });
});

/* ========================================================================== *
 * ④ FR-004 · follow mode clamps to the room                                   *
 * ========================================================================== */
describe('④ a room LARGER than the viewport falls back to clamped follow (FR-004)', () => {
  it('at the right edge the room ends exactly at the screen edge (nothing outside enters)', () => {
    const sim = simWithHugeRoom(199, 199);
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, CONVERGED_FRAMES);

    expect(renderer.zoom).toBe(1); // the fit clamped up to the lower bound
    expect(renderer.roomFits).toBe(false); // 2000 px > 1920 px

    const extent = renderer.roomExtent;
    const z = renderer.zoom;
    const leftEdge = renderer.camera.x + extent.minX * PX_PER_UNIT * z;
    const rightEdge = renderer.camera.x + extent.maxX * PX_PER_UNIT * z;

    // The room's right edge is flush with the screen's right edge: the camera is
    // pinned to the room's boundary, and the world outside it stays off screen.
    expect(rightEdge).toBeCloseTo(1920, 6);
    expect(leftEdge).toBeLessThanOrEqual(1e-6);
    // 1920 - 2000 = -80, i.e. the clamp bottom.
    expect(renderer.camera.x).toBeCloseTo(-80, 6);
  });

  it('at the left edge the room starts exactly at the screen origin', () => {
    const sim = simWithHugeRoom(1, 1);
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, CONVERGED_FRAMES);

    const extent = renderer.roomExtent;
    const z = renderer.zoom;
    const leftEdge = renderer.camera.x + extent.minX * PX_PER_UNIT * z;
    const rightEdge = renderer.camera.x + extent.maxX * PX_PER_UNIT * z;

    expect(leftEdge).toBeCloseTo(0, 6);
    expect(rightEdge).toBeGreaterThanOrEqual(1920 - 1e-6);
    expect(renderer.camera.x).toBeCloseTo(0, 6);
  });

  it('in the middle of a huge room the framing is the pre-M17 player-centred one', () => {
    const sim = simWithHugeRoom(100, 100);
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, CONVERGED_FRAMES);

    // Player px = (1000, 1000); desired = (960 - 1000, 540 - 1000) = (-40, -460).
    // The y clamp: minY = min(1080 - 2000, -0) = -920, maxY = max(-920, 0) = 0, so
    // -460 is already inside the window and is used unchanged.
    expect(renderer.camera.x).toBeCloseTo(-40, 6);
    expect(renderer.camera.y).toBeCloseTo(-460, 6);
  });
});

/* ========================================================================== *
 * ⑤ FR-019 · the shake stays in screen pixels                                 *
 * ========================================================================== */
describe('⑤ the screen shake is NOT scaled by the zoom (FR-019 / SC-009)', () => {
  it('the same shake produces the same SCREEN-pixel offset at z=8.64 and at z=1', () => {
    // `Math.random` is the presentation-layer entropy the shake reads; pinning it to
    // 0 makes the offset deterministic: (0 - 0.5) * 6 = -3 px per frame.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    // --- rig A: room mode, z = 8.64 ------------------------------------------
    const roomSim = simWithStartRoom();
    const roomApp = makeScreenApp(1920, 1080);
    const shaken = new GameRenderer(roomApp);
    shaken.init();
    settle(shaken, roomSim.world, CONVERGED_FRAMES);
    const shakenQuietX = shaken.camera.x;
    expect(shaken.zoom).toBe(8.64);

    // --- rig B: the same room, but a huge room means z = 1 --------------------
    const plainSim = simWithHugeRoom(100, 100);
    const plainApp = makeScreenApp(1920, 1080);
    const plain = new GameRenderer(plainApp);
    plain.init();
    settle(plain, plainSim.world, CONVERGED_FRAMES);
    const plainQuietX = plain.camera.x;
    expect(plain.zoom).toBe(1);

    // --- now shake both, frame by frame --------------------------------------
    // 120 frames is ~1.5x the 78 the 1e-6 tolerance needs (the residual decays as
    // `15 * 0.8^n`), so both rigs have settled well inside the assertion's window.
    for (let i = 0; i < 120; i += 1) {
      shaken.syncWorld(roomSim.world, 1, hitFrame());
      plain.syncWorld(plainSim.world, 1, hitFrame());
    }

    const shakenOffset = shaken.camera.x - shakenQuietX;
    const plainOffset = plain.camera.x - plainQuietX;

    // A first-order lerp chasing `target + offset` settles at `target + offset/0.2`.
    // The per-frame offset is (0 - 0.5) * 6 = -3 px, so both rigs settle 15 px on the
    // same side of their own target — the zoom must not enter this at all.
    expect(shakenOffset).toBeCloseTo(-15, 6);
    expect(plainOffset).toBeCloseTo(-15, 6);
    // If the shake were scaled by `z`, the room rig would sit ~129.6 px away instead.
    expect(Math.abs(shakenOffset)).toBeLessThan(20);
    expect(Math.abs(shakenOffset - plainOffset)).toBeLessThan(1e-6);
  });

  it('the shake never drifts the ZOOM (no feedback loop)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, 50);

    for (let i = 0; i < 300; i += 1) {
      renderer.syncWorld(sim.world, 1, hitFrame());
      expect(renderer.zoom).toBe(8.64);
    }
    expect(renderer.camera.scale.x).toBe(8.64);
    expect(renderer.camera.scale.y).toBe(8.64);
  });
});

/* ========================================================================== *
 * ⑥ the 3x3 edge case                                                         *
 * ========================================================================== */
describe('⑥ a tiny room is clamped at ZOOM_MAX, never blown up to fill the screen', () => {
  it('3x3 at 1920x1080: zoom is EXACTLY 16 and the room occupies ~44% of the short side', () => {
    const sim = simWithTinyRoom();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, 5);

    expect(renderer.zoom).toBe(16);
    const roomPx = renderer.roomExtent.pxW * renderer.zoom;
    expect(roomPx).toBe(480);
    // 480/1080 = 44.4% — BELOW SC-001's 55% floor, which the spec explicitly allows
    // for this case. The thing that must not happen is "one cell fills the screen".
    expect(roomPx / 1080).toBeCloseTo(0.4444, 3);
    expect(roomPx / 1080).toBeLessThan(0.55);
    expect(roomPx).toBeLessThan(1920);
    // A single 1x1 cell is at most 160 CSS px, never the whole screen.
    expect(10 * renderer.zoom).toBeLessThanOrEqual(160);
  });
});

/* ========================================================================== *
 * ⑦ the zoom is applied to the CAMERA, not to the children                    *
 * ========================================================================== */
describe('⑦ world content keeps WORLD-pixel local coordinates (contract §1)', () => {
  it('entity views and wall nodes keep their world-pixel positions under zoom', () => {
    const sim = simWithStartRoom();
    const renderer = new GameRenderer(makeScreenApp(1920, 1080));
    renderer.init();
    settle(renderer, sim.world, 5);

    const playerId = sim.world.query(TransformComponent)[0];
    if (playerId === undefined) throw new Error('QA: no player');
    const transform = sim.world.getComponent(playerId, TransformComponent);
    if (transform === undefined) throw new Error('QA: no transform');

    const root = renderer.camera.children[renderer.camera.children.length - 1];
    if (root === undefined) throw new Error('QA: no render root');
    // The FIRST entity view is the player (only one entity has a Transform here).
    const playerView = root.children[0];
    if (playerView === undefined) throw new Error('QA: no player view');
    expect(playerView.x).toBeCloseTo(transform.x * PX_PER_UNIT, 9);
    expect(playerView.y).toBeCloseTo(transform.y * PX_PER_UNIT, 9);

    // The static layer sits at camera index 0 and its children are at world pixels.
    const staticLayer = renderer.camera.children[0];
    if (staticLayer === undefined) throw new Error('QA: no static layer');
    expect(staticLayer.x).toBe(0);
    expect(staticLayer.y).toBe(0);
    expect(staticLayer.scale.x).toBe(1);
    expect(staticLayer.scale.y).toBe(1);
    // ...while the camera carries the zoom.
    expect(renderer.camera.scale.x).toBe(8.64);
  });
});
