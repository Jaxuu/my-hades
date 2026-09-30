/**
 * QA-INDEPENDENT render-juice verification (milestone M5-T02).
 *
 * Authored by quality-lead (严守真) as a fresh-eyes adversarial net for
 * `specs/10_render_juice_spec.md` (AC-01 / AC-02 / AC-03) and
 * `docs/architecture/ADR-002-render-interpolation.md`.
 *
 * It deliberately does NOT import the engineering suite's helpers
 * (`tests/render/interpolation.test.ts`): every fixture below is re-derived from
 * scratch so the evidence is INDEPENDENT. In particular the HITSTUN half of
 * AC-03 — which the engineering suite never exercises — is covered here.
 *
 * Rules honoured (see `tests/harness/independent-verify.test.ts` for the repo
 * convention):
 *  - REAL `GameSimulator` + REAL PixiJS scene graph; NO logic-layer mocking.
 *  - Duck-typed `Application` = `{ stage: Container, ticker: { deltaMS, add, remove } }`.
 *  - PixiJS v8 under plain Node: NEVER read `.width` / `.height` / bounds (they
 *    trigger canvas text measurement and throw `document is not defined`). Only
 *    `.text` / `.x` / `.y` / `.alpha` / `.tint` / `.rotation` are touched.
 *  - `Text` is constructed with the options object (`{ text, style }`), never the
 *    deprecated positional form.
 *
 * Kept as a permanent part of the regression net.
 */

import { describe, expect, it } from 'vitest';
import { Container, Text } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import type { Snapshot } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { vec2 } from '../../src/core/math';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { TransformComponent } from '../../src/ecs/components/TransformComponent';
import { PreviousTransformComponent } from '../../src/ecs/components/PreviousTransformComponent';
import { IntentComponent } from '../../src/ecs/components/IntentComponent';
import { VelocityComponent } from '../../src/ecs/components/VelocityComponent';
import { ActionState, StateComponent } from '../../src/ecs/components/StateComponent';
import { HealthComponent, applyDamage } from '../../src/ecs/components/HealthComponent';
import { applyFreeze } from '../../src/ecs/components/FreezeComponent';
import { ATTACK_KEY } from '../../src/ecs/components/PlayerInputComponent';
import { GameRenderer } from '../../client/GameRenderer';
import { testEnemy } from '../harness/config-fixtures';

/* ------------------------------------------------------------------ *
 * Independent fixtures (NOT shared with the engineering suite).       *
 * ------------------------------------------------------------------ */

/** Public tint contract (spec 10 §3.3), re-declared here, not imported. */
const NO_TINT = 0xffffff;
const HIT_FLASH_TINT = 0xff0000;

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

function makeApp(deltaMs: number): Application {
  const ticker: FakeTicker = { deltaMS: deltaMs, add: () => {}, remove: () => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

function rootOf(app: Application): Container {
  const camera = app.stage.children[0];
  if (camera === undefined) throw new Error('QA: renderer.init() attached no camera to app.stage');
  const root = camera.children[camera.children.length - 1];
  if (root === undefined) throw new Error('QA: renderer.init() attached no root to the camera');
  return root;
}

/** fxLayer is the LAST child of the render root (spec 10 §4.4). */
function fxLayerOf(app: Application): Container {
  const root = rootOf(app);
  const layer = root.children[root.children.length - 1];
  if (layer === undefined) throw new Error('QA: render root has no children — init() not called?');
  return layer;
}

/** Entity views = every root child EXCEPT the topmost fxLayer, in insertion order. */
function entityViews(app: Application): Container[] {
  const root = rootOf(app);
  return root.children.slice(0, Math.max(0, root.children.length - 1));
}

/** Every `Text` node anywhere under `container`, depth-first. */
function allTexts(container: Container): Text[] {
  const out: Text[] = [];
  for (const child of container.children) {
    if (child instanceof Text) out.push(child);
    out.push(...allTexts(child));
  }
  return out;
}

/** Fetch a component or fail the fixture loudly (keeps the specs strict-clean). */
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`QA fixture: missing ${label}`);
  return value;
}

/* ================================================================== *
 * V1 · TransformSnapshotSystem is semantically BEFORE MovementSystem  *
 * ================================================================== */
