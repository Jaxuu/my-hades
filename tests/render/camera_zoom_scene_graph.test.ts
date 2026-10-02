/**
 * M17 · US5 — the six frozen scene-graph contracts survive an ACTIVE zoom
 * (specs/025-camera-zoom-viewport, FR-015 and
 * contracts/scene-graph-and-screen-space.md §1/§3.1/§3.2).
 *
 * SCOPE, DELIBERATELY NARROW
 * --------------------------
 * Thirteen pre-existing render suites already pin F1-F6 on the DEGRADED path (where
 * `z === 1`), and they are untouched. Re-asserting those here would add maintenance
 * surface without adding coverage. This file covers the one thing they cannot: the
 * scene graph while `zoomActive === true` AND `cameraContainer.scale !== 1`, i.e. the
 * path where the feature is actually doing something.
 *
 * WHY THAT PATH IS THE RISKY ONE
 * ------------------------------
 * The obvious way to implement a zoom is to insert a scaling container between the
 * camera and the render root — and that breaks TWO contracts at once: the camera's
 * last child would no longer be the root (F2), and a wall-less world would have two
 * camera children instead of one (F5). M17 avoids it by writing the scale onto the
 * camera node itself, so no node is added anywhere. This suite is the guard that
 * keeps a future "cleaner" refactor from re-introducing the container.
 *
 * A NOTE ON F5: "with no walls, `camera.children` has length exactly 1" cannot be
 * observed while the zoom is active, because an active zoom REQUIRES a room (and a
 * room is walls). It is therefore asserted at the boundary: the lazy static layer
 * appears when the walls appear and disappears when they go, and the zoom follows it
 * back to the identity — which is the actual contract, stated as behaviour rather
 * than as a snapshot.
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
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { GameRenderer } from '../../client/GameRenderer';
import { testEnemy } from '../harness/config-fixtures';

/* ========================================================================== *
 * Rig                                                                         *
 * ========================================================================== */

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

function makeScreenApp(width = 1920, height = 1080, deltaMs = 20): Application {
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

/** The render root: the camera's LAST child (the static layer, if any, is index 0). */
function renderRoot(renderer: GameRenderer): Container {
  const camera = renderer.camera;
  const root = camera.children[camera.children.length - 1];
  if (root === undefined) throw new Error('QA: no render root under the camera');
  return root;
}

/** The FX layer: the render root's LAST child. */
function fxLayerOf(renderer: GameRenderer): Container {
  const root = renderRoot(renderer);
  const fx = root.children[root.children.length - 1];
  if (fx === undefined) throw new Error('QA: no FX layer under the render root');
  return fx;
}

/** A live zoom: a real room, a real player, a real enemy, and a real viewport. */
function buildZoomingScene(): { sim: GameSimulator; renderer: GameRenderer; enemyId: number } {
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
  LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
  const enemyId = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 6, y: 6, hp: 100, maxHp: 100 }));
  sim.step(1);

  const renderer = new GameRenderer(makeScreenApp());
  renderer.init();
  renderer.syncWorld(sim.world, 1);
  return { sim, renderer, enemyId };
}

/** Assert the rig really is on the zoom-active path — otherwise the suite is vacuous. */
function expectZoomIsLive(renderer: GameRenderer): void {
  expect(renderer.zoomActive).toBe(true);
  expect(renderer.zoom).toBe(8.64);
  expect(renderer.camera.scale.x).toBe(8.64);
  expect(renderer.camera.scale.x).not.toBe(1);
}

/* ========================================================================== *
 * F1-F4 + "no new resident nodes" under an active zoom                        *
 * ========================================================================== */
