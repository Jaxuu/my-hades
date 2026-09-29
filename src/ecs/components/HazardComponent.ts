/**
 * Delayed area-of-effect hazard (M8-T01).
 * See specs/14_aoe_and_run_lifecycle_spec.md §3.1 / §4.1 (AC-01).
 *
 * POD component: data only, no behaviour. The whole lifecycle — countdown and
 * detonation — lives in `HazardSystem`; the assembly lives in `spawnHazard`
 * below. That split is the same one `HitboxComponent` + `CombatActionSystem` /
 * `ProjectileComponent` + `spawnProjectile` already follow.
 *
 * WHAT A HAZARD IS, structurally. It is an entity owning exactly two components:
 *
 *   TransformComponent  -> where the telegraph sits (and where the blast lands)
 *   HazardComponent     -> how big, how hard, how long, and whose side it is on
 *
 * and NOTABLY NOT:
 *
 *   - **no `HitboxComponent`** during the telegraph. That is the whole point of
 *     AC-01: a warning must be incapable of dealing damage, and the cheapest way
 *     to guarantee that is to make it structurally impossible rather than to add
 *     a "don't damage yet" flag that every consumer must remember to check.
 *     `CollisionSystem`'s hitbox query is `(Transform, HitboxComponent)`, so a
 *     telegraph simply does not exist as far as hit resolution is concerned.
 *   - **no `HurtboxComponent`** — a telegraph is not a thing you can punch.
 *   - **no `FactionComponent`** — the faction rides on `HazardComponent.faction`
 *     instead, because `FactionComponent` is exactly what puts an entity into
 *     `CollisionSystem`'s TARGET set and into `AISystem`'s auto-acquire set. A
 *     warning must be invisible to both (spec 14 I2).
 *   - **no `VelocityComponent`** — `MovementSystem.resolveWalls` visits
 *     `(Transform, Velocity)` bodies, so a telegraph is never pushed by geometry.
 *     A warning is anchored to the ground it was planted on (spec 14 I3).
 *
 * WHY `totalDelayTicks` IS STORED rather than being the caller's business: the
 * presentation layer needs the telegraph's PROGRESS (`1 - delayTicks /
 * totalDelayTicks`) to animate the warning. Without it, the renderer would have
 * to remember each hazard's initial length itself — that is the render layer
 * holding logic state, which spec 09 AC-01 forbids. On the component, the
 * snapshot replays the animation exactly.
 *
 * `ownerEntityId` is carried for DIAGNOSTICS ONLY. It is deliberately NOT the
 * owner of the blast hitbox — see `HazardSystem.detonate` and spec 14 §4.1: a
 * bomb that has already been planted must still go off after the enemy that
 * planted it dies, and `CollisionSystem`'s owner gate would otherwise retire it.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';
import { Faction } from './FactionComponent';
import { TransformComponent } from './TransformComponent';

/**
 * Default blast radius, in world units.
 *
 * Deliberately LARGE — 2.5x a melee swing (`DEFAULT_ATTACK_HITBOX_RADIUS = 1`) —
 * because "get out of the circle" is the entire interaction. A radius the player
 * can simply walk past without changing what they were doing is not a hazard.
 */
export const DEFAULT_HAZARD_RADIUS = 2.5;

/**
 * Default blast damage. Above a melee swing (`10`) and above a wall-slam (`12`):
 * a delayed, telegraphed, fully avoidable attack is allowed to be the hardest
 * single hit in the game — that is what pays for the warning.
 */
export const DEFAULT_HAZARD_DAMAGE = 25;

/** Default telegraph length in ticks — 30 ticks @60fps = 0.5 s. */
export const DEFAULT_HAZARD_DELAY_TICKS = 30;

/**
 * Active window of the blast hitbox, in ticks.
 *
 * MUST be `1`. `HazardSystem` sits BEFORE `CollisionSystem` in the pipeline, so
 * the blast is collision-tested on the very tick it is spawned, and
 * `LifespanSystem` (which runs LAST) ages it at the end of that same tick. One
 * tick therefore yields exactly one collision test — the spec's "a hitbox that
 * lives for 1 tick". (Compare the Zeus bolt / Poseidon shockwave, which need `2`
 * precisely because `ModifierSystem` injects them AFTER `CollisionSystem`.)
 */
export const DEFAULT_HAZARD_BLAST_ACTIVE_TICKS = 1;

/**
 * Hitstop of the blast: `0`, i.e. none — the same correctness argument the cast
 * projectile records (spec 13 §3.3). `CollisionSystem` freezes BOTH sides of a
 * landed hit, and a hazard's author is by definition somewhere else on the
 * arena; a non-zero hitstop would freeze the thrower every time its own bomb
 * went off. Zero hitstop plus a non-zero knockback keeps the feedback gate OPEN,
 * so victims still stagger and get pushed.
 */
export const DEFAULT_HAZARD_BLAST_HITSTOP_TICKS = 0;

/**
 * Knockback of the blast, in world units per second. Being `> 0` is what opens
 * `CollisionSystem`'s feedback gate, which is how a victim enters `HITSTUN` and
 * therefore how the knockback displaces at all (spec 04 AC-03).
 */
export const DEFAULT_HAZARD_BLAST_KNOCKBACK = 10;

