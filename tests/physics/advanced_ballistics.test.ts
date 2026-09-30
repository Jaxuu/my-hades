/**
 * M11-T01 · Advanced ballistics & composite hazards acceptance tests.
 * See specs/18_advanced_ballistics_and_hazards_spec.md §4 (semantics),
 * §6 (tick-by-tick contract) and §7 (AC-01 .. AC-04).
 *
 * Fresh-eyes harness suite (QA-owned): every assertion drives the REAL
 * `GameSimulator` with the canonical 17-segment pipeline
 * (TransformSnapshotSystem -> PlayerControllerSystem -> FreezeSystem -> AISystem
 * -> HazardSystem -> MovementSystem -> DashSystem -> StateSystem ->
 * CombatActionSystem -> CollisionSystem -> StatusEffectSystem -> ModifierSystem
 * -> DeathSystem -> EncounterSystem -> RewardSystem -> PickupSystem ->
 * LifespanSystem) and REAL prefab-assembled entities. Nothing is mocked, and ticks
 * are advanced one at a time so the timing contract is pinned per tick.
 *
 * TICK NUMBERING (`sim.step(n)` processes ticks `0 .. n-1`, leaving `sim.tick === n`):
 * a fresh sim needs `step(1)` to have processed tick 0, and `step(5)` to have
 * processed ticks 0..4. Everything below is indexed by the PROCESSED tick, and every
 * checkpoint is anchored on the observable `sim.tick` (never on a prose label).
 *
 * WHERE THE THREE MECHANICS LIVE (this is what the expected tick numbers come from):
 *
 *  - BOUNCE (AC-01) is a branch of `MovementSystem.resolveWalls` (pipeline index 5),
 *    i.e. AFTER this tick's displacement and BEFORE `CollisionSystem` (index 9). A
 *    `destroyOnWall` projectile that ALSO has `bounceCount > 0` is mirrored about the
 *    normalized accumulated wall push instead of being destroyed; a projectile whose
 *    allowance is exhausted falls through to the historic destroy-on-contact path.
 *  - PIERCE (AC-02) is a branch of `CollisionSystem` (index 9). A landed hit with
 *    `pierceCount > 0` spends one pierce, decays `damage` by `(1 - damageFalloff)`
 *    for the FOLLOW-UP targets, and continues the target loop; the target loop is
 *    id-ascending, so "the first target" is the lowest id.
 *  - COMPOSITE EXPLOSION (AC-03) is a tail of `HazardSystem.detonate` (index 4). A
 *    hazard with a non-null `onExplodeConfigId` spawns one more hazard in place, and
 *    `advanceHazards` appends it to THIS tick's drain queue, so its fuse starts on
 *    the tick it was born.
 *
 * HAZARD FUSE ARITHMETIC (judge-then-decrement, spec 18 §4.3 / I6): a hazard with
 * `delayTicks = N` is decremented by phase B on every tick it is alive, reaches `0`
 * at the END of the tick, and DETONATES on the NEXT tick. Concretely, a main hazard
 * spawned before tick 0 with `delayTicks = 30` reads `delayTicks === 1` at
 * `sim.tick 29`, `=== 0` (still armed) at `sim.tick 30`, and detonates on the tick
 * whose processing leaves `sim.tick === 31` — i.e. it detonates on PROCESSED tick 30.
 * The child (`delayTicks = 10`, born during processed tick 30) reads `1` at
 * `sim.tick 39`, `0` at `sim.tick 40`, and detonates on processed tick 40
 * (`sim.tick === 41`). This is the exact same arithmetic the engineering-side G6
 * suite pins; the checkpoints below are written against the OBSERVED `sim.tick`.
 *
 * Grouping:
 *   G1 · wall bounce — reflect, survive, fly away, no deadlock, no penetration   (AC-01)
 *   G2 · piercing + damage falloff — literal damage, single settlement, controls (AC-02)
 *   G3 · composite / chained explosion — radius proof, exact fuse, chain end     (AC-03)
 *   G4 · determinism + the 17-segment pipeline contract                          (cross)
 */

