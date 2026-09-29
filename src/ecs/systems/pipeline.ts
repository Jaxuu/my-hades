/**
 * Canonical per-tick system pipeline.
 * See specs/02_dash_and_state_spec.md §5.1, specs/03_combat_hitbox_spec.md §5.4,
 * specs/04_combat_feedback_spec.md §5.2, specs/05_boon_modifier_spec.md §5.2,
 * specs/07_enemy_ai_spec.md §5.2, specs/08_encounter_and_death_spec.md §5.2 and
 * specs/11_roguelike_loop_spec.md §5.2.
 *
 * Order (HARD CONTRACT, 17 segments):
 *   TransformSnapshotSystem -> PlayerControllerSystem -> FreezeSystem -> AISystem
 *     -> HazardSystem -> MovementSystem -> DashSystem -> StateSystem
 *     -> CombatActionSystem -> CollisionSystem -> StatusEffectSystem
 *     -> ModifierSystem -> DeathSystem -> EncounterSystem -> RewardSystem
 *     -> PickupSystem -> LifespanSystem.
 *
 * Why this exact order:
 * -1. TransformSnapshotSystem is the M5-T02 INSERTION and it sits AHEAD of every
 *     other segment (index 0). It is the sole authority on "where each entity was
 *     at the START of this tick": it hard-copies `TransformComponent` into
 *     `PreviousTransformComponent` so the render layer can interpolate between two
 *     logic ticks (specs/10_render_juice_spec.md §4, ADR-002). It MUST run before
 *     every displacement writer (MovementSystem, DashSystem and any future one),
 *     otherwise it would snapshot a partially-advanced position and the render
 *     layer would interpolate between two already-moved points. It is a PURE
 *     OBSERVER: it writes a component no gameplay system reads and never mutates
 *     `TransformComponent`, so it changes no existing system's relative order — the
 *     M1–M4 contract below holds verbatim, and LifespanSystem stays LAST.
 *  0. PlayerControllerSystem is the new FIRST gameplay segment (M2-T02): it replaces the old
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
 *  0c. HazardSystem is the M8-T01 INSERTION — and it is the FIRST milestone since
 *     M1 to add a genuinely NEW segment rather than extending an existing one.
 *     It sits immediately AFTER AISystem and BEFORE MovementSystem, and all three
 *     halves of that slot are forced (specs/14_aoe_and_run_lifecycle_spec.md §4.3):
 *       - AFTER AISystem: the `wantsToHazard` pulse is raised by the AI in THIS
 *         tick, so a consumer that ran earlier would always be one tick late.
 *       - BEFORE CollisionSystem: the blast must be collision-tested on the very
 *         tick it is spawned, which is what makes the blast's `activeTicks = 1`
 *         mean "exactly one hit test" instead of "a silent no-op" (contrast the
 *         Zeus bolt / Poseidon shockwave, which need 2 because ModifierSystem
 *         injects them AFTER CollisionSystem).
 *       - BEFORE MovementSystem DELIBERATELY: the AoE lands on the ground the
 *         target is standing on at the START of the tick, so this tick's
 *         displacement is the dodge window. Running after MovementSystem would
 *         land the telegraph where the target ENDED UP.
 *     Why a new segment rather than a tail phase on an existing system (the
 *     M7-T01 route): a hazard owns an independent lifecycle and its own event
 *     source (an intent pulse), so folding it into MovementSystem's tail would
 *     create a branch that has nothing to do with motion. The cost is real and
 *     was paid: the six `toEqual` pipeline pinning tests were updated to 16
 *     segments. It changes no EXISTING system's relative position, and
 *     LifespanSystem stays LAST.
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
 * 11. RewardSystem is the M6-T01 INSERTION — the third segment of the "room is
 *     finished" prologue. It sits immediately AFTER EncounterSystem because
 *     EncounterSystem is what ROLLS the boon draft on the `ROOM_CLEARED` transition
 *     (spec 11 AC-01), while RewardSystem is the other half of the loop: it SETTLES
 *     a selection and descends the room (spec 11 AC-04). Keeping them adjacent makes
 *     "roll, then settle" readable in one place, and it guarantees the settle is
 *     evaluated against THIS tick's draft rather than last tick's. It must come
 *     before LifespanSystem, which stays LAST. Consequence, documented rather than
 *     accidental: the descended room is picked up by EncounterSystem on the NEXT
 *     tick, so the deeper wave spawns one tick after the choice — the same one-tick
 *     phase the rest of the engine treats as an architectural property.
 *
 * 12. M6-T02 (spec 12) adds NO segment. It extends two EXISTING ones instead, which
 *     is why the order above is untouched and the six pinning tests keep passing:
 *     `DashSystem` now publishes a `DashEvent` on a third injected bus, and
 *     `ModifierSystem` drains that bus too and invokes the optional `onDash` hook.
 *     The existing DashSystem (index 5) < ModifierSystem (index 10) slot is what
 *     makes the event reach its consumer within the same tick, and the existing
 *     ModifierSystem > CollisionSystem (index 8) slot is what gives an injected
 *     blast its collision test on the FOLLOWING tick (spec 12 §5.2 / §4.4).
 *
 * 13. PickupSystem is the M9-T01 INSERTION — the 17th segment, sitting immediately
 *     BEFORE `LifespanSystem` (which stays LAST). All three halves of that slot are
 *     forced (specs/15_economy_and_victory_spec.md §4.2):
 *       - AFTER `MovementSystem` (index 5): the overlap test must use the position
 *         the collector ENDED the tick at, so walking onto a coin takes it on the
 *         tick the walk completed rather than one tick later.
 *       - AFTER `DeathSystem` (index 12): a pickup dropped by THIS tick's deaths is
 *         already in the world, so the drop and its collection share one tick
 *         boundary. (Contrast the Zeus bolt / Poseidon shockwave, which are
 *         injected by ModifierSystem AFTER CollisionSystem and therefore need
 *         `activeTicks = 2` to be tested at all.)
 *       - BEFORE `LifespanSystem`: a pickup taken this tick is removed at the end of
 *         this tick, and `PickupSystem` never has to destroy anything itself.
 *     Why a new segment rather than a tail phase on an existing system: a pickup
 *     owns an independent lifecycle and an independent read (a ground overlap),
 *     with nothing to do with motion, damage or scheduling. The cost is real and
 *     was paid: the seven `toEqual` pipeline pinning tests were updated to 17
 *     segments. It changes no EXISTING system's relative position, the M1/M2
 *     Movement/Dash/State trio keeps its exact order and adjacency, and
 *     `LifespanSystem` stays LAST.
 *
 * Reordering any of these systems changes observable behaviour and will break the
 * QA tick-by-tick timing assertions (spec 02 §6, spec 03 §6, spec 04 §6, spec 05 §6,
 * spec 07 §6, spec 08 §6, spec 11 §6, spec 15 §6).
 */

