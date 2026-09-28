import { describe, expect, it } from 'vitest';
import { DEFAULT_FPS, FixedClock } from '../../src/core/clock';
import { GameSimulator } from '../../src/core/GameSimulator';

describe('Fixed-Tick clock precision (AC-01, AC-02)', () => {
  it('60 ticks === exactly 1.0 second (tolerance 1e-9)', () => {
    const sim = new GameSimulator();
    sim.step(60);

    expect(sim.tick).toBe(60);
    expect(Math.abs(sim.elapsedSeconds - 1.0)).toBeLessThan(1e-9);
    expect(sim.elapsedSeconds).toBeCloseTo(1.0, 9);
  });

  it('exposes the exact contract constants (no 16.67 truncation)', () => {
    const sim = new GameSimulator();

    expect(sim.fps).toBe(DEFAULT_FPS);
    expect(sim.fixedDeltaSeconds).toBe(1 / 60);
    expect(sim.tickDurationMs).toBe(1000 / 60);
    expect(sim.tickDurationMs).toBe(sim.fixedDeltaSeconds * 1000);
  });

  it('elapsed time is a pure function of tick count (no drift over long runs)', () => {
    const sim = new GameSimulator();
    sim.step(6000);

    expect(sim.tick).toBe(6000);
    expect(Math.abs(sim.elapsedSeconds - 100.0)).toBeLessThan(1e-9);
  });

  it('clock equality holds exactly for the derived expression', () => {
    const clock = new FixedClock();
    clock.advance(60);

    expect(clock.totalTicks).toBe(60);
    expect(clock.elapsedSeconds).toBe(60 * (1 / 60));
  });

  it('supports a custom fps while preserving the contract', () => {
    const sim = new GameSimulator({ fps: 30 });
    sim.step(30);

    expect(sim.fps).toBe(30);
    expect(sim.fixedDeltaSeconds).toBe(1 / 30);
    expect(Math.abs(sim.elapsedSeconds - 1.0)).toBeLessThan(1e-9);
  });

  it('rejects invalid fps and invalid advance counts', () => {
    expect(() => new FixedClock({ fps: 0 })).toThrow(RangeError);
    expect(() => new FixedClock({ fps: -1 })).toThrow(RangeError);
    expect(() => new FixedClock({ fps: Number.NaN })).toThrow(RangeError);

    const clock = new FixedClock();
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(1.5)).toThrow(RangeError);
  });
});
