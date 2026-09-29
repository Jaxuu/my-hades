/**
 * FreezeSystem — hitstop countdown + intent suppression.
 * See specs/04_combat_feedback_spec.md §4.2 / §5.1.
 *
 * Pipeline position: SECOND, right after PlayerControllerSystem and BEFORE every
 * "per-entity advance" system (Movement / Dash / State / CombatAction). That is
 * what makes a freeze granted at the end of tick `T` suppress the attacker's and
 * victim's advancement on ticks `T+1 .. T+N` — see the tick-exact contract in
 * spec 04 §6.
 *
 * Each tick, for every entity carrying a `FreezeComponent` with `remainingTicks >
 * 0`, the counter is decremented by one. If the entity is STILL frozen after the
 * decrement (i.e. every consumer, which runs after us and tests `isFrozen > 0`,
 * will skip it this tick), its `IntentComponent` (if any) is zeroed. Clearing the
 * intent is essential: a pulse (`wantsToDash` / `wantsToAttack`) that the frozen
 * consumer never got to clear would otherwise fire the moment the freeze lapses —
 * a "buffered input" that the frozen entity must NOT receive.
 *
 * NOTE the clear-condition is deliberately the POST-decrement value, matching the
 * consumers exactly. Clearing on the pre-decrement value instead would zero the
 * intent on the RECOVERY tick too, when the entity is no longer skipped — the
 * entity would then resume with a blank intent (spec 04 §4.2 / §6).
 *
 * The component is deliberately NOT removed when the counter reaches zero: a
 * stable `remainingTicks = 0` keeps the snapshot shape identical before and after
 * a freeze, avoiding snapshot churn (spec 04 §4.2).
 *
 * DEAD entities are skipped (M4-T02, spec 08 §4.2), so a corpse's counter stops
 * where it stood instead of draining to zero. That is safe by construction: every
 * consumer of `isFrozen` also skips dead entities, so the value is never read
 * again — it is simply held stable rather than churned. This system is a pure
 * countdown with no gameplay decision of its own, which is why the gate is a
 * tidiness rule here and a correctness rule everywhere else.
 *
 * Holds NO cross-tick hidden state: the whole countdown lives on the component.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import { vec2 } from '../../core/math';
import { FreezeComponent } from '../components/FreezeComponent';
import { IntentComponent } from '../components/IntentComponent';
import { isDead } from '../components/DeadTagComponent';

export class FreezeSystem implements System {
  public readonly name = 'FreezeSystem';

  public update(world: World, _ctx: SystemContext): void {
    for (const id of world.query(FreezeComponent)) {
      // A corpse's freeze is left where it stopped (spec 08 §4.2).
      if (isDead(world, id)) continue;

      const freeze = world.getComponent(id, FreezeComponent);
      if (freeze === undefined) continue;
      if (freeze.remainingTicks <= 0) continue;

      freeze.remainingTicks -= 1;

      // Still frozen after the decrement => the consumers will skip this tick, so
      // clear the intent here (they never reach their own read-and-clear).
      if (freeze.remainingTicks > 0) {
        const intent = world.getComponent(id, IntentComponent);
        if (intent !== undefined) {
          intent.moveVector = vec2(0, 0);
          intent.wantsToDash = false;
          intent.wantsToAttack = false;
        }
      }
    }
  }
}