import { describe, expect, it } from 'vitest';
import {
  DataManager,
  Faction,
  FactionComponent,
  GameSimulator,
  HazardComponent,
  HealthComponent,
  HitboxComponent,
  HurtboxComponent,
  PlayerFactory,
  ProjectileComponent,
  TransformComponent,
  VelocityComponent,
  createDefaultSystems,
  createWall,
  spawnHazard,
  spawnProjectile,
  spawnProjectileFromConfig,
} from '../../src';
import type { EntityId } from '../../src';

const FPS = 60;
const MAX_SPEED = 5;
/** Per-tick integration accumulates float rounding; measured drift is ~1e-15. */
const TOLERANCE = 1e-9;

/**
 * `Math.cos(Math.PI / 4)` written as a LITERAL. Restating it (rather than calling
 * `Math.cos`) keeps the assertion independent of the exact expression the engine
 * used, and makes the expected reflected direction readable at a glance.
 */
const COS45 = 0.7071067811865476;

/** The reference bounce wall: a 10 x 2 slab whose TOP face (the one the projectile
 *  approaches from below) sits at y = 2. */
const BOUNCE_WALL = { x: -5, y: 2, width: 10, height: 2 } as const;
/** Cast-projectile hitbox radius (`DEFAULT_CAST_HITBOX_RADIUS`), as a LITERAL. */
const PROJECTILE_RADIUS = 0.4;
/** Where a radius-0.4 body comes to rest against the wall's top face. */
const REST_Y = 2 - PROJECTILE_RADIUS; // 1.6

/**
 * The processed tick on which the π/4 projectile first overlaps {@link BOUNCE_WALL}.
 * Derived, not copied: it spawns at y = 0.5·sin(π/4) = 0.3535533905932738, advances
 * Δy = (20/60)·sin(π/4) = 0.23570226039551586 per tick, and overlaps once
 * y > REST_Y (0.3535533905932738 + (n+1)·0.23570226039551586 > 1.6  ⇒  n = 5).
 */
const BOUNCE_TICK = 5;
/** The processed tick on which the +x dart first reaches the first dummy (id order). */
const PIERCE_HIT_A_TICK = 4;
/** The processed tick on which the same dart reaches the second dummy and retires. */
const PIERCE_HIT_B_TICK = 13;

/** Positional accessor with a loud guard (the repo runs `noUncheckedIndexedAccess`). */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`QA: no sample at index ${String(index)}`);
  }
  return value;
}

/* --- component accessors -------------------------------------------------- */

function transformOf(sim: GameSimulator, id: EntityId): TransformComponent {
  const transform = sim.world.getComponent(id, TransformComponent);
  if (transform === undefined) throw new Error('QA: entity is missing TransformComponent');
  return transform;
}

function velocityOf(sim: GameSimulator, id: EntityId): VelocityComponent {
  const velocity = sim.world.getComponent(id, VelocityComponent);
  if (velocity === undefined) throw new Error('QA: entity is missing VelocityComponent');
  return velocity;
}

function projectileOf(sim: GameSimulator, id: EntityId): ProjectileComponent {
  const projectile = sim.world.getComponent(id, ProjectileComponent);
  if (projectile === undefined) throw new Error('QA: entity is missing ProjectileComponent');
  return projectile;
}

function hitboxOf(sim: GameSimulator, id: EntityId): HitboxComponent {
  const hitbox = sim.world.getComponent(id, HitboxComponent);
  if (hitbox === undefined) throw new Error('QA: entity is missing HitboxComponent');
  return hitbox;
}

function hazardOf(sim: GameSimulator, id: EntityId): HazardComponent {
  const hazard = sim.world.getComponent(id, HazardComponent);
  if (hazard === undefined) throw new Error('QA: entity is missing HazardComponent');
  return hazard;
}

function hpOf(sim: GameSimulator, id: EntityId): number {
  const health = sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: entity is missing HealthComponent');
  return health.hp;
}

