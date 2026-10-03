/**
 * Player art tests (specs/026-hd-2d-art-assets US1, T014/T015/T016).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * US1 replaces the 16x16 pixel knight with a 128px four-way, six-action HD
 * character. Three things can silently regress and must therefore be pinned by
 * LITERALS:
 *
 *  1. the body is an `AnimatedSprite`, not a static `Sprite`;
 *  2. the ACTION chosen matches the simulated `ActionState`, and the FACING matches
 *     `facingRadians` — asserted on the frame label actually on screen;
 *  3. the pre-feature geometry is still reachable when the atlas is missing
 *     (FR-013 / SC-007) — a missing atlas must degrade to a dot, never to nothing.
 *
 * M18 ADDITIONS
 * -------------
 *  - **Loop semantics** (T015 / research.md D13 / FR-006): `idle` and `move` CYCLE;
 *    `dash` / `attack` / `hit` / `death` settle on their LAST frame.
 *  - **Attack phase** (T016 / contract §4.1): the clip's hit frames are f2-f3, and
 *    that window must overlap the simulation's own attack-active window, so the
 *    picture and the judgement cannot drift apart.
 *  - **Hurtbox-derived size** (T021 / FR-008): the drawn body equals the collision
 *    body, with the natural size read from the HD FRAME rather than a constant.
 *
 * Every assertion reads the PUBLIC scene graph, exactly like the frozen suites.
 */

import { describe, expect, it } from 'vitest';
import { AnimatedSprite, Container, Graphics } from 'pixi.js';
import type { Application } from 'pixi.js';

import { ANIM_FRAME_MS, GameRenderer } from '../../client/GameRenderer';
import { NULL_SPRITE_PROVIDER } from '../../client/assets/AssetCatalog';
import { SHEET_DATA } from '../../client/assets/manifest';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { ActionState, StateComponent } from '../../src/ecs/components/StateComponent';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { HurtboxComponent } from '../../src/ecs/components/HurtboxComponent';
import { HitboxComponent } from '../../src/ecs/components/HitboxComponent';
import { Faction } from '../../src/ecs/components/FactionComponent';
import { ATTACK_KEY } from '../../src/ecs/components/PlayerInputComponent';
import { markDead } from '../../src/ecs/components/DeadTagComponent';
import { loadedCatalog, displayedFrame } from '../harness/art-fixtures';

const TICK_MS = 1000 / 60;

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

/** A player rig with `state` forced, plus the renderer, ready for one sync. */
async function rigWithState(
  state: ActionState | null,
  deltaMs = 16,
): Promise<{ app: Application; sim: GameSimulator; renderer: GameRenderer; player: number }> {
  const catalog = await loadedCatalog();
  const app = makeApp(deltaMs);
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
  if (state !== null) {
    const component = sim.world.getComponent(player, StateComponent);
    if (component === undefined) throw new Error('player lost its StateComponent');
    component.state = state;
  }
  const renderer = new GameRenderer(app, catalog);
  renderer.init();
  renderer.syncWorld(sim.world);
  return { app, sim, renderer, player };
}

describe('US1 · the player is an animated character (FR-001/FR-002)', () => {
  it('builds an AnimatedSprite body when the atlas is available', async () => {
    const { app, renderer } = await rigWithState(ActionState.IDLE);
    const body = bodyOf(app);
    expect(body).toBeInstanceOf(AnimatedSprite);
    // Guard against a vacuous pass: the clip must actually carry frames.
    expect(body?.totalFrames).toBeGreaterThan(1);
    renderer.destroy();
  });

  it('is centred on the entity and sized from its hurtbox (not a magic number)', async () => {
    const { app, sim, renderer, player } = await rigWithState(ActionState.IDLE);
    const body = bodyOf(app);
    expect(body?.anchor.x).toBe(0.5);
    expect(body?.anchor.y).toBe(0.5);

    // M18: the natural size is the FRAME's own size (128 for the player), so the
    // scale is the radius-derived value, not a constant baked from the old 16px art.
    const radius = sim.world.getComponent(player, HurtboxComponent)?.radius ?? 0;
    const naturalPx = body?.texture.width ?? 0;
    expect(naturalPx).toBe(128);
    expect(body?.scale.x).toBeCloseTo((radius * 2 * 10) / naturalPx, 9);
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
    const { app, renderer } = await rigWithState(state);
    expect(displayedFrame(bodyOf(app) as AnimatedSprite)).toBe(expected);
    renderer.destroy();
  });

  it('shows the death clip once the entity carries a DeadTag (FR-004)', async () => {
    const { app, sim, renderer, player } = await rigWithState(ActionState.IDLE);
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
    const { app, sim, renderer } = await rigWithState(ActionState.MOVING, 16);
    const body = bodyOf(app) as AnimatedSprite;
    expect(body.currentFrame).toBe(0);

    // 130ms per move frame: 9 frames at 16ms = 144ms -> frame 1.
    for (let i = 0; i < 9; i += 1) renderer.syncWorld(sim.world);
    expect(body.currentFrame).toBe(1);

    // The simulation was never stepped: the clip advanced on the RENDER clock.
    expect(sim.tick).toBe(0);
    renderer.destroy();
  });
});