describe('QA-INDEP · V1 snapshot precedes movement (semantic)', () => {
  it('prevX is the PRE-movement position even though the real MovementSystem ran', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    // 60 world-units/s * (1/60 s) === exactly 1 world unit per tick (60*(1/60)===1).
    const id = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, maxSpeed: 60 }));
    const intent = must(sim.world.getComponent(id, IntentComponent), 'IntentComponent');
    must(sim.world.getComponent(id, VelocityComponent), 'VelocityComponent');
    intent.moveVector = vec2(1, 0);

    sim.step(1);

    const prev = must(sim.world.getComponent(id, PreviousTransformComponent), 'PreviousTransform');
    const tf = must(sim.world.getComponent(id, TransformComponent), 'TransformComponent');

    // MovementSystem advanced the entity exactly 1 world unit...
    expect(tf.x).toBe(1);
    expect(tf.y).toBe(0);
    // ...and the snapshot captured the position from the START of the tick (0),
    // NOT the post-movement value (1). If the snapshot ran after MovementSystem,
    // prevX would be 1 and this is the gate that fails.
    expect(prev.prevX).toBe(0);
    expect(prev.prevY).toBe(0);

    // Second tick proves the copy is live: prev now == the previous END position.
    sim.step(1);
    expect(prev.prevX).toBe(1);
    expect(tf.x).toBe(2);
  });
});

/* ================================================================== *
 * V3 · render layer is strictly read-only (hard contract)             *
 * ================================================================== */
describe('QA-INDEP · V3 renderer never writes back to the logic world', () => {
  it('world snapshots are bit-identical across a burst that hits every FX path', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const playerId = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const doomedId = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 3, y: 0, hp: 20, maxHp: 20 }));
    const recycledId = EnemyFactory.spawn(sim.world, ...testEnemy({ x: -3, y: 0, hp: 20, maxHp: 20 }));
    sim.step(2);

    const renderer = new GameRenderer(makeApp(20));
    renderer.init();
    // Build all views first, so the burst below exercises the FX paths, not just
    // view creation.
    renderer.syncWorld(sim.world, 0.5);

    // Arm every visual path for the burst:
    applyFreeze(sim.world, playerId, 5); // hit flash
    applyDamage(sim.world, doomedId, 10); // hp 20 -> 10  (floater)
    applyDamage(sim.world, doomedId, 999); // hp -> 0      (lethal floater)
    sim.step(1); // DeathSystem tags `doomed` -> death FX
    sim.world.destroyEntity(recycledId); // -> recycle path

    const before: Snapshot = sim.snapshot();
    const entityCountBefore = sim.world.entityCount;
    const entitiesBefore = sim.world.listEntities();

    // 60 frames @20ms: interpolation + floater spawn/age/destroy (1000ms) +
    // flash + death FX advance/retire (400ms) + recycle all execute.
    for (let frame = 0; frame < 60; frame += 1) {
      renderer.syncWorld(sim.world, 0.37);
    }

    expect(sim.snapshot()).toEqual(before);
    expect(sim.world.entityCount).toBe(entityCountBefore);
    expect(sim.world.listEntities()).toEqual(entitiesBefore);
  });
});

/* ================================================================== *
 * V4 · alpha boundaries, clamp and hostile inputs                     *
 * ================================================================== */
describe('QA-INDEP · V4 alpha boundaries and robustness', () => {
  /** Spawn a player at (0,0), step once (prev=0), then set curr.x = 4 directly. */
  function rig(): { sim: GameSimulator; renderer: GameRenderer; app: Application } {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const id = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    sim.step(1); // snapshot prev = (0,0)
    must(sim.world.getComponent(id, TransformComponent), 'TransformComponent').x = 4;
    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    return { sim, renderer, app };
  }

  it('0 => prev, 1 => curr, 0.5 => exact midpoint; >1 / <0 clamp (no extrapolation)', () => {
    const { sim, renderer, app } = rig();
    const view = (): Container => {
      renderer.syncWorld(sim.world, 0); // first sync also builds the view
      const v = entityViews(app)[0];
      if (v === undefined) throw new Error('QA: expected a player view');
      return v;
    };
    const v = view();

    renderer.syncWorld(sim.world, 0);
    expect(v.x).toBe(0); // prev (0 world units * 10 px)
    renderer.syncWorld(sim.world, 0.5);
    expect(v.x).toBe(20); // 4 * 0.5 * 10, EXACT
    renderer.syncWorld(sim.world, 1);
    expect(v.x).toBe(40); // curr

    renderer.syncWorld(sim.world, 2);
    expect(v.x).toBe(40); // clamped to 1, NOT 80
    renderer.syncWorld(sim.world, -1);
    expect(v.x).toBe(0); // clamped to 0, NOT -40
  });

  it('Infinity clamps, but NaN propagates into the container (measured, reported)', () => {
    const { sim, renderer, app } = rig();
    renderer.syncWorld(sim.world, 0);
    const v = entityViews(app)[0];
    if (v === undefined) throw new Error('QA: expected a player view');

    renderer.syncWorld(sim.world, Number.POSITIVE_INFINITY);
    expect(v.x).toBe(40); // Math.min(1, Infinity) === 1
    renderer.syncWorld(sim.world, Number.NEGATIVE_INFINITY);
    expect(v.x).toBe(0); // Math.max(0, -Infinity) === 0

    // CHARACTERISATION of the documented caller contract (spec 10 §5): NaN is NOT
    // defended and silently produces NaN coordinates. This is a CONCERNS item —
    // the test pins the CURRENT behaviour so a future fix is a deliberate change.
    renderer.syncWorld(sim.world, Number.NaN);
    expect(Number.isNaN(v.x)).toBe(true);
  });
});

