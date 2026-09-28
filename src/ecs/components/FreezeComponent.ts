/**
 * Hitstop freeze counter. See specs/04_combat_feedback_spec.md §3.2 / §4.2.
 *
 * POD component: data only, no behaviour. The mutation helpers below are FREE
 * FUNCTIONS (not component methods), so the "components carry no behaviour"
 * contract (specs/00_harness_spec.md §6.1) stays intact.
 *
 * When an attack connects, BOTH the attacker and the victim are frozen for
 * `hitstopTicks` ticks (the "hitstop" / "hit-freeze" juice of an action game).
 * FreezeSystem decrements `remainingTicks`; the movement / dash / state / combat
 * systems skip any entity whose freeze is still active.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';
import type { World } from '../World';

export class FreezeComponent extends ComponentBase {
  /** Remaining frozen ticks. `0` means "not frozen" (the stable resting value). */
  public remainingTicks: number;

  constructor(remainingTicks = 0) {
    super();
    this.remainingTicks = remainingTicks;
  }
}

/**
 * Whether the entity is currently frozen.
 *
 * A missing `FreezeComponent` counts as "not frozen". An entity that HAS the
 * component but with `remainingTicks <= 0` is likewise not frozen — the component
 * is deliberately NOT removed when it reaches zero, so the snapshot shape stays
 * stable across ticks (spec 04 §4.2).
 */
export function isFrozen(world: World, id: EntityId): boolean {
  const freeze = world.getComponent(id, FreezeComponent);
  return freeze !== undefined && freeze.remainingTicks > 0;
}

/**
 * Freeze the entity for `ticks` ticks, mounting a `FreezeComponent` lazily if the
 * entity has none yet.
 *
 * Tick-exact contract (spec 04 §6): a hit on tick `T` arms the freeze at the END
 * of `T`; FreezeSystem consumes one tick at the START of every frozen tick and the
 * consumers (Movement / Dash / State / CombatAction) all run AFTER it. Arming the
 * counter one tick high therefore yields exactly `ticks` OBSERVABLY frozen ticks,
 * covering `T+1 .. T+ticks` (the hit tick `T` is not itself frozen), with recovery
 * on `T+ticks+1`.
 *
 * Idempotent under repeated hits: `remainingTicks = max(remainingTicks, ticks + 1)`.
 * A later hit therefore never SHORTENS an in-flight freeze — hitstop can only be
 * extended, which is what stops a fast multi-hit from cutting a freeze short.
 *
 * `ticks <= 0` is a no-op (it must not create a component just to store zero).
 */
export function applyFreeze(world: World, id: EntityId, ticks: number): void {
  if (ticks <= 0) return;
  const armed = ticks + 1;
  let freeze = world.getComponent(id, FreezeComponent);
  if (freeze === undefined) {
    freeze = new FreezeComponent(armed);
    world.addComponent(id, freeze);
    return;
  }
  freeze.remainingTicks = Math.max(freeze.remainingTicks, armed);
}
