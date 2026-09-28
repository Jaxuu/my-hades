/**
 * Damage-dealing circle + lifespan + hit ledger. See specs/03_combat_hitbox_spec.md §3.4.
 *
 * POD component: data only, no behaviour. A hitbox is an INDEPENDENT entity — it
 * owns its own `TransformComponent` and does not follow the attacker, so an attack
 * is a fixed circle in world space that lives for `activeTicks` ticks.
 *
 * `hitEntities` is the multi-hit guard (AC-03): an entity that has already been
 * struck by THIS hitbox is skipped, so a single swing deals damage at most once
 * per target even though the circle overlaps it for many consecutive ticks.
 *
 * `faction` is the ATTACKER's faction, snapshotted at spawn time. It is stored on
 * the hitbox (rather than looked up through the attacker each tick) so the hitbox
 * keeps working even if the attacker is destroyed mid-swing, and so hit resolution
 * never depends on the attacker still being alive.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import { Faction } from './FactionComponent';

/** Default radius of a melee attack hitbox, in world units. */
export const DEFAULT_ATTACK_HITBOX_RADIUS = 1;

/** Default damage dealt by one melee attack. */
export const DEFAULT_ATTACK_DAMAGE = 10;

/**
 * Default active window of an attack hitbox, in ticks (15 ticks @60fps = 0.25 s).
 * The window is what makes an attack forgiving: the circle is re-tested against
 * every hostile hurtbox for each of these ticks, so a target that dashes INTO the
 * swing is still hit.
 */
export const DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS = 15;

/** Default forward offset from the attacker's origin to the hitbox centre. */
export const DEFAULT_ATTACK_HITBOX_OFFSET = 0.75;

/**
 * Default hitstop (freeze) length, in ticks, applied to BOTH the attacker and the
 * victim on a successful hit (4 ticks @60fps ≈ 0.067 s). See
 * specs/04_combat_feedback_spec.md AC-01.
 */
export const DEFAULT_HITSTOP_TICKS = 4;

/**
 * Default knockback speed, in world units per second, applied to the victim along
 * the hit direction during HITSTUN. See specs/04_combat_feedback_spec.md AC-03.
 */
export const DEFAULT_KNOCKBACK_FORCE = 12;

export class HitboxComponent extends ComponentBase {
  /** Hit radius in world units. Overlap requires `dist < radius + hurtbox.radius`. */
  public radius: number;

  /** Damage applied on a successful hit. */
  public damage: number;

  /** Remaining lifespan in ticks; LifespanSystem destroys the entity at `<= 0`. */
  public activeTicks: number;

  /** Faction of the attacker; only entities of a DIFFERENT faction can be hit. */
  public faction: Faction;

  /**
   * Id of the attacking entity, snapshotted at spawn time (M2-T02). The hitbox is
   * an INDEPENDENT entity that does not follow the attacker, so hitstop cannot be
   * written back through the transform chain — the owner id is how CollisionSystem
   * finds the attacker to freeze it. May refer to a since-destroyed entity, so
   * callers MUST guard with `world.isAlive(...)` before using it.
   */
  public ownerEntityId: EntityId;

  /** Ticks of hitstop applied to both sides on a successful hit (spec 04 AC-01). */
  public hitstopTicks: number;

  /** Knockback speed (world units/s) applied to the victim (spec 04 AC-03). */
  public knockbackForce: number;

  /** Ids already struck by this hitbox, kept ascending for determinism. */
  public hitEntities: EntityId[];

  /**
   * Provenance of this hitbox (M3-T01). `null` means a base attack; a non-null
   * value is the id of the MODIFIER that injected it (e.g. `'zeus_strike'`).
   *
   * Its ONLY purpose is anti-recursion: CollisionSystem copies it verbatim into
   * the `HitEvent`, and ModifierSystem refuses to dispatch modifiers for a hit
   * whose `sourceModifier` is non-null. Without it, a modifier-injected hitbox
   * that itself lands a hit would re-trigger the modifier that created it,
   * nesting without bound (spec 05 AC-04 / §4.5).
   *
   * Deliberately NOT overloaded with "this hit is pure damage" semantics —
   * feedback is expressed by `hitstopTicks` / `knockbackForce` (spec 05 §3.4).
   */
  public sourceModifier: string | null;

  constructor(
    radius: number,
    damage: number,
    activeTicks: number,
    faction: Faction,
    ownerEntityId: EntityId,
    hitstopTicks = DEFAULT_HITSTOP_TICKS,
    knockbackForce = DEFAULT_KNOCKBACK_FORCE,
    hitEntities: EntityId[] = [],
    sourceModifier: string | null = null,
  ) {
    super();
    this.radius = radius;
    this.damage = damage;
    this.activeTicks = activeTicks;
    this.faction = faction;
    this.ownerEntityId = ownerEntityId;
    this.hitstopTicks = hitstopTicks;
    this.knockbackForce = knockbackForce;
    this.hitEntities = hitEntities;
    this.sourceModifier = sourceModifier;
  }
}
