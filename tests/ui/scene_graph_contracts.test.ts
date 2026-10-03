/**
 * The M19 UI does not enter the Pixi scene graph (specs/027-hud-boon-ui T038 ·
 * FR-054 / SC-012 · contract scene-graph-and-screen-space.md §1).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * Six scene-graph contracts are frozen (F1–F6). The ONE structural temptation of a
 * "material HUD" milestone is to draw the bars and the cards on the canvas — which
 * would add a resident node and break F1/F2/F5 at once. M19 avoids it by keeping the
 * entire interface in the DOM.
 *
 * The proof is two-sided, and neither half is a DOM test:
 *  - the six contracts are asserted against a REAL renderer (they must still hold);
 *  - the UI source is asserted to be DOM-only — it imports no pixi and creates no
 *    `Container` / `Graphics` — so it CANNOT add a node. (tests/ui/ui_skin.test.ts
 *    already pins the manager half; this suite pins the scene graph it protects.)
 */

import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { Application } from 'pixi.js';

import {
  createDefaultSystems,
  EnemyFactory,
  GameSimulator,
  GameStateFactory,
  LevelLoader,
  PlayerFactory,
  TransformComponent,
} from '../../src';
import { GameRenderer } from '../../client/GameRenderer';
import { testEnemy } from '../harness/config-fixtures';
import { readRepoFile, stripComments } from '../harness/ui-source';

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

function makeScreenApp(width = 1920, height = 1080): Application {
  const ticker: FakeTicker = { deltaMS: 20, add: (): void => {}, remove: (): void => {} };
  return {
    stage: new Container(),
    ticker,
    screen: { width, height },
  } as unknown as Application;
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

/** A room + player + enemy scene, the zoom-active path. */
function buildScene(): { sim: GameSimulator; renderer: GameRenderer } {
  const sim = new GameSimulator({ systems: createDefaultSystems(), seed: 0x12345678 });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
  LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
  EnemyFactory.spawn(sim.world, ...testEnemy({ x: 6, y: 6, hp: 100, maxHp: 100 }));
  GameStateFactory.spawn(sim.world);
  sim.step(1);

  const renderer = new GameRenderer(makeScreenApp());
  renderer.init();
  renderer.syncWorld(sim.world, 1);
  return { sim, renderer };
}

describe('T038 · the six frozen scene-graph contracts hold (SC-012)', () => {
  it('F1: the stage has exactly one child, and it is the camera', () => {
    const { renderer } = buildScene();
    const app = renderer.camera.parent;
    if (app === null) throw new Error('QA: the camera is not attached');
    expect(app.children).toHaveLength(1);
    expect(app.children[0]).toBe(renderer.camera);
  });

  it('F2: the render root is still the camera’s LAST child', () => {
    const { renderer } = buildScene();
    const root = renderRoot(renderer);
    expect(root.parent).toBe(renderer.camera);
    // A UI that mounted a canvas node would push the root off the end.
    expect(renderer.camera.children[renderer.camera.children.length - 1]).toBe(root);
  });

  it('F3: the FX layer is still the render root’s LAST child', () => {
    const { renderer } = buildScene();
    const fx = fxLayerOf(renderer);
    expect(fx.parent).toBe(renderRoot(renderer));
  });

  it('F4: root.children[0] is the first entity view', () => {
    const { renderer } = buildScene();
    const root = renderRoot(renderer);
    const fx = fxLayerOf(renderer);
    const views = root.children.filter((child) => child !== fx);
    expect(views.length).toBe(renderer.viewCount);
    expect(root.children[0]).toBe(views[0]);
  });

  it('F5: with no walls, the camera has exactly one child', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems(), seed: 0x12345678 });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    GameStateFactory.spawn(sim.world);
    const renderer = new GameRenderer(makeScreenApp());
    renderer.init();
    renderer.syncWorld(sim.world, 1);

    expect(renderer.wallViewCount).toBe(0);
    expect(renderer.camera.children).toHaveLength(1);
    expect(renderer.camera.children[0]).toBe(renderRoot(renderer));
  });

  it('F6: the FX layer has exactly zero children while idle', () => {
    const { sim, renderer } = buildScene();
    for (let i = 0; i < 60; i += 1) renderer.syncWorld(sim.world);
    expect(fxLayerOf(renderer).children).toHaveLength(0);
    expect(sim.world.query(TransformComponent).length).toBeGreaterThan(0);
  });
});

describe('T038 · the UI cannot add a scene-graph node', () => {
  it('imports no pixi and builds no Container / Graphics', () => {
    const ui = stripComments(readRepoFile('client/UIManager.ts'));
    expect(ui).not.toContain('pixi.js');
    expect(ui).not.toContain('Container');
    expect(ui).not.toContain('Graphics');
    expect(ui).not.toContain('Sprite');
  });
});
