/**
 * Fixed-Tick clock. See specs/00_harness_spec.md §3.
 *
 * Precision contract: `60 ticks === 1.0 second` MUST hold exactly.
 * We therefore derive time by MULTIPLICATION (totalTicks * fixedDeltaSeconds),
 * never by repeated float addition, and never hard-code 16.67ms.
 */

export const DEFAULT_FPS = 60;

export interface FixedClockConfig {
  readonly fps?: number;
}

export class FixedClock {
  /** Logical ticks per second. */
  public readonly fps: number;

  /** Simulated seconds per single tick = 1 / fps. */
  public readonly fixedDeltaSeconds: number;

  /** Milliseconds per single tick = 1000 / fps (NOT truncated). */
  public readonly tickDurationMs: number;

  private _totalTicks = 0;

  constructor(config: FixedClockConfig = {}) {
    const fps = config.fps ?? DEFAULT_FPS;
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new RangeError(`fps must be a positive finite number, received: ${String(fps)}`);
    }
    this.fps = fps;
    this.fixedDeltaSeconds = 1 / fps;
    this.tickDurationMs = 1000 / fps;
  }

  /** Monotonically non-decreasing tick counter. */
  public get totalTicks(): number {
    return this._totalTicks;
  }

  /** Accumulated simulated seconds (pure function of totalTicks). */
  public get elapsedSeconds(): number {
    return this._totalTicks * this.fixedDeltaSeconds;
  }

  /** Accumulated simulated milliseconds (pure function of totalTicks). */
  public get elapsedMs(): number {
    return this._totalTicks * this.tickDurationMs;
  }

  /** Advance the clock by `ticks` (default 1). Must be a non-negative integer. */
  public advance(ticks = 1): void {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new RangeError(`advance(ticks) must be a non-negative integer, received: ${String(ticks)}`);
    }
    this._totalTicks += ticks;
  }
}
