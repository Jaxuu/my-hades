/**
 * M17 · US3 — the viewport can change at any time and the room re-fits itself
 * (specs/025-camera-zoom-viewport, FR-010 / FR-011 / SC-005 / SC-008).
 *
 * WHY THIS NEEDS ITS OWN SUITE
 * ----------------------------
 * The zoom is a function of the viewport, so "the viewport changed" is the input
 * that invalidates it. There are two ways to get that wrong and neither shows up on
 * a fixed-size screen:
 *
 *  - **caching the viewport.** A cached size means a window resize does nothing
 *    until a reload. The implementation deliberately re-reads `app.screen` every
 *    frame and installs NO listener, because `resizeTo: window` already keeps
 *    `app.screen` current (research.md D6) — this suite mutates `screen` in place,
 *    which is exactly what PixiJS does between frames.
 *  - **an aspect-ratio-blind fit.** Using `max`, or a "short side" ratio, overflows
 *    one axis on a 32:9 or a 9:16 viewport. `min` is the only correct choice, and
 *    FR-011 is precisely the claim that the constrained axis decides.
 *
 * The framing-mode threshold gets its own section: a viewport that shrinks across
 * "the room fits" → "the room does not fit" is the one input that changes the mode,
 * so it is the one place a mode decision could oscillate.
 */

import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { LevelLoader } from '../../src/core/LevelLoader';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { GameRenderer, PX_PER_UNIT } from '../../client/GameRenderer';

/* ========================================================================== *
 * Rig                                                                         *
 * ========================================================================== */

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

interface Screen {
  width: number;
  height: number;
}

/** A rig whose `screen` is a mutable object, so a resize is an in-place write. */
function makeResizableApp(width: number, height: number): { app: Application; screen: Screen } {
  const ticker: FakeTicker = { deltaMS: 20, add: () => {}, remove: () => {} };
  const screen: Screen = { width, height };
  const app = {
    stage: new Container(),
    ticker,
    screen,
    get renderer(): never {
      throw new Error('QA: the render layer read app.renderer, which it must never do');
    },
  };
  return { app: app as unknown as Application, screen };
}

function simWithStartRoom(): GameSimulator {
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
  LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
  return sim;
}

/** The room's on-screen rectangle, from the camera transform and the extent. */
function roomScreenRect(renderer: GameRenderer): {
  left: number;
  right: number;
  top: number;
  bottom: number;
} {
  const extent = renderer.roomExtent;
  const z = renderer.zoom;
  return {
    left: renderer.camera.x + extent.minX * PX_PER_UNIT * z,
    right: renderer.camera.x + extent.maxX * PX_PER_UNIT * z,
    top: renderer.camera.y + extent.minY * PX_PER_UNIT * z,
    bottom: renderer.camera.y + extent.maxY * PX_PER_UNIT * z,
  };
}

/* ========================================================================== *
 * ① every target viewport is fitted correctly                                 *
 * ========================================================================== */