/**
 * A STATIC dummy: Transform + Hurtbox + Faction + Health, and NOTHING else.
 *
 * Deliberately no `Intent`, no `Velocity`, no `State`. `CollisionSystem` writes a
 * `KnockbackComponent` on a landed hit, but `MovementSystem` only applies forced
 * displacement to a body that is BOTH in `HITSTUN` (needs a `StateComponent`) AND
 * visited by its move query (needs `Intent` + `Velocity`); `resolveWalls` visits
 * `(Transform, Velocity)`. The dummy owns none of those, so it never moves — every
 * blast / dart is measured against the SAME standing position, and it is the DAMAGE
 * and TIMING the assertions pin, not a drifting target.
 */
function staticDummy(
  sim: GameSimulator,
  x: number,
  y: number,
  faction: Faction,
  hp = 100,
): EntityId {
  const entity = sim.world.createEntity();
  sim.world.addComponent(entity.id, new TransformComponent(x, y, 0));
  sim.world.addComponent(entity.id, new HurtboxComponent(0.5));
  sim.world.addComponent(entity.id, new FactionComponent(faction));
  sim.world.addComponent(entity.id, new HealthComponent(hp, hp));
  return entity.id;
}

/** A player rig: a bare sim with the canonical pipeline and a real caster at the origin. */
function makeCasterRig(): { readonly sim: GameSimulator; readonly caster: EntityId } {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
  const caster = PlayerFactory.spawn(sim.world, {
    x: 0,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
  });
  return { sim, caster };
}

/* ========================================================================== *
 * G1 · wall bounce                                                            *
 * ========================================================================== */
