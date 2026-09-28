/**
 * M2-T02 · Combat feedback acceptance tests (hitstop / hitstun / knockback).
 * See specs/04_combat_feedback_spec.md §6 (tick-by-tick contract) and §7
 * (AC-01 .. AC-08).
 *
 * Fresh-eyes harness suite: every assertion drives the REAL GameSimulator with the
 * canonical pipeline (PlayerControllerSystem -> FreezeSystem -> MovementSystem ->
 * DashSystem -> StateSystem -> CombatActionSystem -> CollisionSystem ->
 * LifespanSystem) and REAL prefab-assembled entities. Nothing is mocked, and ticks
 * are advanced one at a time so the timing contract is pinned per tick.
 *
 * Hit geometry: player at (0, 0) facing +x attacks on tick 0; its hitbox is centred
 * at (0.75, 0) with radius 1.0, and the enemy (hurtbox radius 0.5) at (1.5, 0) is
 * within the 1.5 reach, so the hit lands on tick 0 (the "hit tick" T).
 *
 * Tick derivations used below (T = 0, N = DEFAULT_HITSTOP_TICKS = 4,
 * DEFAULT_HITSTUN_TICKS = 8, DEFAULT_KNOCKBACK_FORCE = 12, dt = 1/60):
 *   - hitstop covers T+1 .. T+N (exactly N ticks); T+N+1 is the recovery tick.
 *   - knockback covers T+N+1 .. T+N+DEFAULT_HITSTUN_TICKS (exactly 8 ticks),
 *     0.2 units each, total 1.6; the victim ends at x = 1.5 + 1.6 = 3.1 and leaves
 *     HITSTUN at the end of tick 12.
 *   - the attacker entered ATTACKING on tick 0 with ticksInState = 0, is paused for
 *     ticks 1..4, then counts 12 more -> exits on tick 17 (12 + N + 1).
 *
 * Grouping:
 *   G0 · hitstop: both sides frozen for exactly DEFAULT_HITSTOP_TICKS   (AC-01)
 *   G1 · freeze pause + resume from the pre-freeze progress             (AC-02)
 *   G2 · hitstun + forced knockback (maxSpeed- and intent-independent)  (AC-03)
 *   G3 · deterministic replay of the feedback path                      (AC-04)
 *   G4 · canonical pipeline order                                       (AC-07)
 *   G5 · invulnerable hits produce ZERO feedback                        (AC-04/spec §4.4)
 *   G6 · a pulse that cannot fire is consumed, never buffered           (spec §4.2/§8/§5.1)
 *   G7 · hitstopTicks / knockbackForce configuration boundaries         (spec §3.6)
 *   G8 · applyFreeze / isFrozen free-function semantics                 (spec §3.3)
 *   G9 · IntentComponent pulse vs persistent semantics                  (spec §3.1)
 *   G10 · intent-decoupling guard: hardware drives the player only      (AC-06)
 */

import { describe, expect, it } from 'vitest';
import {
  ActionState,
  ATTACK_KEY,
  DASH_KEY,
  DEFAULT_ATTACK_DAMAGE,
  DEFAULT_ATTACK_DURATION_TICKS,
  DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS,
  DEFAULT_ATTACK_HITBOX_RADIUS,
  DEFAULT_HITSTOP_TICKS,
  DEFAULT_HITSTUN_TICKS,
  DEFAULT_KNOCKBACK_FORCE,
  DEFAULT_MAX_HP,
  EnemyFactory,
  Faction,
  FreezeComponent,
  GameSimulator,
  HealthComponent,
  HitboxComponent,
  IntentComponent,
  INVULNERABLE_TAG,
  KnockbackComponent,
  PlayerFactory,
  PlayerInputComponent,
  StateComponent,
  TransformComponent,
  addTag,
  applyFreeze,
  createDefaultSystems,
  isFrozen,
  normalizeVec2,
  vec2,
} from '../../src';
import type { EntityId, Snapshot } from '../../src';

const FPS = 60;
const MAX_SPEED = 5;
const TOLERANCE = 1e-9;

interface Rig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
  readonly enemy: EntityId;
}

/** A hit-lands-on-tick-0 rig. `enemyMaxSpeed` lets a test prove knockback ignores it. */
function makeRig(options: { enemyMaxSpeed?: number } = {}): Rig {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
  const enemy = EnemyFactory.spawn(sim.world, {
    x: 1.5,
    y: 0,
    facingRadians: 0,
    maxSpeed: options.enemyMaxSpeed ?? MAX_SPEED,
  });
  return { sim, player, enemy };
}

/* --- component accessors (sim-based, so they work for ad-hoc rigs too) ------ */

function stateOfSim(sim: GameSimulator, id: EntityId): StateComponent {
  const c = sim.world.getComponent(id, StateComponent);
  if (c === undefined) throw new Error('QA: entity is missing StateComponent');
  return c;
}

