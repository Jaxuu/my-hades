/**
 * M1-T02 · Dash & action-state acceptance tests.
 * See specs/02_dash_and_state_spec.md §6 (tick-by-tick timing contract) and §7
 * (AC-01 .. AC-07).
 *
 * Fresh-eyes, QA-independent suite: every assertion drives the REAL GameSimulator
 * with the canonical pipeline (MovementSystem -> DashSystem -> StateSystem) and a
 * PlayerFactory-assembled entity. Nothing is mocked. Ticks are advanced one at a
 * time so the hard timing contract is pinned per tick, not only at the end.
 *
 * Grouping:
 *   G0 · assembly + tuning constants (supports AC-01)
 *   G1 · invulnerability window                     (AC-03)
 *   G2 · cooldown gate + rising-edge trigger        (AC-04, spec 03 §4.3)
 *   G3 · dash displacement / speed / direction lock (AC-05, AC-02)
 *   G4 · state machine + no-deadlock + determinism  (AC-01, AC-07, AC-06)
 *
 * M2-T01 revision: the dash trigger changed from the held level (`buttonDash`) to
 * the rising edge (`buttonDashJustPressed`). G2 was updated accordingly — holding
 * the dash key no longer auto-repeats a dash once the cooldown lapses.
 */

import { describe, expect, it } from 'vitest';
import {
  ActionState,
  createDefaultSystems,
  DASH_KEY,
  DashStatsComponent,
  DEFAULT_DASH_COOLDOWN_TICKS,
  DEFAULT_DASH_DURATION_TICKS,
  DEFAULT_DASH_INVULNERABLE_TICKS,
  DEFAULT_DASH_SPEED_MULTIPLIER,
  GameSimulator,
  hasTag,
  InputComponent,
  INVULNERABLE_TAG,
  PlayerFactory,
  StateComponent,
  TagComponent,
  TransformComponent,
  vec2,
  VelocityComponent,
} from '../../src';
import type { EntityId, Snapshot } from '../../src';

const FPS = 60;
const MAX_SPEED = 5;
/** Per-tick integration accumulates float rounding; measured drift is ~1e-15. */
const TOLERANCE = 1e-9;

const DASH_SPEED = MAX_SPEED * DEFAULT_DASH_SPEED_MULTIPLIER; // 15 unit/s
const PER_DASH_TICK = DASH_SPEED / FPS; // 0.25 world units / tick
const PER_WALK_TICK = MAX_SPEED / FPS; // 1/12 world units / tick
const DASH_DISTANCE = PER_DASH_TICK * DEFAULT_DASH_DURATION_TICKS; // 3.75
const WALK_DISTANCE_15 = PER_WALK_TICK * DEFAULT_DASH_DURATION_TICKS; // 1.25

interface Rig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
}

function makeRig(): Rig {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { maxSpeed: MAX_SPEED, facingRadians: 0 });
  return { sim, player };
}

function stateOf(rig: Rig): StateComponent {
  const c = rig.sim.world.getComponent(rig.player, StateComponent);
  if (c === undefined) throw new Error('QA: player is missing StateComponent');
  return c;
}

function dashOf(rig: Rig): DashStatsComponent {
  const c = rig.sim.world.getComponent(rig.player, DashStatsComponent);
  if (c === undefined) throw new Error('QA: player is missing DashStatsComponent');
  return c;
}

function transformOf(rig: Rig): TransformComponent {
  const c = rig.sim.world.getComponent(rig.player, TransformComponent);
  if (c === undefined) throw new Error('QA: player is missing TransformComponent');
  return c;
}

function velocityOf(rig: Rig): VelocityComponent {
  const c = rig.sim.world.getComponent(rig.player, VelocityComponent);
  if (c === undefined) throw new Error('QA: player is missing VelocityComponent');
  return c;
}

function tagsOf(rig: Rig): readonly string[] {
  const c = rig.sim.world.getComponent(rig.player, TagComponent);
  if (c === undefined) throw new Error('QA: player is missing TagComponent');
  return c.tags;
}

function inputOf(rig: Rig): InputComponent {
  const c = rig.sim.world.getComponent(rig.player, InputComponent);
  if (c === undefined) throw new Error('QA: player is missing InputComponent');
  return c;
}

function isInvulnerable(rig: Rig): boolean {
  return hasTag(rig.sim.world, rig.player, INVULNERABLE_TAG);
}

function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(TOLERANCE);
}

