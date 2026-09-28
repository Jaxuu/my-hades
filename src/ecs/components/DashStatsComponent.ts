/**
 * Dash tuning data. See specs/02_dash_and_state_spec.md §3.2.
 *
 * POD component: data only, no behaviour. All timing fields are expressed in
 * Ticks (integers) so behaviour is fps-independent and replay-exact; only
 * `speedMultiplier` is a ratio.
 */

import { ComponentBase } from '../Component';

/** Dash speed relative to the entity's base maxSpeed. */
export const DEFAULT_DASH_SPEED_MULTIPLIER = 3;

/** Total dash duration in ticks (15 ticks @ 60fps = 0.25 s). */
export const DEFAULT_DASH_DURATION_TICKS = 15;

/** Leading ticks of the dash during which the entity is invulnerable (0.2 s). */
export const DEFAULT_DASH_INVULNERABLE_TICKS = 12;

/** Cooldown after a dash starts, in ticks (30 ticks @ 60fps = 0.5 s). */
export const DEFAULT_DASH_COOLDOWN_TICKS = 30;

export class DashStatsComponent extends ComponentBase {
  /** Speed multiplier applied to maxSpeed while dashing. */
  public speedMultiplier: number;

  /** Dash duration in ticks. */
  public durationTicks: number;

  /** Number of leading dash ticks carrying the invulnerability tag. */
  public invulnerableTicks: number;

  /** Cooldown length in ticks (counted from the dash start). */
  public cooldownTicks: number;

  /** Remaining cooldown ticks; `0` means a dash is available. */
  public cooldownRemaining: number;

  constructor(
    speedMultiplier = DEFAULT_DASH_SPEED_MULTIPLIER,
    durationTicks = DEFAULT_DASH_DURATION_TICKS,
    invulnerableTicks = DEFAULT_DASH_INVULNERABLE_TICKS,
    cooldownTicks = DEFAULT_DASH_COOLDOWN_TICKS,
    cooldownRemaining = 0,
  ) {
    super();
    this.speedMultiplier = speedMultiplier;
    this.durationTicks = durationTicks;
    this.invulnerableTicks = invulnerableTicks;
    this.cooldownTicks = cooldownTicks;
    this.cooldownRemaining = cooldownRemaining;
  }
}
