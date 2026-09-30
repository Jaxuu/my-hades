/**
 * M12-T02 · Presentation-layer camera follow (spec 20 AC-03 / §4.3).
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * Until M12-T02 the room was drawn at the world origin in the canvas's top-left
 * corner, so a player who walked far enough simply walked off screen (spec 19 R5).
 * The fix is a `Container` (`camera`) that becomes the public parent of everything
 * world-space and is translated every frame so the player sits at the centre of the
 * screen. This suite covers the four things that can go wrong:
 *
 *  - the camera is not wired into the scene graph        -> G1
 *  - the follow is a snap, not a lerp (or never converges) -> G2
 *  - it moves the WRONG thing (views instead of camera)  -> G3
 *  - it breaks with no player / breaks the FX tree        -> G4 / G5
 *
 * The rig drives the REAL `GameSimulator` + the REAL `GameRenderer` against a
 * duck-typed `Application` (`{ stage, ticker }`) — the same stand-in the M5 render
 * suites use. PixiJS v8 cannot be driven from plain Node, and the renderer only ever
 * needs those two members.
 *
 * IMPORTANT (PixiJS v8 under plain Node): never read `.width` / `.height` / bounds on
 * a `Text` — that triggers a lazy canvas text-measurement and throws
 * `document is not defined`. Only `.x` / `.y` / `.parent` are touched.
 *
 * THE FAKE APP HAS NO `screen`, so the camera's target is `-playerPx` (the screen
 * centre is the origin). That degradation is itself part of AC-03 and is asserted
 * rather than avoided (spec 20 I12 / T4).
 */

import { describe, expect, it } from 'vitest';
import { Container, Text } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { LevelLoader } from '../../src/core/LevelLoader';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { WallComponent } from '../../src/ecs/components/WallComponent';
import { applyDamage } from '../../src/ecs/components/HealthComponent';
import { GameRenderer, PX_PER_UNIT } from '../../client/GameRenderer';
import { testEnemy } from '../harness/config-fixtures';

/* ========================================================================== *
 * Helpers                                                                     *
 * ========================================================================== */

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

/** Duck-typed `Application`: a real Container stage + a controllable ticker. */
function makeApp(deltaMs = 20): Application {
  const ticker: FakeTicker = { deltaMS: deltaMs, add: () => {}, remove: () => {} };
  return { stage: new Container(), ticker } as unknown as Application;
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
    if (child instanceof Container) out.push(...findTexts(child));
  }
  return out;
}

function transformOf(sim: GameSimulator, id: number): TransformComponent {
  const transform = sim.world.getComponent(id, TransformComponent);
  if (transform === undefined) throw new Error('QA: entity is missing TransformComponent');
  return transform;
}

/* ========================================================================== *
 * G1 · the scene graph                                                       *
 * ========================================================================== */
describe('G1 · the camera is the stage child and wraps the render root (AC-03)', () => {
  it('wires stage -> camera -> root, and keeps the frozen root child order', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);

    const camera = renderer.camera;
    // The camera is the ONE stage child.
    expect(app.stage.children).toHaveLength(1);
    expect(app.stage.children[0]).toBe(camera);
    // With no walls, the camera holds exactly the render root.
    expect(camera.children).toHaveLength(1);
    const root = camera.children[camera.children.length - 1];
    expect(root).toBeDefined();

    // The FROZEN M5 contract still holds under the camera: entity views keep
    // ascending-id order from index 0, and the FX layer stays the LAST child.
    if (root === undefined) throw new Error('QA: no render root');
    expect(renderer.viewCount).toBe(1);
    expect(root.children).toHaveLength(2); // the player view + the FX layer
  });
});

/* ========================================================================== *
 * G2 · the lerp exists and converges                                          *
 * ========================================================================== */
describe('G2 · the camera eases towards the player and converges (AC-03)', () => {
  it('does NOT snap on the first frame, then converges to the exact target', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    // Player at world (1.5, 1.5) -> (15, 15) px. The fake app has no screen, so the
    // target is `screenCentre - playerPx = -playerPx = (-15, -15)`.
    PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });

    const renderer = new GameRenderer(app);
    renderer.init();

    renderer.syncWorld(sim.world);
    // The FIRST frame is a partial step, not the destination: this is what proves the
    // follow is a lerp rather than a hard snap (which would be exactly -15 here).
    expect(renderer.camera.x).not.toBe(-1.5 * PX_PER_UNIT);
    expect(renderer.camera.x).toBeGreaterThan(-1.5 * PX_PER_UNIT);

    // Many frames later it has converged to the target.
    for (let i = 0; i < 120; i += 1) renderer.syncWorld(sim.world);
    expect(renderer.camera.x).toBeCloseTo(-1.5 * PX_PER_UNIT, 6);
    expect(renderer.camera.y).toBeCloseTo(-1.5 * PX_PER_UNIT, 6);
  });

  it('follows the player to a new position', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });

    const renderer = new GameRenderer(app);
    renderer.init();

    for (let i = 0; i < 120; i += 1) renderer.syncWorld(sim.world);
    expect(renderer.camera.x).toBeCloseTo(-1.5 * PX_PER_UNIT, 6);

    // Move the player and let the camera chase.
    transformOf(sim, player).x = 5.5;
    for (let i = 0; i < 120; i += 1) renderer.syncWorld(sim.world);
    expect(renderer.camera.x).toBeCloseTo(-5.5 * PX_PER_UNIT, 6);
  });
});