/* ------------------------------------------------------------------ *
 * G0 · assembly + tuning constants                                    *
 * ------------------------------------------------------------------ */
describe('G0 · assembly and tuning constants (AC-01 support)', () => {
  it('assembles a player owning State + DashStats + Tag, starting IDLE and off cooldown', () => {
    const rig = makeRig();

    expect(rig.sim.world.hasComponent(rig.player, StateComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(rig.player, DashStatsComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(rig.player, TagComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(rig.player, InputComponent)).toBe(true);

    expect(stateOf(rig).state).toBe(ActionState.IDLE);
    expect(stateOf(rig).ticksInState).toBe(0);
    expect(isInvulnerable(rig)).toBe(false);
  });

  it('exposes exactly the four ActionState values (M2-T01 adds ATTACKING)', () => {
    expect(Object.values(ActionState).sort()).toEqual(['ATTACKING', 'DASHING', 'IDLE', 'MOVING']);
  });

  it('exposes a one-tick-wide dash edge flag next to the persistent held level', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });

    rig.sim.step(1); // tick 0 — the press itself
    expect(inputOf(rig).buttonDash).toBe(true);
    expect(inputOf(rig).buttonDashJustPressed).toBe(true);

    rig.sim.step(1); // tick 1 — still held, but the edge has already elapsed
    expect(inputOf(rig).buttonDash).toBe(true);
    expect(inputOf(rig).buttonDashJustPressed).toBe(false);

    rig.sim.inject({ kind: 'keyUp', tick: 2, key: DASH_KEY });
    rig.sim.step(2); // ticks 2..3 — released
    expect(inputOf(rig).buttonDash).toBe(false);
    expect(inputOf(rig).buttonDashJustPressed).toBe(false);
  });

  it('starts with the spec tuning constants (3 / 15 / 12 / 30 / 0)', () => {
    const dash = dashOf(makeRig());

    expect(dash.speedMultiplier).toBe(DEFAULT_DASH_SPEED_MULTIPLIER);
    expect(dash.durationTicks).toBe(DEFAULT_DASH_DURATION_TICKS);
    expect(dash.invulnerableTicks).toBe(DEFAULT_DASH_INVULNERABLE_TICKS);
    expect(dash.cooldownTicks).toBe(DEFAULT_DASH_COOLDOWN_TICKS);
    expect(dash.cooldownRemaining).toBe(0);

    expect(DEFAULT_DASH_SPEED_MULTIPLIER).toBe(3);
    expect(DEFAULT_DASH_DURATION_TICKS).toBe(15);
    expect(DEFAULT_DASH_INVULNERABLE_TICKS).toBe(12);
    expect(DEFAULT_DASH_COOLDOWN_TICKS).toBe(30);
  });
});

/* ------------------------------------------------------------------ *
 * G1 · invulnerability window                                         *
 * ------------------------------------------------------------------ */