import type { System } from '../System';
import { EventQueue } from '../events';
import type { DashEvent, EntityDeathEvent } from '../events';
import { createDefaultModifierRegistry } from '../modifiers/index';
import { PlayerControllerSystem } from './PlayerControllerSystem';
import { FreezeSystem } from './FreezeSystem';
import { AISystem } from './AISystem';
import { HazardSystem } from './HazardSystem';
import { MovementSystem } from './MovementSystem';
import { DashSystem } from './DashSystem';
import { StateSystem } from './StateSystem';
import { CombatActionSystem } from './CombatActionSystem';
import { CollisionSystem } from './CollisionSystem';
import { StatusEffectSystem } from './StatusEffectSystem';
import { ModifierSystem } from './ModifierSystem';
import { DeathSystem } from './DeathSystem';
import { EncounterSystem } from './EncounterSystem';
import { RewardSystem } from './RewardSystem';
import { PickupSystem } from './PickupSystem';
import { LifespanSystem } from './LifespanSystem';
import { TransformSnapshotSystem } from './TransformSnapshotSystem';

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
 * @param dashEvents Dash bus shared by DashSystem (producer) and ModifierSystem
 *   (consumer) — the M6-T02 addition (spec 12 §5.3). Both ends sit in the same tick
 *   (DashSystem is index 5, ModifierSystem index 10), so the bus is a within-tick
 *   wire exactly like the hit bus, and ModifierSystem's full drain keeps it empty at
 *   every tick boundary. Defaults to a private queue, so the two pre-existing
 *   `createDefaultSystems` call shapes are unchanged; tests inject one to observe
 *   `DashEvent`.
 */
export function createDefaultSystems(
  events: EventQueue = new EventQueue(),
  deathEvents: EventQueue<EntityDeathEvent> = new EventQueue<EntityDeathEvent>(),
  dashEvents: EventQueue<DashEvent> = new EventQueue<DashEvent>(),
): readonly System[] {
  return [
    new TransformSnapshotSystem(),
    new PlayerControllerSystem(),
    new FreezeSystem(),
    new AISystem(),
    new HazardSystem(),
    new MovementSystem(),
    new DashSystem(dashEvents),
    new StateSystem(),
    new CombatActionSystem(),
    new CollisionSystem(events),
    new StatusEffectSystem(),
    new ModifierSystem(events, createDefaultModifierRegistry(), dashEvents),
    new DeathSystem(deathEvents),
    new EncounterSystem(),
    new RewardSystem(),
    new PickupSystem(),
    new LifespanSystem(),
  ];
}
