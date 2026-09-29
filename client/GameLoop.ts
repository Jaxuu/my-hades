/**
 * GameLoop — real time -> fixed logic ticks -> one render sync per frame.
 * See specs/09_renderer_bridge_spec.md §4.1 / §6.
 *
 * The loop is the ONLY place the wall clock is read, and even here it is used for
 * exactly one thing: to decide HOW MANY fixed ticks to advance this frame. The
 * tick length itself always comes from `sim.tickDurationMs` — never a hard-coded
 * 16.67 or 1/60 (ADR-001 R3, spec 09 C6).
 *
 * Rendering does NOT participate in the timing contract (spec 09 §3.6): dropped
 * frames, stalls or a backgrounded tab must never change the simulation result.
 * The catch-up cap is what enforces that — it discards the render-frame budget on
 * overflow instead of spiralling.
 */

import type { Ticker } from 'pixi.js';

import type { GameSimulator } from '../src/core/GameSimulator';
import type { GameRenderer } from './GameRenderer';
import type { KeyboardInput } from './KeyboardInput';

/**
 * Hard cap on logic ticks advanced per rendered frame. Guards against the
 * "spiral of death": after a long stall (e.g. a backgrounded tab) the accumulator
 * would demand hundreds of ticks, each frame making the next frame even longer.
 */
export const MAX_STEPS_PER_FRAME = 5;

export class GameLoop {
  private readonly sim: GameSimulator;
  private readonly renderer: GameRenderer;
  private readonly input: KeyboardInput;
  private readonly onTick: (ticker: Ticker) => void;

  private accumulatorMs = 0;
  private running = false;

  constructor(sim: GameSimulator, renderer: GameRenderer, input: KeyboardInput) {
    this.sim = sim;
    this.renderer = renderer;
    this.input = input;
    this.onTick = (ticker: Ticker): void => {
      this.frame(ticker.deltaMS);
    };
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.accumulatorMs = 0;
    this.renderer.ticker.add(this.onTick);
  }

  public stop(): void {
    if (!this.running) return;
    this.running = false;
    this.renderer.ticker.remove(this.onTick);
  }

  /**
   * One rendered frame: accumulate real time, advance whole fixed ticks (input
   * flushed immediately BEFORE each `step`), then sync the renderer once.
   */
  private frame(deltaMs: number): void {
    const tickDurationMs = this.sim.tickDurationMs;
    this.accumulatorMs += deltaMs;

    let steps = 0;
    while (this.accumulatorMs >= tickDurationMs && steps < MAX_STEPS_PER_FRAME) {
      // Order is load-bearing: inject targets `sim.tick`, and step(1) processes
      // exactly `sim.tick`. Injecting after stepping would land in the past and
      // throw (spec 09 §4.1).
      this.input.flush(this.sim);
      this.sim.step(1);
      this.accumulatorMs -= tickDurationMs;
      steps += 1;
    }

    // Hit the cap => we are behind. Drop the leftover budget rather than trying to
    // catch up forever: the game "slows down" instead of exploding (spec 09 §6.2).
    if (steps === MAX_STEPS_PER_FRAME) {
      this.accumulatorMs = 0;
    }

    this.renderer.syncWorld(this.sim.world);
  }
}
