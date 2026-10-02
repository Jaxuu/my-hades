/**
 * Player art tests (specs/024-real-art-assets US1, T013).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * US1 replaces the blue dot with an animated character. Three things can silently
 * regress and must therefore be pinned by LITERALS:
 *
 *  1. the body is an `AnimatedSprite`, not a static `Sprite` (FR-002: at least an
 *     idle and a move action);
 *  2. the ACTION chosen matches the simulated `ActionState`, and the FACING matches
 *     `facingRadians` — the mapping is asserted on the frame label actually on
 *     screen, not on an intermediate value;
 *  3. the pre-feature geometry is still reachable when the atlas is missing
 *     (FR-013 / SC-007) — a missing atlas must degrade to a dot, never to nothing.
 *
 * Every assertion reads the PUBLIC scene graph, exactly like the frozen suites.
 */

import { describe, expect, it } from 'vitest';
import { AnimatedSprite, Container, Graphics } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameRenderer } from '../../client/GameRenderer';
import { NULL_SPRITE_PROVIDER } from '../../client/assets/AssetCatalog';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { ActionState, StateComponent } from '../../src/ecs/components/StateComponent';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { markDead } from '../../src/ecs/components/DeadTagComponent';
import { loadedCatalog, displayedFrame } from '../harness/art-fixtures';

function makeApp(deltaMs = 16): Application {
  const ticker = { deltaMS: deltaMs, add: (): void => {}, remove: (): void => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

/** The player's view container (the render root's first child, below fxLayer). */
function playerView(app: Application): Container {
  const camera = app.stage.children[0];
  if (camera === undefined) throw new Error('no camera on the stage');
  const root = camera.children[camera.children.length - 1];
  if (root === undefined) throw new Error('no render root');
  const view = root.children[0];
  if (view === undefined) throw new Error('no player view');
  return view;
}

/** The animated body inside the player view, or `undefined` on the fallback path. */
function bodyOf(app: Application): AnimatedSprite | undefined {
  return playerView(app).children.find((child): child is AnimatedSprite =>
    child instanceof AnimatedSprite,
  );
}

describe('US1 · the player is an animated character (FR-001/FR-002)', () => {
  it('builds an AnimatedSprite body when the atlas is available', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    const body = bodyOf(app);
    expect(body).toBeInstanceOf(AnimatedSprite);
    // Guard against a vacuous pass: the clip must actually carry frames.
    expect(body?.totalFrames).toBeGreaterThan(0);
    renderer.destroy();
  });

  it('is centred on the entity and sized from its hurtbox (not a magic number)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    const body = bodyOf(app);
    expect(body?.anchor.x).toBe(0.5);
    expect(body?.anchor.y).toBe(0.5);
    // radius 0.5 world units -> 10px diameter; a 16px tile draws at 0.625.
    expect(body?.scale.x).toBeCloseTo(0.625, 9);
    renderer.destroy();
  });
});

describe('US1 · action selection follows the simulated ActionState (FR-002/FR-004)', () => {
  // Facing is 0 rad, which the quantiser calls `right` (the renderer's convention:
  // 0 points +x). The literal pins below are the WHOLE contract of E4.
  const cases: readonly (readonly [ActionState, string])[] = [
    [ActionState.IDLE, 'player.base.idle.right.0'],
    [ActionState.MOVING, 'player.base.move.right.0'],
    [ActionState.DASHING, 'player.base.dash.right.0'],
    [ActionState.ATTACKING, 'player.base.attack.right.0'],
    [ActionState.HITSTUN, 'player.base.hit.right.0'],
  ];

  it.each(cases)('shows the %s clip', async (state, expected) => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const component = sim.world.getComponent(player, StateComponent);
    if (component === undefined) throw new Error('player lost its StateComponent');
    component.state = state;

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(displayedFrame(bodyOf(app) as AnimatedSprite)).toBe(expected);
    renderer.destroy();
  });

  it('shows the death clip once the entity carries a DeadTag (FR-004)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);
    markDead(sim.world, player);
    renderer.syncWorld(sim.world);

    expect(displayedFrame(bodyOf(app) as AnimatedSprite)).toBe('player.base.death.right.0');
    renderer.destroy();
  });
});

