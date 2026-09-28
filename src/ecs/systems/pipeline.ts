/**
 * Canonical per-tick system pipeline.
 * See specs/02_dash_and_state_spec.md §5.1, specs/03_combat_hitbox_spec.md §5.4 and
 * specs/04_combat_feedback_spec.md §5.2.
 *
 * Order (HARD CONTRACT):
 *   PlayerControllerSystem -> FreezeSystem -> MovementSystem -> DashSystem
 *     -> StateSystem -> CombatActionSystem -> CollisionSystem -> LifespanSystem.
 *
 * Why this exact order:
 *  0. PlayerControllerSystem is the new FIRST segment (M2-T02): it replaces the old
 *     MovementSystem.bindInput phase and is the hardware -> intent seam. Running it
 *     first means every later system reads a fully-populated `IntentComponent` for
 *     this tick. FreezeSystem follows immediately so a freeze is applied before ANY
 *     "per-entity advance" system, letting hitstop suppress the whole tick.
 *     The relative order of the M1/M2 six segments (Movement .. Lifespan) is
 *     UNCHANGED and MUST NOT be reordered.
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
 *     the hit-feedback write point: hitstop, HITSTUN and knockback are all written
 *     here, at the END of the tick, so they take effect from the NEXT tick.
 *  6. LifespanSystem runs LAST so it cannot destroy a hitbox before that hitbox has
 *     been collision-tested this tick — a hitbox gets its full `activeTicks` span.
 *
 * Reordering any of these systems changes observable behaviour and will break the
 * QA tick-by-tick timing assertions (spec 02 §6, spec 03 §6, spec 04 §6).
 */

import type { System } from '../System';
import { PlayerControllerSystem } from './PlayerControllerSystem';
import { FreezeSystem } from './FreezeSystem';
import { MovementSystem } from './MovementSystem';
import { DashSystem } from './DashSystem';
import { StateSystem } from './StateSystem';
import { CombatActionSystem } from './CombatActionSystem';
import { CollisionSystem } from './CollisionSystem';
import { LifespanSystem } from './LifespanSystem';

/** Fresh instances of the canonical pipeline, in execution order. */
export function createDefaultSystems(): readonly System[] {
  return [
    new PlayerControllerSystem(),
    new FreezeSystem(),
    new MovementSystem(),
    new DashSystem(),
    new StateSystem(),
    new CombatActionSystem(),
    new CollisionSystem(),
    new LifespanSystem(),
  ];
}
