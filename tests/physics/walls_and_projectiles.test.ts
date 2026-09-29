/**
 * M7-T01 · Arena walls + projectiles acceptance tests.
 * See specs/13_arena_and_projectiles_spec.md §4 (semantics), §6 (tick-by-tick
 * contract) and §7 (AC-01 .. AC-04 / AC-06).
 *
 * Fresh-eyes harness suite: every assertion drives the REAL `GameSimulator` with the
 * canonical 17-segment pipeline (TransformSnapshotSystem -> PlayerControllerSystem
 * -> FreezeSystem -> AISystem -> HazardSystem -> MovementSystem -> DashSystem ->
 * StateSystem -> CombatActionSystem -> CollisionSystem -> StatusEffectSystem ->
 * ModifierSystem -> DeathSystem -> EncounterSystem -> RewardSystem -> PickupSystem
 * -> LifespanSystem) and REAL
 * prefab-assembled entities. Nothing is mocked, and ticks are advanced one at a time
 * so the timing contract is pinned per tick.
 *
 * TICK NUMBERING (`sim.step(n)` processes ticks `0 .. n-1`, leaving `sim.tick === n`):
 * a fresh sim needs `step(1)` to have processed tick 0, and `step(5)` to have
 * processed ticks 0..4. Everything below is indexed by the PROCESSED tick.
 *
 * PHASES THAT MATTER HERE (they are what the expected tick numbers come from):
 *
 *  - WALL RESOLUTION runs inside `MovementSystem` (pipeline index 4), i.e. AFTER this
 *    tick's displacement and BEFORE `CollisionSystem` (index 8). That is why a
 *    wall-stopped projectile can never also hit something behind the wall this tick.
 *  - A projectile spawned by `CombatActionSystem` (index 7) IS collision-tested on
 *    its spawn tick (index 8 runs later), but has NOT moved yet — it moves for the
 *    first time on the next tick.
 *  - `LifespanSystem` (index 14) ages every hitbox at the end of every tick, so a
 *    freshly spawned projectile reads `activeTicks === lifespan - 1`.
 *
 * Grouping:
 *   G0 · wall / body-radius primitives                                          (AC-01)
 *   G1 · a body walking into a wall is stopped at the face, never through it     (AC-01)
 *   G2 · Poseidon Wall-Slam: knockback into a wall settles damage exactly once   (AC-02)
 *   G3 · the wall-slam predicate: what is NOT a wall-slam                        (AC-02)
 *   G4 · cast assembly: the projectile component set and tuning                  (AC-03)
 *   G5 · flight, a single-target hit, and the absence of piercing                (AC-03/04)
 *   G6 · retirement on walls — and the proof that it does not tunnel             (AC-04)
 *   G7 · pipeline unchanged + pulse gating + determinism                         (AC-06)
 */

import { describe, expect, it } from 'vitest';
import {
  ATTACK_KEY,
  ActionState,
  ArmorComponent,
  CAST_KEY,
  DASH_KEY,
  DEFAULT_CAST_DAMAGE,
  DEFAULT_CAST_HITBOX_RADIUS,
  DEFAULT_CAST_HITSTOP_TICKS,
  DEFAULT_CAST_KNOCKBACK,
  DEFAULT_CAST_LIFESPAN_TICKS,
  DEFAULT_CAST_PROJECTILE_SPEED,
  DEFAULT_CAST_SPAWN_OFFSET,
  DEFAULT_ELITE_HURTBOX_RADIUS,
  DEFAULT_ELITE_MAX_HP,
  DEFAULT_HURTBOX_RADIUS,
  DEFAULT_MAX_HP,
  DEFAULT_POSEIDON_DASH_DAMAGE,
  DEFAULT_POSEIDON_DASH_KNOCKBACK,
  DEFAULT_WALL_SLAM_DAMAGE,
  EnemyFactory,
  Faction,
  FactionComponent,
  GameSimulator,
  HealthComponent,
  HitboxComponent,
  HurtboxComponent,
  IntentComponent,
  KnockbackComponent,
  POSEIDON_DASH_MODIFIER,
  PlayerFactory,
  ProjectileComponent,
  StateComponent,
  TransformComponent,
  VelocityComponent,
  WallComponent,
  addModifier,
  circleBodyRadius,
  createDefaultSystems,
  createWall,
  isFrozen,
  spawnProjectile,
  vec2,
} from '../../src';
import type { EntityId } from '../../src';

const FPS = 60;
const MAX_SPEED = 5;
/** Per-tick integration accumulates float rounding; measured drift is ~1e-15. */
const TOLERANCE = 1e-9;

