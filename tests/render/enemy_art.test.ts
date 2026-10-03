/**
 * Enemy art tests (specs/026-hd-2d-art-assets US2, T022/T023).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * US2's whole value is that the enemy types are distinguishable AT A GLANCE. That
 * rests entirely on the capability-signature classifier, which is invisible: if it
 * silently degraded, every enemy would draw the same monster and no other test
 * would notice. So the sprite ids are pinned by LITERAL, one per type.
 *
 * The other half is the graceful fallback: an entity the renderer classifies as an
 * enemy must never become INVISIBLE (that would be worse than the wrong monster),
 * and a non-combatant must not acquire a view at all.
 *
 * M18 ADDITIONS
 * -------------
 *  - **`dash` aliases `move`** (T023 / research.md D6): the key exists and its frame
 *    SEQUENCE equals `move`'s, so the alias is a real declaration and not a
 *    coincidentally-similar animation.
 *  - **Drawn size == collision size** (FR-008): the HD set mixes 96 / 128 / 160 px
 *    bodies, so the meaningful claim is that `scale x frameWidth` equals the
 *    hurtbox diameter — NOT that one sprite's scale number exceeds another's.
 *  - **Six, not five** (I2): the data table declares five categories, and
 *    `unknown` is the sixth, catch-all sprite. The two claims are asserted
 *    separately so neither can hide the other.
 */

import { describe, expect, it } from 'vitest';
import { AnimatedSprite, Container, Graphics } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameRenderer, PX_PER_UNIT } from '../../client/GameRenderer';
import { NULL_SPRITE_PROVIDER } from '../../client/assets/AssetCatalog';
import { SHEET_DATA } from '../../client/assets/manifest';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { spawnCombatant } from '../../src/ecs/prefabs/spawn-helpers';
import { Faction, FactionComponent } from '../../src/ecs/components/FactionComponent';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { HurtboxComponent } from '../../src/ecs/components/HurtboxComponent';
import { StateComponent, ActionState } from '../../src/ecs/components/StateComponent';
import { markDead } from '../../src/ecs/components/DeadTagComponent';
import { World } from '../../src/ecs/World';
import { enemySpriteId } from '../../client/assets/sprite-map';
import { testElite } from '../harness/config-fixtures';
import { displayedFrame, loadedCatalog } from '../harness/art-fixtures';