describe('G1 · invulnerability window (AC-03)', () => {
  it('carries the tag on clocks 1..12 and drops it on clocks 13..20', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });

    // clock 0 — before any tick is processed there is no tag.
    expect(rig.sim.tick).toBe(0);
    expect(isInvulnerable(rig)).toBe(false);

    const observed: boolean[] = [];
    for (let clock = 1; clock <= 20; clock += 1) {
      rig.sim.step(1);
      expect(rig.sim.tick).toBe(clock);
      observed.push(isInvulnerable(rig));
    }

    for (let clock = 1; clock <= 20; clock += 1) {
      const expected = clock <= DEFAULT_DASH_INVULNERABLE_TICKS; // 1..12 true, 13..20 false
      expect(observed[clock - 1]).toBe(expected);
    }
  });

  it('keeps the tag set deduplicated even though it is re-applied every tick', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.step(6); // mid-window: DashSystem re-adds the tag on every tick

    const tags = tagsOf(rig);
    expect(tags).toEqual([INVULNERABLE_TAG]);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.filter((tag) => tag === INVULNERABLE_TAG)).toHaveLength(1);
  });

  it('never tags an entity that has not dashed', () => {
    const rig = makeRig();
    rig.sim.step(5);

    expect(isInvulnerable(rig)).toBe(false);
    expect(tagsOf(rig)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * G2 · cooldown gate                                                  *
 * ------------------------------------------------------------------ */
describe('G2 · cooldown gate (AC-04)', () => {
  it('baseline: a single dash returns to IDLE at clock 16 and never moves again', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.inject({ kind: 'keyUp', tick: 1, key: DASH_KEY });

    rig.sim.step(16); // clock 16 — dash done
    expect(stateOf(rig).state).toBe(ActionState.IDLE);
    expectClose(transformOf(rig).x, DASH_DISTANCE);

    rig.sim.step(30); // clock 46 — long past the 30-tick cooldown, but no key held
    expect(stateOf(rig).state).toBe(ActionState.IDLE);
    expectClose(transformOf(rig).x, DASH_DISTANCE); // total displacement stays 3.75
  });

  it('counts cooldownRemaining down to exactly 0 on tick 30', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.inject({ kind: 'keyUp', tick: 1, key: DASH_KEY }); // one dash, then let go

    rig.sim.step(1); // clock 1 — dash just started, cooldown armed to full
    expect(dashOf(rig).cooldownRemaining).toBe(DEFAULT_DASH_COOLDOWN_TICKS);

    rig.sim.step(29); // clock 30
    expect(rig.sim.tick).toBe(30);
    expect(dashOf(rig).cooldownRemaining).toBe(1);

    rig.sim.step(1); // clock 31 — tick 30 processed
    expect(rig.sim.tick).toBe(31);
    expect(dashOf(rig).cooldownRemaining).toBe(0);
  });

  it('does NOT auto re-dash while the dash key stays held (rising-edge trigger)', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });

    rig.sim.step(30); // clock 30 — first dash long over, cooldown at 1
    expect(stateOf(rig).state).toBe(ActionState.IDLE);
    expect(dashOf(rig).cooldownRemaining).toBe(1);

    rig.sim.step(1); // clock 31 — cooldown reaches 0, but the key was never released
    expect(dashOf(rig).cooldownRemaining).toBe(0);
    expect(stateOf(rig).state).toBe(ActionState.IDLE);

    // Holding for another 60 ticks must not produce a second dash: M2-T01 changed
    // the trigger from the held level to the rising edge (spec 03 §4.3).
    rig.sim.step(60); // clock 91
    expect(stateOf(rig).state).toBe(ActionState.IDLE);
    expectClose(transformOf(rig).x, DASH_DISTANCE);
  });

  it('re-dashes only after a release + fresh press (rising edge)', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.step(31); // clock 31 — cooldown 0 while the key is still held: no re-dash
    expect(dashOf(rig).cooldownRemaining).toBe(0);
    expect(stateOf(rig).state).toBe(ActionState.IDLE);

    rig.sim.inject({ kind: 'keyUp', tick: 31, key: DASH_KEY });
    rig.sim.step(1); // clock 32 — released: still no dash
    expect(stateOf(rig).state).toBe(ActionState.IDLE);

    rig.sim.inject({ kind: 'keyDown', tick: 32, key: DASH_KEY });
    rig.sim.step(1); // clock 33 — fresh rising edge => dash
    expect(stateOf(rig).state).toBe(ActionState.DASHING);
    expect(stateOf(rig).ticksInState).toBe(1);
    expect(dashOf(rig).cooldownRemaining).toBe(DEFAULT_DASH_COOLDOWN_TICKS);
    expect(isInvulnerable(rig)).toBe(true);
  });

  it('ignores a dash request made while still on cooldown', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.inject({ kind: 'keyUp', tick: 1, key: DASH_KEY });
    rig.sim.step(16); // clock 16 — the single dash has finished

    expect(stateOf(rig).state).toBe(ActionState.IDLE);
    expectClose(transformOf(rig).x, DASH_DISTANCE);
    expect(dashOf(rig).cooldownRemaining).toBe(15);

    // Re-press mid-cooldown, release again before the cooldown expires.
    rig.sim.inject({ kind: 'keyDown', tick: 16, key: DASH_KEY });
    rig.sim.inject({ kind: 'keyUp', tick: 24, key: DASH_KEY });

    rig.sim.step(1); // clock 17 — cooldown keeps ticking; it is NOT reset to 30
    expect(dashOf(rig).cooldownRemaining).toBe(14);
    expect(stateOf(rig).state).toBe(ActionState.IDLE);

    let sawDashing = false;
    for (let i = 0; i < 14; i += 1) {
      // ticks 17..30 -> clock 31
      rig.sim.step(1);
      if (stateOf(rig).state === ActionState.DASHING) sawDashing = true;
    }

    expect(sawDashing).toBe(false);
    expectClose(transformOf(rig).x, DASH_DISTANCE); // no extra displacement
    expect(dashOf(rig).cooldownRemaining).toBe(0);
    expect(stateOf(rig).state).toBe(ActionState.IDLE);
  });

  it('lets a fresh request re-enter DASHING once the cooldown has elapsed', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.inject({ kind: 'keyUp', tick: 1, key: DASH_KEY });
    rig.sim.step(35); // clock 35 — cooldown long expired, key released

    expect(dashOf(rig).cooldownRemaining).toBe(0);
    expect(stateOf(rig).state).toBe(ActionState.IDLE);

    rig.sim.inject({ kind: 'keyDown', tick: 35, key: DASH_KEY });
    rig.sim.step(1); // clock 36

    expect(stateOf(rig).state).toBe(ActionState.DASHING);
    expect(stateOf(rig).ticksInState).toBe(1);
    expect(dashOf(rig).cooldownRemaining).toBe(DEFAULT_DASH_COOLDOWN_TICKS);
    expect(isInvulnerable(rig)).toBe(true);

    rig.sim.step(15); // clock 51 — second dash completed
    expectClose(transformOf(rig).x, DASH_DISTANCE * 2);
  });
});