/** The reference arena wall: a 2 x 10 slab whose left face sits at x = 3. */
const WALL = { x: 3, y: -5, width: 2, height: 10 } as const;

/** Where a body of a given radius comes to rest against {@link WALL}. */
const REST_AT_WALL = WALL.x;

/** The elite spawn X used by the slam rigs: inside the dash blast, short of the wall. */
const ELITE_X = 2;
/** Small enough that a single Poseidon blast (5) BREAKS it, which is what unlocks knockback. */
const ELITE_ARMOR = 3;

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

function stateOf(sim: GameSimulator, id: EntityId): StateComponent {
  const state = sim.world.getComponent(id, StateComponent);
  if (state === undefined) throw new Error('QA: entity is missing StateComponent');
  return state;
}

function hpOf(sim: GameSimulator, id: EntityId): number {
  const health = sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: entity is missing HealthComponent');
  return health.hp;
}

function hitboxOf(sim: GameSimulator, id: EntityId): HitboxComponent {
  const hitbox = sim.world.getComponent(id, HitboxComponent);
  if (hitbox === undefined) throw new Error('QA: entity is missing HitboxComponent');
  return hitbox;
}

function knockbackOf(sim: GameSimulator, id: EntityId): KnockbackComponent {
  const knockback = sim.world.getComponent(id, KnockbackComponent);
  if (knockback === undefined) throw new Error('QA: entity is missing KnockbackComponent');
  return knockback;
}

function wallOf(sim: GameSimulator, id: EntityId): WallComponent {
  const wall = sim.world.getComponent(id, WallComponent);
  if (wall === undefined) throw new Error('QA: entity is missing WallComponent');
  return wall;
}

function armorOf(sim: GameSimulator, id: EntityId): ArmorComponent {
  const armor = sim.world.getComponent(id, ArmorComponent);
  if (armor === undefined) throw new Error('QA: entity is missing ArmorComponent');
  return armor;
}

/** Ids of every live projectile, ascending. */
function projectiles(sim: GameSimulator): EntityId[] {
  return sim.world.query(ProjectileComponent);
}

/** A bare sim with the canonical pipeline and a player at the origin facing +x. */
function makePlayerRig(): { readonly sim: GameSimulator; readonly player: EntityId } {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, {
    x: 0,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
  });
  return { sim, player };
}

/* ========================================================================== *
 * G0 · primitives                                                             *
 * ========================================================================== */
describe('G0 · wall and body-radius primitives (AC-01)', () => {
  it('defaults to a unit box, and a wall carries NO TransformComponent', () => {
    const wall = new WallComponent();
    expect(wall.x).toBe(0);
    expect(wall.y).toBe(0);
    expect(wall.width).toBe(1);
    expect(wall.height).toBe(1);

    // The wall-slam tuning is part of the contract (spec 13 §3.2), pinned as a
    // LITERAL so a silent retune cannot slip through behind the constant.
    expect(DEFAULT_WALL_SLAM_DAMAGE).toBe(12);

    const sim = new GameSimulator();
    const id = createWall(sim.world, { x: 3, y: -5, width: 2, height: 10 });

    const stored = wallOf(sim, id);
    expect([stored.x, stored.y, stored.width, stored.height]).toEqual([3, -5, 2, 10]);
    // A wall is geometry, not a mover: no Transform means no system can displace it
    // and the snapshot never has to carry a position that can never change.
    expect(sim.world.hasComponent(id, TransformComponent)).toBe(false);
    expect(sim.world.hasComponent(id, VelocityComponent)).toBe(false);
  });

  it('rejects a non-positive extent or a non-finite origin, leaking no entity', () => {
    const sim = new GameSimulator();

    expect(() => createWall(sim.world, { x: 0, y: 0, width: 0, height: 1 })).toThrow(RangeError);
    expect(() => createWall(sim.world, { x: 0, y: 0, width: -1, height: 1 })).toThrow(RangeError);
    expect(() => createWall(sim.world, { x: 0, y: 0, width: Number.NaN, height: 1 })).toThrow(
      RangeError,
    );
    expect(() =>
      createWall(sim.world, { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 }),
    ).toThrow(RangeError);
    expect(() => createWall(sim.world, { x: 0, y: 0, width: 1, height: 0 })).toThrow(RangeError);
    expect(() => createWall(sim.world, { x: 0, y: 0, width: 1, height: -1 })).toThrow(RangeError);
    expect(() => createWall(sim.world, { x: Number.NaN, y: 0, width: 1, height: 1 })).toThrow(
      RangeError,
    );
    expect(() =>
      createWall(sim.world, { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 }),
    ).toThrow(RangeError);

    // Validation happens BEFORE the entity is created, so a rejected wall cannot
    // leave a half-assembled entity behind.
    expect(sim.world.entityCount).toBe(0);
  });

  it('derives the collision radius from the hurtbox first, then the hitbox', () => {
    const sim = new GameSimulator();
    const owner = sim.world.createEntity().id;

    const bare = sim.world.createEntity().id;
    expect(circleBodyRadius(sim.world, bare)).toBeUndefined(); // not a circle body

    const withHitbox = sim.world.createEntity().id;
    sim.world.addComponent(withHitbox, new HitboxComponent(0.4, 8, 60, Faction.Player, owner));
    expect(circleBodyRadius(sim.world, withHitbox)).toBe(0.4); // a projectile's body

    const withHurtbox = sim.world.createEntity().id;
    sim.world.addComponent(withHurtbox, new HurtboxComponent(0.5));
    expect(circleBodyRadius(sim.world, withHurtbox)).toBe(0.5); // a combatant's body

    const both = sim.world.createEntity().id;
    sim.world.addComponent(both, new HitboxComponent(0.4, 8, 60, Faction.Player, owner));
    sim.world.addComponent(both, new HurtboxComponent(0.9));
    expect(circleBodyRadius(sim.world, both)).toBe(0.9); // the BODY wins
  });
});

