/**
 * Armor / super-armor pool. See specs/12_armor_and_dash_boons_spec.md §3.1 / AC-01
 * and AC-02.
 *
 * POD component: data only, no behaviour. Damage routing lives in the free
 * function {@link applyDamageWithArmor}, so the "components carry no behaviour"
 * contract (specs/00_harness_spec.md §6.1) stays intact — the same shape
 * `HealthComponent` + `applyDamage` already follow.
 *
 * SEMANTICS — armor is a SECOND, DEPLETABLE damage ledger IN FRONT of HP, plus one
 * extra rule that HP does not have: while it stands, the entity cannot be
 * staggered.
 *
 *  - A hit drains `current` FIRST; only the overflow (the "spill") reaches HP
 *    (spec 12 AC-02).
 *  - While `current > 0` the entity is IMMUNE to `HITSTUN` and to knockback: it
 *    takes the damage (and the hitstop, which armor NEVER blocks — spec 12 AC-01)
 *    but keeps its action state and its plan. That is the "super armor" contract,
 *    and it is what gives an enemy's windup weight.
 *  - The hit that takes `current` to `0` BREAKS the armor: that very hit staggers
 *    normally, and every later hit behaves as if no armor existed.
 *
 * There is no regeneration and no reset in this milestone: `current` only ever
 * decreases, so `current === 0` is a permanent "broken" state AND a stable resting
 * value — the component is deliberately never removed, the same stable-shape rule
 * `FreezeComponent` / `TagComponent` follow (snapshot churn avoidance).
 *
 * `max` is carried for PRESENTATION (an armor bar) and for the snapshot only;
 * nothing in the logic layer reads it.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';
import { applyDamage } from './HealthComponent';

/** Default armor pool for a freshly spawned armored entity. */
export const DEFAULT_ARMOR = 50;

export class ArmorComponent extends ComponentBase {
  /** Remaining armor. Never negative once damage goes through `applyDamageWithArmor`. */
  public current: number;

  /** Armor ceiling. Read by presentation / snapshot only. */
  public max: number;

  constructor(current = DEFAULT_ARMOR, max = DEFAULT_ARMOR) {
    super();
    this.current = current;
    this.max = max;
  }
}

/** The outcome of resolving ONE hit against an entity's armor. */
export interface ArmorDamageResult {
  /** Damage soaked by armor; `0` when the entity has no standing armor. */
  readonly absorbed: number;
  /** Damage that reached HP. `absorbed + spill === amount` ALWAYS (spec 12 I1). */
  readonly spill: number;
  /**
   * True when armor was STANDING before this hit AND SURVIVED it — i.e. the target
   * shrugs the hit off. `CollisionSystem` MUST suppress `HITSTUN` and knockback
   * when this is true, and MUST NOT suppress hitstop (spec 12 AC-01 / I3).
   *
   * Computed from the POST-hit value, which is what makes the BREAKING hit
   * (`current` reaching `0`) stagger normally (spec 12 AC-02).
   */
  readonly armoredThrough: boolean;
}

/**
 * Resolve `amount` damage against `id`, routing it through its armor first.
 *
 * The single damage entry point for a HITBOX settlement — `CollisionSystem` calls
 * this instead of `applyDamage` so that "armor first, overflow to HP" is expressed
 * in exactly one place. Three paths, and the difference between them is the whole
 * contract (spec 12 §3.1):
 *
 *  - NO armor component, or armor already broken (`current <= 0`): a plain HP hit.
 *    This is the pre-M6 behaviour, bit for bit (spec 12 I4).
 *  - Standing armor: absorb `min(current, amount)`, then spill the REST to HP.
 *    `armoredThrough` is then `current > 0` — false exactly when this hit broke it.
 *
 * Damage is CONSERVED: `absorbed + spill === amount` holds for every path, so no
 * hit can ever be silently swallowed by the shield (spec 12 AC-02).
 *
 * No-op-ish on an entity without `HealthComponent`: the armor still drains, and
 * `applyDamage` quietly does nothing — the same opt-in shape every component
 * consumer follows.
 *
 * Pure arithmetic — no wall clock, no randomness, fully deterministic.
 */
export function applyDamageWithArmor(
  world: World,
  id: EntityId,
  amount: number,
): ArmorDamageResult {
  const armor = world.getComponent(id, ArmorComponent);
  const armorBefore = armor === undefined ? 0 : armor.current;

  // No armor to route through: identical to the pre-M6 settlement.
  if (armor === undefined || armorBefore <= 0) {
    applyDamage(world, id, amount);
    return { absorbed: 0, spill: amount, armoredThrough: false };
  }

  const absorbed = Math.min(armorBefore, amount);
  armor.current = armorBefore - absorbed;
  const spill = amount - absorbed;
  applyDamage(world, id, spill);

  // POST-hit value: the hit that zeroes the armor is the hit that breaks it, and
  // it must NOT be treated as armored-through (spec 12 AC-02).
  return { absorbed, spill, armoredThrough: armor.current > 0 };
}

/**
 * Whether the entity currently has STANDING armor (component present and
 * `current > 0`). A missing component counts as `false`.
 */
export function isArmored(world: World, id: EntityId): boolean {
  const armor = world.getComponent(id, ArmorComponent);
  return armor !== undefined && armor.current > 0;
}
