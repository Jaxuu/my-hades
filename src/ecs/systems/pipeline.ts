/**
 * Canonical per-tick system pipeline.
 * See specs/02_dash_and_state_spec.md §5.1, specs/03_combat_hitbox_spec.md §5.4,
 * specs/04_combat_feedback_spec.md §5.2, specs/05_boon_modifier_spec.md §5.2,
 * specs/07_enemy_ai_spec.md §5.2 and specs/08_encounter_and_death_spec.md §5.2.
 *
 * Order (HARD CONTRACT):
 *   PlayerControllerSystem -> FreezeSystem -> AISystem -> MovementSystem -> DashSystem
 *     -> StateSystem -> CombatActionSystem -> CollisionSystem -> StatusEffectSystem
 *     -> ModifierSystem -> DeathSystem -> EncounterSystem -> LifespanSystem.
 *
 * Why this exact order:
 *  0. PlayerControllerSystem is the new FIRST segment (M2-T02): it replaces the old
 *     MovementSystem.bindInput phase and is the hardware -> intent seam. Running it
 *     first means every later system reads a fully-populated `IntentComponent` for
 *     this tick. FreezeSystem follows immediately so a freeze is applied before ANY
 *     "per-entity advance" system, letting hitstop suppress the whole tick.
 *     The relative order of the M1/M2 six segments (Movement .. Lifespan) is
 *     UNCHANGED and MUST NOT be reordered.
 *  0b. AISystem is the M4-T01 INSERTION — the enemy half of the intent-generation
 *     prologue (PlayerControllerSystem handles the player's hardware -> intent).
 *     It sits AFTER FreezeSystem and BEFORE every advance system, and that exact
 *     slot is the freeze-phase contract (spec 07 §5.2 rule 2): FreezeSystem
 *     decrements `remainingTicks` first, and everything after it decides "am I
 *     frozen this tick?" from the POST-decrement value. AISystem must see the same
 *     verdict as the action systems it feeds, or an enemy would come out of hitstop
 *     one tick later than the player. It changes no existing system's relative
 *     position and LifespanSystem stays LAST.
 *  1. MovementSystem integrates position against the state decided on the PREVIOUS
 *     tick. Running it before the dash/state systems means a dash started this tick
 *     begins displacing on the next tick, giving exactly 15 movement ticks for a
 *     15-tick dash and making the 15-tick total displacement contract (spec 02 §6)
 *     hold.
 *  2. DashSystem then applies this tick's dash entry / direction lock / i-frame
 *     tag, and ticks the cooldown. It must run AFTER movement (so it cannot
 *     retro-actively move this tick) and BEFORE the state machine.
 *  3. StateSystem runs after those two so it advances `ticksInState` only after the
 *     dash decision is in place — this is what aligns the invulnerability span with
 *     the leading ticks of the dash and lets the dash exit exactly on tick 15.
 *     The first three gameplay systems (Movement/Dash/State) are the M1 hard
 *     contract and MUST NOT be reordered.
 *  4. CombatActionSystem runs after the state machine so this tick's action state is
 *     already settled when the attack gate is evaluated, and before collision so a
 *     hitbox spawned this tick can already connect this tick.
 *  5. CollisionSystem runs after the hitboxes for this tick exist. It therefore sees
 *     the i-frame tag exactly as DashSystem left it this tick, which is what makes
 *     the invulnerability-consumption contract (spec 03 §4.4) tick-exact. It is also
 *     the hit-feedback write point (hitstop, HITSTUN, knockback) AND, as of M3-T01,
 *     the hit-EVENT publish point: every landed hit emits a `HitEvent` on the shared
 *     bus. Feedback and events are both written at the END of the tick, so feedback
 *     takes effect from the NEXT tick.
 *  6. StatusEffectSystem is the M3-T02 INSERTION — it sits between CollisionSystem and
 *     ModifierSystem, and that exact slot is what makes the damage-over-time timing
 *     contract read as written: a status applied by a modifier on tick `T` is first
 *     counted on `T+1`, so the first damage tick lands on `T + intervalTicks` and the
 *     status clears at the end of `T + durationTicks` (spec 06 §4.2). It runs after
 *     CollisionSystem so the hit that applies the status is already fully resolved. It
 *     changes no existing system's relative position, and LifespanSystem stays LAST.
 *  7. ModifierSystem is the M3-T01 INSERTION — it must sit after CollisionSystem (to
 *     read this tick's events) and before LifespanSystem (an injected hitbox must not
 *     be aged before it has ever been collision-tested, which is why a Zeus bolt has
 *     `activeTicks = 2` for exactly one test tick — spec 05 §4.4). It deliberately
 *     does NOT reorder anything: the six M1/M2 segments keep their relative order and
 *     LifespanSystem stays LAST.
 *  8. LifespanSystem runs LAST so it cannot destroy a hitbox before that hitbox has
 *     been collision-tested this tick — a hitbox gets its full `activeTicks` span.
 *  9. DeathSystem is the M4-T02 INSERTION. It sits after EVERY damage source
 *     (CollisionSystem and StatusEffectSystem are both upstream) and after
 *     ModifierSystem, so the tick has fully played out before the dead are counted:
 *     `hp` is final, boons have already reacted to the hits that landed, and a hit
 *     landed on the tick its owner dies still counts. It sits BEFORE LifespanSystem
 *     because LifespanSystem must stay LAST — running after it would let a hitbox be
 *     destroyed before it had ever been collision-tested, silently shortening every
 *     `activeTicks` window by one tick. It changes no existing system's relative
 *     position.
 * 10. EncounterSystem is the second M4-T02 INSERTION, and it must come AFTER
 *     DeathSystem: its whole input is the death tag (`DeadTagComponent` is written at
 *     the end of the tick by DeathSystem), so running earlier would delay every wave
 *     transition by one tick and make `delayTicks` read one tick short. It must also
 *     come before LifespanSystem, which stays LAST. Consequence, documented rather
 *     than accidental: a wave spawned on tick `T` first ACTS on `T+1`, because every
 *     per-entity system has already run this tick (spec 08 §6.2).
 *
 * Reordering any of these systems changes observable behaviour and will break the
 * QA tick-by-tick timing assertions (spec 02 §6, spec 03 §6, spec 04 §6, spec 05 §6,
 * spec 07 §6, spec 08 §6).
 */

