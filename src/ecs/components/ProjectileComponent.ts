/**
 * Self-propelled projectile marker + assembly. See
 * specs/13_arena_and_projectiles_spec.md §3.3 (M7-T01 AC-03 / AC-04) and
 * specs/18_advanced_ballistics_and_hazards_spec.md §4.1 (M11-T01 AC-01).
 *
 * POD component: data only, no behaviour. It carries exactly ONE field,
 * `bounceCount` — the number of remaining WALL REFLECTIONS — and nothing else,
 * because everything else a projectile needs is already expressed by a component
 * that exists for its own sake:
 *
 *   - where it is / which way it points -> `TransformComponent`
 *   - how fast it flies                 -> `VelocityComponent`
 *   - what it hits for, how long it lives, what it has struck, whether contact or a
 *     wall retires it                   -> `HitboxComponent`
 *
 * WHY `bounceCount` IS *NOT* ZERO-FIELD (the M11 change). Through M7 this component
 * was a bare marker (like `DeadTagComponent`) whose whole payload was IDENTITY:
 * "this entity flies under its own power". M11-T01 gives a projectile a real
 * behaviour — bouncing off static geometry — and that behaviour needs a per-entity
 * counter. A counter is SIMULATION state, so it cannot live anywhere but on a
 * component (spec 00 §6.1: anything that changes between two ticks must be
 * snapshot-visible and replay-exact). The two candidate homes were:
 *
 *   - `HitboxComponent` (which already owns the sibling counters `pierceCount` /
 *     `damageFalloff`), or
 *   - this component.
 *
 * It lives HERE, and the reason is scoping: bouncing is a property of the
 * PROJECTILE, not of a generic damage circle. A melee swing is a static circle with
 * no `VelocityComponent` and is never wall-resolved, so a `bounceCount` on the
 * hitbox would be an inert field on every hitbox that is not a projectile — dead
 * data on ~all instances, and a field every future hitbox author must remember is
 * meaningless for them. Keeping it on `ProjectileComponent` makes "bounces" and
 * "is a projectile" the same set by construction, exactly as `destroyOnWall` lives
 * on the hitbox because wall resolution is a property of what the wall pass visits.
 * The cost of the split (a projectile's tuning now spans two components) is recorded
 * in spec 18 §9 / §10.
 *
 * WHY a marker rather than a NEGATIVE predicate. `MovementSystem` must integrate
 * entities that have no `IntentComponent` — the tempting shortcut is "has a
 * `VelocityComponent` but no `IntentComponent`". That predicate silently opts in
 * every future intent-less entity, and it reads as an absence rather than a fact.
 * An unspoofable component type (the same reasoning `DeadTagComponent` records) is
 * positive, queryable and impossible to satisfy by accident.
 *
 * `spawnProjectile` is the ONE assembly point, mirroring `spawnCombatant`: the
 * component set of a projectile is defined here and nowhere else, so a caller (the
 * Cast action, a test, a future projectile boon) can never build a half-formed one.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';
import { vec2 } from '../../core/math';
import { DataManager } from '../../data/DataManager';
import { Faction } from './FactionComponent';
import {
  DEFAULT_HITBOX_DAMAGE_FALLOFF,
  DEFAULT_HITBOX_PIERCE_COUNT,
  HitboxComponent,
} from './HitboxComponent';
import { TransformComponent } from './TransformComponent';
import { VelocityComponent } from './VelocityComponent';

/** Flight speed of a cast projectile, in world units per second. */
export const DEFAULT_CAST_PROJECTILE_SPEED = 20;

/**
 * Radius of a cast projectile's hitbox. Smaller than a melee swing (`1`) because a
 * projectile is a precision tool — and because a small, fast circle is exactly the
 * shape that would expose a discrete-collision tunnelling bug, so keeping it well
 * under the smallest target keeps this milestone honest (spec 13 §11).
 */
export const DEFAULT_CAST_HITBOX_RADIUS = 0.4;

/** Damage of one cast projectile. Below a melee swing (`10`): range is paid for in damage. */
export const DEFAULT_CAST_DAMAGE = 8;