describe('G1 · a bouncing projectile is reflected, not retired (AC-01)', () => {
  it('flips its direction on the contact tick, survives, and flies away', () => {
    const { sim, caster } = makeCasterRig();
    createWall(sim.world, BOUNCE_WALL);
    const dart = spawnProjectile(sim.world, {
      x: 0,
      y: 0,
      directionRadians: Math.PI / 4,
      faction: Faction.Player,
      ownerEntityId: caster,
      bounceCount: 1,
    });

    // Ticks 0 .. BOUNCE_TICK-1 — the approach. Every pre-bounce tick must show the
    // UNCHANGED direction, an unspent allowance, a live entity, and — the
    // anti-tunnelling assertion — a centre still short of the resting line, so the
    // circle never overlaps the wall before the tick it is resolved.
    for (let tick = 0; tick < BOUNCE_TICK; tick += 1) {
      sim.step(1); // processes tick `tick`
      const direction = velocityOf(sim, dart).directionVector;
      expect(direction.x).toBeCloseTo(COS45, 9);
      expect(direction.y).toBeCloseTo(COS45, 9);
      expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1, 9); // length preserved
      expect(projectileOf(sim, dart).bounceCount).toBe(1);
      expect(sim.world.isAlive(dart)).toBe(true);
      // The gap to the resting line is still positive by more than float noise:
      // the circle never overlaps the wall before the tick it is resolved.
      expect(REST_Y - transformOf(sim, dart).y).toBeGreaterThan(TOLERANCE);
    }
    expect(sim.tick).toBe(BOUNCE_TICK);

    // The contact tick — the reflection.
    sim.step(1); // processes tick BOUNCE_TICK
    const reflected = velocityOf(sim, dart).directionVector;
    expect(reflected.x).toBeCloseTo(0.7071067811865476, 9);
    expect(reflected.y).toBeCloseTo(-0.7071067811865476, 9);
    expect(Math.hypot(reflected.x, reflected.y)).toBeCloseTo(1, 9); // |V'| === |V|
    expect(projectileOf(sim, dart).bounceCount).toBe(0); // the allowance was spent
    expect(sim.world.isAlive(dart)).toBe(true); // NOT destroyed by the wall
    expect(transformOf(sim, dart).y).toBeCloseTo(REST_Y, 9); // pushed out to the face
    const yAtBounce = transformOf(sim, dart).y;

    // After the bounce: it keeps flying, now along -y, and is never retired by the
    // geometry it just left.
    let previousY = yAtBounce;
    for (let tick = 0; tick < 10; tick += 1) {
      sim.step(1);
      const y = transformOf(sim, dart).y;
      expect(y).toBeLessThan(previousY);
      previousY = y;
      expect(sim.world.isAlive(dart)).toBe(true);
    }
    expect(sim.tick).toBe(BOUNCE_TICK + 11);

    // It dies of its OWN lifespan, not of a wall: nothing is left between here and
    // the natural expiry (default 60 ticks), and it is gone exactly at the boundary.
    sim.step(60 - (BOUNCE_TICK + 11)); // reach processed tick 59
    expect(sim.tick).toBe(60);
    expect(sim.world.isAlive(dart)).toBe(false);
  });

  it('CONTROL · a projectile with no bounce allowance is still retired on contact', () => {
    // Regression guard for the bounce branch: it must not swallow the historic
    // destroy-on-contact path used by every pre-M11 projectile.
    const { sim, caster } = makeCasterRig();
    createWall(sim.world, BOUNCE_WALL);
    const dart = spawnProjectile(sim.world, {
      x: 0,
      y: 0,
      directionRadians: Math.PI / 4,
      faction: Faction.Player,
      ownerEntityId: caster,
      // bounceCount omitted => the default 0, i.e. the historic behaviour.
    });
    expect(projectileOf(sim, dart).bounceCount).toBe(0);

    sim.step(BOUNCE_TICK); // ticks 0..4 — still clear of the wall
    expect(sim.world.isAlive(dart)).toBe(true);

    sim.step(1); // tick 5 — reaches the wall
    expect(sim.world.isAlive(dart)).toBe(false);
  });

  it('does not deadlock or ping-pong inside a two-wall corner (one reflection per tick)', () => {
    // A projectile pressed into a CONCAVE corner: two perpendicular walls push it on
    // the same tick, so the accumulated push is diagonal. Exactly one reflection must
    // happen, the tick must keep advancing, and the entity count must not balloon.
    const { sim, caster } = makeCasterRig();
    createWall(sim.world, { x: 2, y: -6, width: 2, height: 12 }); // left face at x = 2
    createWall(sim.world, { x: -6, y: 2, width: 12, height: 2 }); // bottom face at y = 2
    const dart = spawnProjectile(sim.world, {
      x: 0,
      y: 0,
      directionRadians: Math.PI / 4,
      faction: Faction.Player,
      ownerEntityId: caster,
      bounceCount: 1,
    });
    const entitiesBefore = sim.world.entityCount;

    sim.step(BOUNCE_TICK + 1); // ticks 0..5 — the corner contact happens on tick 5
    expect(sim.tick).toBe(BOUNCE_TICK + 1); // the sim advanced normally: no spin

    // One reflection, mirrored about the diagonal accumulated normal (-1,-1)/√2.
    const direction = velocityOf(sim, dart).directionVector;
    expect(direction.x).toBeCloseTo(-0.7071067811865476, 9);
    expect(direction.y).toBeCloseTo(-0.7071067811865476, 9);
    expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1, 9);
    expect(projectileOf(sim, dart).bounceCount).toBe(0); // spent exactly once
    expect(sim.world.isAlive(dart)).toBe(true);
    expect(sim.world.entityCount).toBe(entitiesBefore); // no entity explosion

    // Keep stepping: the pass is a single finite traversal, so nothing wedges.
    sim.step(10);
    expect(sim.tick).toBe(BOUNCE_TICK + 11);
    expect(sim.world.entityCount).toBe(entitiesBefore);
    expect(sim.world.isAlive(dart)).toBe(true);
  });
});

/* ========================================================================== *
 * G2 · piercing + damage falloff                                              *
 * ========================================================================== */