describe('US1 · facing follows facingRadians and is stable at the seam (FR-003)', () => {
  const facings: readonly (readonly [number, string])[] = [
    [0, 'right'],
    [Math.PI / 2, 'down'],
    [-Math.PI / 2, 'up'],
    [Math.PI, 'left'],
    [-Math.PI, 'left'],
  ];

  it.each(facings)('facingRadians %s shows the %s clip', async (radians, facing) => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const transform = sim.world.getComponent(player, TransformComponent);
    if (transform === undefined) throw new Error('player lost its TransformComponent');
    transform.facingRadians = radians;

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(displayedFrame(bodyOf(app) as AnimatedSprite)).toBe(`player.base.idle.${facing}.0`);
    renderer.destroy();
  });

  it('does NOT flip between facings across the ±PI seam (no jitter)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const transform = sim.world.getComponent(player, TransformComponent);
    if (transform === undefined) throw new Error('player lost its TransformComponent');

    const renderer = new GameRenderer(app, catalog);
    renderer.init();

    const seen = new Set<string | undefined>();
    for (let i = 0; i < 40; i += 1) {
      // Alternate the two representations of "straight left" the way a real body
      // would, and record the FACING of the clip being displayed. The frame index
      // legitimately advances, so only the facing segment is compared.
      transform.facingRadians = i % 2 === 0 ? Math.PI - 1e-9 : -Math.PI + 1e-9;
      renderer.syncWorld(sim.world);
      seen.add(displayedFrame(bodyOf(app) as AnimatedSprite)?.replace(/\.\d+$/, ''));
    }
    expect([...seen]).toEqual(['player.base.idle.left']);
    renderer.destroy();
  });

  it('counter-rotates the sprite so the art stays upright under the frozen rotation', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const transform = sim.world.getComponent(player, TransformComponent);
    if (transform === undefined) throw new Error('player lost its TransformComponent');
    transform.facingRadians = 0.75;

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    // The frozen contract: the CONTAINER's rotation IS the facing.
    expect(playerView(app).rotation).toBe(0.75);
    // ...and the sprite cancels it, so the character does not spin with it.
    expect(bodyOf(app)?.rotation).toBe(-0.75);
    renderer.destroy();
  });
});

describe('US1 · the animation clock is real frame time (FR-002, ADR-002)', () => {
  it('advances the frame as real milliseconds pass, and never reads logic ticks', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp(16);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const component = sim.world.getComponent(player, StateComponent);
    if (component === undefined) throw new Error('player lost its StateComponent');
    component.state = ActionState.MOVING;

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);
    const body = bodyOf(app) as AnimatedSprite;
    expect(body.currentFrame).toBe(0);

    // 130ms per move frame: 9 frames at 16ms = 144ms -> frame 1.
    for (let i = 0; i < 9; i += 1) renderer.syncWorld(sim.world);
    expect(body.currentFrame).toBe(1);

    // The simulation was never stepped: the clip advanced on the RENDER clock.
    expect(sim.tick).toBe(0);
    renderer.destroy();
  });

  it('settles on the last frame instead of wrapping (a clip does not loop)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp(16);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const component = sim.world.getComponent(player, StateComponent);
    if (component === undefined) throw new Error('player lost its StateComponent');
    component.state = ActionState.MOVING;

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);
    const body = bodyOf(app) as AnimatedSprite;
    expect(body.totalFrames).toBe(2);

    // Far past the end of a 2-frame clip: it must HOLD the last frame rather than
    // restart, or every walk cycle would read as a flicker.
    for (let i = 0; i < 200; i += 1) renderer.syncWorld(sim.world);
    expect(body.currentFrame).toBe(body.totalFrames - 1);
    renderer.destroy();
  });
});

describe('US1 · a missing atlas degrades to the pre-feature geometry (FR-013)', () => {
  it('keeps the view alive and draws the old circle + facing line', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 1.5, y: -2 });

    // The default provider misses on every lookup — exactly the pre-M16 renderer.
    const renderer = new GameRenderer(app, NULL_SPRITE_PROVIDER);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(renderer.viewCount).toBe(1);
    const view = playerView(app);
    expect(view.x).toBe(15);
    expect(view.y).toBe(-20);
    expect(bodyOf(app)).toBeUndefined();
    // Two geometry children: the body disc and the facing line.
    const graphics = view.children.filter((child): child is Graphics => child instanceof Graphics);
    expect(graphics.length).toBeGreaterThanOrEqual(2);
    renderer.destroy();
  });

  it('still tints for a hit when it is on the geometry path', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const component = sim.world.getComponent(player, StateComponent);
    if (component === undefined) throw new Error('player lost its StateComponent');
    component.state = ActionState.HITSTUN;

    const renderer = new GameRenderer(app, NULL_SPRITE_PROVIDER);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(playerView(app).tint).toBe(0xff0000);
    renderer.destroy();
  });
});
