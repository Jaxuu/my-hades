/**
 * Canonical per-tick system pipeline.
 * See specs/02_dash_and_state_spec.md §5.1.
 *
 * Order (HARD CONTRACT): MovementSystem -> DashSystem -> StateSystem.
 *
 * Why this exact order:
 *  1. MovementSystem integrates position against the state decided on the PREVIOUS
 *     tick. Running it first means a dash started this tick begins displacing on
 *     the next tick, giving exactly 15 movement ticks for a 15-tick dash and making
 *     the 15-tick total displacement contract (spec 02 §6) hold.
 *  2. DashSystem then applies this tick's dash entry / direction lock / i-frame
 *     tag, and ticks the cooldown. It must run AFTER movement (so it cannot
 *     retro-actively move this tick) and BEFORE the state machine.
 *  3. StateSystem runs LAST so it advances `ticksInState` only after the dash
 *     decision is in place — this is what aligns the invulnerability span with
 *     the leading ticks of the dash and lets the dash exit exactly on tick 15.
 *
 * Reordering these systems changes observable behaviour and will break the QA
 * tick-by-tick timing assertions (spec 02 §6).
 */

import type { System } from '../System';
import { MovementSystem } from './MovementSystem';
import { DashSystem } from './DashSystem';
import { StateSystem } from './StateSystem';

/** Fresh instances of the canonical pipeline, in execution order. */
export function createDefaultSystems(): readonly System[] {
  return [new MovementSystem(), new DashSystem(), new StateSystem()];
}