/* ------------------------------------------------------------------ *
 * G3 · dash displacement, speed and direction lock                    *
 * ------------------------------------------------------------------ */
describe('G3 · dash displacement, speed and direction lock (AC-05, AC-02)', () => {
  it('a held dash covers 3.75 units along +x in 15 ticks, then clears the multiplier', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.step(16); // clock 16 — the 15 dash movement ticks (1..15) are done

    const transform = transformOf(rig);
    expectClose(transform.x, DASH_DISTANCE);
    expectClose(transform.y, 0);

    // The dash speed multiplier is cleared on the first non-dashing tick.
    rig.sim.step(1); // clock 17
    expect(velocityOf(rig).speedMultiplier).toBe(1);
    expect(velocityOf(rig).currentSpeed).toBe(0);
  });

  it('dash distance is exactly 3x the same-15-tick walk distance', () => {
    const dashRig = makeRig();
    dashRig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    dashRig.sim.step(16); // 15 movement ticks (1..15)
    const dashDistance = Math.hypot(transformOf(dashRig).x, transformOf(dashRig).y);

    const walkRig = makeRig();
    walkRig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    walkRig.sim.step(DEFAULT_DASH_DURATION_TICKS); // 15 movement ticks (0..14)
    const walkDistance = Math.hypot(transformOf(walkRig).x, transformOf(walkRig).y);

    expect(dashDistance).toBeGreaterThan(walkDistance);
    expectClose(walkDistance, WALK_DISTANCE_15);
    expectClose(dashDistance / walkDistance, DEFAULT_DASH_SPEED_MULTIPLIER);
  });

  it('locks the dash to the facing direction captured at dash start', () => {
    const rig = makeRig();
    // Steer +y for 10 ticks so facing becomes +pi/2.
    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(0, 1) });
    rig.sim.step(10); // clock 10

    const facingBefore = transformOf(rig).facingRadians;
    const yBefore = transformOf(rig).y;
    expectClose(facingBefore, Math.PI / 2);

    // Release the stick and dash: the direction must come from facing, not input.
    rig.sim.inject({ kind: 'move', tick: 10, vector: vec2(0, 0) });
    rig.sim.inject({ kind: 'keyDown', tick: 10, key: DASH_KEY });
    rig.sim.step(1); // clock 11 — dash started (no movement on the start tick)
    expect(stateOf(rig).state).toBe(ActionState.DASHING);
    expectClose(velocityOf(rig).directionVector.x, 0);
    expectClose(velocityOf(rig).directionVector.y, 1);

    rig.sim.step(15); // clock 26 — dash movement ticks 11..25
    const transform = transformOf(rig);
    expectClose(transform.y, yBefore + DASH_DISTANCE);
    expectClose(transform.x, 0);
    expectClose(transform.facingRadians, Math.PI / 2); // never rewritten while dashing
  });

  it('rejects mid-dash steering: a move input cannot bend the locked path', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.step(5); // clock 5 — x = 4 * 0.25
    expect(stateOf(rig).state).toBe(ActionState.DASHING);
    expectClose(transformOf(rig).x, 4 * PER_DASH_TICK);

    // Try to yank the stick the other way mid-dash.
    rig.sim.inject({ kind: 'move', tick: 5, vector: vec2(-1, 0) });
    rig.sim.step(11); // clock 16 — finish the dash

    const transform = transformOf(rig);
    expectClose(transform.x, DASH_DISTANCE); // still a straight +x dash
    expectClose(transform.y, 0);
    const dir = velocityOf(rig).directionVector;
    expectClose(dir.x, 1);
    expectClose(dir.y, 0);
    expectClose(transform.facingRadians, 0); // facing was not flipped to -x
  });
});