function transformOfSim(sim: GameSimulator, id: EntityId): TransformComponent {
  const c = sim.world.getComponent(id, TransformComponent);
  if (c === undefined) throw new Error('QA: entity is missing TransformComponent');
  return c;
}

function hpOfSim(sim: GameSimulator, id: EntityId): number {
  const c = sim.world.getComponent(id, HealthComponent);
  if (c === undefined) throw new Error('QA: entity is missing HealthComponent');
  return c.hp;
}

function intentOfSim(sim: GameSimulator, id: EntityId): IntentComponent {
  const c = sim.world.getComponent(id, IntentComponent);
  if (c === undefined) throw new Error('QA: entity is missing IntentComponent');
  return c;
}

function stateOf(rig: Rig, id: EntityId): StateComponent {
  return stateOfSim(rig.sim, id);
}

function transformOf(rig: Rig, id: EntityId): TransformComponent {
  return transformOfSim(rig.sim, id);
}

function hpOf(rig: Rig, id: EntityId): number {
  return hpOfSim(rig.sim, id);
}

function intentOf(rig: Rig, id: EntityId): IntentComponent {
  return intentOfSim(rig.sim, id);
}

/** Ids of every live hitbox of the given faction, in ascending order. */
function hitboxesOf(sim: GameSimulator, faction: Faction): EntityId[] {
  return sim.world.query(TransformComponent, HitboxComponent).filter((id) => {
    const hitbox = sim.world.getComponent(id, HitboxComponent);
    return hitbox !== undefined && hitbox.faction === faction;
  });
}

/* ------------------------------------------------------------------ *
 * G0 · hitstop                                                        *
 * ------------------------------------------------------------------ */