/* ========================================================================== *
 * G1 · wall blocking                                                          *
 * ========================================================================== */
describe('G1 · a body walking into a wall stops at the face (AC-01)', () => {
  it('never lets the body past the face, and rests exactly against it', () => {
    const rig = makePlayerRig();
    createWall(rig.sim.world, WALL);
    const limit = REST_AT_WALL - DEFAULT_HURTBOX_RADIUS; // 2.5

    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });

    let previous = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 90; i += 1) {
      rig.sim.step(1);
      const x = transformOf(rig.sim, rig.player).x;
      // THE anti-tunnelling assertion: at every tick boundary the body is still on
      // the near side of the face. A tunnelling bug shows up here immediately.
      expect(x).toBeLessThanOrEqual(limit + TOLERANCE);
      // ... and it never bounces back: the wall only ever stops forward motion.
      expect(x).toBeGreaterThanOrEqual(previous - TOLERANCE);
      previous = x;
    }

    // 90 ticks of input would have carried it 7.5 units unobstructed; it is pinned
    // to the face instead, exactly one radius out.
    expect(transformOf(rig.sim, rig.player).x).toBeCloseTo(limit, 9);
  });

  it('is a no-op when there is no wall — the M1 contract is untouched', () => {
    const rig = makePlayerRig();
    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    rig.sim.step(60);
    expect(transformOf(rig.sim, rig.player).x).toBeCloseTo(MAX_SPEED, 9);
  });

  it('ignores a wall the body is walking AWAY from', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    // Already resting against the wall's right face (x = 5 + radius) and walking +x:
    // the resolver must leave a body that is not overlapping completely alone.
    const startX = 5 + DEFAULT_HURTBOX_RADIUS;
    const player = PlayerFactory.spawn(sim.world, {
      x: startX,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    createWall(sim.world, WALL); // the wall is BEHIND the player

    sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    sim.step(60);
    expect(transformOf(sim, player).x).toBeCloseTo(startX + MAX_SPEED, 9);
  });

  it('blocks leftward motion symmetrically', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, {
      x: 0,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    createWall(sim.world, { x: -5, y: -5, width: 2, height: 10 }); // right face at x = -3

    sim.inject({ kind: 'move', tick: 0, vector: vec2(-1, 0) });
    sim.step(90);
    expect(transformOf(sim, player).x).toBeCloseTo(-3 + DEFAULT_HURTBOX_RADIUS, 9);
  });
});

/* ========================================================================== *
 * G2 · Poseidon Wall-Slam                                                     *
 * ========================================================================== */
interface SlamRig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
  readonly elite: EntityId;
}

/**
 * A player with `poseidon_dash` at the origin, an elite at `(2, 0)` whose small armour
 * pool a single blast (5) BREAKS, and the reference wall whose face sits at x = 3.
 *
 * The elite is deliberately script-driven (no `ai`): it must not walk, so every
 * displacement it shows is knockback — which is what makes the wall-slam observable.
 */
function makeSlamRig(): SlamRig {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, {
    x: 0,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
  });
  const elite = EnemyFactory.spawnElite(sim.world, {
    x: ELITE_X,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
    armor: ELITE_ARMOR,
  });
  createWall(sim.world, WALL);
  addModifier(sim.world, player, POSEIDON_DASH_MODIFIER);
  return { sim, player, elite };
}

