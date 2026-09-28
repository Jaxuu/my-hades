/**
 * Hit-point pool. See specs/03_combat_hitbox_spec.md §3.1.
 *
 * POD component: data only, no behaviour. Damage is applied by free functions
 * (`applyDamage`), so the "components carry no behaviour" contract
 * (specs/00_harness_spec.md §6.1) stays intact.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';

/** Default hit-point pool for a freshly spawned combatant. */
export const DEFAULT_MAX_HP = 100;

export class HealthComponent extends ComponentBase {
  /** Current hit points. Never negative once damage goes through `applyDamage`. */
  public hp: number;

  /** Hit-point ceiling. Damage never raises `hp` above it. */
  public maxHp: number;

  constructor(hp = DEFAULT_MAX_HP, maxHp = DEFAULT_MAX_HP) {
    super();
    this.hp = hp;
    this.maxHp = maxHp;
  }
}

/**
 * Subtract `amount` from the entity's `hp`, clamped at `0`.
 *
 * Free function (not a component method, spec 00 §6.1). No-op when the entity has
 * no `HealthComponent`, so callers do not need to pre-check. Pure arithmetic —
 * no wall clock, no randomness, fully deterministic.
 */
export function applyDamage(world: World, id: EntityId, amount: number): void {
  const health = world.getComponent(id, HealthComponent);
  if (health === undefined) return;
  health.hp = Math.max(0, health.hp - amount);
}

/**
 * Whether the entity is still alive. An entity without a `HealthComponent` is
 * considered alive (health is opt-in, not a universal trait).
 */
export function isAlive(world: World, id: EntityId): boolean {
  const health = world.getComponent(id, HealthComponent);
  return health === undefined || health.hp > 0;
}
