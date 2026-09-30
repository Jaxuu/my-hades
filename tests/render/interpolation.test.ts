/**
 * Render-juice tests (specs/10_render_juice_spec.md AC-01 / AC-02 / AC-03).
 *
 * Verifies the M5-T02 "game feel" layer — render interpolation, damage floaters
 * and the hit flash — against a REAL `GameSimulator` and the REAL PixiJS scene
 * graph, with NO jsdom and no browser.
 *
 * Mirrors `renderer_bridge.test.ts`: the `Application` is a duck-typed stand-in
 * (`{ stage, ticker }`) and assertions read only PUBLIC observables (the scene
 * graph under `app.stage`, plus the read-only `World`). Nothing here touches
 * `GameRenderer`'s private fields.
 *
 * IMPORTANT (PixiJS v8 under plain Node): `Text` CONSTRUCTS fine without a DOM,
 * and `.text` / `.x` / `.y` / `.alpha` are readable — but reading `.width` /
 * `.height` / bounds triggers a lazy canvas text-measurement and throws
 * `document is not defined`. The floater assertions therefore NEVER touch size,
 * only `.text` and the parent/child relationship.
 */

import { describe, expect, it } from 'vitest';
import { Container, Text } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import type { System } from '../../src/ecs/System';
import type { World } from '../../src/ecs/World';
import type { EntityId } from '../../src/ecs/Entity';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { PreviousTransformComponent } from '../../src/ecs/components/PreviousTransformComponent';
import { applyDamage } from '../../src/ecs/components/HealthComponent';
import { applyFreeze } from '../../src/ecs/components/FreezeComponent';
import { GameRenderer } from '../../client/GameRenderer';
import { testEnemy } from '../harness/config-fixtures';

/** Expected tint values, mirrored from spec 10 §3.3 (public contract). */
const NO_TINT = 0xffffff;
const HIT_FLASH_TINT = 0xff0000;

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

/** Duck-typed `Application`: a real Container stage + a controllable ticker. */
function makeApp(deltaMs: number): { app: Application; ticker: FakeTicker } {
  const ticker: FakeTicker = { deltaMS: deltaMs, add: () => {}, remove: () => {} };
  const app = { stage: new Container(), ticker } as unknown as Application;
  return { app, ticker };
}

/**
 * The render root. M12-T02: the stage's only child is the CAMERA, and the root is the
 * camera's LAST child (the static layer, when present, sits at camera index 0).
 */
function renderRoot(app: Application): Container {
  const camera = app.stage.children[0];
  if (camera === undefined) {
    throw new Error('renderer.init() did not attach a camera to app.stage');
  }
  const root = camera.children[camera.children.length - 1];
  if (root === undefined) {
    throw new Error('renderer.init() did not attach a root to the camera');
  }
  return root;
}

/**
 * The FX layer is the LAST child of the render root (see `GameRenderer.init`):
 * entity views are always inserted just below it, so it stays topmost.
 */
function fxLayerOf(app: Application): Container {
  const root = renderRoot(app);
  const layer = root.children[root.children.length - 1];
  if (layer === undefined) {
    throw new Error('render root has no children — was init() called?');
  }
  return layer;
}

/** All `Text` nodes anywhere under `container`, depth-first. */
function findTexts(container: Container): Text[] {
  const out: Text[] = [];
  for (const child of container.children) {
    if (child instanceof Text) out.push(child);
    out.push(...findTexts(child));
  }
  return out;
}

/**
 * Build the canonical pipeline with `probe` spliced in IMMEDIATELY AFTER
 * `TransformSnapshotSystem`. Located BY NAME (never a hard-coded index) so the
 * splice point cannot silently drift if the pipeline is ever reordered.
 */
function withProbeAfterSnapshot(probe: System): readonly System[] {
  const base = createDefaultSystems();
  const snapIndex = base.findIndex((system) => system.name === 'TransformSnapshotSystem');
  if (snapIndex === -1) {
    throw new Error('QA: the canonical pipeline has no TransformSnapshotSystem');
  }
  return [...base.slice(0, snapIndex + 1), probe, ...base.slice(snapIndex + 1)];
}