/* ================================================================== *
 * V5 · damage floaters (AC-02)                                        *
 * ================================================================== */
describe('QA-INDEP · V5 damage floaters', () => {
  it('a 100 -> 90 drop spawns exactly one Text whose .text is "-10"', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const id = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 3, y: 0, hp: 100, maxHp: 100 }));
    sim.step(1);

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1); // build view, seed lastHp = 100
    expect(allTexts(rootOf(app))).toHaveLength(0);

    applyDamage(sim.world, id, 10);
    renderer.syncWorld(sim.world, 1);

    const texts = allTexts(rootOf(app));
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toBe('-10');
  });

  it('HP RISING (heal) spawns NO floater', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const id = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, hp: 50, maxHp: 100 }));
    sim.step(1);

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1); // seed lastHp = 50

    // Direct field write: a heal, not a hit.
    must(sim.world.getComponent(id, HealthComponent), 'HealthComponent').hp = 80;
    renderer.syncWorld(sim.world, 1);

    expect(allTexts(rootOf(app))).toHaveLength(0);
  });

  it('a low-HP entity spawning does NOT emit a first-frame phantom floater', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, hp: 30, maxHp: 100 }));
    sim.step(1);

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    // The FIRST sync creates the view; lastHp is seeded from the live HP (30), so
    // there is no drop to report.
    renderer.syncWorld(sim.world, 1);
    expect(allTexts(rootOf(app))).toHaveLength(0);

    // A second sync with unchanged HP must still report nothing.
    renderer.syncWorld(sim.world, 1);
    expect(allTexts(rootOf(app))).toHaveLength(0);
  });

  it('the floater is destroyed after 1000ms and fxLayer does not leak', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const id = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, hp: 100, maxHp: 100 }));
    sim.step(1);

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1); // build view, seed lastHp = 100

    applyDamage(sim.world, id, 10);
    renderer.syncWorld(sim.world, 1); // spawn floater (elapsed 0)
    expect(allTexts(rootOf(app))).toHaveLength(1);

    // 50 frames * 20ms = 1000ms >= FLOATING_TEXT_LIFETIME_MS -> destroyed.
    for (let frame = 0; frame < 50; frame += 1) renderer.syncWorld(sim.world, 1);
    expect(allTexts(rootOf(app))).toHaveLength(0);
    expect(fxLayerOf(app).children).toHaveLength(0);

    // No leak: 40 more frames keep the FX layer empty (nothing accumulates).
    for (let frame = 0; frame < 40; frame += 1) renderer.syncWorld(sim.world, 1);
    expect(fxLayerOf(app).children).toHaveLength(0);
  });

  it('two separate hits yield two independently-timed floaters', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const id = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, hp: 100, maxHp: 100 }));
    sim.step(1);

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1); // build view, seed lastHp = 100

    applyDamage(sim.world, id, 10); // 100 -> 90
    renderer.syncWorld(sim.world, 1); // floater #1 (elapsed 0)
    applyDamage(sim.world, id, 10); // 90 -> 80
    renderer.syncWorld(sim.world, 1); // floater #2 (elapsed 0); #1 aged by 20ms

    const texts = allTexts(rootOf(app));
    expect(texts).toHaveLength(2);
    expect(texts.map((t) => t.text)).toEqual(['-10', '-10']);
    // Independent clocks: the older floater has already faded by one frame
    // (20/1000 = 0.02), the newer one is still at full alpha.
    expect(texts[0]?.alpha).toBeCloseTo(0.98, 10);
    expect(texts[1]?.alpha).toBe(1);
  });
});

/* ================================================================== *
 * V6 · hit flash (AC-03) — including the UNCOVERED HITSTUN branch     *
 * ================================================================== */