describe('G0 · hitstop freezes both sides (AC-01)', () => {
  it('freezes attacker and victim for exactly DEFAULT_HITSTOP_TICKS ticks', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 (the hit tick T) — the hit lands

    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
    expect(isFrozen(rig.sim.world, rig.player)).toBe(true);
    expect(isFrozen(rig.sim.world, rig.enemy)).toBe(true);

    // Ticks T+1 .. T+N are frozen: neither the state machine nor the position moves.
    for (let i = 0; i < DEFAULT_HITSTOP_TICKS; i += 1) {
      const playerTicks = stateOf(rig, rig.player).ticksInState;
      const playerX = transformOf(rig, rig.player).x;
      const enemyTicks = stateOf(rig, rig.enemy).ticksInState;
      const enemyX = transformOf(rig, rig.enemy).x;

      rig.sim.step(1);

      expect(stateOf(rig, rig.player).ticksInState).toBe(playerTicks);
      expect(transformOf(rig, rig.player).x).toBe(playerX);
      expect(stateOf(rig, rig.enemy).ticksInState).toBe(enemyTicks);
      expect(transformOf(rig, rig.enemy).x).toBe(enemyX);
    }
  });

  it('covers exactly N ticks: the (N+1)-th tick after the hit is NOT frozen', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0

    rig.sim.step(DEFAULT_HITSTOP_TICKS); // ticks 1..N — the whole freeze
    // The hitstop is over on the NEXT tick: the attacker's machine advances again.
    const playerTicks = stateOf(rig, rig.player).ticksInState;
    rig.sim.step(1); // tick N+1
    expect(stateOf(rig, rig.player).ticksInState).toBe(playerTicks + 1);
  });

  it('reports isFrozen true through tick T+N and false from T+N+1 (boundary)', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — freeze armed with `remainingTicks = N + 1`

    // Ticks T+1 .. T+N: still frozen at the END of each of these N ticks.
    for (let i = 0; i < DEFAULT_HITSTOP_TICKS; i += 1) {
      rig.sim.step(1);
      expect(isFrozen(rig.sim.world, rig.player)).toBe(true);
      expect(isFrozen(rig.sim.world, rig.enemy)).toBe(true);
    }

    // Tick T+N+1: the counter has reached 0, so the freeze is over — but the
    // component is still present with remainingTicks === 0 (no snapshot churn).
    rig.sim.step(1);
    expect(isFrozen(rig.sim.world, rig.player)).toBe(false);
    expect(isFrozen(rig.sim.world, rig.enemy)).toBe(false);
    const freeze = rig.sim.world.getComponent(rig.player, FreezeComponent);
    if (freeze === undefined) throw new Error('QA: attacker lost its FreezeComponent');
    expect(freeze.remainingTicks).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * G1 · pause + resume                                                 *
 * ------------------------------------------------------------------ */
describe('G1 · the freeze pauses progress and resumes it (AC-02)', () => {
  it('resumes the state machine from the pre-freeze tick count (no reset, no skip)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { maxSpeed: MAX_SPEED });

    sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    sim.step(3); // ticks 0..2 — MOVING, counter advancing

    const state = sim.world.getComponent(player, StateComponent);
    if (state === undefined) throw new Error('QA: player is missing StateComponent');
    expect(state.state).toBe(ActionState.MOVING);
    const frozenAt = state.ticksInState;
    expect(frozenAt).toBeGreaterThan(0);

    const transform = sim.world.getComponent(player, TransformComponent);
    if (transform === undefined) throw new Error('QA: player is missing TransformComponent');
    const xAtFreeze = transform.x;

    applyFreeze(sim.world, player, DEFAULT_HITSTOP_TICKS);

    sim.step(DEFAULT_HITSTOP_TICKS); // the whole freeze — nothing advances, nothing moves
    expect(state.ticksInState).toBe(frozenAt);
    expect(transform.x).toBe(xAtFreeze);

    sim.step(1); // first tick after the freeze — resumes from `frozenAt`
    expect(state.ticksInState).toBe(frozenAt + 1);
    expect(transform.x).toBeGreaterThan(xAtFreeze);
  });

  it('suppresses movement intent while frozen', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { maxSpeed: MAX_SPEED });

    sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    sim.step(1); // tick 0 — moves a little
    const transform = sim.world.getComponent(player, TransformComponent);
    if (transform === undefined) throw new Error('QA: player is missing TransformComponent');
    const xBefore = transform.x;

    applyFreeze(sim.world, player, DEFAULT_HITSTOP_TICKS);
    // Keep holding the stick: a frozen entity must NOT respond to intent.
    sim.inject({ kind: 'move', tick: 1, vector: vec2(1, 0) });
    sim.step(DEFAULT_HITSTOP_TICKS); // ticks 1..N
    expect(transform.x).toBe(xBefore);
  });

  it('holds the attacker perfectly still while it keeps HOLDING the stick (residual intent is suppressed, not drifted)', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0

    // The attacker walked 5/60 BEFORE the swing, so its hitbox spawned at
    // (0.0833 + 0.75, 0) = (0.8333, 0): still 0.6667 < 1.5 from the enemy, so the
    // hit lands even though the attacker was moving.
    const xAfterTick0 = transformOf(rig, rig.player).x;
    expect(xAfterTick0).toBeCloseTo(MAX_SPEED * rig.sim.fixedDeltaSeconds, 9);
    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
    expect(stateOf(rig, rig.player).state).toBe(ActionState.ATTACKING);

    // Ticks 1..N: frozen. The hardware is STILL holding the stick (residual intent
    // exists) yet the entity must not drift by a single bit, and the state machine
    // must not advance.
    for (let i = 0; i < DEFAULT_HITSTOP_TICKS; i += 1) {
      rig.sim.step(1);
      expect(transformOf(rig, rig.player).x).toBe(xAfterTick0);
      expect(stateOf(rig, rig.player).ticksInState).toBe(0);

      const input = rig.sim.world.getComponent(rig.player, PlayerInputComponent);
      if (input === undefined) throw new Error('QA: player is missing PlayerInputComponent');
      expect(input.moveVector.x).toBe(1); // residual hardware intent is really there...
      expect(intentOf(rig, rig.player).moveVector.x).toBe(0); // ...but the logical intent is zeroed
    }

    // Tick N+1: recovery — the held stick drives movement again from the frozen spot.
    rig.sim.step(1);
    expect(transformOf(rig, rig.player).x).toBeGreaterThan(xAfterTick0);
    expect(intentOf(rig, rig.player).moveVector.x).toBe(1);
  });

  it('resumes the attacker on the REAL hit path and exits ATTACKING on tick 17', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0

    expect(stateOf(rig, rig.player).state).toBe(ActionState.ATTACKING);
    expect(stateOf(rig, rig.player).ticksInState).toBe(0);

    // Ticks 1..4: frozen, the counter is pinned at 0 (not reset to a stuck value).
    for (let i = 0; i < DEFAULT_HITSTOP_TICKS; i += 1) {
      rig.sim.step(1);
      expect(stateOf(rig, rig.player).state).toBe(ActionState.ATTACKING);
      expect(stateOf(rig, rig.player).ticksInState).toBe(0);
    }

    // Tick 5: resumes counting from 0 -> 1 (proves "continue", not "restart").
    rig.sim.step(1);
    expect(stateOf(rig, rig.player).ticksInState).toBe(1);

    // Tick 16: the counter reaches DEFAULT_ATTACK_DURATION_TICKS.
    rig.sim.step(DEFAULT_ATTACK_DURATION_TICKS - 1); // ticks 6..16
    expect(stateOf(rig, rig.player).state).toBe(ActionState.ATTACKING);
    expect(stateOf(rig, rig.player).ticksInState).toBe(DEFAULT_ATTACK_DURATION_TICKS);

    // Tick 17: ATTACKING ends (12 counts + 4 frozen + the entry tick = 17).
    rig.sim.step(1);
    expect(stateOf(rig, rig.player).state).toBe(ActionState.IDLE);
    expect(stateOf(rig, rig.player).ticksInState).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * G2 · hitstun + knockback                                            *
 * ------------------------------------------------------------------ */
describe('G2 · hitstun and forced knockback (AC-03)', () => {
  it('puts the victim in HITSTUN on the hit tick', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0

    expect(stateOf(rig, rig.enemy).state).toBe(ActionState.HITSTUN);
    // Seeded at 1: HITSTUN is entered by CollisionSystem (which runs after
    // StateSystem), so its entry tick is counted by seeding the counter at 1 —
    // this makes the observable stun span equal DEFAULT_HITSTUN_TICKS (spec 04 §4.4).
    expect(stateOf(rig, rig.enemy).ticksInState).toBe(1);
    expect(rig.sim.world.hasComponent(rig.enemy, KnockbackComponent)).toBe(true);
  });

  it('displaces the victim along the attack direction, independent of maxSpeed and intent', () => {
    // Enemy maxSpeed is deliberately huge: knockback must NOT use it.
    const rig = makeRig({ enemyMaxSpeed: 1000 });
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — hit lands, hitstop armed
    rig.sim.step(DEFAULT_HITSTOP_TICKS); // ticks 1..N — frozen, so no displacement yet

    const before = transformOf(rig, rig.enemy).x;

    // Steer the victim's intent BACKWARDS: forced knockback must ignore it.
    intentOf(rig, rig.enemy).moveVector = vec2(-1, 0);

    rig.sim.step(1); // tick N+1 — knockback begins
    const after = transformOf(rig, rig.enemy).x;
    const dt = rig.sim.fixedDeltaSeconds;

    // +x (away from the attacker), exactly knockbackForce * dt — NOT maxSpeed * dt.
    expect(after - before).toBeCloseTo(DEFAULT_KNOCKBACK_FORCE * dt, 9);
    expect(after - before).toBeGreaterThan(0);
    expect(Math.abs(after - before - (1000 * dt))).toBeGreaterThan(1);
  });

  it('holds HITSTUN for DEFAULT_HITSTUN_TICKS then returns to locomotion', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — HITSTUN entered (ticksInState = 0)

    // HITSTUN is frozen for the hitstop; it then counts its own duration.
    rig.sim.step(DEFAULT_HITSTOP_TICKS + DEFAULT_HITSTUN_TICKS + 1);
    expect(stateOf(rig, rig.enemy).state).not.toBe(ActionState.HITSTUN);
  });

  it('keeps the forced displacement out of the VelocityComponent (knockback is a separate channel)', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1);
    rig.sim.step(DEFAULT_HITSTOP_TICKS);
    rig.sim.step(1); // one knockback tick

    const knockback = rig.sim.world.getComponent(rig.enemy, KnockbackComponent);
    if (knockback === undefined) throw new Error('QA: enemy is missing KnockbackComponent');
    expect(knockback.velocity.x).toBeCloseTo(DEFAULT_KNOCKBACK_FORCE, 9);
    expect(Math.abs(knockback.velocity.y)).toBeLessThan(TOLERANCE);
  });

  it('sweeps exactly DEFAULT_HITSTUN_TICKS displacement ticks, totalling knockbackForce * hitstunTicks * dt', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0

    const startX = transformOf(rig, rig.enemy).x;
    let previous = startX;
    let movedTicks = 0;

    for (let i = 0; i < DEFAULT_HITSTOP_TICKS + DEFAULT_HITSTUN_TICKS; i += 1) {
      rig.sim.step(1); // ticks 1 .. 12
      const now = transformOf(rig, rig.enemy).x;
      if (now !== previous) movedTicks += 1;
      previous = now;
    }

    // Exactly 8 displacement ticks (ticks 5..12), then HITSTUN is over.
    expect(movedTicks).toBe(DEFAULT_HITSTUN_TICKS);
    const total = previous - startX;
    expect(total).toBeCloseTo(DEFAULT_KNOCKBACK_FORCE * DEFAULT_HITSTUN_TICKS * rig.sim.fixedDeltaSeconds, 9);
    expect(previous).toBeCloseTo(3.1, 9);
    expect(stateOf(rig, rig.enemy).state).not.toBe(ActionState.HITSTUN);
  });

  it('produces a BIT-IDENTICAL knockback displacement for enemy maxSpeed 0.5 vs 1000', () => {
    const run = (enemyMaxSpeed: number): number => {
      const rig = makeRig({ enemyMaxSpeed });
      rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
      rig.sim.step(1 + DEFAULT_HITSTOP_TICKS + DEFAULT_HITSTUN_TICKS); // ticks 0..12
      return transformOf(rig, rig.enemy).x;
    };

    const slow = run(0.5);
    const fast = run(1000);
    expect(slow).toBe(fast); // bit-identical — knockback never reads maxSpeed
    expect(slow).toBeCloseTo(3.1, 9);
  });

  it('produces a BIT-IDENTICAL displacement whether or not the victim holds a reverse intent', () => {
    // A global `move` event reaches only the PLAYER (the enemy owns no hardware),
    // so we write the victim's intent directly — exactly how an AI would steer it.
    const run = (reverse: boolean): number => {
      const rig = makeRig();
      rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
      rig.sim.step(1); // tick 0
      for (let i = 0; i < DEFAULT_HITSTOP_TICKS + DEFAULT_HITSTUN_TICKS; i += 1) {
        if (reverse) intentOf(rig, rig.enemy).moveVector = vec2(-1, 0); // hold "away from the hit"
        rig.sim.step(1); // ticks 1..12
      }
      return transformOf(rig, rig.enemy).x;
    };

    expect(run(true)).toBe(run(false)); // intent is ignored during HITSTUN
  });

  it('knocks the victim AWAY from the hitbox centre on a non-axial hit', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    // Enemy at (0.5, 1.0); hitbox centre (0.75, 0): distance hypot(-0.25, 1) = 1.031 < 1.5.
    const enemy = EnemyFactory.spawn(sim.world, { x: 0.5, y: 1.0, facingRadians: 0, maxSpeed: MAX_SPEED });
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // tick 0

    const knockback = sim.world.getComponent(enemy, KnockbackComponent);
    if (knockback === undefined) throw new Error('QA: enemy is missing KnockbackComponent');

    const expectedDir = normalizeVec2(vec2(0.5 - 0.75, 1.0 - 0)); // away from the hitbox centre
    expect(knockback.velocity.x).toBeCloseTo(expectedDir.x * DEFAULT_KNOCKBACK_FORCE, 9);
    expect(knockback.velocity.y).toBeCloseTo(expectedDir.y * DEFAULT_KNOCKBACK_FORCE, 9);
    expect(knockback.velocity.y).toBeGreaterThan(0); // pushed +y ...
    expect(knockback.velocity.x).toBeLessThan(0); // ... and -x, i.e. diagonally away

    sim.step(DEFAULT_HITSTOP_TICKS); // ticks 1..4 — frozen, no displacement
    const beforeX = transformOfSim(sim, enemy).x;
    const beforeY = transformOfSim(sim, enemy).y;
    sim.step(1); // tick 5 — one knockback tick
    const dx = transformOfSim(sim, enemy).x - beforeX;
    const dy = transformOfSim(sim, enemy).y - beforeY;

    expect(Math.hypot(dx, dy)).toBeCloseTo(DEFAULT_KNOCKBACK_FORCE * sim.fixedDeltaSeconds, 9);
    expect(dy).toBeGreaterThan(0);
    expect(dx).toBeLessThan(0);
  });

  it('falls back to the hitbox facing when the centres coincide (degenerate direction)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    // Enemy sits EXACTLY on the hitbox centre (0.75, 0): the away-vector degenerates,
    // so the direction must fall back to the hitbox facing (+x, facingRadians = 0).
    const enemy = EnemyFactory.spawn(sim.world, { x: 0.75, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // tick 0

    const knockback = sim.world.getComponent(enemy, KnockbackComponent);
    if (knockback === undefined) throw new Error('QA: enemy is missing KnockbackComponent');
    expect(knockback.velocity.x).toBeCloseTo(DEFAULT_KNOCKBACK_FORCE, 9);
    expect(Math.abs(knockback.velocity.y)).toBeLessThan(TOLERANCE);
  });
});