/** Lifetime of a cast projectile, in ticks (60 ticks @60fps = 1 s of flight). */
export const DEFAULT_CAST_LIFESPAN_TICKS = 60;

/**
 * Hitstop of a cast projectile: `0`, i.e. none.
 *
 * This is NOT a taste decision, it is a correctness one. `CollisionSystem` freezes
 * BOTH sides of a landed hit, and the projectile's `ownerEntityId` is the CASTER —
 * who is by definition far away. A non-zero hitstop would therefore freeze the
 * shooter in place every time its own projectile connected. Zero hitstop keeps the
 * feedback gate open (via the non-zero knockback below), so the VICTIM still
 * staggers and gets pushed, while the caster is never touched.
 */
export const DEFAULT_CAST_HITSTOP_TICKS = 0;

/**
 * Knockback of a cast projectile, in world units per second. Below a melee swing
 * (`12`): a projectile nudges, it does not launch. Being `> 0` is what opens
 * `CollisionSystem`'s feedback gate, which is how the victim enters `HITSTUN` and
 * therefore how the knockback displaces at all (spec 04 AC-03).
 */
export const DEFAULT_CAST_KNOCKBACK = 6;

/**
 * Forward offset from the caster's origin to the projectile's spawn point. Keeps
 * the projectile from being born inside its own body — cosmetic for the hit
 * resolution (same-faction hits are already impossible) but honest for anything
 * reading positions.
 */
export const DEFAULT_CAST_SPAWN_OFFSET = 0.5;

/**
 * Default remaining wall-bounce allowance of a cast projectile (M11-T01 AC-01).
 *
 * `0` means "no bouncing": the projectile is destroyed the moment static geometry
 * pushes it, which is the historic (M7) behaviour. A positive value is the number
 * of wall reflections the projectile may make before it retires.
 */
export const DEFAULT_PROJECTILE_BOUNCE_COUNT = 0;

export class ProjectileComponent extends ComponentBase {
  /**
   * Remaining wall REFLECTIONS (M11-T01, spec 18 AC-01).
   *
   * Read and mutated by the wall-resolution pass in `MovementSystem`: when a
   * projectile that would otherwise be destroyed on contact with geometry has
   * `bounceCount > 0`, the allowance is decremented by one and its velocity is
   * mirrored about the wall normal instead of the entity being destroyed.
   * `0` is the historic behaviour.
   */
  public bounceCount: number;

  constructor(bounceCount = DEFAULT_PROJECTILE_BOUNCE_COUNT) {
    super();
    this.bounceCount = bounceCount;
  }
}

/** The spec of a projectile to spawn. */
export interface ProjectileSpawnOptions {
  /** Caster origin X; the projectile spawns `spawnOffset` further along `directionRadians`. */
  readonly x: number;
  /** Caster origin Y. */
  readonly y: number;
  /** Flight direction in radians (atan2 convention: `+x` is `0`). */
  readonly directionRadians: number;
  /** Faction the projectile belongs to; it can only hit a DIFFERENT faction. */
  readonly faction: Faction;
  /** The entity that cast it — snapshotted, so hitstop/ownership survive its death. */
  readonly ownerEntityId: EntityId;
  /** Flight speed; defaults to {@link DEFAULT_CAST_PROJECTILE_SPEED}. */
  readonly speed?: number;
  /** Hitbox radius; defaults to {@link DEFAULT_CAST_HITBOX_RADIUS}. */
  readonly radius?: number;
  /** Damage; defaults to {@link DEFAULT_CAST_DAMAGE}. */
  readonly damage?: number;
  /** Lifespan in ticks; defaults to {@link DEFAULT_CAST_LIFESPAN_TICKS}. */
  readonly lifespanTicks?: number;
  /** Knockback; defaults to {@link DEFAULT_CAST_KNOCKBACK}. */
  readonly knockback?: number;
  /**
   * Remaining wall reflections (M11-T01); defaults to
   * {@link DEFAULT_PROJECTILE_BOUNCE_COUNT}. Must be a non-negative integer.
   */
  readonly bounceCount?: number;
  /**
   * Remaining pierce allowance (M11-T01); defaults to
   * {@link DEFAULT_HITBOX_PIERCE_COUNT}. Must be a non-negative integer.
   */
  readonly pierceCount?: number;
  /**
   * Fractional damage removed after each pierce (M11-T01); defaults to
   * {@link DEFAULT_HITBOX_DAMAGE_FALLOFF}. Must be a finite number in `[0, 1)`.
   */
  readonly damageFalloff?: number;
}

