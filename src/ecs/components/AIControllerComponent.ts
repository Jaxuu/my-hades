/**
 * Enemy AI controller state. See specs/07_enemy_ai_spec.md §3.1 / §3.2.
 *
 * POD component: data only, no behaviour. Every state transition lives in
 * `AISystem`; this component is the whole FSM state, so the machine is fully
 * described by the snapshot and holds no cross-tick hidden state
 * (specs/00_harness_spec.md §6.1).
 *
 * The component is OPT-IN: `spawnCombatant` mounts it only when the caller passes
 * AI tuning (spec 07 §3.5 / C10). Enemies without it are script-driven exactly as
 * they were before M4 — which is what keeps every pre-M4 test bit-for-bit
 * unchanged, because `AISystem` rewrites the intent of every entity it owns.
 */

import { ComponentBase } from '../Component';
import type { EntityId } from '../Entity';

/**
 * The enemy finite state machine.
 *
 * Orthogonal to `ActionState`: `AIState` answers "what do I intend to do",
 * `ActionState` answers "what is my body doing". An enemy in `WINDUP` is rooted
 * and telegraphing, so its `ActionState` is still `IDLE` — which is exactly why
 * `CombatActionSystem` lets the attack through when the windup ends
 * (spec 07 §4.2).
 */
export enum AIState {
  /** Idle: no target, or the target is outside the sight radius. */
  IDLE = 'IDLE',
  /** Chasing: the target is in sight but out of attack range. */
  CHASING = 'CHASING',
  /** Windup / telegraph: rooted in place, facing locked, counting down. */
  WINDUP = 'WINDUP',
  /** Cooldown: the forced gap after an attack. */
  COOLDOWN = 'COOLDOWN',
}

/** Default sight radius, in world units (spec 07 §3.4). */
export const DEFAULT_AI_SIGHT_RADIUS = 8;

/**
 * Default attack radius, in world units (spec 07 §3.4).
 *
 * Kept below the melee reach so a windup started inside it always connects: the
 * hitbox centre sits `0.75` in front of the attacker, the hitbox radius is `1.0`
 * and the hurtbox radius is `0.5`, i.e. a reach of `2.25`.
 */
export const DEFAULT_AI_ATTACK_RADIUS = 1.5;

/** Default windup (telegraph) length in ticks — 30 ticks @60fps = 0.5 s. */
export const DEFAULT_AI_WINDUP_TICKS = 30;

/** Default cooldown length in ticks — 60 ticks @60fps = 1 s. */
export const DEFAULT_AI_COOLDOWN_TICKS = 60;

export class AIControllerComponent extends ComponentBase {
  /** Current FSM state. */
  public state: AIState;

  /**
   * The entity this AI is hunting, or `null` when it has none yet.
   *
   * When `null` — or when the stored target is no longer alive — `AISystem`
   * auto-acquires the nearest hostile entity and stores it here, so the
   * acquisition is STICKY (a locked target is kept until it dies).
   */
  public targetEntityId: EntityId | null;

  /** Distance at which a target is noticed, in world units. Must be > 0. */
  public sightRadius: number;

  /** Distance at which a windup is started, in world units. Must be > 0 and <= sightRadius. */
  public attackRadius: number;

  /**
   * Telegraph length in ticks. The enemy is rooted and its facing is locked for
   * this many ticks before the attack pulse is raised (spec 07 AC-04).
   */
  public windupTicks: number;

  /** Forced gap after an attack, in ticks (spec 07 AC-05). */
  public cooldownTicks: number;

  /**
   * Ticks left in the current state. Decremented once per tick while in `WINDUP`
   * or `COOLDOWN`; the transition fires on the tick it reaches `0`. Always `0`
   * in `IDLE` / `CHASING`.
   *
   * On ENTERING `WINDUP` / `COOLDOWN` the counter is seeded to the full duration
   * and the entry tick is NOT counted, so the state is observable for exactly
   * `windupTicks` / `cooldownTicks` ticks (spec 07 §6.1).
   */
  public ticksRemaining: number;

  /**
   * Attack facing captured on the tick the windup STARTED — the target's
   * position AT THAT MOMENT, never recomputed afterwards. This is what makes the
   * telegraph a fixed, dodgeable window (spec 07 §4.4).
   */
  public lockedFacingRadians: number;

  constructor(
    targetEntityId: EntityId | null = null,
    sightRadius = DEFAULT_AI_SIGHT_RADIUS,
    attackRadius = DEFAULT_AI_ATTACK_RADIUS,
    windupTicks = DEFAULT_AI_WINDUP_TICKS,
    cooldownTicks = DEFAULT_AI_COOLDOWN_TICKS,
    state = AIState.IDLE,
    ticksRemaining = 0,
    lockedFacingRadians = 0,
  ) {
    super();
    this.targetEntityId = targetEntityId;
    this.sightRadius = sightRadius;
    this.attackRadius = attackRadius;
    this.windupTicks = windupTicks;
    this.cooldownTicks = cooldownTicks;
    this.state = state;
    this.ticksRemaining = ticksRemaining;
    this.lockedFacingRadians = lockedFacingRadians;
  }
}
