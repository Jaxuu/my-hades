/**
 * KeyboardInput — DOM key state -> per-tick input injection.
 * See specs/09_renderer_bridge_spec.md §4.2.
 *
 * Owns only the PHYSICAL key set and translates it, once per logic tick, into the
 * tick-aligned events the deterministic `InputQueue` expects:
 *
 *   - `move`  : PERSISTENT — re-injected every tick from the current WASD vector.
 *     `PlayerInputComponent.moveVector` is only overwritten when a `move` event
 *     arrives, so "hold the stick" is expressed by injecting the current vector
 *     every tick (spec 01 §2 "persistent input").
 *   - keyDown : RISING EDGE — injected once, on the tick a pulse key is pressed.
 *   - keyUp   : falling edge — injected once, when it is released.
 *
 * Dash / attack are single-tick pulses derived by `PlayerControllerSystem` from the
 * "released-before AND held-after" transition of the held-key set, so keyDown /
 * keyUp MUST be paired and "held" MUST NOT re-emit keyDown (spec 02 / 03 / 04).
 *
 * Injection order matters: `GameSimulator.inject` rejects `tick < sim.tick`, and
 * `step(1)` processes exactly `sim.tick` — so `flush(sim)` must run BEFORE `step(1)`
 * (spec 09 §4.1).
 */

import type { GameSimulator } from '../src/core/GameSimulator';
import type { Vec2 } from '../src/core/math';
import { vec2 } from '../src/core/math';
import { ATTACK_KEY, DASH_KEY } from '../src/ecs/components/PlayerInputComponent';

// Physical key codes (layout-independent), so WASD works on non-QWERTY layouts too.
const MOVE_UP = 'KeyW';
const MOVE_DOWN = 'KeyS';
const MOVE_LEFT = 'KeyA';
const MOVE_RIGHT = 'KeyD';
const ATTACK_CODE = 'KeyJ';
const DASH_CODE = 'KeyK';

/** Physical code -> logical key name for the two rising-edge pulses. */
const PULSE_KEYS = new Map<string, string>([
  [ATTACK_CODE, ATTACK_KEY],
  [DASH_CODE, DASH_KEY],
]);

/** Every physical code this input layer cares about. */
const TRACKED_CODES = new Set<string>([
  MOVE_UP,
  MOVE_DOWN,
  MOVE_LEFT,
  MOVE_RIGHT,
  ATTACK_CODE,
  DASH_CODE,
]);

export class KeyboardInput {
  private readonly target: Window;
  private readonly held = new Set<string>();
  private downEdges = new Set<string>();
  private upEdges = new Set<string>();
  private disposed = false;

  constructor(target: Window = window) {
    this.target = target;
    target.addEventListener('keydown', this.handleKeyDown);
    target.addEventListener('keyup', this.handleKeyUp);
    target.addEventListener('blur', this.handleBlur);
  }

  /**
   * Inject one tick's worth of input into `sim`. MUST be called immediately before
   * `sim.step(1)` (spec 09 §4.1).
   */
  public flush(sim: GameSimulator): void {
    const tick = sim.tick;

    // 1) Persistent movement vector — every tick, even when nothing is held.
    sim.inject({ kind: 'move', tick, vector: this.currentMoveVector() });

    // 2) Rising edges -> keyDown.
    for (const code of this.downEdges) {
      const key = PULSE_KEYS.get(code);
      if (key !== undefined) {
        sim.inject({ kind: 'keyDown', tick, key });
      }
    }

    // 3) Falling edges -> keyUp, EXCEPT a same-frame tap: a key pressed and released
    //    between two flushes would otherwise never be observed as held, losing the
    //    pulse. Defer its keyUp by one tick so the rising edge survives.
    const deferredUp = new Set<string>();
    for (const code of this.upEdges) {
      const key = PULSE_KEYS.get(code);
      if (key === undefined) continue;
      if (this.downEdges.has(code)) {
        deferredUp.add(code);
        continue;
      }
      sim.inject({ kind: 'keyUp', tick, key });
    }

    this.downEdges.clear();
    this.upEdges = deferredUp;
  }

  /** Detach every DOM listener. */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target.removeEventListener('keydown', this.handleKeyDown);
    this.target.removeEventListener('keyup', this.handleKeyUp);
    this.target.removeEventListener('blur', this.handleBlur);
  }

  /** World y maps directly to screen y (down), so W is -y and S is +y. */
  private currentMoveVector(): Vec2 {
    let x = 0;
    let y = 0;
    if (this.held.has(MOVE_LEFT)) x -= 1;
    if (this.held.has(MOVE_RIGHT)) x += 1;
    if (this.held.has(MOVE_UP)) y -= 1;
    if (this.held.has(MOVE_DOWN)) y += 1;
    return vec2(x, y);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const code = event.code;
    if (!TRACKED_CODES.has(code)) return;
    event.preventDefault();
    if (this.held.has(code)) return; // auto-repeat: already held, no new edge
    this.held.add(code);
    this.downEdges.add(code);
    this.upEdges.delete(code); // a re-press cancels a pending release
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    const code = event.code;
    if (!TRACKED_CODES.has(code)) return;
    if (!this.held.has(code)) return;
    this.held.delete(code);
    this.upEdges.add(code);
  };

  /** Losing focus must not leave keys stuck "held" forever. */
  private readonly handleBlur = (): void => {
    for (const code of this.held) {
      if (PULSE_KEYS.has(code)) this.upEdges.add(code);
    }
    this.held.clear();
  };
}