describe('① switching between the four target viewports re-fits and re-centres (FR-010)', () => {
  const CASES = [
    { w: 800, h: 600, zoom: 4.8, targetX: 160, targetY: 60 },
    { w: 1920, h: 1080, zoom: 8.64, targetX: 528, targetY: 108 },
    { w: 2560, h: 1440, zoom: 11.52, targetX: 704, targetY: 144 },
    { w: 3840, h: 2160, zoom: 16, targetX: 1120, targetY: 280 },
  ] as const;

  it.each(CASES)(
    '$w x $h: zoom = $zoom and the room centre lands on the viewport centre',
    ({ w, h, zoom, targetX, targetY }) => {
      const sim = simWithStartRoom();
      const { app, screen } = makeResizableApp(w, h);
      const renderer = new GameRenderer(app);
      renderer.init();
      for (let i = 0; i < 400; i += 1) renderer.syncWorld(sim.world);

      expect(renderer.zoom).toBeCloseTo(zoom, 9);
      expect(renderer.camera.scale.x).toBeCloseTo(zoom, 9);
      expect(renderer.roomFits).toBe(true);
      // z = 8.64 etc.; room centre px = (5,5) * 10 = (50,50).
      expect(renderer.camera.x).toBeCloseTo(targetX, 6);
      expect(renderer.camera.y).toBeCloseTo(targetY, 6);

      const rect = roomScreenRect(renderer);
      expect(rect.left + rect.right).toBeCloseTo(w, 6);
      expect(rect.top + rect.bottom).toBeCloseTo(h, 6);
      expect(screen.width).toBe(w); // the rig really is at this size
    },
  );

  it('one renderer walked through all four sizes re-fits at each step, with no reload', () => {
    const sim = simWithStartRoom();
    const { app, screen } = makeResizableApp(800, 600);
    const renderer = new GameRenderer(app);
    renderer.init();
    for (let i = 0; i < 400; i += 1) renderer.syncWorld(sim.world);
    expect(renderer.zoom).toBeCloseTo(4.8, 9);

    for (const { w, h, zoom } of CASES) {
      screen.width = w;
      screen.height = h;
      // No event, no reset — just the next frame.
      for (let i = 0; i < 400; i += 1) renderer.syncWorld(sim.world);
      expect(renderer.zoom).toBeCloseTo(zoom, 9);
      const rect = roomScreenRect(renderer);
      expect(rect.left).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.right).toBeLessThanOrEqual(w + 1e-9);
      expect(rect.top).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.bottom).toBeLessThanOrEqual(h + 1e-9);
    }
  });
});

/* ========================================================================== *
 * ② extreme aspect ratios                                                     *
 * ========================================================================== */
describe('② extreme aspect ratios fit on the CONSTRAINED axis (FR-011 / SC-008)', () => {
  const EXTREMES = [
    { label: '32:9 ultra-wide', w: 3840, h: 1080 },
    { label: '9:16 ultra-tall', w: 1080, h: 1920 },
    { label: '21:9', w: 2560, h: 1080 },
    { label: '4:3', w: 1024, h: 768 },
  ] as const;

  it.each(EXTREMES)('$label: the room is fully visible (zero crop, zero overflow)', ({ w, h }) => {
    const sim = simWithStartRoom();
    const { app } = makeResizableApp(w, h);
    const renderer = new GameRenderer(app);
    renderer.init();
    for (let i = 0; i < 400; i += 1) renderer.syncWorld(sim.world);

    const rect = roomScreenRect(renderer);
    // No crop: nothing of the room is off the left/top edge.
    expect(rect.left).toBeGreaterThanOrEqual(-1e-9);
    expect(rect.top).toBeGreaterThanOrEqual(-1e-9);
    // No overflow: nothing of the room is past the right/bottom edge.
    expect(rect.right).toBeLessThanOrEqual(w + 1e-9);
    expect(rect.bottom).toBeLessThanOrEqual(h + 1e-9);
    // And the fit is the CONSTRAINED axis: the room touches its limit on exactly the
    // axis that binds, which is what "以受限方向为准" means operationally.
    const occupancyX = (rect.right - rect.left) / w;
    const occupancyY = (rect.bottom - rect.top) / h;
    expect(Math.max(occupancyX, occupancyY)).toBeCloseTo(0.8, 6);
  });

  it('the ultra-wide case is height-constrained, the ultra-tall case is width-constrained', () => {
    const sim = simWithStartRoom();

    const wide = makeResizableApp(3840, 1080);
    const wideRenderer = new GameRenderer(wide.app);
    wideRenderer.init();
    for (let i = 0; i < 400; i += 1) wideRenderer.syncWorld(sim.world);
    // min(3840/100, 1080/100) = 10.8 -> 8.64 (the HEIGHT binds, not the 38.4 width).
    expect(wideRenderer.zoom).toBe(8.64);

    const tall = makeResizableApp(1080, 1920);
    const tallRenderer = new GameRenderer(tall.app);
    tallRenderer.init();
    for (let i = 0; i < 400; i += 1) tallRenderer.syncWorld(sim.world);
    // min(1080/100, 1920/100) = 10.8 -> 8.64 (the WIDTH binds, not the 19.2 height).
    expect(tallRenderer.zoom).toBe(8.64);
  });
});