describe('US1 · loop semantics: idle/move cycle, one-shots settle (T015 / FR-006)', () => {
  const looping: readonly (readonly [string, ActionState, number])[] = [
    ['idle', ActionState.IDLE, ANIM_FRAME_MS.idle],
    ['move', ActionState.MOVING, ANIM_FRAME_MS.move],
  ];

  it.each(looping)('the %s clip WRAPS instead of freezing', async (_name, state, frameMs) => {
    const { app, sim, renderer } = await rigWithState(state, 16);
    const body = bodyOf(app) as AnimatedSprite;
    const total = body.totalFrames;
    expect(total).toBeGreaterThan(1);

    // Run comfortably past ONE full cycle, recording every frame that was shown.
    const syncs = Math.ceil((total * frameMs) / 16) + 40;
    const frames: number[] = [];
    for (let i = 0; i < syncs; i += 1) {
      renderer.syncWorld(sim.world);
      frames.push(body.currentFrame);
    }

    // A wrap is a transition from the last frame back to frame 0.
    const wrapped = frames.some((frame, i) => i > 0 && frames[i - 1] === total - 1 && frame === 0);
    expect(wrapped, `${_name} never wrapped`).toBe(true);
    // ...and the clip really did reach its last frame (not a truncated cycle).
    expect(Math.max(...frames)).toBe(total - 1);
    renderer.destroy();
  });

  const oneShot: readonly (readonly [string, ActionState, number])[] = [
    // `syncs` is the observation budget. 400 frames is "far past the end" for the
    // clips that live as long as the state does; `death` is capped because the
    // death FX RETIRES the view after 400ms (`DEATH_FADE_MS`), so a longer window
    // would be measuring a destroyed sprite rather than the clip.
    ['dash', ActionState.DASHING, 400],
    ['attack', ActionState.ATTACKING, 400],
    ['hit', ActionState.HITSTUN, 400],
    ['death', ActionState.IDLE, 22],
  ];

  it.each(oneShot)('the %s clip SETTLES on its last frame (no wrap to 0)', async (name, state, syncs) => {
    const { app, sim, renderer, player } = await rigWithState(state, 16);
    if (name === 'death') markDead(sim.world, player);
    renderer.syncWorld(sim.world);

    const body = bodyOf(app) as AnimatedSprite;
    const total = body.totalFrames;
    expect(total).toBeGreaterThan(1);

    const frames: number[] = [];
    for (let i = 0; i < syncs; i += 1) {
      renderer.syncWorld(sim.world);
      frames.push(body.currentFrame);
    }
    // Far past the end of the clip: it must HOLD the last frame rather than
    // restart, or every attack would read as a flicker.
    expect(frames[frames.length - 1], `${name} final frame`).toBe(total - 1);
    // No wrap: once the last frame is reached, frame 0 never appears again.
    const firstLast = frames.indexOf(total - 1);
    expect(frames.slice(firstLast).includes(0)).toBe(false);
    renderer.destroy();
  });
});

describe('US1 · the attack HIT phase matches the simulated attack window (T016)', () => {
  it('puts the hit frames at f2-f3 and overlaps the sim attack-active window', async () => {
    const clip = SHEET_DATA['player.base']?.animations?.['player.base.attack.right'];
    expect(clip).toBeDefined();
    const frames = clip ?? [];
    // Contract §4.1: 起手 f0-1 / 命中 f2-3 / 收招 f4-5 — so there IS a windup and a
    // recovery, and the hit phase is neither the first nor the last frame.
    expect(frames.length).toBeGreaterThanOrEqual(6);

    // Measure the SIMULATION's own attack window: how long the player is ATTACKING
    // and for how many ticks a player-faction hitbox exists.
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });

    let attackTicks = 0;
    let firstHitboxTick = -1;
    let lastHitboxTick = -1;
    for (let tick = 0; tick < 120; tick += 1) {
      sim.step(1);
      if (sim.world.getComponent(player, StateComponent)?.state === ActionState.ATTACKING) {
        attackTicks += 1;
      }
      const liveHitbox = sim.world
        .query(HitboxComponent)
        .some((id) => sim.world.getComponent(id, HitboxComponent)?.faction === Faction.Player);
      if (liveHitbox) {
        if (firstHitboxTick < 0) firstHitboxTick = tick;
        lastHitboxTick = tick;
      }
    }

    // Guard against a vacuous pass: the rig must actually have attacked.
    expect(attackTicks).toBeGreaterThan(0);
    expect(firstHitboxTick).toBeGreaterThanOrEqual(0);

    const activeStartMs = firstHitboxTick * TICK_MS;
    const activeEndMs = (lastHitboxTick + 1) * TICK_MS;
    const hitStartMs = 2 * ANIM_FRAME_MS.attack;
    const hitEndMs = 4 * ANIM_FRAME_MS.attack;
    const overlapMs = Math.min(hitEndMs, activeEndMs) - Math.max(hitStartMs, activeStartMs);
    expect(
      overlapMs,
      `hit window [${hitStartMs}, ${hitEndMs})ms vs active [${activeStartMs.toFixed(0)}, ${activeEndMs.toFixed(0)})ms`,
    ).toBeGreaterThan(0);
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