export class HazardComponent extends ComponentBase {
  /** Blast hitbox radius, in world units. Must be > 0. */
  public radius: number;

  /** Blast damage. Must be >= 0 and finite (`0` is a legal pure-displacement trap). */
  public damage: number;

  /**
   * REMAINING telegraph ticks. Decremented ONLY by `HazardSystem`, and only
   * while it is `> 0`. Read as "ticks of warning left"; `0` means "detonates on
   * this tick's update".
   */
  public delayTicks: number;

  /**
   * The telegraph length this hazard was planted with. IMMUTABLE for the
   * hazard's lifetime, and read ONLY by the presentation layer to compute the
   * warning's progress. Nothing in the logic layer reads it.
   */
  public totalDelayTicks: number;

  /** Faction of the BLAST (not of the telegraph — a telegraph has no side). */
  public faction: Faction;

  /**
   * The entity that planted this hazard. Diagnostics / audit only: it is NOT the
   * blast's `ownerEntityId` (see the class docstring).
   */
  public ownerEntityId: EntityId;

  constructor(
    radius = DEFAULT_HAZARD_RADIUS,
    damage = DEFAULT_HAZARD_DAMAGE,
    delayTicks = DEFAULT_HAZARD_DELAY_TICKS,
    totalDelayTicks = delayTicks,
    faction: Faction = Faction.Enemy,
    ownerEntityId: EntityId = -1,
  ) {
    super();
    this.radius = radius;
    this.damage = damage;
    this.delayTicks = delayTicks;
    this.totalDelayTicks = totalDelayTicks;
    this.faction = faction;
    this.ownerEntityId = ownerEntityId;
  }
}

/**
 * The spec of a hazard to plant.
 *
 * `delayTicks = 0` is legal: it is the `N = 0` limit of the "detonates on tick
 * `T + N`" rule, i.e. an instant ground explosion that blows on the very tick the
 * system first sees it. There is no "wait at least one tick" special case — the
 * arithmetic simply evaluates to "now".
 */
export interface HazardSpawnOptions {
  /** Telegraph origin X; also the blast centre X. */
  readonly x: number;
  /** Telegraph origin Y; also the blast centre Y. */
  readonly y: number;
  /** Blast radius; defaults to {@link DEFAULT_HAZARD_RADIUS}. Must be > 0. */
  readonly radius?: number;
  /** Blast damage; defaults to {@link DEFAULT_HAZARD_DAMAGE}. Must be >= 0. */
  readonly damage?: number;
  /** Telegraph length in ticks; defaults to {@link DEFAULT_HAZARD_DELAY_TICKS}. */
  readonly delayTicks?: number;
  /** Faction of the blast; defaults to `Faction.Enemy`. */
  readonly faction?: Faction;
  /** The planting entity, for audit; defaults to `-1` (nobody). */
  readonly ownerEntityId?: EntityId;
}

/** @throws RangeError if `value` is not a positive finite number. */
function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number, received: ${String(value)}`);
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

/**
 * Assemble a hazard telegraph entity owning exactly:
 * `TransformComponent` + `HazardComponent`.
 *
 * Validation lives at this seam (never inside the component) so a malformed
 * hazard can never reach the world: a non-positive radius would make the blast
 * overlap test degenerate, and a non-finite origin would poison every position
 * derived from it. Nothing is created before validation passes, so a rejected
 * hazard leaks no entity.
 *
 * @throws RangeError if `x` / `y` is not finite, or `radius` / `damage` /
 *   `delayTicks` fails its validation.
 */
export function spawnHazard(world: World, options: HazardSpawnOptions): EntityId {
  const radius = options.radius ?? DEFAULT_HAZARD_RADIUS;
  const damage = options.damage ?? DEFAULT_HAZARD_DAMAGE;
  const delayTicks = options.delayTicks ?? DEFAULT_HAZARD_DELAY_TICKS;

  if (!Number.isFinite(options.x)) {
    throw new RangeError(`hazard.x must be a finite number, received: ${String(options.x)}`);
  }
  if (!Number.isFinite(options.y)) {
    throw new RangeError(`hazard.y must be a finite number, received: ${String(options.y)}`);
  }
  assertPositiveFinite(radius, 'hazard.radius');
  assertNonNegativeFinite(damage, 'hazard.damage');
  assertNonNegativeInteger(delayTicks, 'hazard.delayTicks');

  const entity = world.createEntity();
  world.addComponent(entity.id, new TransformComponent(options.x, options.y, 0));
  world.addComponent(
    entity.id,
    new HazardComponent(
      radius,
      damage,
      delayTicks,
      delayTicks,
      options.faction ?? Faction.Enemy,
      options.ownerEntityId ?? -1,
    ),
  );
  return entity.id;
}

/**
 * Whether `id` is currently a hazard TELEGRAPH — i.e. carries a
 * `HazardComponent` with a non-zero remaining fuse.
 *
 * A read-side convenience for the presentation layer (a hazard whose fuse has
 * run out is destroyed on the same tick it detonates, so in practice this is
 * equivalent to "the entity exists"; the helper exists so the render layer never
 * has to encode that reasoning itself).
 */
export function isArmed(world: World, id: EntityId): boolean {
  const hazard = world.getComponent(id, HazardComponent);
  return hazard !== undefined && hazard.delayTicks > 0;
}