/* ========================================================================== *
 * G3 · only the camera is translated                                          *
 * ========================================================================== */
describe('G3 · views keep world-pixel coordinates; only the camera moves (AC-03)', () => {
  it('leaves entity views at world pixels while the camera is offset', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 2, y: -3 });

    const renderer = new GameRenderer(app);
    renderer.init();
    for (let i = 0; i < 120; i += 1) renderer.syncWorld(sim.world);

    const playerView = renderRoot(renderer).children[0];
    if (playerView === undefined) throw new Error('QA: no player view');

    // The view is at WORLD pixels — unaffected by the camera.
    expect(playerView.x).toBe(2 * PX_PER_UNIT);
    expect(playerView.y).toBe(-3 * PX_PER_UNIT);
    // The camera, meanwhile, has moved to centre that world position.
    expect(renderer.camera.x).toBeCloseTo(-2 * PX_PER_UNIT, 6);
    expect(renderer.camera.y).toBeCloseTo(3 * PX_PER_UNIT, 6);
  });

  it('leaves wall blocks at world pixels while the camera is offset', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 4.5, y: 8.5 });

    const renderer = new GameRenderer(app);
    renderer.init();

    const result = LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
    expect(result.wallCount).toBeGreaterThan(0);
    for (let i = 0; i < 120; i += 1) renderer.syncWorld(sim.world);

    // The static layer is camera index 0 (behind the root); its child 0 is the floor,
    // and its remaining children are the wall blocks, in wall-entity order.
    const staticLayer = renderer.camera.children[0];
    if (staticLayer === undefined) throw new Error('QA: no static layer under the camera');
    const wallBlock = staticLayer.children[1];
    if (wallBlock === undefined) throw new Error('QA: no wall block in the static layer');

    const wallIds = sim.world.query(WallComponent);
    const firstWall = wallIds[0];
    if (firstWall === undefined) throw new Error('QA: no wall entity');
    const wall = sim.world.getComponent(firstWall, WallComponent);
    if (wall === undefined) throw new Error('QA: wall entity lost its component');

    // World pixels, untouched by the camera (which has panned to centre the player).
    expect(wallBlock.x).toBe(wall.x * PX_PER_UNIT);
    expect(renderer.camera.x).not.toBe(0);
  });
});

/* ========================================================================== *
 * G4 · robustness: no player view                                             *
 * ========================================================================== */
describe('G4 · a world with no player view leaves the camera alone (AC-03)', () => {
  it('does not throw and does not move the camera', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });

    const renderer = new GameRenderer(app);
    renderer.init();

    // An empty world: no views at all.
    expect(() => renderer.syncWorld(sim.world)).not.toThrow();
    expect(renderer.camera.x).toBe(0);
    expect(renderer.camera.y).toBe(0);

    // Even with the camera pre-offset, an empty sync must not disturb it.
    renderer.camera.x = 42;
    renderer.camera.y = -7;
    renderer.syncWorld(sim.world);
    expect(renderer.camera.x).toBe(42);
    expect(renderer.camera.y).toBe(-7);
  });
});

/* ========================================================================== *
 * G5 · the FX tree rides the camera                                           *
 * ========================================================================== */
describe('G5 · floating text hangs inside the camera tree (world-space) (AC-03)', () => {
  it('keeps the FX layer under the root and the floater under the FX layer', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const enemyId = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 3, y: 0, hp: 100, maxHp: 100 }));
    sim.step(1);

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1); // build views, seed lastHp = 100

    applyDamage(sim.world, enemyId, 10);
    renderer.syncWorld(sim.world, 1); // spawn the floater

    const root = renderRoot(renderer);
    const fxLayer = root.children[root.children.length - 1];
    if (fxLayer === undefined) throw new Error('QA: no FX layer under the root');

    // The FX layer is the root's LAST child, and it is NOT a direct stage child: it
    // rides the camera, which is what makes the floater's world-space coordinates
    // translate with the world.
    expect(fxLayer.parent).toBe(root);
    expect(app.stage.children).not.toContain(fxLayer);

    const texts = findTexts(root);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.parent).toBe(fxLayer);
    // The floater's x is the enemy's WORLD pixel x — unmodified by the camera.
    expect(texts[0]?.x).toBe(3 * PX_PER_UNIT);
  });
});
