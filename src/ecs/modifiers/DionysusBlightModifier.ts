/**
 * Dionysus Blight — the first STATUS-APPLYING modifier.
 * See specs/06_status_effect_and_dot_spec.md §3.3 / §4.1 (AC-02).
 *
 * Where Zeus Strike injects an entity (a hitbox), Dionysus Blight injects a
 * COMPONENT STATE: it stamps a `poison` status onto the victim and then forgets
 * about it. Every subsequent damage tick is produced by `StatusEffectSystem`, with
 * no further involvement from this handler — which is exactly what makes the DoT
 * survive hitstop, outlive the attack that caused it, and need no cross-tick state
 * on the modifier itself (spec 00 §6.1).
 *
 * Because the status carries its own timers, this handler is idempotent per hit:
 * re-applying only stacks and refreshes, never duplicates (spec 06 §4.1).
 */

import type { HitEvent } from '../events';
import type { IModifierHandler, ModifierContext } from './ModifierRegistry';
import { DIONYSUS_BLIGHT_MODIFIER } from '../components/ModifierComponent';
import { POISON_STATUS_SPEC, applyStatusEffect } from '../components/StatusEffectComponent';

/**
 * Poison the victim on every landed base attack.
 *
 * The target may legitimately be gone (destroyed earlier this tick), which is why
 * `applyStatusEffect` guards on `isAlive` rather than this handler checking twice.
 */
export class DionysusBlightModifier implements IModifierHandler {
  public readonly id = DIONYSUS_BLIGHT_MODIFIER;

  public onHit(event: HitEvent, context: ModifierContext): void {
    applyStatusEffect(context.world, event.targetId, POISON_STATUS_SPEC);
  }
}