describe('G2 · Poseidon Wall-Slam: a knockback the wall stops (AC-02)', () => {
  it('slams the elite into the wall for exactly one extra hit, then holds', () => {
    const rig = makeSlamRig();
    const sim = rig.sim;

    sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    sim.step(1); // tick 0 — the dash starts; ModifierSystem injects the blast

    expect(stateOf(sim, rig.player).state).toBe(ActionState.DASHING);
    expect(hpOf(sim, rig.elite)).toBe(DEFAULT_ELITE_MAX_HP);
    expect(transformOf(sim, rig.elite).x).toBe(ELITE_X);

    sim.step(1); // tick 1 — the blast's single collision test: armour BREAKS

    // Strict spillover arithmetic (spec 12 I1): 3 absorbed, 2 to HP.
    expect(armorOf(sim, rig.elite).current).toBe(0);
    expect(DEFAULT_POSEIDON_DASH_DAMAGE - ELITE_ARMOR).toBe(2);
    expect(hpOf(sim, rig.elite)).toBe(
      DEFAULT_ELITE_MAX_HP - (DEFAULT_POSEIDON_DASH_DAMAGE - ELITE_ARMOR),
    );

    // Breaking the armour is what unlocks the reaction (spec 12 AC-02).
    expect(stateOf(sim, rig.elite).state).toBe(ActionState.HITSTUN);
    expect(knockbackOf(sim, rig.elite).velocity.x).toBeCloseTo(DEFAULT_POSEIDON_DASH_KNOCKBACK, 9);
    // The knockback is integrated by MovementSystem, which already ran this tick.
    expect(transformOf(sim, rig.elite).x).toBe(ELITE_X);

    sim.step(1); // tick 2 — knockback meets the wall

    const restX = REST_AT_WALL - DEFAULT_ELITE_HURTBOX_RADIUS; // 2.2
    expect(transformOf(sim, rig.elite).x).toBeCloseTo(restX, 9);
    expect(hpOf(sim, rig.elite)).toBe(DEFAULT_ELITE_MAX_HP - 2 - DEFAULT_WALL_SLAM_DAMAGE);
    expect(hpOf(sim, rig.elite)).toBe(DEFAULT_ELITE_MAX_HP - 14);

    // The wall ABSORBED the knockback: no residual speed pressing into it, which is
    // what keeps the contact from settling again on the next tick.
    expect(knockbackOf(sim, rig.elite).velocity.x).toBe(0);
    expect(knockbackOf(sim, rig.elite).velocity.y).toBe(0);
    // ... and the stun was REFRESHED (seeded 0 in MovementSystem, advanced to 1 by
    // StateSystem, which runs later in the same tick).
    expect(stateOf(sim, rig.elite).state).toBe(ActionState.HITSTUN);
    expect(stateOf(sim, rig.elite).ticksInState).toBe(1);

    // EXACTLY ONE slam: the remaining 7 stun ticks deal nothing.
    sim.step(7); // ticks 3..9
    expect(hpOf(sim, rig.elite)).toBe(DEFAULT_ELITE_MAX_HP - 14);
    expect(stateOf(sim, rig.elite).state).toBe(ActionState.HITSTUN);
    expect(transformOf(sim, rig.elite).x).toBeCloseTo(restX, 9);

    // The refreshed stun spans 8 observable ticks (2..9) and releases on tick 10.
    sim.step(1); // tick 10
    expect(stateOf(sim, rig.elite).state).toBe(ActionState.IDLE);
    expect(hpOf(sim, rig.elite)).toBe(DEFAULT_ELITE_MAX_HP - 14);

    // The dasher is never hurt by its own boon.
    expect(hpOf(sim, rig.player)).toBe(DEFAULT_MAX_HP);
  });

  it('stops the dasher at the same wall without slamming it (no knockback channel)', () => {
    const rig = makeSlamRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.step(20); // ticks 0..19 — the dash carries it into the wall

    expect(transformOf(rig.sim, rig.player).x).toBeCloseTo(
      REST_AT_WALL - DEFAULT_HURTBOX_RADIUS,
      9,
    );
    expect(hpOf(rig.sim, rig.player)).toBe(DEFAULT_MAX_HP);
  });
});

/* ========================================================================== *
 * G3 · what is NOT a wall-slam                                                *
 * ========================================================================== */