/* ------------------------------------------------------------------ *
 * G4 · state machine, no-deadlock and determinism                     *
 * ------------------------------------------------------------------ */
describe('G4 · state machine, no-deadlock and determinism (AC-01, AC-07, AC-06)', () => {
  it('switches IDLE <-> MOVING on the stick and resets ticksInState on transitions', () => {
    const rig = makeRig();

    rig.sim.step(1); // clock 1 — idle persists
    expect(stateOf(rig).state).toBe(ActionState.IDLE);
    expect(stateOf(rig).ticksInState).toBe(1);

    rig.sim.inject({ kind: 'move', tick: 1, vector: vec2(1, 0) });
    rig.sim.step(1); // clock 2 — IDLE -> MOVING (counter reset)
    expect(stateOf(rig).state).toBe(ActionState.MOVING);
    expect(stateOf(rig).ticksInState).toBe(0);

    rig.sim.step(1); // clock 3 — MOVING persists, counter advances
    expect(stateOf(rig).state).toBe(ActionState.MOVING);
    expect(stateOf(rig).ticksInState).toBe(1);

    rig.sim.inject({ kind: 'move', tick: 3, vector: vec2(0, 0) });
    rig.sim.step(1); // clock 4 — MOVING -> IDLE (counter reset)
    expect(stateOf(rig).state).toBe(ActionState.IDLE);
    expect(stateOf(rig).ticksInState).toBe(0);
  });

  it('never stays DASHING longer than durationTicks and stays drivable', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });

    const states: ActionState[] = [];
    let maxTicksInDash = 0;
    for (let i = 0; i < 300; i += 1) {
      rig.sim.step(1);
      const state = stateOf(rig);
      states.push(state.state);
      if (state.state === ActionState.DASHING) {
        maxTicksInDash = Math.max(maxTicksInDash, state.ticksInState);
      }
    }

    // states[k] is the state after clock k+1.
    expect(states[15]).toBe(ActionState.IDLE); // clock 16 — first dash has exited

    let longestRun = 0;
    let run = 0;
    for (const s of states) {
      if (s === ActionState.DASHING) {
        run += 1;
        longestRun = Math.max(longestRun, run);
      } else {
        run = 0;
      }
    }
    expect(longestRun).toBe(DEFAULT_DASH_DURATION_TICKS); // it dashes, for exactly the duration
    expect(longestRun).toBeLessThanOrEqual(DEFAULT_DASH_DURATION_TICKS);
    expect(maxTicksInDash).toBeLessThanOrEqual(DEFAULT_DASH_DURATION_TICKS);

    // Still drivable afterwards: release the dash key, push the stick, expect MOVING.
    rig.sim.inject({ kind: 'keyUp', tick: 300, key: DASH_KEY });
    rig.sim.inject({ kind: 'move', tick: 300, vector: vec2(1, 0) });
    const xBefore = transformOf(rig).x;
    rig.sim.step(1); // clock 301
    expect(stateOf(rig).state).toBe(ActionState.MOVING);
    expect(transformOf(rig).x).toBeGreaterThan(xBefore);
  });

  it('replays identically across two independent simulators, tick by tick', () => {
    const runScript = (): Snapshot[] => {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
      PlayerFactory.spawn(sim.world, { maxSpeed: MAX_SPEED, facingRadians: 0 });
      sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
      sim.inject({ kind: 'move', tick: 5, vector: vec2(0, 1) });
      sim.inject({ kind: 'move', tick: 12, vector: vec2(-1, 0) });
      sim.inject({ kind: 'keyUp', tick: 20, key: DASH_KEY });
      sim.inject({ kind: 'keyDown', tick: 40, key: DASH_KEY });

      const frames: Snapshot[] = [];
      for (let i = 0; i < 70; i += 1) {
        sim.step(1);
        frames.push(sim.snapshot());
      }
      return frames;
    };

    const a = runScript();
    const b = runScript();
    expect(a).toHaveLength(70);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]).toEqual(b[i]);
    }
    expect(a).toEqual(b);
  });
});