function makeApp(deltaMs = 16): Application {
  const ticker = { deltaMS: deltaMs, add: (): void => {}, remove: (): void => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

function renderRoot(app: Application): Container {
  const camera = app.stage.children[0];
  if (camera === undefined) throw new Error('no camera on the stage');
  const root = camera.children[camera.children.length - 1];
  if (root === undefined) throw new Error('no render root');
  return root;
}

/** The `n`-th entity view (ascending id order, below the FX layer). */
function viewAt(app: Application, index: number): Container {
  const view = renderRoot(app).children[index];
  if (view === undefined) throw new Error(`no view at index ${index}`);
  return view;
}

function bodyOf(view: Container): AnimatedSprite | undefined {
  return view.children.find((child): child is AnimatedSprite => child instanceof AnimatedSprite);
}

/** The width a body actually occupies on screen, in pixels. */
function drawnWidth(body: AnimatedSprite): number {
  return body.scale.x * body.texture.width;
}

describe('US2 · each declared enemy type draws its own monster (FR-005)', () => {
  const cases: readonly (readonly [string, () => readonly [string, object]])[] = [
    ['grunt', () => ['grunt', {}]],
    ['raider', () => ['raider', {}]],
    ['bomber', () => ['bomber', {}]],
    ['gunner', () => ['gunner', {}]],
  ];

  it.each(cases)('%s gets its own sprite id', async (type, build) => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const [enemyId] = build();
    EnemyFactory.spawn(sim.world, enemyId, { x: 0, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(displayedFrame(bodyOf(viewAt(app, 0)) as AnimatedSprite)).toBe(
      `enemy.${type}.idle.right.0`,
    );
    renderer.destroy();
  });

  it('gives the elite its own sprite id (spawned through spawnElite)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    EnemyFactory.spawnElite(sim.world, 'elite', { x: 0, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(displayedFrame(bodyOf(viewAt(app, 0)) as AnimatedSprite)).toBe('enemy.elite.idle.right.0');
    renderer.destroy();
  });

  it('gives all FIVE declared types five DISTINCT sprite ids in one frame', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    EnemyFactory.spawn(sim.world, 'grunt', { x: 0, y: 0 });
    EnemyFactory.spawn(sim.world, 'raider', { x: 1, y: 0 });
    EnemyFactory.spawn(sim.world, 'bomber', { x: 2, y: 0 });
    EnemyFactory.spawn(sim.world, 'gunner', { x: 3, y: 0 });
    EnemyFactory.spawnElite(sim.world, 'elite', { x: 4, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    const prefixes = [0, 1, 2, 3, 4].map((i) =>
      (displayedFrame(bodyOf(viewAt(app, i)) as AnimatedSprite) ?? '').replace(/\.idle\..*$/, ''),
    );
    expect(prefixes).toEqual([
      'enemy.grunt',
      'enemy.raider',
      'enemy.bomber',
      'enemy.gunner',
      'enemy.elite',
    ]);
    expect(new Set(prefixes).size).toBe(5);
    renderer.destroy();
  });

  it('gives the sixth (catch-all) type its own atlas too — six DISTINCT sources', async () => {
    // I2: the spec says "5 categories" and the sheet carries 6 ids. Both are true,
    // and the difference must be explicit rather than blurred.
    const six = ['grunt', 'elite', 'raider', 'bomber', 'gunner', 'unknown'];
    const animations = six.map((type) => SHEET_DATA[`enemy.${type}`]?.animations?.[`enemy.${type}.idle.down`]);
    for (const animation of animations) {
      expect(animation).toBeDefined();
      expect((animation ?? []).length).toBeGreaterThan(0);
    }
    const frameNames = animations.map((animation) => (animation ?? [])[0] ?? '');
    expect(new Set(frameNames).size).toBe(6);
  });
});

describe('US2 · dash aliases move (T023 / research.md D6)', () => {
  it('declares `enemy.<type>.dash.<facing>` for every type and facing', () => {
    for (const type of ['grunt', 'elite', 'raider', 'bomber', 'gunner', 'unknown']) {
      for (const facing of ['down', 'up', 'left', 'right']) {
        const key = `enemy.${type}.dash.${facing}`;
        expect(Object.keys(SHEET_DATA[`enemy.${type}`]?.animations ?? {}), key).toContain(key);
      }
    }
  });

  it('makes the dash sequence EXACTLY the move sequence (a real alias, not a lookalike)', () => {
    for (const type of ['grunt', 'elite', 'raider', 'bomber', 'gunner', 'unknown']) {
      const animations = SHEET_DATA[`enemy.${type}`]?.animations ?? {};
      for (const facing of ['down', 'up', 'left', 'right']) {
        const dash = animations[`enemy.${type}.dash.${facing}`] ?? [];
        const move = animations[`enemy.${type}.move.${facing}`] ?? [];
        expect(dash.length).toBeGreaterThan(0);
        expect(dash).toEqual(move);
      }
    }
  });

  it('plays the move frames when an enemy is DASHING (the alias is what the renderer sees)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const raider = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });
    const state = sim.world.getComponent(raider, StateComponent);
    if (state === undefined) throw new Error('raider lost its StateComponent');
    state.state = ActionState.DASHING;

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(displayedFrame(bodyOf(viewAt(app, 0)) as AnimatedSprite)).toBe(
      'enemy.raider.move.right.0',
    );
    renderer.destroy();
  });
});

describe('US2 · facing and death follow the simulation (FR-006)', () => {
  it('turns the enemy sprite with facingRadians, counter-rotated under the container', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const gunner = EnemyFactory.spawn(sim.world, 'gunner', { x: 0, y: 0, facingRadians: Math.PI / 2 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    const view = viewAt(app, 0);
    expect(view.rotation).toBeCloseTo(Math.PI / 2, 9);
    const body = bodyOf(view) as AnimatedSprite;
    expect(body.rotation).toBeCloseTo(-Math.PI / 2, 9);
    expect(displayedFrame(body)).toBe('enemy.gunner.idle.down.0');
    // Guard against a vacuous pass: the entity really is the gunner.
    expect(sim.world.getComponent(gunner, FactionComponent)?.faction).toBe(Faction.Enemy);
    renderer.destroy();
  });

  it('plays the death clip when the entity carries a DeadTag', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const grunt = EnemyFactory.spawn(sim.world, 'grunt', { x: 0, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);
    markDead(sim.world, grunt);
    renderer.syncWorld(sim.world);

    expect(displayedFrame(bodyOf(viewAt(app, 0)) as AnimatedSprite)).toBe(
      'enemy.grunt.death.right.0',
    );
    renderer.destroy();
  });

  it('advances the death clip and settles it on its last frame (C6 / FR-006)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const grunt = EnemyFactory.spawn(sim.world, 'grunt', { x: 0, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);
    markDead(sim.world, grunt);
    renderer.syncWorld(sim.world);

    const body = bodyOf(viewAt(app, 0)) as AnimatedSprite;
    const total = body.totalFrames;
    expect(total).toBeGreaterThan(1);

    // The death FX retires the view at 400ms, so the window stops short of that.
    const frames: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      renderer.syncWorld(sim.world);
      frames.push(body.currentFrame);
    }
    expect(frames[frames.length - 1]).toBe(total - 1);
    expect(frames.slice(frames.indexOf(total - 1)).includes(0)).toBe(false);
    renderer.destroy();
  });

  it('draws the body at the entity hurtbox size, so an elite is visibly bigger (FR-008)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const grunt = EnemyFactory.spawn(sim.world, 'grunt', { x: 0, y: 0 });
    const elite = EnemyFactory.spawnElite(sim.world, 'elite', { x: 2, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    const gruntBody = bodyOf(viewAt(app, 0)) as AnimatedSprite;
    const eliteBody = bodyOf(viewAt(app, 1)) as AnimatedSprite;
    const gruntRadius = sim.world.getComponent(grunt, HurtboxComponent)?.radius ?? 0;
    const eliteRadius = sim.world.getComponent(elite, HurtboxComponent)?.radius ?? 0;

    // The claim is about the DRAWN SIZE, not about a scale number: the HD set uses
    // different frame sizes per type (96 / 128 / 160), so a smaller scale can still
    // be a bigger body.
    expect(eliteRadius).toBeGreaterThan(gruntRadius);
    expect(drawnWidth(gruntBody)).toBeCloseTo(gruntRadius * 2 * PX_PER_UNIT, 9);
    expect(drawnWidth(eliteBody)).toBeCloseTo(eliteRadius * 2 * PX_PER_UNIT, 9);
    expect(drawnWidth(eliteBody)).toBeGreaterThan(drawnWidth(gruntBody));
    // ...and the natural sizes really do differ, so the two types are not simply
    // the same art at two scales.
    expect(eliteBody.texture.width).not.toBe(gruntBody.texture.width);
    renderer.destroy();
  });
});

describe('US2 · an unrecognised enemy never becomes invisible', () => {
  it('draws the grunt catch-all for a factioned unit with no capabilities', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const world = new World({ seed: 3 });
    // A bare factioned body: none of armor / hazard / ai is mounted, which the
    // frozen table resolves to the catch-all.
    const id = spawnCombatant(world, Faction.Enemy, { x: 0, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(world);

    expect(displayedFrame(bodyOf(viewAt(app, 0)) as AnimatedSprite)).toBe(
      'enemy.grunt.idle.right.0',
    );
    // The entity really is the one we spawned.
    expect(world.isAlive(id)).toBe(true);
    renderer.destroy();
  });

  it('skips a non-combatant entirely rather than inventing a view for it', () => {
    const app = makeApp();
    const world = new World({ seed: 4 });
    const orphan = world.createEntity();
    world.addComponent(orphan.id, new TransformComponent(0, 0, 0));

    const renderer = new GameRenderer(app, NULL_SPRITE_PROVIDER);
    renderer.init();
    renderer.syncWorld(world);

    expect(renderer.viewCount).toBe(0);
    renderer.destroy();
  });

  it('resolves the generic fallback id to a REAL sheet animation (not a dangling id)', async () => {
    const catalog = await loadedCatalog();
    // The classifier's `unknown` arm must name an animation the sheet actually
    // carries — otherwise "unrecognised" would mean "invisible", which is the one
    // failure mode an art swap must never introduce.
    const frames = catalog.animation(`${enemySpriteId('unknown')}.idle.down`);
    expect(frames).toBeDefined();
    expect(frames?.length).toBeGreaterThan(0);
  });

  it('keeps an enemy view alive through a mid-fight action change (no flicker to nothing)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const raider = EnemyFactory.spawn(sim.world, 'raider', { x: 0, y: 0 });
    const state = sim.world.getComponent(raider, StateComponent);
    if (state === undefined) throw new Error('raider lost its StateComponent');

    const renderer = new GameRenderer(app, catalog);
    renderer.init();

    const seen: string[] = [];
    for (const next of [
      ActionState.IDLE,
      ActionState.MOVING,
      ActionState.ATTACKING,
      ActionState.HITSTUN,
      ActionState.DASHING,
      ActionState.IDLE,
    ]) {
      state.state = next;
      renderer.syncWorld(sim.world);
      seen.push(displayedFrame(bodyOf(viewAt(app, 0)) as AnimatedSprite) ?? 'MISSING');
    }
    // M18: the DASHING slot shows the MOVE frames, because `dash` is a declared
    // alias of `move` for enemies (research.md D6) rather than its own artwork.
    expect(seen).toEqual([
      'enemy.raider.idle.right.0',
      'enemy.raider.move.right.0',
      'enemy.raider.attack.right.0',
      'enemy.raider.hit.right.0',
      'enemy.raider.move.right.0',
      'enemy.raider.idle.right.0',
    ]);
    renderer.destroy();
  });
});

describe('US2 · the geometry fallback still covers every enemy (FR-013)', () => {
  it('draws the pre-feature square when the atlas is unavailable', () => {
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    EnemyFactory.spawn(sim.world, 'gunner', { x: 2, y: 0 });

    const renderer = new GameRenderer(app, NULL_SPRITE_PROVIDER);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(renderer.viewCount).toBe(1);
    const view = viewAt(app, 0);
    expect(bodyOf(view)).toBeUndefined();
    expect(view.children.some((child) => child instanceof Graphics)).toBe(true);
    renderer.destroy();
  });

  it('still applies the hurtbox outline on the art path (spec 09 AC-04)', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    EnemyFactory.spawn(sim.world, 'elite', { x: 0, y: 0 });

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    const view = viewAt(app, 0);
    // Body sprite + hurtbox outline: the outline is kept on BOTH paths.
    expect(view.children.length).toBeGreaterThanOrEqual(2);
    renderer.destroy();
  });

  it('uses the elite variant fixture without touching src/', async () => {
    const catalog = await loadedCatalog();
    const app = makeApp();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    EnemyFactory.spawnElite(sim.world, ...testElite({ x: 0, y: 0 }));

    const renderer = new GameRenderer(app, catalog);
    renderer.init();
    renderer.syncWorld(sim.world);

    expect(displayedFrame(bodyOf(viewAt(app, 0)) as AnimatedSprite)).toBe('enemy.elite.idle.right.0');
    renderer.destroy();
  });
});
