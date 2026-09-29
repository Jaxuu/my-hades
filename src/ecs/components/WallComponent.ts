/**
 * Static arena geometry: an axis-aligned wall. See
 * specs/13_arena_and_projectiles_spec.md §3.2 (M7-T01 AC-01 / AC-02).
 *
 * POD component: data only, no behaviour. The AABB (`x` / `y` / `width` / `height`)
 * IS the wall's geometry — there is deliberately no `TransformComponent`, which
 * expresses structurally that a wall is not something that moves: it is invisible
 * to `MovementSystem`'s integration branches and to `TransformSnapshotSystem`, and
 * the only thing that ever reads it is the static-geometry resolution pass.
 *
 * `width` / `height` are the box EXTENT (always positive), so the four edges are
 * `left = x`, `top = y`, `right = x + width`, `bottom = y + height`. That is the
 * same parameterisation {@link resolveCircleAABB} consumes, so a wall can be handed
 * to the solver verbatim with no conversion — and therefore no chance of the two
 * disagreeing about which corner `(x, y)` means.
 *
 * The mutation/assembly helpers below are FREE FUNCTIONS (not component methods),
 * so the "components carry no behaviour" contract (specs/00_harness_spec.md §6.1)
 * stays intact — the same shape `ArmorComponent` + `applyDamageWithArmor` follow.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';
import { HitboxComponent } from './HitboxComponent';
import { HurtboxComponent } from './HurtboxComponent';

/**
 * Damage dealt by a WALL-SLAM: an entity that is knocked back into a wall takes
 * this on top of whatever the hit that launched it already dealt (spec 13 AC-02).
 *
 * Deliberately larger than a melee swing (`DEFAULT_ATTACK_DAMAGE = 10`): the wall
 * is meant to be a WEAPON, so "shove the elite into the wall" must out-damage
 * "hit it once". It is a constant rather than a function of the impact speed so the
 * tick-by-tick assertions stay exact and the mechanic stays readable.
 */
export const DEFAULT_WALL_SLAM_DAMAGE = 12;

export class WallComponent extends ComponentBase {
  /** AABB left edge (world X of the top-left corner). */
  public x: number;

  /** AABB top edge (world Y of the top-left corner). */
  public y: number;

  /** AABB width (extent along +x). Must be > 0. */
  public width: number;

  /** AABB height (extent along +y). Must be > 0. */
  public height: number;

  constructor(x = 0, y = 0, width = 1, height = 1) {
    super();
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
}

/** The spec of a wall to spawn. */
export interface WallSpawnOptions {
  /** AABB left edge. */
  readonly x: number;
  /** AABB top edge. */
  readonly y: number;
  /** AABB width. Must be a positive finite number. */
  readonly width: number;
  /** AABB height. Must be a positive finite number. */
  readonly height: number;
}

/** @throws RangeError if `value` is not a finite number. */
function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number, received: ${String(value)}`);
  }
}

/**
 * Spawn a static wall entity carrying a `WallComponent`.
 *
 * Validation lives at this seam rather than inside the component, so a wall can
 * never reach the world in a shape the solver cannot reason about: a zero or
 * negative extent would make `resolveCircleAABB`'s clamp degenerate, and a
 * non-finite origin would poison every subsequent position it touched.
 *
 * @throws RangeError if `x` / `y` is not finite, or `width` / `height` is not a
 *   positive finite number.
 */
export function createWall(world: World, options: WallSpawnOptions): EntityId {
  assertFinite(options.x, 'wall.x');
  assertFinite(options.y, 'wall.y');
  if (!Number.isFinite(options.width) || options.width <= 0) {
    throw new RangeError(
      `wall.width must be a positive finite number, received: ${String(options.width)}`,
    );
  }
  if (!Number.isFinite(options.height) || options.height <= 0) {
    throw new RangeError(
      `wall.height must be a positive finite number, received: ${String(options.height)}`,
    );
  }

  const entity = world.createEntity();
  world.addComponent(
    entity.id,
    new WallComponent(options.x, options.y, options.width, options.height),
  );
  return entity.id;
}

/**
 * The radius a dynamic entity presents to static geometry — i.e. "how big is this
 * thing's body".
 *
 * Preference order is deliberate: `HurtboxComponent` first, because a combatant's
 * BODY is what should stop at a wall (its hurtbox is the body's volume). A
 * projectile owns no hurtbox, so it falls through to `HitboxComponent.radius` —
 * its damage circle IS its body. An entity with neither is not a circle body at
 * all, and `undefined` is the honest answer: it is what keeps the wall pass from
 * inventing a collision shape for, say, a bare bookkeeping entity.
 */
export function circleBodyRadius(world: World, id: EntityId): number | undefined {
  const hurtbox = world.getComponent(id, HurtboxComponent);
  if (hurtbox !== undefined) return hurtbox.radius;

  const hitbox = world.getComponent(id, HitboxComponent);
  if (hitbox !== undefined) return hitbox.radius;

  return undefined;
}