import type { System } from '../System';
import { EventQueue } from '../events';
import type { EntityDeathEvent } from '../events';
import { PlayerControllerSystem } from './PlayerControllerSystem';
import { FreezeSystem } from './FreezeSystem';
import { AISystem } from './AISystem';
import { MovementSystem } from './MovementSystem';
import { DashSystem } from './DashSystem';
import { StateSystem } from './StateSystem';
import { CombatActionSystem } from './CombatActionSystem';
import { CollisionSystem } from './CollisionSystem';
import { StatusEffectSystem } from './StatusEffectSystem';
import { ModifierSystem } from './ModifierSystem';
import { DeathSystem } from './DeathSystem';
import { EncounterSystem } from './EncounterSystem';
import { LifespanSystem } from './LifespanSystem';

/**
 * Fresh instances of the canonical pipeline, in execution order.
 *
 * @param events Event bus shared by CollisionSystem (producer) and ModifierSystem
 *   (consumer). Defaults to a private queue, so existing `createDefaultSystems()`
 *   callers are unaffected; tests may inject their own queue to observe the bus
 *   (spec 05 §6.5). A fresh queue per call means two simulators can never share
 *   events, which is what keeps replay deterministic (spec 05 §5.3).
 * @param deathEvents Death bus owned by DeathSystem (producer; no mandatory
 *   consumer, so DeathSystem CLEARS it at the start of every tick and its post-step
 *   content is exactly "the deaths of the tick just processed"). Defaults to a
 *   private queue, so callers that do not care about deaths need no change; tests
 *   inject one to observe `EntityDeathEvent` (spec 08 §6.1).
 */
export function createDefaultSystems(
  events: EventQueue = new EventQueue(),
  deathEvents: EventQueue<EntityDeathEvent> = new EventQueue<EntityDeathEvent>(),
): readonly System[] {
  return [
    new PlayerControllerSystem(),
    new FreezeSystem(),
    new AISystem(),
    new MovementSystem(),
    new DashSystem(),
    new StateSystem(),
    new CombatActionSystem(),
    new CollisionSystem(events),
    new StatusEffectSystem(),
    new ModifierSystem(events),
    new DeathSystem(deathEvents),
    new EncounterSystem(),
    new LifespanSystem(),
  ];
}