describe('render juice (spec 10)', () => {
  it('AC-01: blends prev -> curr by alpha (exactly 5.0 at the midpoint)', () => {
    const { app } = makeApp(20);

    // A probe writes the DESTINATION transform directly (transform.x = 1 world
    // unit = 10 px). Integrating a velocity instead would drag in the float error
    // `600 * (1/60) = 9.999999999999998`, so the midpoint would NOT be exactly 5.
    const target: { id: EntityId | undefined } = { id: undefined };
    const probe: System = {
      name: 'MoveProbe',
      update(world: World): void {
        const id = target.id;
        if (id === undefined) return;
        const transform = world.getComponent(id, TransformComponent);
        if (transform !== undefined) transform.x = 1;
      },
    };

    const sim = new GameSimulator({ systems: withProbeAfterSnapshot(probe) });
    const playerId = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    target.id = playerId;

    // One tick: TransformSnapshotSystem records prev = (0, 0), then the probe sets
    // curr.x = 1. No input => no locomotion, so curr stays exactly 1.
    sim.step(1);

    const renderer = new GameRenderer(app);
    renderer.init();

    // prev snapshot really was captured at the start of the tick.
    const previous = sim.world.getComponent(playerId, PreviousTransformComponent);
    expect(previous?.prevX).toBe(0);

    // alpha = 0 -> previous tick. The FIRST sync also builds the view, so capture
    // root.children[0] (the player view, just below fxLayer) only AFTER it.
    renderer.syncWorld(sim.world, 0);
    const playerView = renderRoot(app).children[0];
    if (playerView === undefined) throw new Error('expected a player view at root.children[0]');
    expect(playerView.x).toBe(0);

    renderer.syncWorld(sim.world, 0.5);
    expect(playerView.x).toBe(5.0); // 1 world unit * 0.5 * PX_PER_UNIT(10), EXACT

    renderer.syncWorld(sim.world, 1);
    expect(playerView.x).toBe(10);

    // The render layer is READ-ONLY: the logic transform is untouched.
    const transform = sim.world.getComponent(playerId, TransformComponent);
    expect(transform?.x).toBe(1);
  });

  it('AC-01: interpolation preserves the PX_PER_UNIT contract (10 world units => 50 px at the midpoint)', () => {
    // WHY THIS CASE EXISTS: the task brief's AC-01 prose is self-contradictory
    // under PX_PER_UNIT = 10 — it says the entity moves "(0,0) -> (10,0)" AND
    // asserts "container.x === 5.0" at alpha 0.5. Those cannot both hold: a
    // 10-world-unit displacement is 100 px, whose midpoint is 50 px. The test
    // above keeps the "=== 5.0" reading by moving 1 world unit (1 * 10 * 0.5 = 5).
    // THIS case covers the other reading — the "10 world units" DISPLACEMENT,
    // measured in the WORLD-UNIT interpretation (10 * 0.5 * PX_PER_UNIT = 50 px).
    // Together they close AC-01 from both observable angles.
    const { app } = makeApp(20);

    // A probe writes the DESTINATION transform directly (transform.x = 10 world
    // units = 100 px). Integrating a velocity instead would drag in the float
    // error `600 * (1/60) = 9.999999999999998`, so the midpoint would NOT be
    // exactly 50. The entity is spawned at (0, 0).
    const target: { id: EntityId | undefined } = { id: undefined };
    const probe: System = {
      name: 'MoveProbe',
      update(world: World): void {
        const id = target.id;
        if (id === undefined) return;
        const transform = world.getComponent(id, TransformComponent);
        if (transform !== undefined) transform.x = 10;
      },
    };

    const sim = new GameSimulator({ systems: withProbeAfterSnapshot(probe) });
    const playerId = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    target.id = playerId;

    // One tick: TransformSnapshotSystem records prev = (0, 0), then the probe sets
    // curr.x = 10. No input => no locomotion, so curr stays exactly 10.
    sim.step(1);

    const renderer = new GameRenderer(app);
    renderer.init();

    // prev snapshot really was captured BEFORE the move (at the start of the tick).
    const previous = sim.world.getComponent(playerId, PreviousTransformComponent);
    expect(previous?.prevX).toBe(0);

    // alpha = 0 -> previous tick. The FIRST sync also builds the view, so capture
    // root.children[0] (the player view, just below fxLayer) only AFTER it.
    renderer.syncWorld(sim.world, 0);
    const playerView = renderRoot(app).children[0];
    if (playerView === undefined) throw new Error('expected a player view at root.children[0]');
    expect(playerView.x).toBe(0);

    renderer.syncWorld(sim.world, 0.5);
    expect(playerView.x).toBe(50); // 10 world units * 0.5 * PX_PER_UNIT(10), EXACT

    renderer.syncWorld(sim.world, 1);
    expect(playerView.x).toBe(100);

    // The render layer is READ-ONLY: the logic transform is untouched.
    const transform = sim.world.getComponent(playerId, TransformComponent);
    expect(transform?.x).toBe(10);
  });

  it('AC-01: clamps alpha outside [0, 1] (never extrapolates)', () => {
    const { app } = makeApp(20);

    const target: { id: EntityId | undefined } = { id: undefined };
    const probe: System = {
      name: 'MoveProbe',
      update(world: World): void {
        const id = target.id;
        if (id === undefined) return;
        const transform = world.getComponent(id, TransformComponent);
        if (transform !== undefined) transform.x = 1;
      },
    };

    const sim = new GameSimulator({ systems: withProbeAfterSnapshot(probe) });
    target.id = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    sim.step(1);

    const renderer = new GameRenderer(app);
    renderer.init();

    // alpha > 1 clamps to 1 (current). The FIRST sync builds the view, so capture
    // root.children[0] (the player view) only AFTER it.
    renderer.syncWorld(sim.world, 2);
    const playerView = renderRoot(app).children[0];
    if (playerView === undefined) throw new Error('expected a player view at root.children[0]');
    expect(playerView.x).toBe(10);

    // alpha < 0 clamps to 0 (previous).
    renderer.syncWorld(sim.world, -1);
    expect(playerView.x).toBe(0);
  });

  it('AC-02: a dropped HP spawns a rising "-N" floater', () => {
    const { app } = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const enemyId = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 3, y: 0, hp: 100, maxHp: 100 }));
    sim.step(1);

    const renderer = new GameRenderer(app);
    renderer.init();

    // First sync builds the view and seeds `lastHp = 100` — no floater yet.
    renderer.syncWorld(sim.world, 1);
    expect(findTexts(renderRoot(app))).toHaveLength(0);

    applyDamage(sim.world, enemyId, 10);
    renderer.syncWorld(sim.world, 1);

    const texts = findTexts(renderRoot(app));
    expect(texts).toHaveLength(1);
    // Assert `.text` ONLY — never width/height (they need a DOM canvas).
    expect(texts[0]?.text).toBe('-10');
  });

  it('AC-02: a floater is destroyed once its 1000ms lifetime elapses', () => {
    const { app } = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const enemyId = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, hp: 100, maxHp: 100 }));
    sim.step(1);

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1);

    applyDamage(sim.world, enemyId, 10);
    renderer.syncWorld(sim.world, 1); // spawns the floater (elapsed 0)
    expect(findTexts(renderRoot(app))).toHaveLength(1);

    // 50 frames * 20ms = 1000ms >= FLOATING_TEXT_LIFETIME_MS -> destroyed.
    for (let frame = 0; frame < 50; frame += 1) {
      renderer.syncWorld(sim.world, 1);
    }

    expect(findTexts(renderRoot(app))).toHaveLength(0);
    expect(fxLayerOf(app).children).toHaveLength(0);
  });

  it('AC-03: a frozen entity is tinted, and the tint resets when the freeze lapses', () => {
    const { app } = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const playerId = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    sim.step(1);

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1);

    const playerView = renderRoot(app).children[0];
    if (playerView === undefined) throw new Error('expected a player view at root.children[0]');
    expect(playerView.tint).toBe(NO_TINT);

    // applyFreeze(2) arms remainingTicks = 3; FreezeSystem drains it one per tick.
    applyFreeze(sim.world, playerId, 2);
    renderer.syncWorld(sim.world, 1);
    expect(playerView.tint).toBe(HIT_FLASH_TINT);

    sim.step(3); // 3 -> 2 -> 1 -> 0, freeze lapses
    renderer.syncWorld(sim.world, 1);
    expect(playerView.tint).toBe(NO_TINT);
  });
});