describe('G3 · the wall-slam predicate (AC-02)', () => {
  it('does NOT slam a body that merely walks into the wall', () => {
    const rig = makePlayerRig();
    createWall(rig.sim.world, WALL);

    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    rig.sim.step(90);

    expect(transformOf(rig.sim, rig.player).x).toBeCloseTo(
      REST_AT_WALL - DEFAULT_HURTBOX_RADIUS,
      9,
    );
    expect(hpOf(rig.sim, rig.player)).toBe(DEFAULT_MAX_HP);
  });

  it('does NOT slam a body carrying a STALE knockback outside HITSTUN', () => {
    const rig = makePlayerRig();
    createWall(rig.sim.world, WALL);
    // Rig: `KnockbackComponent` is never removed by the engine, so a body can still
    // carry one long after the stun that owned it. That must not re-arm the slam.
    rig.sim.world.addComponent(rig.player, new KnockbackComponent(vec2(40, 0)));

    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    rig.sim.step(90);

    expect(stateOf(rig.sim, rig.player).state).not.toBe(ActionState.HITSTUN);
    expect(transformOf(rig.sim, rig.player).x).toBeCloseTo(
      REST_AT_WALL - DEFAULT_HURTBOX_RADIUS,
      9,
    );
    expect(hpOf(rig.sim, rig.player)).toBe(DEFAULT_MAX_HP);
  });

  it('does NOT slam a body knocked back ALONG the wall (push perpendicular to motion)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    // Pressed into a wall whose left face is at x = 0 (gap 0.2 < radius 0.5).
    const player = PlayerFactory.spawn(sim.world, {
      x: -0.2,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    createWall(sim.world, { x: 0, y: -1, width: 2, height: 2 });

    // Rig: stunned, and knocked back PARALLEL to the wall face (+y).
    const state = stateOf(sim, player);
    state.state = ActionState.HITSTUN;
    state.ticksInState = 0;
    sim.world.addComponent(player, new KnockbackComponent(vec2(0, 40)));

    sim.step(1);

    // Pushed out to the face (so a push DID happen)...
    expect(transformOf(sim, player).x).toBeCloseTo(-0.5, 9);
    // ... but slid along it: dot(push, knockback) === 0, which is not a slam.
    expect(hpOf(sim, player)).toBe(DEFAULT_MAX_HP);
    // The knockback was NOT absorbed either — the body keeps sliding.
    expect(knockbackOf(sim, player).velocity.y).toBeCloseTo(40, 9);
  });

  it('DOES slam a stunned body knocked back straight into the wall (isolated from the boon)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, {
      x: 2.4,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    createWall(sim.world, WALL);

    const state = stateOf(sim, player);
    state.state = ActionState.HITSTUN;
    state.ticksInState = 0;
    sim.world.addComponent(player, new KnockbackComponent(vec2(40, 0)));

    sim.step(1);

    expect(hpOf(sim, player)).toBe(DEFAULT_MAX_HP - DEFAULT_WALL_SLAM_DAMAGE);
    expect(transformOf(sim, player).x).toBeCloseTo(REST_AT_WALL - DEFAULT_HURTBOX_RADIUS, 9);
    expect(knockbackOf(sim, player).velocity.x).toBe(0);
  });
});

/* ========================================================================== *
 * G4 · cast assembly                                                          *
 * ========================================================================== */
