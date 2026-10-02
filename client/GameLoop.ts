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
 *
 * M14-T01 adds a SECOND thing after the catch-up loop: the frame's logic events
 * are drained from the injected `ClientEventBridge` (exactly once) and handed to
 * the renderer (shake + sparks) and the audio sink (chimes). Both the bridge and
 * the sink are OPTIONAL, so the loop's original behaviour — and its original
 * three-argument constructor — are unchanged (spec 22 §4.1).
 */

import type { Ticker } from 'pixi.js';

import type { GameSimulator } from '../src/core/GameSimulator';
import { isInHub } from '../src/ecs/components/GameStateComponent';
import { PlayerInputComponent } from '../src/ecs/components/PlayerInputComponent';
import type { ClientEventBridge, FrameEvents } from './ClientEventBridge';
import type { GameRenderer } from './GameRenderer';

/**
 * The keyboard seam: everything this loop needs from the device layer.
 *
 * Structural rather than the concrete `KeyboardInput` class, and that is a
 * type-surface decision with teeth: `KeyboardInput` reads the bare DOM globals
 * `window` / `KeyboardEvent`, so even a TYPE import of it drags those names into
 * the DOM-less `npm run typecheck` program (`lib: ["ES2022"]`) and fails it with
 * TS2304. `client/main.ts` still passes the real class — an instance satisfies
 * this interface structurally — so nothing about the wiring changes.
 */
export interface InputSource {
  flush(sim: GameSimulator): void;
}

/**
 * The howler-FREE audio seam (M14-T01, spec 22 §2.5).
 *
 * `GameLoop` must never import `howler` (that would put it in the render suites'
 * import graph via the renderer's siblings), so it talks to audio through this
 * structural interface instead. `client/AudioManager` satisfies it without
 * importing it.
 *
 * M16 (specs/024-real-art-assets T028) ADDS six optional methods at the TAIL. They
 * are optional on purpose: a sink written against the pre-M16 interface still
 * satisfies this one, so `new GameLoop(sim, renderer, input, bridge, sink)` keeps
 * type-checking and behaving exactly as before. The loop calls each through `?.`,
 * so an old sink simply does not hear the new cues.
 */
export interface AudioSink {
  playHit(): void;
  playDash(): void;
  playCoin(): void;
  /** M16: an enemy (or the player) died. */
  playEnemyDeath?(): void;
  /** M16: a hazard telegraph detonated. */
  playHazardBlast?(): void;
  /** M16: a UI button was pressed. */
  playUiClick?(): void;
  /** M16: a reward option was chosen. */
  playRewardSelect?(): void;
  /** M16: the run ended in death. */
  playDeath?(): void;
  /** M16: the run ended in victory. */
  playWin?(): void;
}

/**
 * Hard cap on logic ticks advanced per rendered frame. Guards against the
 * "spiral of death": after a long stall (e.g. a backgrounded tab) the accumulator
 * would demand hundreds of ticks, each frame making the next frame even longer.
 */
export const MAX_STEPS_PER_FRAME = 5;

export class GameLoop {
  private readonly sim: GameSimulator;
  private readonly renderer: GameRenderer;
  private readonly input: InputSource;
  private readonly onTick: (ticker: Ticker) => void;

  /**
   * The presentation-side event observer (M14-T01) and the audio sink. Both are
   * OPTIONAL and default to `null`, so the pre-M14 `new GameLoop(sim, renderer,
   * input)` shape keeps behaving EXACTLY as before (spec 22 §4.1).
   */
  private readonly bridge: ClientEventBridge | null;
  private readonly audio: AudioSink | null;

  private accumulatorMs = 0;
  private running = false;

  constructor(
    sim: GameSimulator,
    renderer: GameRenderer,
    input: InputSource,
    bridge: ClientEventBridge | null = null,
    audio: AudioSink | null = null,
  ) {
    this.sim = sim;
    this.renderer = renderer;
    this.input = input;
    this.bridge = bridge;
    this.audio = audio;
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
      this.syncFrame(0);
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

    this.syncFrame(alpha);
  }

  /**
   * Consume this frame's logic events (EXACTLY once) and hand them to the
   * presentation consumers (M14-T01, spec 22 §4.1).
   *
   * The bridge is drained here — after the `step` loop — so the renderer can turn
   * "a hit landed" into a shake + sparks, and the audio sink can turn it into a
   * chime, in the SAME frame the events were produced. `drainFrame()` empties the
   * buffer, which is what makes "consumed exactly once per frame" true.
   *
   * When no bridge was injected (the pre-M14 wiring) this is a plain
   * `syncWorld(world, alpha)` — byte-for-byte the old behaviour.
   */
  private syncFrame(alpha: number): void {
    const bridge = this.bridge;
    if (bridge === null) {
      this.renderer.syncWorld(this.sim.world, alpha);
      return;
    }
    const events = bridge.drainFrame();
    this.playSounds(events);
    this.renderer.syncWorld(this.sim.world, alpha, events);
  }

  /**
   * Fire one sound per event, through the howler-free sink.
   *
   * M16 adds the death cue. Which one is decided by a READ of the world — the same
   * "the engine publishes no event for this, so observe the state" trade-off
   * `installCoinChime` documents: `PlayerInputComponent` is the engine's structural
   * "this is the player" marker (spec 01 §3.3), so a death carrying it is the run
   * ending rather than a monster falling. The six new sink methods are optional, so
   * a pre-M16 sink still works and simply hears nothing new.
   */
  private playSounds(events: FrameEvents): void {
    const audio = this.audio;
    if (audio === null) return;
    events.hits.forEach(() => {
      audio.playHit();
    });
    events.dashes.forEach(() => {
      audio.playDash();
    });
    events.deaths.forEach((death) => {
      if (this.sim.world.getComponent(death.entityId, PlayerInputComponent) !== undefined) {
        audio.playDeath?.();
        return;
      }
      audio.playEnemyDeath?.();
    });
  }
}
