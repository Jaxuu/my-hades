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

export class HitboxComponent extends ComponentBase {
  /** Hit radius in world units. Overlap requires `dist < radius + hurtbox.radius`. */
  public radius: number;

  /** Damage applied on a successful hit. */
  public damage: number;

  /** Remaining lifespan in ticks; LifespanSystem destroys the entity at `<= 0`. */
  public activeTicks: number;

  /** Faction of the attacker; only entities of a DIFFERENT faction can be hit. */
  public faction: Faction;

  /** Ids already struck by this hitbox, kept ascending for determinism. */
  public hitEntities: EntityId[];

  constructor(
    radius: number,
    damage: number,
    activeTicks: number,
    faction: Faction,
    hitEntities: EntityId[] = [],
  ) {
    super();
    this.radius = radius;
    this.damage = damage;
    this.activeTicks = activeTicks;
    this.faction = faction;
    this.hitEntities = hitEntities;
  }
}
