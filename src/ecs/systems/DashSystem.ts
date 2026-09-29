/**
 * DashSystem — dash entry, cooldown and invulnerability span.
 * See specs/02_dash_and_state_spec.md §5.2 and specs/04_combat_feedback_spec.md §4.7.
 *
 * Pipeline position: runs AFTER MovementSystem (so this tick's displacement is
 * integrated against the state decided last tick) and BEFORE StateSystem (so the
 * dash decision and the invulnerability tag are in place before `ticksInState`
 * advances). See `pipeline.ts` for the full ordering rationale.
 *
 * All timing is measured in Ticks and driven by `ticksInState` / `cooldownRemaining`
 * on components — the system holds NO cross-tick hidden state (spec 00 §6.1).
 *
 * Trigger semantics (M2-T02): a dash fires on the entity's logical intent pulse
 * `IntentComponent.wantsToDash`, never on a held level. The pulse is CLEARED as
 * soon as it is read, so holding the dash key cannot auto-repeat a dash as soon as
 * the cooldown lapses; the player must release and press again (spec 03 §4.3).
 * Reading intent instead of hardware also means enemies can dash without owning any
 * input device — their AI simply raises the same pulse.
 *
 * Dash entry is gated to the LOCOMOTION states `IDLE` / `MOVING` only (spec 02
 * §4.1, spec 04 §5.1). `HITSTUN` and `ATTACKING` are uninterruptible, so a dash
 * pulse raised while the entity is stunned or mid-swing must NOT cancel that state:
 * this closes the F1 (hitstun dash-cancel) and F2 (attack-cancel) holes. The pulse
 * is consumed UNCONDITIONALLY (read-and-cleared before the state gate), so a pulse
 * raised in a non-locomotion state is DROPPED, not buffered — it cannot fire later
 * once the entity returns to locomotion.
 *
 * Frozen entities are skipped entirely (spec 04 §4.7): hitstop suppresses dash
 * entry, so no pulse is buffered while frozen (FreezeSystem clears it instead).
 *
 * DEAD entities are skipped before even that (M4-T02, spec 08 §4.2): a corpse
 * cannot start a dash, cannot hold an i-frame tag, and cannot keep ticking a
 * cooldown. The death gate precedes the freeze gate because death is permanent
 * while a freeze lapses — an ordering that matters the moment a corpse dies with a
 * freeze still armed.
 *
 * DASH EVENT (M6-T02, spec 12 AC-03). Entering `DASHING` is itself a FACT other
 * systems may want to react to, so `startDash` publishes a {@link DashEvent} on the
 * injected dash bus in the same call that flips the state — the event describes
 * "this entity really started dashing", never "this entity wanted to". A pulse the
 * entry gate REJECTS therefore publishes nothing, which keeps the event honest.
 *
 * The event is produced here and consumed by `ModifierSystem`, which runs LATER IN
 * THE SAME TICK (DashSystem is index 5, ModifierSystem index 10), so an `onDash`
 * hook never needs a cross-tick buffer. Emission order is the loop order — entity
 * id ascending — so the injected-entity sequence stays reproducible.
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import { vec2 } from '../../core/math';
import { EventQueue } from '../events';
import type { DashEvent } from '../events';
import { ActionState, StateComponent } from '../components/StateComponent';
import { DashStatsComponent } from '../components/DashStatsComponent';
import { IntentComponent } from '../components/IntentComponent';
import { isFrozen } from '../components/FreezeComponent';
import { isDead } from '../components/DeadTagComponent';
import { INVULNERABLE_TAG, addTag, removeTag } from '../components/TagComponent';
import { TransformComponent } from '../components/TransformComponent';
import { VelocityComponent } from '../components/VelocityComponent';

export class DashSystem implements System {
  public readonly name = 'DashSystem';

  /**
   * Tick-scoped dash bus. Injected so the SAME queue instance is shared with
   * ModifierSystem (see `createDefaultSystems`); the default keeps the system
   * usable standalone, but a standalone instance's events are never drained.
   */
  private readonly dashEvents: EventQueue<DashEvent>;

  constructor(dashEvents: EventQueue<DashEvent> = new EventQueue<DashEvent>()) {
    this.dashEvents = dashEvents;
  }

  public update(world: World, ctx: SystemContext): void {
    const ids = world.query(
      IntentComponent,
      StateComponent,
      DashStatsComponent,
      VelocityComponent,
      TransformComponent,
    );

    for (const id of ids) {
      // Death first: a corpse takes no action, not even a frozen one (spec 08 §4.2).
      if (isDead(world, id)) continue;
      if (isFrozen(world, id)) continue;

      const intent = world.getComponent(id, IntentComponent);
      const state = world.getComponent(id, StateComponent);
      const dash = world.getComponent(id, DashStatsComponent);
      const velocity = world.getComponent(id, VelocityComponent);
      const transform = world.getComponent(id, TransformComponent);
      if (
        intent === undefined ||
        state === undefined ||
        dash === undefined ||
        velocity === undefined ||
        transform === undefined
      ) {
        continue;
      }

      // Read-and-clear the one-tick dash pulse UNCONDITIONALLY, before the state
      // gate: a pulse raised in an uninterruptible state (HITSTUN / ATTACKING) is
      // consumed here and then ignored, so it can never fire later.
      const wantsToDash = intent.wantsToDash;
      intent.wantsToDash = false;

      if (state.state !== ActionState.DASHING) {
        // Not dashing: tick the cooldown down, clear any stale speed multiplier,
        // then start a dash if requested and off cooldown.
        if (dash.cooldownRemaining > 0) dash.cooldownRemaining -= 1;
        velocity.speedMultiplier = 1;
        // Gate entry to LOCOMOTION only (spec 02 §4.1): HITSTUN and ATTACKING are
        // uninterruptible, so a dash must not cancel a stun (F1) or a swing (F2).
        const inLocomotion =
          state.state === ActionState.IDLE || state.state === ActionState.MOVING;
        if (wantsToDash && inLocomotion && dash.cooldownRemaining === 0) {
          this.startDash(world, id, state, dash, velocity, transform, ctx.tick);
        }
      } else {
        // Dashing: keep the cooldown ticking, and hold the invulnerability tag for
        // the leading `invulnerableTicks` ticks of the dash only.
        if (dash.cooldownRemaining > 0) dash.cooldownRemaining -= 1;
        if (state.ticksInState < dash.invulnerableTicks) {
          addTag(world, id, INVULNERABLE_TAG);
        } else {
          removeTag(world, id, INVULNERABLE_TAG);
        }
      }
    }
  }

  /**
   * Enter DASHING: lock the current facing into the velocity direction (so input
   * can no longer steer), apply the dash speed multiplier and grant i-frames.
   *
   * The {@link DashEvent} is published at the END of this method — after the state
   * flip — so a consumer that reacts by reading the world sees the entity already
   * `DASHING`, and so "the event means the dash started" is true by construction
   * rather than by convention (spec 12 AC-03).
   */
  private startDash(
    world: World,
    id: EntityId,
    state: StateComponent,
    dash: DashStatsComponent,
    velocity: VelocityComponent,
    transform: TransformComponent,
    tick: number,
  ): void {
    const lockedDir = vec2(Math.cos(transform.facingRadians), Math.sin(transform.facingRadians));

    state.state = ActionState.DASHING;
    state.ticksInState = 0;
    dash.cooldownRemaining = dash.cooldownTicks;
    velocity.speedMultiplier = dash.speedMultiplier;
    velocity.directionVector = lockedDir;
    velocity.currentSpeed = velocity.maxSpeed * dash.speedMultiplier;
    addTag(world, id, INVULNERABLE_TAG);

    this.dashEvents.emit({
      tick,
      entityId: id,
      position: vec2(transform.x, transform.y),
      direction: lockedDir,
    });
  }
}