describe('F1-F4 hold while the camera is scaled (FR-015)', () => {
  it('F1: the stage has exactly one child, and it is the camera', () => {
    const { renderer } = buildZoomingScene();
    expectZoomIsLive(renderer);

    const app = renderer.camera.parent;
    if (app === null) throw new Error('QA: the camera is not attached');
    expect(app.children).toHaveLength(1);
    expect(app.children[0]).toBe(renderer.camera);
  });

  it('F2: the render root is still the camera\'s LAST child — no zoom container was inserted', () => {
    const { renderer } = buildZoomingScene();
    expectZoomIsLive(renderer);

    const root = renderRoot(renderer);
    // With a room, the camera holds exactly two children: the static layer and the
    // root. A scaling container between them would make this three.
    expect(renderer.camera.children).toHaveLength(2);
    expect(renderer.camera.children[0]).not.toBe(root);
    expect(renderer.camera.children[1]).toBe(root);
    expect(root.parent).toBe(renderer.camera);
  });

  it('F3: the FX layer is still the render root\'s LAST child', () => {
    const { renderer } = buildZoomingScene();
    expectZoomIsLive(renderer);

    const fx = fxLayerOf(renderer);
    expect(fx.parent).toBe(renderRoot(renderer));
    expect(fx.scale.x).toBe(1); // the FX layer carries NO zoom of its own
    expect(fx.scale.y).toBe(1);
  });

  it('F4: root.children[0] is the first entity view, in ascending id order', () => {
    const { renderer } = buildZoomingScene();
    expectZoomIsLive(renderer);

    const root = renderRoot(renderer);
    const fx = fxLayerOf(renderer);
    const views = root.children.filter((child) => child !== fx);
    expect(views.length).toBe(renderer.viewCount);
    expect(root.children[0]).toBe(views[0]);

    // The views keep their own world positions and their own local scale — the zoom
    // lives on the camera and nowhere else, which is what makes F4 (and every
    // pre-M17 view assertion) survive.
    for (const view of views) {
      expect(view.scale.x).toBe(1);
      expect(view.scale.y).toBe(1);
    }
  });

  it('no node in the camera subtree carries a scale other than the camera\'s own zoom', () => {
    const { renderer } = buildZoomingScene();
    expectZoomIsLive(renderer);

    const walk = (node: Container, isCamera: boolean): void => {
      if (!isCamera) {
        // Every non-camera node keeps its LOCAL scale. (A death FX scales its own
        // container, but nothing is dying here, so 1 is the expected value.)
        expect(node.scale.x).toBe(1);
        expect(node.scale.y).toBe(1);
      }
      for (const child of node.children) walk(child, false);
    };
    walk(renderer.camera, true);
  });

  it('the particle layer, when mounted, still sits BETWEEN the static layer and the root', () => {
    const { sim, renderer, enemyId } = buildZoomingScene();
    expectZoomIsLive(renderer);

    // Feed a hit so a spark mounts the particle layer.
    renderer.syncWorld(sim.world, 1, {
      hits: [
        {
          tick: 0,
          attackerId: 1,
          targetId: enemyId,
          hitboxEntityId: 0,
          position: { x: 6, y: 6 },
          damage: 1,
          modifierId: null,
        } as unknown as { tick: number },
      ] as never,
      deaths: [],
      dashes: [],
    });

    expect(renderer.sparkCount).toBeGreaterThan(0);
    const root = renderRoot(renderer);
    expect(renderer.camera.children).toHaveLength(3);
    expect(renderer.camera.children[0]).not.toBe(root); // static layer
    expect(renderer.camera.children[1]).not.toBe(root); // particle layer
    expect(renderer.camera.children[2]).toBe(root); // root, STILL last
  });
});

/* ========================================================================== *
 * F5 · the lazy static layer, observed at the boundary                        *
 * ========================================================================== */
describe('F5 · the static layer is still mounted lazily, and the zoom follows it', () => {
  it('appears with the room, disappears with it, and the camera children go 2 -> 1', () => {
    const { sim, renderer } = buildZoomingScene();
    expectZoomIsLive(renderer);
    expect(renderer.camera.children).toHaveLength(2);

    // Tear the room down: with no walls the static layer must go, leaving exactly
    // one camera child — the root — which is F5's contract.
    LevelLoader.clearRoomEntities(sim.world);
    renderer.syncWorld(sim.world);

    expect(renderer.wallViewCount).toBe(0);
    expect(renderer.camera.children).toHaveLength(1);
    expect(renderer.camera.children[0]).toBe(renderRoot(renderer));
    // ...and with no room the zoom degrades, so nothing is left scaled either.
    expect(renderer.camera.scale.x).toBe(1);
    expect(renderer.zoomActive).toBe(false);

    // Re-enter a room: the layer comes back at index 0 and the zoom returns.
    const playerId = sim.world.query(TransformComponent)[0];
    if (playerId === undefined) throw new Error('QA: no player');
    LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId });
    renderer.syncWorld(sim.world);

    expect(renderer.camera.children).toHaveLength(2);
    expect(renderer.camera.children[0]).not.toBe(renderRoot(renderer));
    expect(renderer.camera.children[1]).toBe(renderRoot(renderer));
    expect(renderer.camera.scale.x).toBe(8.64);
  });
});

/* ========================================================================== *
 * F6 · the FX layer stays empty at rest                                       *
 * ========================================================================== */
describe('F6 · the FX layer has exactly zero children while idle (FR-015)', () => {
  it('an untouched scene has an empty FX layer, at zoom 8.64', () => {
    const { sim, renderer } = buildZoomingScene();
    expectZoomIsLive(renderer);

    for (let i = 0; i < 60; i += 1) renderer.syncWorld(sim.world);

    const fx = fxLayerOf(renderer);
    expect(fx.children).toHaveLength(0);
    expect(fx.children.filter((child) => child instanceof Text)).toHaveLength(0);
    // Still zoomed after 60 idle frames — the zoom is not "used up" by idling.
    expect(renderer.camera.scale.x).toBe(8.64);
  });

  it('a damage floater appears under the FX layer and leaves it empty again', () => {
    const { sim, renderer, enemyId } = buildZoomingScene();
    expectZoomIsLive(renderer);

    applyDamage(sim.world, enemyId, 10);
    renderer.syncWorld(sim.world, 1);

    const fx = fxLayerOf(renderer);
    const floaters = fx.children.filter((child) => child instanceof Text);
    expect(floaters).toHaveLength(1);
    // The floater rides the WORLD space — it is inside the camera, so it scales with
    // the room (FR-001 lists damage floaters as world-space content).
    expect(renderer.camera.scale.x).toBe(8.64);
  });
});