/** @throws RangeError if `value` is not a positive finite number. */
function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number, received: ${String(value)}`);
  }
}

/** @throws RangeError if `value` is not a positive integer. */
function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer, received: ${String(value)}`);
  }
}

/** @throws RangeError if `value` is not a non-negative finite number. */
function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number, received: ${String(value)}`);
  }
}

/** @throws RangeError if `value` is not a non-negative integer. */
function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, received: ${String(value)}`);
  }
}

/** @throws RangeError if `value` is not a finite number in `[0, 1)`. */
function assertUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError(`${label} must be a finite number in [0, 1), received: ${String(value)}`);
  }
}

/**
 * Assemble a flying projectile entity owning exactly:
 * `TransformComponent` + `VelocityComponent` + `HitboxComponent` + `ProjectileComponent`.
 *
 * Both self-retirement switches are ON: `destroyOnHit` (a projectile retires on the
 * first target it strikes — spec 13 AC-04) and `destroyOnWall` (it never passes
 * through geometry). M11-T01 makes both of them CONDITIONAL on an allowance:
 * `pierceCount > 0` lets the projectile survive a landed hit and strike on, and
 * `bounceCount > 0` lets it reflect off a wall instead of retiring. Both default to
 * `0`, so a plain cast behaves exactly as it did in M7. `sourceModifier` is `null`,
 * so a projectile hit counts as a BASE hit and may trigger the caster's on-hit boons
 * exactly like a melee swing.
 *
 * The projectile owns NO `IntentComponent` (nothing steers it), no
 * `HurtboxComponent`/`HealthComponent`/`FactionComponent` (it cannot be hit — the
 * target query requires all three), and no `StateComponent` (it has no action state
 * to be interrupted).
 *
 * @throws RangeError if `speed` / `radius` / `damage` / `lifespanTicks` /
 *   `knockback` / `bounceCount` / `pierceCount` / `damageFalloff` /
 *   `directionRadians` fails its validation.
 */
export function spawnProjectile(world: World, options: ProjectileSpawnOptions): EntityId {
  const speed = options.speed ?? DEFAULT_CAST_PROJECTILE_SPEED;
  const radius = options.radius ?? DEFAULT_CAST_HITBOX_RADIUS;
  const damage = options.damage ?? DEFAULT_CAST_DAMAGE;
  const lifespanTicks = options.lifespanTicks ?? DEFAULT_CAST_LIFESPAN_TICKS;
  const knockback = options.knockback ?? DEFAULT_CAST_KNOCKBACK;
  const bounceCount = options.bounceCount ?? DEFAULT_PROJECTILE_BOUNCE_COUNT;
  const pierceCount = options.pierceCount ?? DEFAULT_HITBOX_PIERCE_COUNT;
  const damageFalloff = options.damageFalloff ?? DEFAULT_HITBOX_DAMAGE_FALLOFF;

  // Assembly-seam validation, ALL of it BEFORE `createEntity`: a rejected projectile
  // must leave no half-built entity behind (spec 18 §8).
  assertPositiveFinite(speed, 'projectile.speed');
  assertPositiveFinite(radius, 'projectile.radius');
  assertNonNegativeFinite(damage, 'projectile.damage');
  assertPositiveInteger(lifespanTicks, 'projectile.lifespanTicks');
  assertNonNegativeFinite(knockback, 'projectile.knockback');
  assertNonNegativeInteger(bounceCount, 'projectile.bounceCount');
  assertNonNegativeInteger(pierceCount, 'projectile.pierceCount');
  assertUnitInterval(damageFalloff, 'projectile.damageFalloff');
  if (!Number.isFinite(options.directionRadians)) {
    throw new RangeError(
      `projectile.directionRadians must be a finite number, received: ${String(options.directionRadians)}`,
    );
  }

  const direction = vec2(Math.cos(options.directionRadians), Math.sin(options.directionRadians));

  const entity = world.createEntity();
  world.addComponent(
    entity.id,
    new TransformComponent(
      options.x + direction.x * DEFAULT_CAST_SPAWN_OFFSET,
      options.y + direction.y * DEFAULT_CAST_SPAWN_OFFSET,
      options.directionRadians,
    ),
  );
  world.addComponent(entity.id, new VelocityComponent(speed, speed, direction));
  world.addComponent(
    entity.id,
    new HitboxComponent(
      radius,
      damage,
      lifespanTicks,
      options.faction,
      options.ownerEntityId,
      DEFAULT_CAST_HITSTOP_TICKS,
      knockback,
      [], // hitEntities — nothing struck yet
      null, // sourceModifier — a cast is a BASE hit, not a boon-injected one
      true, // destroyOnHit — a projectile retires on its first target (unless piercing)
      true, // destroyOnWall — a projectile never passes through geometry (unless bouncing)
      pierceCount,
      damageFalloff,
    ),
  );
  world.addComponent(entity.id, new ProjectileComponent(bounceCount));
  return entity.id;
}

