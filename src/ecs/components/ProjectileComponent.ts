/**
 * Self-propelled projectile marker + assembly. See
 * specs/13_arena_and_projectiles_spec.md §3.3 (M7-T01 AC-03 / AC-04).
 *
 * POD component: data only, no behaviour — and deliberately ZERO FIELDS, exactly
 * like `DeadTagComponent`. Everything a projectile needs is already expressed by a
 * component that exists for its own sake:
 *
 *   - where it is / which way it points -> `TransformComponent`
 *   - how fast it flies                 -> `VelocityComponent`
 *   - what it hits for, how long it lives, what it has struck, and whether contact
 *     retires it                       -> `HitboxComponent`
 *
 * Copying any of that here would create a second source of truth that could drift,
 * which is the one thing this codebase refuses to do (see the same argument in
 * `DeadTagComponent`). So the component's whole payload is IDENTITY: "this entity
 * flies under its own power".
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
import { Faction } from './FactionComponent';
import { HitboxComponent } from './HitboxComponent';
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

export class ProjectileComponent extends ComponentBase {}

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

/**
 * Assemble a flying projectile entity owning exactly:
 * `TransformComponent` + `VelocityComponent` + `HitboxComponent` + `ProjectileComponent`.
 *
 * Both self-retirement switches are ON: `destroyOnHit` (no piercing — a projectile
 * retires on the first target it strikes, spec 13 AC-04) and `destroyOnWall` (no
 * passing through geometry). `sourceModifier` is `null`, so a projectile hit counts
 * as a BASE hit and may trigger the caster's on-hit boons exactly like a melee swing.
 *
 * The projectile owns NO `IntentComponent` (nothing steers it), no
 * `HurtboxComponent`/`HealthComponent`/`FactionComponent` (it cannot be hit — the
 * target query requires all three), and no `StateComponent` (it has no action state
 * to be interrupted).
 *
 * @throws RangeError if `speed` / `radius` / `damage` / `lifespanTicks` /
 *   `knockback` / `directionRadians` fails its validation.
 */
export function spawnProjectile(world: World, options: ProjectileSpawnOptions): EntityId {
  const speed = options.speed ?? DEFAULT_CAST_PROJECTILE_SPEED;
  const radius = options.radius ?? DEFAULT_CAST_HITBOX_RADIUS;
  const damage = options.damage ?? DEFAULT_CAST_DAMAGE;
  const lifespanTicks = options.lifespanTicks ?? DEFAULT_CAST_LIFESPAN_TICKS;
  const knockback = options.knockback ?? DEFAULT_CAST_KNOCKBACK;

  assertPositiveFinite(speed, 'projectile.speed');
  assertPositiveFinite(radius, 'projectile.radius');
  assertNonNegativeFinite(damage, 'projectile.damage');
  assertPositiveInteger(lifespanTicks, 'projectile.lifespanTicks');
  assertNonNegativeFinite(knockback, 'projectile.knockback');
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
      true, // destroyOnHit — a projectile retires on its first target
      true, // destroyOnWall — a projectile never passes through geometry
    ),
  );
  world.addComponent(entity.id, new ProjectileComponent());
  return entity.id;
}
