/**
 * AISystem — enemy finite state machine -> logical intent.
 * See specs/07_enemy_ai_spec.md §4 (semantics) and §5.2 (pipeline position).
 *
 * Pipeline position: the THIRD segment, immediately AFTER FreezeSystem and BEFORE
 * every per-entity advance system (Movement / Dash / State / CombatAction). It is
 * the enemy half of the "intent generation" prologue: PlayerControllerSystem turns
 * hardware into the player's intent, AISystem turns the FSM into the enemy's.
 *
 * Why AFTER FreezeSystem rather than before it (spec 07 §5.2 rule 2 / §10
 * trade-off 1): FreezeSystem decrements `remainingTicks` FIRST, and every system
 * after it tests the POST-decrement value to decide whether this entity is frozen.
 * AISystem must see the same verdict as the action systems it feeds — if it ran
 * before FreezeSystem it would read the pre-decrement value and pause for one tick
 * too many, so an enemy would come out of hitstop one tick later than the player.
 *
 * What it writes (AC-01 — the AI's output is INTENT ONLY):
 *
 *   intent.moveVector    — this tick's locomotion intent (zero unless chasing)
 *   intent.wantsToAttack — the single-tick attack pulse raised when a windup ends
 *   intent.aimRadians    — the locked attack facing while in WINDUP, else null
 *
 * It never writes TransformComponent / VelocityComponent, never creates entities
 * and never calls applyDamage / applyFreeze. Displacement and the actual swing are
 * executed by the existing MovementSystem / CombatActionSystem, which is the whole
 * point of the intent seam: a new enemy behaviour needs no new movement or combat
 * code (spec 07 §1.1).
 *
 * Three gates, in this order (spec 07 §4.6 + spec 08 §4.2 — the order is NOT
 * exchangeable):
 *
 *  -1. DEATH (`isDead`)      -> INERT: skip entirely, write nothing. A corpse owns
 *      no intent and takes no decisions, permanently. This gate comes FIRST
 *      because it is the only one that can never lapse.
 *   0. hitstop (`isFrozen`)  -> PAUSE: skip entirely, write nothing. FreezeSystem,
 *      which ran immediately before us, has already zeroed a still-frozen entity's
 *      intent, so the pause cannot buffer anything.
 *   1. `HITSTUN`             -> INTERRUPT: reset the FSM to IDLE, then stay inert.
 *      A windup that was interrupted is DISCARDED, never resumed — after the stun
 *      the enemy re-evaluates from scratch.
 *
 * Gate 0 must come first of the two live gates: a single hit writes hitstop AND
 * hitstun together, so if the hitstun branch were tested first it would fire during
 * the hitstop window and downgrade the pause into a cancel, silently eating
 * telegraph frames.
 *
 * The death gate is not merely "the AI happens to write nothing": it is what makes
 * AC-01's "a corpse outputs no intent" hold against a HAND-WRITTEN intent too. An
 * AI entity whose intent is overwritten every tick by this system would otherwise
 * still be driven after death by whatever was left in the component (spec 08 §6.3).
 *
 * Holds NO cross-tick hidden state: the whole machine lives on
 * `AIControllerComponent` (spec 07 C5).
 */

import type { System, SystemContext } from '../System';
import type { World } from '../World';
import type { EntityId } from '../Entity';
import type { Vec2 } from '../../core/math';
import { lengthVec2, normalizeVec2, vec2 } from '../../core/math';
import { AIControllerComponent, AIState } from '../components/AIControllerComponent';
import { IntentComponent } from '../components/IntentComponent';
import { ActionState, StateComponent } from '../components/StateComponent';
import { TransformComponent } from '../components/TransformComponent';
import { FactionComponent, areHostile } from '../components/FactionComponent';
import { HealthComponent, isAlive } from '../components/HealthComponent';
import { isFrozen } from '../components/FreezeComponent';
import { isDead } from '../components/DeadTagComponent';

export class AISystem implements System {
  public readonly name = 'AISystem';