/**
 * The per-INSTANCE half of a config-driven projectile spawn (M11-T01).
 *
 * Mirrors `EnemyPlacement`: everything here is a fact about THIS projectile rather
 * than about its TYPE. The per-TYPE half (speed / radius / damage / lifespan /
 * knockback / bounce / pierce / falloff) is a `ProjectileConfig` resolved through
 * `DataManager`, so the same projectile type can be fired from twenty places
 * without repeating a single number.
 */
export interface ProjectilePlacement {
  /** Caster origin X; the projectile spawns `spawnOffset` further along `directionRadians`. */
  readonly x: number;
  /** Caster origin Y. */
  readonly y: number;
  /** Flight direction in radians (atan2 convention: `+x` is `0`). */
  readonly directionRadians: number;
  /** Faction the projectile belongs to. */
  readonly faction: Faction;
  /** The entity that cast it. */
  readonly ownerEntityId: EntityId;
}

/**
 * Assemble a projectile from a named `projectiles` config template (M11-T01).
 *
 * This is the config-driven sibling of {@link spawnProjectile}: it reads the
 * template `configId` from `DataManager` and merges it UNDER the placement, so any
 * field the template omits falls through to the same `DEFAULT_CAST_*` values
 * `spawnProjectile` would have used. The `src/ecs -> src/data` dependency is the
 * same one `EnemyFactory` already takes, and it introduces no cycle (`src/data`
 * never imports `src/ecs`).
 *
 * @throws SchemaError when `configId` is not in the loaded `projectiles` table
 *   (including the case where Bootstrap never ran).
 * @throws RangeError under the same conditions listed on {@link spawnProjectile}.
 */
export function spawnProjectileFromConfig(
  world: World,
  configId: string,
  placement: ProjectilePlacement,
): EntityId {
  const config = DataManager.getProjectileConfig(configId);
  return spawnProjectile(world, {
    ...placement,
    ...(config.speed === undefined ? {} : { speed: config.speed }),
    ...(config.radius === undefined ? {} : { radius: config.radius }),
    ...(config.damage === undefined ? {} : { damage: config.damage }),
    ...(config.lifespanTicks === undefined ? {} : { lifespanTicks: config.lifespanTicks }),
    ...(config.knockback === undefined ? {} : { knockback: config.knockback }),
    ...(config.bounceCount === undefined ? {} : { bounceCount: config.bounceCount }),
    ...(config.pierceCount === undefined ? {} : { pierceCount: config.pierceCount }),
    ...(config.damageFalloff === undefined ? {} : { damageFalloff: config.damageFalloff }),
  });
}