describe('G4 · casting spawns a self-propelled projectile (AC-03)', () => {
  it('assembles exactly the documented component set and tuning', () => {
    const rig = makePlayerRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: CAST_KEY });
    rig.sim.step(1); // tick 0

    const ids = projectiles(rig.sim);
    expect(ids).toHaveLength(1);
    const projectile = at(ids, 0);

    // The component set: Transform + Velocity + Hitbox + Projectile, and nothing that
    // would make it a combatant or let it be steered / hit.
    expect(rig.sim.world.hasComponent(projectile, TransformComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(projectile, VelocityComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(projectile, HitboxComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(projectile, ProjectileComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(projectile, IntentComponent)).toBe(false);
    expect(rig.sim.world.hasComponent(projectile, StateComponent)).toBe(false);
    expect(rig.sim.world.hasComponent(projectile, HurtboxComponent)).toBe(false);
    expect(rig.sim.world.hasComponent(projectile, HealthComponent)).toBe(false);
    expect(rig.sim.world.hasComponent(projectile, FactionComponent)).toBe(false);

    // Spawn point: offset along the caster's facing, so it is not born inside itself.
    const transform = transformOf(rig.sim, projectile);
    expect(transform.x).toBeCloseTo(DEFAULT_CAST_SPAWN_OFFSET, 9);
    expect(transform.y).toBeCloseTo(0, 9);
    expect(transform.facingRadians).toBeCloseTo(0, 9);

    // Motion channel: the projectile's OWN velocity, not an intent.
    const velocity = velocityOf(rig.sim, projectile);
    expect(velocity.maxSpeed).toBe(DEFAULT_CAST_PROJECTILE_SPEED);
    expect(velocity.currentSpeed).toBe(DEFAULT_CAST_PROJECTILE_SPEED);
    expect(velocity.directionVector.x).toBeCloseTo(1, 9);
    expect(velocity.directionVector.y).toBeCloseTo(0, 9);

    // Damage circle + retirement switches.
    const hitbox = hitboxOf(rig.sim, projectile);
    expect(hitbox.radius).toBe(DEFAULT_CAST_HITBOX_RADIUS);
    expect(hitbox.damage).toBe(DEFAULT_CAST_DAMAGE);
    expect(hitbox.knockbackForce).toBe(DEFAULT_CAST_KNOCKBACK);
    expect(hitbox.hitstopTicks).toBe(DEFAULT_CAST_HITSTOP_TICKS);
    expect(hitbox.hitstopTicks).toBe(0); // the tuning itself, not the constant
    expect(hitbox.faction).toBe(Faction.Player);
    expect(hitbox.ownerEntityId).toBe(rig.player);
    expect(hitbox.sourceModifier).toBeNull(); // a base hit — boons may react to it
    expect(hitbox.destroyOnHit).toBe(true);
    expect(hitbox.destroyOnWall).toBe(true);
    expect(hitbox.hitEntities).toEqual([]);
    // LifespanSystem already aged it once this tick.
    expect(hitbox.activeTicks).toBe(DEFAULT_CAST_LIFESPAN_TICKS - 1);

    // hitstop 0 is what keeps the CASTER out of the freeze its own shot causes.
    expect(isFrozen(rig.sim.world, rig.player)).toBe(false);
  });

  it('pins the projectile tuning as LITERALS (spec 13 §3.3)', () => {
    // Comparing a component field against the constant that built it is a tautology:
    // a silent retune of the constant would keep the wiring test green. The numbers
    // below ARE the contract, so they are written out.
    expect(DEFAULT_CAST_PROJECTILE_SPEED).toBe(20);
    expect(DEFAULT_CAST_HITBOX_RADIUS).toBe(0.4);
    expect(DEFAULT_CAST_DAMAGE).toBe(8);
    expect(DEFAULT_CAST_LIFESPAN_TICKS).toBe(60);
    expect(DEFAULT_CAST_HITSTOP_TICKS).toBe(0);
    expect(DEFAULT_CAST_KNOCKBACK).toBe(6);
    expect(DEFAULT_CAST_SPAWN_OFFSET).toBe(0.5);
  });

  it('fires along the caster facing, not along +x', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, {
      x: 0,
      y: 0,
      facingRadians: Math.PI / 2,
      maxSpeed: MAX_SPEED,
    });
    sim.inject({ kind: 'keyDown', tick: 0, key: CAST_KEY });
    sim.step(1);

    const projectile = at(projectiles(sim), 0);
    expect(transformOf(sim, projectile).x).toBeCloseTo(0, 9);
    expect(transformOf(sim, projectile).y).toBeCloseTo(DEFAULT_CAST_SPAWN_OFFSET, 9);
    expect(velocityOf(sim, projectile).directionVector.y).toBeCloseTo(1, 9);
    expect(hitboxOf(sim, projectile).ownerEntityId).toBe(player);
  });

  it('does not fire from a MELEE attack — the two actions are distinct', () => {
    const rig = makePlayerRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0

    expect(projectiles(rig.sim)).toHaveLength(0);
    // The melee hitbox exists, is in front of the attacker, and is NOT a projectile:
    // no velocity (so it never moves) and no self-retirement.
    const melee = rig.sim.world.query(HitboxComponent).filter((id) => id !== rig.player);
    expect(melee).toHaveLength(1);
    const meleeId = at(melee, 0);
    expect(rig.sim.world.hasComponent(meleeId, ProjectileComponent)).toBe(false);
    expect(rig.sim.world.hasComponent(meleeId, VelocityComponent)).toBe(false);
    expect(hitboxOf(rig.sim, meleeId).destroyOnHit).toBe(false);
    expect(hitboxOf(rig.sim, meleeId).destroyOnWall).toBe(false);
  });
});

/* ========================================================================== *
 * G5 · flight, one hit, no piercing                                           *
 * ========================================================================== */
