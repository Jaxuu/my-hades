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
 *
 * M5-T02 adds one thing after the catch-up loop: the leftover accumulator is
 * handed to the renderer as `alpha`, the interpolation factor between the tick we
 * just finished (`PreviousTransformComponent`) and the tick we are now in
 * (`TransformComponent`). It is a READ-ONLY projection of render timing — it never
 * touches logic state (specs/10_render_juice_spec.md §4.1, ADR-002).
 */

import type { Ticker } from 'pixi.js';

import type { GameSimulator } from '../src/core/GameSimulator';
import { isInHub } from '../src/ecs/components/GameStateComponent';
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
   *
   * M13-T01 adds one early exit, and it is the only place this loop reads game
   * state: while the run is in the HUB, ZERO logic ticks are advanced. The camp is a
   * MENU — the world behind the talent screen is a still frame — so letting time
   * creep would make `sim.tick` drift upward for no reason, and it would keep
   * draining queued input into a run that has already been settled. The renderer is
   * still synced (with `alpha = 0`, i.e. no interpolation, which is the truth about
   * a world that is not moving), so the scene stays on screen behind the menu.
   *
   * The exit is `return`, not `continue`: the accumulator is dropped rather than
   * carried, so leaving the camp cannot burst-advance the ticks that "should" have
   * happened while the menu was open. A menu is not a pause screen; it is time that
   * never was.
   */
  private frame(deltaMs: number): void {
    if (isInHub(this.sim.world)) {
      this.accumulatorMs = 0;
      this.renderer.syncWorld(this.sim.world, 0);
      return;
    }

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

    // The leftover accumulator is "how far we have already walked INTO the next
    // tick", which is exactly the prev -> curr interpolation factor (ADR-002). On
    // the overflow path above it is 0, so alpha falls out to 0 naturally. Clamped
    // to [0, 1] because a tiny negative remainder from float subtraction must
    // never make the renderer extrapolate past the current tick.
    const alpha =
      tickDurationMs > 0 ? Math.min(1, Math.max(0, this.accumulatorMs / tickDurationMs)) : 0;

    this.renderer.syncWorld(this.sim.world, alpha);
  }
}