describe('G2 · a piercing dart passes through and decays (AC-02)', () => {
  it('deals full damage to the first dummy, half to the second, none to the third', () => {
    const { sim, caster } = makeCasterRig();
    const first = staticDummy(sim, 3, 0, Faction.Enemy);
    const second = staticDummy(sim, 6, 0, Faction.Enemy);
    const third = staticDummy(sim, 9, 0, Faction.Enemy);
    const dart = spawnProjectile(sim.world, {
      x: 0,
      y: 0,
      directionRadians: 0,
      faction: Faction.Player,
      ownerEntityId: caster,
      pierceCount: 1,
      damage: 10,
      damageFalloff: 0.5,
    });
    // Retained reference: the entity is destroyed on its SECOND hit, but the
    // component object is mutated in place BEFORE that, so holding it is the only
    // way to observe the final `hitEntities` ledger.
    const ledger = hitboxOf(sim, dart);
    const firstStart = transformOf(sim, first);
    const secondStart = transformOf(sim, second);
    const thirdStart = transformOf(sim, third);

    // Ticks 0..3 — still short of the first dummy.
    sim.step(PIERCE_HIT_A_TICK); // 4 steps
    expect(sim.tick).toBe(PIERCE_HIT_A_TICK);
    expect(hpOf(sim, first)).toBe(100);
    expect(hpOf(sim, second)).toBe(100);
    expect(hpOf(sim, third)).toBe(100);
    expect(sim.world.isAlive(dart)).toBe(true);
    expect(ledger.pierceCount).toBe(1);
    expect(ledger.damage).toBe(10);

    // Tick 4 — the first dummy is struck for the FULL 10, and the dart survives.
    sim.step(1);
    expect(hpOf(sim, first)).toBe(100 - 10); // 90
    expect(hpOf(sim, second)).toBe(100);
    expect(hpOf(sim, third)).toBe(100);
    expect(sim.world.isAlive(dart)).toBe(true); // it pierced — not retired
    expect(ledger.pierceCount).toBe(0); // one allowance spent
    expect(ledger.damage).toBe(5); // 10 * (1 - 0.5), for the FOLLOW-UP target
    expect(ledger.hitEntities).toEqual([first]);

    // Ticks 5..6 — the circle still overlaps the first dummy for two more ticks, and
    // the `hitEntities` guard must refuse to settle it a second time.
    sim.step(2);
    expect(hpOf(sim, first)).toBe(90); // exactly one settlement
    expect(ledger.hitEntities).toEqual([first]);

    // Ticks 7..12 — flying on, still clear of the second dummy.
    sim.step(PIERCE_HIT_B_TICK - 1 - 6); // 6 steps => processed tick 12
    expect(sim.tick).toBe(PIERCE_HIT_B_TICK);
    expect(sim.world.isAlive(dart)).toBe(true);
    expect(hpOf(sim, second)).toBe(100);

    // Tick 13 — the second dummy is struck for the DECAYED 5, then the dart retires.
    sim.step(1);
    expect(hpOf(sim, first)).toBe(90);
    expect(hpOf(sim, second)).toBe(100 - 5); // 95
    expect(hpOf(sim, third)).toBe(100); // the third is untouched
    expect(sim.world.isAlive(dart)).toBe(false); // allowance exhausted => retire
    // The ledger, captured before destruction, holds BOTH victims.
    expect(ledger.hitEntities).toEqual([first, second]);

    // Every dummy is a STATIC body: the knockback wrote no displacement.
    expect(transformOf(sim, first).x).toBeCloseTo(firstStart.x, 9);
    expect(transformOf(sim, first).y).toBeCloseTo(firstStart.y, 9);
    expect(transformOf(sim, second).x).toBeCloseTo(secondStart.x, 9);
    expect(transformOf(sim, second).y).toBeCloseTo(secondStart.y, 9);
    expect(transformOf(sim, third).x).toBeCloseTo(thirdStart.x, 9);
    expect(transformOf(sim, third).y).toBeCloseTo(thirdStart.y, 9);
  });

  it('CONTROL A · pierceCount 0 retires on the first hit, leaving the second whole', () => {
    const { sim, caster } = makeCasterRig();
    const first = staticDummy(sim, 3, 0, Faction.Enemy);
    const second = staticDummy(sim, 6, 0, Faction.Enemy);
    const dart = spawnProjectile(sim.world, {
      x: 0,
      y: 0,
      directionRadians: 0,
      faction: Faction.Player,
      ownerEntityId: caster,
      damage: 10, // pierceCount omitted => the default 0
    });
    expect(hitboxOf(sim, dart).pierceCount).toBe(0);

    sim.step(PIERCE_HIT_A_TICK + 1); // ticks 0..4
    expect(hpOf(sim, first)).toBe(100 - 10); // 90
    expect(sim.world.isAlive(dart)).toBe(false); // retired on the first victim

    sim.step(20);
    expect(hpOf(sim, second)).toBe(100); // never reached
  });

  it('CONTROL B · pierceCount 1 with NO falloff deals full damage to both', () => {
    // Proves the decay is driven by `damageFalloff`, not by piercing itself.
    const { sim, caster } = makeCasterRig();
    const first = staticDummy(sim, 3, 0, Faction.Enemy);
    const second = staticDummy(sim, 6, 0, Faction.Enemy);
    const dart = spawnProjectile(sim.world, {
      x: 0,
      y: 0,
      directionRadians: 0,
      faction: Faction.Player,
      ownerEntityId: caster,
      pierceCount: 1,
      damage: 10,
      damageFalloff: 0, // no decay
    });

    sim.step(PIERCE_HIT_A_TICK + 1); // ticks 0..4
    expect(hpOf(sim, first)).toBe(100 - 10); // 90
    expect(sim.world.isAlive(dart)).toBe(true);
    expect(hitboxOf(sim, dart).damage).toBe(10); // undecayed

    sim.step(PIERCE_HIT_B_TICK - PIERCE_HIT_A_TICK); // ticks 5..13
    expect(hpOf(sim, second)).toBe(100 - 10); // 90 — full damage again
    expect(sim.world.isAlive(dart)).toBe(false);
  });

  it('wires the shipped `piercing_dart` template end to end (config -> assembly -> behaviour)', () => {
    // The template as shipped. Read back as LITERALS so a silent retune is caught.
    const config = DataManager.getProjectileConfig('piercing_dart');
    expect(config.pierceCount).toBe(1);
    expect(config.damageFalloff).toBe(0.5);
    // NOTE (QA finding): the shipped template omits `damage`, so the assembly seam
    // applies `DEFAULT_CAST_DAMAGE`, which is 8 — NOT 10. See the report.
    expect(config.damage).toBeUndefined();

    const { sim, caster } = makeCasterRig();
    const first = staticDummy(sim, 3, 0, Faction.Enemy);
    const second = staticDummy(sim, 6, 0, Faction.Enemy);
    const third = staticDummy(sim, 9, 0, Faction.Enemy);
    const dart = spawnProjectileFromConfig(sim.world, 'piercing_dart', {
      x: 0,
      y: 0,
      directionRadians: 0,
      faction: Faction.Player,
      ownerEntityId: caster,
    });

    // The assembled component carries the template's pierce/falloff and the seam's
    // damage default, all as LITERALS.
    const hitbox = hitboxOf(sim, dart);
    expect(hitbox.damage).toBe(8);
    expect(hitbox.pierceCount).toBe(1);
    expect(hitbox.damageFalloff).toBe(0.5);

    // ... and it really punches through: 8 on the first, 4 on the second, 0 on the third.
    sim.step(PIERCE_HIT_A_TICK + 1); // ticks 0..4
    expect(hpOf(sim, first)).toBe(100 - 8); // 92
    expect(sim.world.isAlive(dart)).toBe(true);

    sim.step(PIERCE_HIT_B_TICK - PIERCE_HIT_A_TICK); // ticks 5..13
    expect(hpOf(sim, second)).toBe(100 - 4); // 96 == 8 * (1 - 0.5)
    expect(hpOf(sim, third)).toBe(100);
    expect(sim.world.isAlive(dart)).toBe(false);
  });
});