/* ------------------------------------------------------------------ *
 * G3 · deterministic replay                                           *
 * ------------------------------------------------------------------ */
describe('G3 · deterministic replay of the feedback path (AC-04)', () => {
  it('replays a hitstop + hitstun + knockback script identically, tick by tick', () => {
    const runScript = (): Snapshot[] => {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
      PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
      EnemyFactory.spawn(sim.world, { x: 1.5, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });

      sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
      sim.inject({ kind: 'keyDown', tick: 20, key: ATTACK_KEY });
      sim.inject({ kind: 'keyUp', tick: 22, key: ATTACK_KEY });

      const frames: Snapshot[] = [];
      for (let i = 0; i < 40; i += 1) {
        sim.step(1);
        frames.push(sim.snapshot());
      }
      return frames;
    };

    const a = runScript();
    const b = runScript();
    expect(a).toHaveLength(40);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]).toEqual(b[i]);
    }
    expect(a).toEqual(b);
  });
});

/* ------------------------------------------------------------------ *
 * G4 · pipeline order                                                 *
 * ------------------------------------------------------------------ */
describe('G4 · canonical pipeline order (AC-07)', () => {
  it('runs PlayerController -> Freeze -> Movement -> Dash -> State -> CombatAction -> Collision -> Lifespan', () => {
    expect(createDefaultSystems().map((system) => system.name)).toEqual([
      'PlayerControllerSystem',
      'FreezeSystem',
      'MovementSystem',
      'DashSystem',
      'StateSystem',
      'CombatActionSystem',
      'CollisionSystem',
      'LifespanSystem',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * G5 · invulnerable hits write no feedback                            *
 * ------------------------------------------------------------------ */
describe('G5 · an invulnerable hit produces ZERO feedback (spec §4.4 / §8)', () => {
  it('neither damages, freezes, stuns nor knocks back an Invulnerable victim', () => {
    const rig = makeRig();
    addTag(rig.sim.world, rig.enemy, INVULNERABLE_TAG);
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — the hitbox overlaps, but the target is invulnerable

    expect(hpOf(rig, rig.enemy)).toBe(DEFAULT_MAX_HP); // no damage
    expect(isFrozen(rig.sim.world, rig.enemy)).toBe(false); // no hitstop on the victim
    expect(isFrozen(rig.sim.world, rig.player)).toBe(false); // ... nor on the attacker
    expect(stateOf(rig, rig.enemy).state).not.toBe(ActionState.HITSTUN); // no hitstun
    expect(rig.sim.world.hasComponent(rig.enemy, KnockbackComponent)).toBe(false); // no knockback

    // The i-frame hit is ignored ENTIRELY: the victim is not even recorded in the
    // hit ledger, so the same hitbox can still connect once the window lapses.
    const hitboxes = hitboxesOf(rig.sim, Faction.Player);
    expect(hitboxes).toHaveLength(1);
    const hitboxId = hitboxes[0];
    if (hitboxId === undefined) throw new Error('QA: expected one player hitbox');
    const ledger = rig.sim.world.getComponent(hitboxId, HitboxComponent);
    if (ledger === undefined) throw new Error('QA: hitbox is missing HitboxComponent');
    expect(ledger.hitEntities).not.toContain(rig.enemy);
  });
});

/* ------------------------------------------------------------------ *
 * G6 · un-fireable pulses are consumed, never buffered                *
 * ------------------------------------------------------------------ */
describe('G6 · a pulse that cannot fire is consumed, never buffered (spec §4.2 / §8 / §5.1)', () => {
  it('clears an AI-driven dash pulse raised during the freeze so it cannot fire on recovery', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    // Far away so the frozen entity is isolated from any combat.
    const enemy = EnemyFactory.spawn(sim.world, { x: 50, y: 50, facingRadians: 0, maxSpeed: MAX_SPEED });
    sim.step(1); // tick 0

    applyFreeze(sim.world, enemy, DEFAULT_HITSTOP_TICKS); // arm a freeze as a hit would
    intentOfSim(sim, enemy).wantsToDash = true; // AI pulse raised at the START of the freeze

    sim.step(DEFAULT_HITSTOP_TICKS); // ticks 1..N — frozen; FreezeSystem clears the intent
    expect(stateOfSim(sim, enemy).state).not.toBe(ActionState.DASHING);
    expect(intentOfSim(sim, enemy).wantsToDash).toBe(false); // the pulse was actually cleared

    sim.step(1); // tick N+1 — recovery: the buffered pulse must NOT fire
    expect(stateOfSim(sim, enemy).state).not.toBe(ActionState.DASHING);

    // A FRESH pulse after the freeze is honoured — suppression is not permanent.
    intentOfSim(sim, enemy).wantsToDash = true;
    sim.step(1); // tick N+2
    expect(stateOfSim(sim, enemy).state).toBe(ActionState.DASHING);
  });

  it('does not buffer a player key press made during the freeze, but a fresh press still works', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    sim.step(1); // tick 0
    applyFreeze(sim.world, player, DEFAULT_HITSTOP_TICKS);

    sim.inject({ kind: 'keyDown', tick: 1, key: DASH_KEY }); // pressed mid-freeze
    sim.step(DEFAULT_HITSTOP_TICKS); // ticks 1..4
    expect(stateOfSim(sim, player).state).not.toBe(ActionState.DASHING);

    sim.step(1); // tick 5 — recovery; the key is still held, so no NEW edge => no dash
    expect(stateOfSim(sim, player).state).not.toBe(ActionState.DASHING);

    // Release + fresh press after the freeze: the dash must fire normally.
    sim.inject({ kind: 'keyUp', tick: 6, key: DASH_KEY });
    sim.inject({ kind: 'keyDown', tick: 7, key: DASH_KEY });
    sim.step(2); // ticks 6, 7
    expect(stateOfSim(sim, player).state).toBe(ActionState.DASHING);
  });

  it('refuses to let a dash pulse cancel HITSTUN (F1 regression): consumed, not honoured', () => {
    // Dash entry is gated to IDLE/MOVING (spec 02 §4.1), so a stun must survive a
    // dash pulse. This is the F1 hole the QA adversarial pass opened.
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — the hit lands: the enemy enters HITSTUN and is frozen
    rig.sim.step(DEFAULT_HITSTOP_TICKS); // ticks 1..4 — frozen, so no pulse can be read
    rig.sim.step(1); // tick 5 — recovery: HITSTUN is still counting, no longer frozen

    // An AI/script raises the victim's dash pulse WHILE it is stunned.
    intentOf(rig, rig.enemy).wantsToDash = true;
    rig.sim.step(1); // tick 6
    expect(stateOf(rig, rig.enemy).state).toBe(ActionState.HITSTUN); // stun NOT cancelled
    expect(intentOf(rig, rig.enemy).wantsToDash).toBe(false); // pulse consumed + dropped

    // The stun still runs its full DEFAULT_HITSTUN_TICKS and returns to locomotion
    // (IDLE) at the end of tick 12 (spec 04 §6.2).
    rig.sim.step(6); // ticks 7..12
    expect(stateOf(rig, rig.enemy).state).toBe(ActionState.IDLE);

    // Suppression is NOT permanent: a FRESH pulse raised once back in locomotion
    // (past tick 13) fires normally.
    rig.sim.step(1); // tick 13 — settled in IDLE
    intentOf(rig, rig.enemy).wantsToDash = true;
    rig.sim.step(1); // tick 14
    expect(stateOf(rig, rig.enemy).state).toBe(ActionState.DASHING);
  });

  it('refuses to let a dash pulse cancel ATTACKING (F2 regression): no attack-cancel', () => {
    // spec 02 §4.1 gates dash entry to IDLE/MOVING; spec 03 §1.3 puts attack-cancel
    // out of scope. This is the F2 hole (M2-T01 lineage) the QA adversarial pass opened.
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — the swing lands: the player is ATTACKING and frozen
    rig.sim.step(DEFAULT_HITSTOP_TICKS); // ticks 1..4 — frozen

    // Press dash WHILE the swing is still committed (recovery tick 5).
    rig.sim.inject({ kind: 'keyDown', tick: 5, key: DASH_KEY });
    rig.sim.step(1); // tick 5
    expect(stateOf(rig, rig.player).state).toBe(ActionState.ATTACKING); // not cancelled
    expect(intentOf(rig, rig.player).wantsToDash).toBe(false); // pulse consumed + dropped

    // ATTACKING honours its full commitment window and exits on tick 17
    // (12 counts + 4 frozen + the entry tick — see G1).
    rig.sim.step(12); // ticks 6..17
    expect(stateOf(rig, rig.player).state).toBe(ActionState.IDLE);

    // Release + fresh press once back in locomotion: the dash must fire normally.
    rig.sim.inject({ kind: 'keyUp', tick: 18, key: DASH_KEY });
    rig.sim.inject({ kind: 'keyDown', tick: 19, key: DASH_KEY });
    rig.sim.step(2); // ticks 18, 19
    expect(stateOf(rig, rig.player).state).toBe(ActionState.DASHING);
  });
});

/* ------------------------------------------------------------------ *
 * G7 · configuration boundaries                                       *
 * ------------------------------------------------------------------ */
describe('G7 · hitstopTicks / knockbackForce configuration boundaries (spec §3.6)', () => {
  it('hitstopTicks = 0 lands the hit but freezes NEITHER side', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, { x: 1.5, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });

    const hitbox = sim.world.createEntity();
    sim.world.addComponent(hitbox.id, new TransformComponent(0.75, 0, 0));
    sim.world.addComponent(
      hitbox.id,
      new HitboxComponent(
        DEFAULT_ATTACK_HITBOX_RADIUS,
        DEFAULT_ATTACK_DAMAGE,
        DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS,
        Faction.Player,
        player,
        0, // hitstopTicks
        DEFAULT_KNOCKBACK_FORCE,
      ),
    );

    sim.step(1); // tick 0

    expect(hpOfSim(sim, enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE); // hit still lands
    expect(stateOfSim(sim, enemy).state).toBe(ActionState.HITSTUN); // hitstun still applies
    expect(isFrozen(sim.world, enemy)).toBe(false); // ... but no freeze ...
    expect(isFrozen(sim.world, player)).toBe(false); // ... on either side
  });

  it('knockbackForce = 0 pins the victim in place, so the persistent overlap must still deal damage only ONCE', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, { x: 1.5, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });

    const hitbox = sim.world.createEntity();
    sim.world.addComponent(hitbox.id, new TransformComponent(0.75, 0, 0));
    sim.world.addComponent(
      hitbox.id,
      new HitboxComponent(
        DEFAULT_ATTACK_HITBOX_RADIUS,
        DEFAULT_ATTACK_DAMAGE,
        DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS,
        Faction.Player,
        player,
        DEFAULT_HITSTOP_TICKS,
        0, // knockbackForce
      ),
    );

    sim.step(DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS - 1); // ticks 0..13 — hitbox alive throughout

    // The victim never moves, so the circles overlap on EVERY one of those ticks.
    // If the multi-hit guard were broken, hp would drop again and again.
    expect(hpOfSim(sim, enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
    expect(transformOfSim(sim, enemy).x).toBe(1.5); // pinned

    const ledger = sim.world.getComponent(hitbox.id, HitboxComponent);
    if (ledger === undefined) throw new Error('QA: hitbox is missing HitboxComponent');
    expect(ledger.hitEntities).toEqual([enemy]); // exactly one recorded strike

    // Proof the guard (not distance) is what prevented the re-hit: still overlapping.
    const hitboxX = transformOfSim(sim, hitbox.id).x;
    expect(Math.abs(transformOfSim(sim, enemy).x - hitboxX)).toBeLessThan(
      DEFAULT_ATTACK_HITBOX_RADIUS + 0.5,
    );
  });
});

/* ------------------------------------------------------------------ *
 * G8 · applyFreeze / isFrozen semantics                               *
 * ------------------------------------------------------------------ */
describe('G8 · applyFreeze / isFrozen free-function semantics (spec §3.3)', () => {
  it('mounts lazily, only ever extends an existing freeze, and no-ops for ticks <= 0', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const id = sim.world.createEntity().id;

    expect(sim.world.getComponent(id, FreezeComponent)).toBeUndefined();
    expect(isFrozen(sim.world, id)).toBe(false); // a missing component is "not frozen"

    // Non-positive ticks are no-ops — they must NOT even mount the component.
    applyFreeze(sim.world, id, 0);
    applyFreeze(sim.world, id, -3);
    expect(sim.world.getComponent(id, FreezeComponent)).toBeUndefined();

    // A real freeze arms `ticks + 1` (one tick high, so exactly `ticks` are observable).
    applyFreeze(sim.world, id, DEFAULT_HITSTOP_TICKS);
    const freeze = sim.world.getComponent(id, FreezeComponent);
    if (freeze === undefined) throw new Error('QA: applyFreeze did not mount FreezeComponent');
    expect(freeze.remainingTicks).toBe(DEFAULT_HITSTOP_TICKS + 1);
    expect(isFrozen(sim.world, id)).toBe(true);

    // A shorter re-freeze never SHORTENS the in-flight one (max, not assignment).
    applyFreeze(sim.world, id, 2); // max(5, 3) = 5
    expect(freeze.remainingTicks).toBe(DEFAULT_HITSTOP_TICKS + 1);

    // A longer re-freeze extends it.
    applyFreeze(sim.world, id, 10); // max(5, 11) = 11
    expect(freeze.remainingTicks).toBe(11);

    // Once the countdown lapses the component SURVIVES with remainingTicks === 0
    // (no snapshot churn) and isFrozen flips back to false.
    sim.step(11);
    expect(sim.world.hasComponent(id, FreezeComponent)).toBe(true);
    expect(freeze.remainingTicks).toBe(0);
    expect(isFrozen(sim.world, id)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * G9 · IntentComponent pulse vs persistent semantics                  *
 * ------------------------------------------------------------------ */
describe('G9 · IntentComponent pulse / persistent semantics (spec §3.1)', () => {
  it('clears the dash and attack pulses once a consumer reads them (one-tick wide)', () => {
    const attackSim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const attacker = PlayerFactory.spawn(attackSim.world, { maxSpeed: MAX_SPEED });
    attackSim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    attackSim.step(1);
    expect(intentOfSim(attackSim, attacker).wantsToAttack).toBe(false); // consumed by CombatActionSystem

    const dashSim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const dasher = PlayerFactory.spawn(dashSim.world, { maxSpeed: MAX_SPEED });
    dashSim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    dashSim.step(1);
    expect(intentOfSim(dashSim, dasher).wantsToDash).toBe(false); // consumed by DashSystem
  });

  it('keeps moveVector persistent across empty input frames', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { maxSpeed: MAX_SPEED });
    sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    sim.step(5); // ticks 0..4, four of them with no input frame at all

    expect(intentOfSim(sim, player).moveVector.x).toBe(1);
    expect(intentOfSim(sim, player).moveVector.y).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * G10 · intent-decoupling guard                                       *
 * ------------------------------------------------------------------ */
describe('G10 · intent-decoupling guard: the global input frame drives the PLAYER only (AC-06)', () => {
  it('gives PlayerInputComponent to the player but not the enemy', () => {
    const rig = makeRig();
    expect(rig.sim.world.hasComponent(rig.player, PlayerInputComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(rig.enemy, PlayerInputComponent)).toBe(false);
  });

  it('cannot make the enemy dash, attack or move from the global input frame', () => {
    const rig = makeRig();
    const enemyX0 = transformOf(rig, rig.enemy).x;

    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(-1, 0) });
    rig.sim.step(1);

    // Control: the frame WAS delivered and the player reacted to it.
    expect(stateOf(rig, rig.player).state).toBe(ActionState.DASHING);

    // The enemy owns no hardware input, so none of it reaches the enemy.
    expect(stateOf(rig, rig.enemy).state).not.toBe(ActionState.DASHING);
    expect(stateOf(rig, rig.enemy).state).not.toBe(ActionState.ATTACKING);
    expect(transformOf(rig, rig.enemy).x).toBe(enemyX0);
    expect(hitboxesOf(rig.sim, Faction.Enemy)).toHaveLength(0);
  });
});