/* ========================================================================== *
 * ③ the fits / does-not-fit threshold                                         *
 * ========================================================================== */
describe('③ the framing-mode decision is stable and monotone across the threshold', () => {
  it('a fixed viewport gives the SAME decision on every frame (no jitter)', () => {
    const sim = simWithStartRoom();
    const { app } = makeResizableApp(1920, 1080);
    const renderer = new GameRenderer(app);
    renderer.init();

    const decisions = new Set<boolean>();
    for (let i = 0; i < 300; i += 1) {
      renderer.syncWorld(sim.world);
      decisions.add(renderer.roomFits);
    }
    // One value, not a flicker between two — SC-005's "不逐帧抖动".
    expect(decisions.size).toBe(1);
    expect([...decisions][0]).toBe(true);
  });

  it('shrinking the viewport flips the decision at most ONCE, and never back', () => {
    const sim = simWithStartRoom();
    const { app, screen } = makeResizableApp(240, 1080);
    const renderer = new GameRenderer(app);
    renderer.init();

    let flips = 0;
    let previous: boolean | null = null;
    const trail: boolean[] = [];

    // Sweep the width down through the threshold (the 10x10 room stops fitting once
    // 100 * z > width, which happens somewhere below ~125 px).
    for (let width = 240; width >= 40; width -= 5) {
      screen.width = width;
      screen.height = 1080;
      for (let i = 0; i < 30; i += 1) renderer.syncWorld(sim.world);
      const fits = renderer.roomFits;
      trail.push(fits);
      if (previous !== null && fits !== previous) flips += 1;
      previous = fits;
    }

    // Exactly one transition (room mode -> follow mode) as the viewport narrows: the
    // decision is monotone in the width, so it cannot oscillate.
    expect(flips).toBe(1);
    expect(trail[0]).toBe(true);
    expect(trail[trail.length - 1]).toBe(false);
  });

  it('the camera SETTLES on each side of the threshold (no oscillation)', () => {
    const sim = simWithStartRoom();
    const { app, screen } = makeResizableApp(200, 1080);
    const renderer = new GameRenderer(app);
    renderer.init();

    for (const width of [200, 120, 60]) {
      screen.width = width;
      for (let i = 0; i < 500; i += 1) renderer.syncWorld(sim.world);
      const settledX = renderer.camera.x;
      // Five more frames must not move it: a converged first-order lerp has nothing
      // left to close, so a non-zero delta here would mean a limit cycle.
      for (let i = 0; i < 5; i += 1) renderer.syncWorld(sim.world);
      expect(renderer.camera.x).toBeCloseTo(settledX, 9);
      expect(Number.isFinite(renderer.camera.x)).toBe(true);
      expect(Number.isFinite(renderer.camera.y)).toBe(true);
      expect(Number.isFinite(renderer.zoom)).toBe(true);
    }
  });

  it('the mode switch is a smooth ease, not a snap (the lerp still owns the camera)', () => {
    const sim = simWithStartRoom();
    const { app, screen } = makeResizableApp(200, 1080);
    const renderer = new GameRenderer(app);
    renderer.init();
    for (let i = 0; i < 500; i += 1) renderer.syncWorld(sim.world);

    const beforeX = renderer.camera.x;
    // Cross the threshold in one step.
    screen.width = 60;
    renderer.syncWorld(sim.world);
    const afterX = renderer.camera.x;

    // The camera is still a 0.2 lerp: one frame closes at most 20% of the gap, so the
    // switch is an eased move. A snap would move the whole distance in one frame.
    const moved = Math.abs(afterX - beforeX);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(0.2 * 200); // far below a teleport across the viewport
  });
});