describe('QA-INDEP · V6 hit flash (freeze + HITSTUN)', () => {
  it('freeze => 0xff0000, lapse => 0xffffff', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const id = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    sim.step(1);

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1);
    const view = entityViews(app)[0];
    if (view === undefined) throw new Error('QA: expected a player view');
    expect(view.tint).toBe(NO_TINT);

    applyFreeze(sim.world, id, 2); // arms remainingTicks = 3
    renderer.syncWorld(sim.world, 1);
    expect(view.tint).toBe(HIT_FLASH_TINT);

    sim.step(3); // 3 -> 2 -> 1 -> 0
    renderer.syncWorld(sim.world, 1);
    expect(view.tint).toBe(NO_TINT);
  });

  it('HITSTUN (direct state write) => 0xff0000, back to IDLE => 0xffffff', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const id = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    sim.step(1);

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1);
    const view = entityViews(app)[0];
    if (view === undefined) throw new Error('QA: expected a player view');
    const state = must(sim.world.getComponent(id, StateComponent), 'StateComponent');

    state.state = ActionState.HITSTUN;
    renderer.syncWorld(sim.world, 1);
    expect(view.tint).toBe(HIT_FLASH_TINT);

    state.state = ActionState.IDLE;
    renderer.syncWorld(sim.world, 1);
    expect(view.tint).toBe(NO_TINT);
  });

  it('a REAL collision writing HITSTUN tints the victim (previously uncovered branch)', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 }); // id 0, facing +x
    const enemyId = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0.75, y: 0, hp: 100, maxHp: 100 })); // id 1

    // Rising edge on the attack key -> CombatActionSystem spawns a hitbox at the
    // attacker's facing offset (0.75, 0), which overlaps the enemy's hurtbox.
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1);

    // Prove the REAL CollisionSystem — not a hand-written field — set HITSTUN.
    const enemyState = must(sim.world.getComponent(enemyId, StateComponent), 'StateComponent');
    expect(enemyState.state).toBe(ActionState.HITSTUN);

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1);

    // Entity views are created in ascending id order: [player(0), enemy(1), hitbox(2)].
    const views = entityViews(app);
    expect(views).toHaveLength(3);
    expect(views[1]?.tint).toBe(HIT_FLASH_TINT);
  });

  it('a hitbox view (no State, no Freeze) is never tinted, even beside a HITSTUN victim', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0.75, y: 0, hp: 100, maxHp: 100 }));
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1);

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1);

    const views = entityViews(app);
    // views[2] is the hitbox: player + enemy are both flashing here, so this
    // asserts the flash is keyed on component presence, not on "some nearby entity".
    expect(views[2]?.tint).toBe(NO_TINT);
  });
});

/* ================================================================== *
 * V7 · interpolation does not break existing contracts                *
 * ================================================================== */
describe('QA-INDEP · V7 backward compatibility & determinism', () => {
  it('single-arg syncWorld(world) is bit-identical to syncWorld(world, 1)', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const id = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    sim.step(1);
    must(sim.world.getComponent(id, TransformComponent), 'TransformComponent').x = 4;

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();

    renderer.syncWorld(sim.world); // M5-T01 call shape: alpha defaults to 1
    const v = entityViews(app)[0];
    if (v === undefined) throw new Error('QA: expected a player view');
    const legacyX = v.x;

    renderer.syncWorld(sim.world, 1);
    expect(legacyX).toBe(40);
    expect(v.x).toBe(legacyX);
  });

  it('facing interpolation takes the SHORT arc across the +/-PI seam', () => {
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    const id = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 3.0 });
    sim.step(1); // snapshot prevFacing = 3.0 (no input -> facing untouched)
    // Move the CURRENT facing to -3.0: a naive blend would sweep ~6 rad through PI.
    must(sim.world.getComponent(id, TransformComponent), 'TransformComponent').facingRadians = -3.0;

    const app = makeApp(20);
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1);

    const v = entityViews(app)[0];
    if (v === undefined) throw new Error('QA: expected a player view');
    // Short arc: 3.0 -> -3.0 is 0.283 rad across the seam, so rotation stays near 3.0.
    expect(Math.abs(v.rotation - 3.0)).toBeLessThan(0.4);
    // The long way (naive) would land near -3.0 (|rotation - 3.0| ~= 6).
    expect(Math.abs(v.rotation - -3.0)).toBeGreaterThan(5);
  });

  it('determinism: two identical scripts yield bit-identical snapshots incl. PreviousTransform', () => {
    const script = (): Snapshot[] => {
      const sim = new GameSimulator({ systems: createDefaultSystems() });
      PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
      EnemyFactory.spawn(sim.world, ...testEnemy({ x: 3, y: 0 }));
      sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
      sim.inject({ kind: 'move', tick: 5, vector: vec2(1, 0) });
      const out: Snapshot[] = [];
      for (let i = 0; i < 20; i += 1) {
        sim.step(1);
        out.push(sim.snapshot());
      }
      return out;
    };

    const a = script();
    const b = script();
    expect(a).toEqual(b);
    for (let i = 0; i < a.length; i += 1) expect(a[i]).toEqual(b[i]);

    // The new render-support component really is in the snapshot (and therefore in
    // the determinism comparison), not silently absent.
    const first = a[0];
    if (first === undefined) throw new Error('QA: empty script output');
    const types = first.entities.flatMap((e) => e.components.map((c) => c.type));
    expect(types).toContain('PreviousTransformComponent');
  });
});
