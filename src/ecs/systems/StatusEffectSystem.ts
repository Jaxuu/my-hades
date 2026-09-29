/**
 * StatusEffectSystem — the damage-over-time clock.
 * See specs/06_status_effect_and_dot_spec.md §4.2 / §4.3.
 *
 * Pipeline position: IMMEDIATELY AFTER CollisionSystem and BEFORE ModifierSystem.
 * That placement is not cosmetic — it is what makes the DoT timing contract exact:
 *
 *  - A status is applied by a modifier handler, i.e. inside ModifierSystem. Running
 *    BEFORE ModifierSystem means the status applied on tick `T` is first counted on
 *    tick `T+1`, so the observable contract reads exactly as written: the first
 *    damage tick lands on `T + intervalTicks`, and the status is cleared at the end
 *    of `T + durationTicks`. Had this system run AFTER ModifierSystem, the
 *    application tick would itself be counted and every number in the spec would
 *    silently be one tick short (spec 06 §4.2, the "1 Tick phase" trap).
 *  - It stays after CollisionSystem so the base hit that applies the status has
 *    already been resolved (damage + feedback) when the first DoT tick is computed.
 *  - It does not disturb the M1/M2 six-segment relative order, and LifespanSystem
 *    stays LAST (spec 05 C7).
 *
 * What a damage tick IS (spec 06 AC-03): the hp of the victim is decremented
 * DIRECTLY. No hitbox entity is created, no `HitEvent` is published, no hitstop,
 * no HITSTUN, no knockback. A DoT is "true damage": it must not stun-lock the victim
 * or extend the freeze of the hit that poisoned it, and it must not be able to
 * re-enter the modifier pipeline (there is nothing to re-enter it).
 *
 * Freeze does NOT pause a DoT: hitstop suppresses ACTIONS (movement / dash / state /
 * attack), whereas a status is a persistent world fact. Letting a 4-tick hitstop
 * re-phase every poison counter would also make the timing depend on unrelated
 * combat events (spec 06 §10 trade-off 2).
 *
 * Holds NO cross-tick hidden state: both counters (`remainingTicks`,
 * `ticksUntilProc`) live on the component (spec 00 §6.1).
 *
 * DEAD entities are skipped (M4-T02, spec 08 §4.2): a corpse stops taking damage
 * over time. Note this is a SEMANTIC choice, not a numerical one — `applyDamage`
 * clamps at `0`, so letting a corpse's poison tick would change no hit points. It
 * is skipped because "death ends every ongoing process" is the contract the rest of
 * the engine implements, and a status clock still running on a body is the one
 * place that contract would visibly leak (spec 08 §8).
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { StatusEffect } from '../components/StatusEffectComponent';
import { StatusEffectComponent } from '../components/StatusEffectComponent';
import { applyDamage } from '../components/HealthComponent';
import { isDead } from '../components/DeadTagComponent';

export class StatusEffectSystem implements System {
  public readonly name = 'StatusEffectSystem';

  public update(world: World, _ctx: SystemContext): void {
    // `query` returns a fresh ascending array, so rebuilding each entity's effect
    // list while we iterate is safe and stays deterministic.
    for (const id of world.query(StatusEffectComponent)) {
      // A corpse's status clocks are stopped, not run out (spec 08 §4.2).
      if (isDead(world, id)) continue;

      const component = world.getComponent(id, StatusEffectComponent);
      if (component === undefined) continue;

      const survivors: StatusEffect[] = [];
      for (const effect of component.effects) {
        effect.remainingTicks -= 1;
        effect.ticksUntilProc -= 1;

        // Damage tick. Checked BEFORE the expiry test so a status whose duration is
        // an exact multiple of its interval still gets its final tick: the last one
        // lands on the very tick the status runs out (spec 06 §4.2).
        if (effect.ticksUntilProc <= 0) {
          applyDamage(world, id, effect.damagePerStack * effect.stacks);
          effect.ticksUntilProc = effect.intervalTicks;
        }

        if (effect.remainingTicks > 0) survivors.push(effect);
      }
      component.effects = survivors;
    }
  }
}