describe('G5 · the projectile flies, hits once, and stops there (AC-03/04)', () => {
  it('flies per tick, retires on the near enemy, and never reaches the far one', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const caster = PlayerFactory.spawn(sim.world, {
      x: 0,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    const near = EnemyFactory.spawn(sim.world, {
      x: 3,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    const far = EnemyFactory.spawn(sim.world, {
      x: 6,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });

    sim.inject({ kind: 'keyDown', tick: 0, key: CAST_KEY });
    sim.step(1); // tick 0 — spawned, and collision-tested at (0.5, 0): out of reach
    const projectile = at(projectiles(sim), 0);
    expect(transformOf(sim, projectile).x).toBeCloseTo(DEFAULT_CAST_SPAWN_OFFSET, 9);
    expect(hpOf(sim, near)).toBe(DEFAULT_MAX_HP);

    sim.step(4); // ticks 1..4 — self-propelled flight
    expect(sim.world.isAlive(projectile)).toBe(true);
    expect(transformOf(sim, projectile).x).toBeCloseTo(
      DEFAULT_CAST_SPAWN_OFFSET + (4 * DEFAULT_CAST_PROJECTILE_SPEED) / FPS,
      9,
    );
    // Still short of `near` (dist 1.167 > radius 0.4 + hurtbox 0.5).
    expect(hpOf(sim, near)).toBe(DEFAULT_MAX_HP);

    sim.step(1); // tick 5 — the flight reaches `near`
    expect(hpOf(sim, near)).toBe(DEFAULT_MAX_HP - DEFAULT_CAST_DAMAGE);
    expect(sim.world.isAlive(projectile)).toBe(false); // retired on the hit
    expect(stateOf(sim, near).state).toBe(ActionState.HITSTUN);
    expect(knockbackOf(sim, near).velocity.x).toBeCloseTo(DEFAULT_CAST_KNOCKBACK, 9);

    // hitstop 0 means the CASTER is untouched by the freeze its own shot caused —
    // the reason a projectile must never inherit the melee hitstop (spec 13 §4.4).
    expect(isFrozen(sim.world, near)).toBe(false);
    expect(isFrozen(sim.world, caster)).toBe(false);

    // NO PIERCING: `far` is untouched, and the projectile is gone, so it cannot
    // arrive later either. Step well past the flight time it would have needed.
    expect(hpOf(sim, far)).toBe(DEFAULT_MAX_HP);
    sim.step(20); // ticks 6..25
    expect(hpOf(sim, far)).toBe(DEFAULT_MAX_HP);
    expect(projectiles(sim)).toHaveLength(0);

    // The victim really was pushed: MovementSystem integrates the knockback from the
    // tick after the hit.
    expect(transformOf(sim, near).x).toBeGreaterThan(3);
  });

  it('expires on its own lifespan when it hits nothing', () => {
    const rig = makePlayerRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: CAST_KEY });
    rig.sim.step(1); // tick 0
    const projectile = at(projectiles(rig.sim), 0);

    rig.sim.step(DEFAULT_CAST_LIFESPAN_TICKS - 1); // ticks 1..59 — nothing to hit
    expect(rig.sim.world.isAlive(projectile)).toBe(false);
    expect(projectiles(rig.sim)).toHaveLength(0);
  });
});

/* ========================================================================== *
 * G6 · walls retire projectiles                                               *
 * ========================================================================== */
describe('G6 · a projectile is retired by geometry, and cannot pass through it (AC-04)', () => {
  it('retires on the tick its flight reaches the wall', () => {
    const rig = makePlayerRig();
    createWall(rig.sim.world, { x: 4, y: -5, width: 2, height: 10 });

    rig.sim.inject({ kind: 'keyDown', tick: 0, key: CAST_KEY });
    rig.sim.step(1); // tick 0
    const projectile = at(projectiles(rig.sim), 0);

    rig.sim.step(9); // ticks 1..9 — still clear of the face at x = 4
    expect(rig.sim.world.isAlive(projectile)).toBe(true);
    expect(transformOf(rig.sim, projectile).x).toBeCloseTo(
      DEFAULT_CAST_SPAWN_OFFSET + (9 * DEFAULT_CAST_PROJECTILE_SPEED) / FPS,
      9,
    );

    rig.sim.step(1); // tick 10 — the flight reaches the wall
    expect(rig.sim.world.isAlive(projectile)).toBe(false);
    expect(projectiles(rig.sim)).toHaveLength(0);
  });

  it('comes to rest exactly on the face when it is NOT retired (proves no tunnelling)', () => {
    const rig = makePlayerRig();
    createWall(rig.sim.world, { x: 4, y: -5, width: 2, height: 10 });

    const projectile = spawnProjectile(rig.sim.world, {
      x: 0,
      y: 0,
      directionRadians: 0,
      faction: Faction.Player,
      ownerEntityId: rig.player,
    });
    // Rig: this one survives contact, so its resting position is observable. The
    // production projectile (destroyOnWall === true) is destroyed the moment it is
    // pushed, which is why the resting position can only be pinned this way.
    hitboxOf(rig.sim, projectile).destroyOnWall = false;

    const limit = 4 - DEFAULT_CAST_HITBOX_RADIUS; // 3.6

    for (let i = 0; i < 40; i += 1) {
      rig.sim.step(1);
      expect(transformOf(rig.sim, projectile).x).toBeLessThanOrEqual(limit + TOLERANCE);
    }

    expect(rig.sim.world.isAlive(projectile)).toBe(true);
    expect(transformOf(rig.sim, projectile).x).toBeCloseTo(limit, 9);
  });

  it('a wall-stopped projectile deals no damage — it dies before the collision test', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, {
      x: 0,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    // The enemy stands BEHIND the wall: the projectile must never reach it.
    const shielded = EnemyFactory.spawn(sim.world, {
      x: 7,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    createWall(sim.world, { x: 4, y: -5, width: 2, height: 10 });

    sim.inject({ kind: 'keyDown', tick: 0, key: CAST_KEY });
    sim.step(30); // ticks 0..29 — the projectile dies on the wall around tick 10

    expect(projectiles(sim)).toHaveLength(0);
    expect(hpOf(sim, shielded)).toBe(DEFAULT_MAX_HP);
  });
});

/* ========================================================================== *
 * G7 · pipeline, pulse gating, determinism                                    *
 * ========================================================================== */
describe('G7 · pipeline unchanged, pulse gating, determinism (AC-06)', () => {
  it('keeps the canonical 17-segment order — M7-T01 adds NO segment of its own', () => {
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

    // The two slots M7-T01 RELIES ON (it reorders nothing):
    //  - MovementSystem resolves walls, so it must run after TransformSnapshotSystem
    //    (which records the pre-move position) ...
    expect(names.indexOf('MovementSystem')).toBeGreaterThan(names.indexOf('TransformSnapshotSystem'));
    //  - ... and BEFORE CollisionSystem, which is what makes a wall-stopped projectile
    //    untestable on the tick it is stopped (spec 13 I6).
    expect(names.indexOf('MovementSystem')).toBeLessThan(names.indexOf('CollisionSystem'));
  });

  it('drops a cast pulse raised while DASHING — consumed, never buffered', () => {
    const rig = makePlayerRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: CAST_KEY });

    rig.sim.step(1); // tick 0 — the dash wins, the cast pulse is consumed and dropped
    expect(stateOf(rig.sim, rig.player).state).toBe(ActionState.DASHING);
    expect(projectiles(rig.sim)).toHaveLength(0);

    // Held keys are rising-edge only, so nothing fires later either.
    rig.sim.step(60);
    expect(projectiles(rig.sim)).toHaveLength(0);
  });

  it('drops a cast pulse raised while HITSTUN', () => {
    const rig = makePlayerRig();
    const state = stateOf(rig.sim, rig.player);
    state.state = ActionState.HITSTUN;
    state.ticksInState = 0;

    rig.sim.inject({ kind: 'keyDown', tick: 0, key: CAST_KEY });
    rig.sim.step(1);

    expect(projectiles(rig.sim)).toHaveLength(0);
  });

  it('fires once per PRESS — holding the key does not repeat', () => {
    const rig = makePlayerRig();

    rig.sim.inject({ kind: 'keyDown', tick: 0, key: CAST_KEY });
    rig.sim.step(20); // ticks 0..19
    expect(projectiles(rig.sim)).toHaveLength(1);

    // Release, then press again: a second projectile.
    rig.sim.inject({ kind: 'keyUp', tick: 20, key: CAST_KEY });
    rig.sim.step(1); // tick 20
    rig.sim.inject({ kind: 'keyDown', tick: 21, key: CAST_KEY });
    rig.sim.step(1); // tick 21
    expect(projectiles(rig.sim)).toHaveLength(2);
  });

  it('is deterministic with walls, a wall-slam and a projectile in the mix', () => {
    const run = (): unknown => {
      const rig = makeSlamRig();
      rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
      rig.sim.inject({ kind: 'keyDown', tick: 40, key: CAST_KEY });
      rig.sim.step(60);
      return rig.sim.snapshot();
    };

    expect(run()).toEqual(run());
  });

  it('leaves the pre-M7 arithmetic untouched when no wall exists', () => {
    // Same script, no wall, two runs: byte-identical snapshots. Together with the
    // untouched M1..M6 suites this is the zero-regression evidence for spec 13 I7.
    const run = (): unknown => {
      const rig = makePlayerRig();
      rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
      rig.sim.inject({ kind: 'keyDown', tick: 10, key: DASH_KEY });
      rig.sim.inject({ kind: 'keyDown', tick: 30, key: CAST_KEY });
      rig.sim.step(60);
      return rig.sim.snapshot();
    };

    expect(run()).toEqual(run());
  });
});