  public update(world: World, _ctx: SystemContext): void {
    const ids = world.query(
      AIControllerComponent,
      IntentComponent,
      StateComponent,
      TransformComponent,
    );

    for (const id of ids) {
      // --- Gate -1: death is absolute (M4-T02, spec 08 §4.2) --------------
      // Before the component fetch: a corpse costs one store lookup, nothing more.
      if (isDead(world, id)) continue;

      const ai = world.getComponent(id, AIControllerComponent);
      const intent = world.getComponent(id, IntentComponent);
      const state = world.getComponent(id, StateComponent);
      const transform = world.getComponent(id, TransformComponent);
      if (
        ai === undefined ||
        intent === undefined ||
        state === undefined ||
        transform === undefined
      ) {
        continue;
      }

      // --- Gate 0: hitstop PAUSES the FSM --------------------------------
      // Return without touching anything: the counter is frozen in place, so a
      // 4-tick hitstop shifts the windup 4 ticks later instead of eating 4 frames.
      if (isFrozen(world, id)) continue;

      // The AI is the SOLE author of an AI entity's intent (AC-01): clear this
      // tick's decision before deriving the new one, so a hand-written intent can
      // never leak through, and the attack pulse is exactly one tick wide.
      intent.moveVector = vec2(0, 0);
      intent.wantsToAttack = false;
      intent.aimRadians = null;

      // --- Gate 1: hitstun INTERRUPTS the FSM ----------------------------
      if (state.state === ActionState.HITSTUN) {
        ai.state = AIState.IDLE;
        ai.ticksRemaining = 0;
        continue;
      }

      const target = this.resolveTarget(world, id, ai);
      const toTarget = this.offsetToTarget(world, transform, target);
      const distance = toTarget === null ? Number.POSITIVE_INFINITY : lengthVec2(toTarget);

      switch (ai.state) {
        case AIState.IDLE: {
          if (toTarget === null) break;
          if (distance <= ai.attackRadius) {
            this.enterWindup(ai, intent, toTarget);
            break;
          }
          if (distance <= ai.sightRadius) {
            ai.state = AIState.CHASING;
            ai.ticksRemaining = 0;
          }
          break;
        }

        case AIState.CHASING: {
          if (toTarget === null) {
            ai.state = AIState.IDLE;
            ai.ticksRemaining = 0;
            break;
          }
          if (distance <= ai.attackRadius) {
            this.enterWindup(ai, intent, toTarget);
            break;
          }
          if (distance <= ai.sightRadius) {
            // AC-03: a NORMALIZED vector towards the target's CURRENT position —
            // re-read every tick, so the chase turns as the target moves.
            intent.moveVector = normalizeVec2(toTarget);
            break;
          }
          // Out of sight: drop the chase (AC-03).
          ai.state = AIState.IDLE;
          ai.ticksRemaining = 0;
          break;
        }

        case AIState.WINDUP: {
          // The telegraph: rooted (moveVector stays zero) and facing locked.
          // Re-asserting the lock every tick keeps `facingRadians` pinned.
          intent.aimRadians = ai.lockedFacingRadians;
          ai.ticksRemaining -= 1;
          if (ai.ticksRemaining <= 0) {
            // The pulse is consumed by CombatActionSystem in THIS tick (it runs
            // later in the same pipeline), which spawns the hitbox along the
            // facing MovementSystem just applied from `aimRadians`.
            intent.wantsToAttack = true;
            ai.state = AIState.COOLDOWN;
            ai.ticksRemaining = ai.cooldownTicks;
          }
          break;
        }

        case AIState.COOLDOWN: {
          ai.ticksRemaining -= 1;
          if (ai.ticksRemaining <= 0) {
            // AC-05: the cooldown hands control back to the DECISION states, not
            // straight to a new windup — the next tick decides whether to wind up
            // again, which is what makes the cycle `windup + cooldown + 1`.
            ai.ticksRemaining = 0;
            ai.state =
              toTarget !== null && distance <= ai.sightRadius ? AIState.CHASING : AIState.IDLE;
          }
          break;
        }
      }
    }
  }

  /**
   * Resolve this tick's target, auto-acquiring one when the stored id is absent or
   * dead. Acquisition is STICKY: once a live target is stored it is kept until it
   * dies, so the enemy does not flip between equidistant prey mid-fight.
   */
  private resolveTarget(world: World, id: EntityId, ai: AIControllerComponent): EntityId | null {
    const current = ai.targetEntityId;
    if (current !== null && world.isAlive(current)) return current;

    const acquired = this.acquireNearestHostile(world, id);
    ai.targetEntityId = acquired;
    return acquired;
  }

  /**
   * The nearest live hostile entity with a transform, or `null` when there is none.
   *
   * Deterministic by construction: `World.query` is id-ascending and the comparison
   * is a STRICT `<`, so the lowest id wins a distance tie on every machine
   * (spec 07 §4.5 / C2).
   */
  private acquireNearestHostile(world: World, id: EntityId): EntityId | null {
    const selfTransform = world.getComponent(id, TransformComponent);
    const selfFaction = world.getComponent(id, FactionComponent);
    if (selfTransform === undefined || selfFaction === undefined) return null;

    let best: EntityId | null = null;
    let bestDistanceSq = Number.POSITIVE_INFINITY;

    for (const other of world.query(TransformComponent, FactionComponent, HealthComponent)) {
      if (other === id) continue;
      const otherFaction = world.getComponent(other, FactionComponent);
      const otherTransform = world.getComponent(other, TransformComponent);
      if (otherFaction === undefined || otherTransform === undefined) continue;
      if (!areHostile(selfFaction.faction, otherFaction.faction)) continue;
      if (!isAlive(world, other)) continue;

      const dx = otherTransform.x - selfTransform.x;
      const dy = otherTransform.y - selfTransform.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        best = other;
      }
    }

    return best;
  }

  /** Vector from `transform` to the target's origin, or `null` when there is none. */
  private offsetToTarget(
    world: World,
    transform: TransformComponent,
    target: EntityId | null,
  ): Vec2 | null {
    if (target === null) return null;
    const targetTransform = world.getComponent(target, TransformComponent);
    if (targetTransform === undefined) return null;
    return vec2(targetTransform.x - transform.x, targetTransform.y - transform.y);
  }

  /**
   * Start a windup: root the enemy, seed the telegraph counter and LOCK the attack
   * facing to the direction the target is in RIGHT NOW (spec 07 AC-04).
   *
   * The entry tick does not decrement the counter, so the windup is observable for
   * exactly `windupTicks` ticks and the pulse lands on entry-tick + `windupTicks`.
   */
  private enterWindup(ai: AIControllerComponent, intent: IntentComponent, toTarget: Vec2): void {
    const facing = Math.atan2(toTarget.y, toTarget.x);
    ai.state = AIState.WINDUP;
    ai.ticksRemaining = ai.windupTicks;
    ai.lockedFacingRadians = facing;
    // Locked from the entry tick, so the very first telegraph frame already faces
    // the target (MovementSystem applies it because the enemy is rooted).
    intent.aimRadians = facing;
  }
}