/* ========================================================================== *
 * G3 · composite / chained explosion                                          *
 * ========================================================================== */
describe('G3 · a composite chain detonates on T+N and terminates (AC-03)', () => {
  it('blows the main at radius 1, then the child at radius 2.5 / damage 8, then stops', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    // Radii chosen to prove the TWO different blast radii, not to decorate the rig:
    //   inner  0.5 from the centre -> inside BOTH the main (1+0.5=1.5) and the child (2.5+0.5=3)
    //   outer  2.0 from the centre -> outside the main (1.5 < 2.0), inside the child (3.0)
    //   beyond 4.0 from the centre -> outside BOTH (3.0 < 4.0)
    const inner = staticDummy(sim, 0.5, 0, Faction.Player);
    const outer = staticDummy(sim, 2.0, 0, Faction.Player);
    const beyond = staticDummy(sim, 4.0, 0, Faction.Player);
    const innerStart = transformOf(sim, inner);
    const outerStart = transformOf(sim, outer);
    const beyondStart = transformOf(sim, beyond);

    const main = spawnHazard(sim.world, {
      x: 0,
      y: 0,
      radius: 1, // the MAIN's own radius — deliberately NOT the child template's 2.5
      damage: 25,
      delayTicks: 30,
      faction: Faction.Enemy,
      ownerEntityId: -1,
      onExplodeConfigId: 'poison_cloud', // shipped child template: 2.5 / 8 / 10
    });

    // Ticks 0..28 — the fuse burns; nobody is touched.
    sim.step(29);
    expect(sim.tick).toBe(29);
    expect(hazardOf(sim, main).delayTicks).toBe(1);
    expect(sim.world.isAlive(main)).toBe(true);
    expect(hpOf(sim, inner)).toBe(100);
    expect(hpOf(sim, outer)).toBe(100);
    expect(hpOf(sim, beyond)).toBe(100);

    // Tick 29 — fused to zero, still armed, still harmless (judge-then-decrement).
    sim.step(1);
    expect(sim.tick).toBe(30);
    expect(hazardOf(sim, main).delayTicks).toBe(0);
    expect(sim.world.isAlive(main)).toBe(true);
    expect(hpOf(sim, inner)).toBe(100);

    // Tick 30 — the MAIN detonates, at ITS radius (1), not the child's.
    sim.step(1);
    expect(sim.tick).toBe(31);
    expect(hpOf(sim, inner)).toBe(100 - 25); // 75 — inside 1 + 0.5
    expect(hpOf(sim, outer)).toBe(100); // outside 1 + 0.5 => PROVES the main radius is 1
    expect(hpOf(sim, beyond)).toBe(100);
    expect(sim.world.isAlive(main)).toBe(false);

    // The child exists in place, carries the TEMPLATE's fuse, and has NO further chain.
    const afterMain = sim.world.query(HazardComponent);
    expect(afterMain).toHaveLength(1);
    const child = at(afterMain, 0);
    expect(child).not.toBe(main);
    expect(hazardOf(sim, child).totalDelayTicks).toBe(10);
    expect(hazardOf(sim, child).onExplodeConfigId).toBeNull();
    // Its fuse started on the tick it was born (appended to the same drain queue).
    expect(hazardOf(sim, child).delayTicks).toBe(9);

    // Ticks 31..38 — the child burns down and has NOT blown by tick 38.
    sim.step(8);
    expect(sim.tick).toBe(39);
    expect(hazardOf(sim, child).delayTicks).toBe(1);
    expect(sim.world.isAlive(child)).toBe(true);
    expect(hpOf(sim, inner)).toBe(100 - 25); // still only the main's 25
    expect(hpOf(sim, outer)).toBe(100);

    // Tick 39 — fused to zero, still armed, still harmless.
    sim.step(1);
    expect(sim.tick).toBe(40);
    expect(hazardOf(sim, child).delayTicks).toBe(0);
    expect(sim.world.isAlive(child)).toBe(true);
    expect(hpOf(sim, inner)).toBe(100 - 25);
    expect(hpOf(sim, outer)).toBe(100);

    // Tick 40 — the CHILD detonates, at ITS radius (2.5) and damage (8).
    sim.step(1);
    expect(sim.tick).toBe(41);
    expect(hpOf(sim, inner)).toBe(100 - 25 - 8); // 67 — inside 2.5 + 0.5
    expect(hpOf(sim, outer)).toBe(100 - 8); // 92 — PROVES the child radius is 2.5
    expect(hpOf(sim, beyond)).toBe(100); // outside 2.5 + 0.5
    expect(sim.world.isAlive(child)).toBe(false);
    expect(sim.world.query(HazardComponent)).toEqual([]);

    // Tick 41 and beyond — the chain TERMINATED: nothing re-detonates every tick.
    sim.step(10);
    expect(sim.tick).toBe(51);
    expect(hpOf(sim, inner)).toBe(67);
    expect(hpOf(sim, outer)).toBe(92);
    expect(hpOf(sim, beyond)).toBe(100);

    // The three dummies never moved (no Intent/Velocity => the blast's knockback
    // wrote no displacement). This is the premise the whole rig rests on.
    expect(transformOf(sim, inner).x).toBeCloseTo(innerStart.x, 9);
    expect(transformOf(sim, inner).y).toBeCloseTo(innerStart.y, 9);
    expect(transformOf(sim, outer).x).toBeCloseTo(outerStart.x, 9);
    expect(transformOf(sim, outer).y).toBeCloseTo(outerStart.y, 9);
    expect(transformOf(sim, beyond).x).toBeCloseTo(beyondStart.x, 9);
    expect(transformOf(sim, beyond).y).toBeCloseTo(beyondStart.y, 9);
  });
});

/* ========================================================================== *
 * G4 · determinism + pipeline contract                                        *
 * ========================================================================== */
describe('G4 · determinism and the 17-segment pipeline (cross-group)', () => {
  it('produces byte-identical snapshots for a script with bounce + pierce + chain', () => {
    const run = (): unknown => {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
      const caster = PlayerFactory.spawn(sim.world, {
        x: 0,
        y: 0,
        facingRadians: 0,
        maxSpeed: MAX_SPEED,
      });

      // G1 — a bouncing bolt into the reference wall.
      createWall(sim.world, BOUNCE_WALL);
      spawnProjectile(sim.world, {
        x: 0,
        y: 0,
        directionRadians: Math.PI / 4,
        faction: Faction.Player,
        ownerEntityId: caster,
        bounceCount: 1,
      });

      // G2 — a piercing dart down a row of static dummies (kept clear of the wall).
      staticDummy(sim, 3, -20, Faction.Enemy);
      staticDummy(sim, 6, -20, Faction.Enemy);
      spawnProjectile(sim.world, {
        x: 0,
        y: -20,
        directionRadians: 0,
        faction: Faction.Player,
        ownerEntityId: caster,
        pierceCount: 1,
        damage: 10,
        damageFalloff: 0.5,
      });

      // G3 — a composite chain, far from everything else.
      staticDummy(sim, 0.5, 20, Faction.Player);
      spawnHazard(sim.world, {
        x: 0,
        y: 20,
        radius: 1,
        damage: 25,
        delayTicks: 30,
        faction: Faction.Enemy,
        ownerEntityId: -1,
        onExplodeConfigId: 'poison_cloud',
      });

      sim.step(60);
      return sim.snapshot();
    };

    expect(run()).toEqual(run());
  });

  it('keeps the canonical 17-segment order — M11-T01 adds NO segment of its own', () => {
    const names = createDefaultSystems().map((system) => system.name);
    expect(names).toEqual([
      'TransformSnapshotSystem',
      'PlayerControllerSystem',
      'FreezeSystem',
      'AISystem',
      'HazardSystem',
      'MovementSystem',
      'DashSystem',
      'StateSystem',
      'CombatActionSystem',
      'CollisionSystem',
      'StatusEffectSystem',
      'ModifierSystem',
      'DeathSystem',
      'EncounterSystem',
      'RewardSystem',
      'PickupSystem',
      'LifespanSystem',
    ]);
    expect(names).toHaveLength(17);
    expect(names.indexOf('LifespanSystem')).toBe(names.length - 1);

    // The three slots this milestone RELIES ON (it reorders nothing):
    //  - HazardSystem plants / detonates BEFORE this tick's displacement and collision;
    //  - MovementSystem resolves the bounce AFTER displacement, BEFORE collision, so a
    //    wall-reflected projectile is never also collision-tested as wall-stopped;
    //  - CollisionSystem settles the pierce AFTER that.
    expect(names.indexOf('HazardSystem')).toBeLessThan(names.indexOf('MovementSystem'));
    expect(names.indexOf('MovementSystem')).toBeLessThan(names.indexOf('CollisionSystem'));
  });
});
