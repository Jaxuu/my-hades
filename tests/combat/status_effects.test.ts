/**
 * M3-T02 · Status-effect / damage-over-time acceptance tests.
 * See specs/06_status_effect_and_dot_spec.md §6 (tick-by-tick contract) and §7
 * (AC-01 .. AC-10).
 *
 * Fresh-eyes harness suite: every behavioural assertion drives the REAL
 * GameSimulator with the canonical pipeline
 * (PlayerControllerSystem -> FreezeSystem -> MovementSystem -> DashSystem ->
 * StateSystem -> CombatActionSystem -> CollisionSystem -> StatusEffectSystem ->
 * ModifierSystem -> LifespanSystem) and REAL prefab-assembled entities. Nothing is
 * mocked, and ticks are advanced one at a time so the timing contract is pinned
 * per tick rather than only at the end.
 *
 * ── Tick derivation (this is the whole point of the suite, T = application tick) ──
 *
 * Geometry: player at (0, 0) facing +x attacks on tick 0; its hitbox is centred at
 * (0.75, 0) with radius 1.0, and the enemy (hurtbox radius 0.5) at (1.5, 0) is
 * within the 1.5 reach, so the base hit lands on tick 0.
 *
 * The status is applied by DionysusBlightModifier INSIDE ModifierSystem, which runs
 * AFTER StatusEffectSystem. Therefore the application tick T is NOT counted by the
 * status clock — the first countdown step happens on T+1. That single positional
 * fact is what makes every number below read exactly as the spec words it:
 *
 *   damage tick #k  lands on  T + k * DEFAULT_POISON_INTERVAL_TICKS
 *   the status is cleared at the END of  T + DEFAULT_POISON_DURATION_TICKS
 *
 * With interval 30 / duration 120 (an exact multiple) a single application produces
 * exactly FOUR damage ticks — at ticks 30, 60, 90, 120 — the last one landing on the
 * very tick the status expires. Total 4 * 4 = 16 damage.
 *
 * Had StatusEffectSystem been placed after ModifierSystem, every one of those
 * numbers would silently be one tick short; G4 pins that with explicit
 * "no damage before tick 30 / none after tick 120" assertions.
 *
 * Multi-hit rigs: the base attack also knocks the victim back 1.6 world units, so a
 * rig that must land a SECOND deliberate hit spawns the enemy with an inflated
 * `hurtboxRadius` — a test-rig concern only, so the victim stays inside the swing's
 * reach without any gameplay constant being touched.
 *
 * Grouping:
 *   G0 · StatusEffectComponent + free functions (lazy mount, stacks, cap)   (AC-01)
 *   G1 · Dionysus Blight applies poison on a landed hit                     (AC-02)
 *   G2 · stacking + duration refresh                                        (AC-02)
 *   G3 · stack cap (six hits against a cap of five)                         (AC-02)
 *   G4 · DoT tick timing: exact damage ticks, exact expiry                  (AC-03)
 *   G5 · DoT is TRUE damage: zero hitstop / hitstun / hitbox / HitEvent     (AC-03)
 *   G6 · the modifier REGISTRY contract (M3-T02 task 1)                     (AC-04)
 *   G7 · pipeline order + deterministic replay                              (AC-08/09)
 */

import { describe, expect, it } from 'vitest';
import {
  ATTACK_KEY,
  ActionState,
  BURN_STATUS_ID,
  CollisionSystem,
  CombatActionSystem,
  DEFAULT_ATTACK_DAMAGE,
  DEFAULT_MAX_HP,
  DEFAULT_POISON_DAMAGE_PER_STACK,
  DEFAULT_POISON_DURATION_TICKS,
  DEFAULT_POISON_INTERVAL_TICKS,
  DEFAULT_POISON_MAX_STACKS,
  DIONYSUS_BLIGHT_MODIFIER,
  DashSystem,
  DionysusBlightModifier,
  EnemyFactory,
  EventQueue,
  FreezeSystem,
  GameSimulator,
  HealthComponent,
  HitboxComponent,
  LifespanSystem,
  ModifierRegistry,
  ModifierSystem,
  MovementSystem,
  POISON_STATUS_ID,
  POISON_STATUS_SPEC,
  PlayerControllerSystem,
  PlayerFactory,
  StateComponent,
  StateSystem,
  StatusEffectComponent,
  StatusEffectSystem,
  TransformComponent,
  VULNERABLE_STATUS_ID,
  ZEUS_STRIKE_MODIFIER,
  ZeusStrikeModifier,
  addModifier,
  applyStatusEffect,
  createDefaultModifierRegistry,
  createDefaultSystems,
  getStatusEffect,
  hasStatusEffect,
  isFrozen,
  removeStatusEffect,
  vec2,
} from '../../src';
import type {
  EntityId,
  HitEvent,
  IModifierHandler,
  ModifierContext,
  Snapshot,
  StatusEffectSpec,
  System,
  SystemContext,
  World,
} from '../../src';

const FPS = 60;
const ENEMY_X = 1.5;

/**
 * Ticks between two consecutive attacks of the same player, measured on the real
 * pipeline: the attack commits for 12 non-frozen ticks, and the hitstop of the
 * landing blow freezes the attacker for 4 more. Recovery happens on tick 5, so the
 * state machine has counted 12 ticks by tick 16 and hands control back on tick 17.
 */
const ATTACK_CYCLE_TICKS = 17;

/** A rig that lands its base hit on tick 0 and poisons the enemy. */
interface Rig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
  readonly enemy: EntityId;
}

interface RigOptions {
  /** Inflate the victim's hurtbox so a later, deliberate hit can still connect. */
  readonly enemyHurtboxRadius?: number;
  /** Raise the victim's ceiling so long DoT runs stay observable. */
  readonly enemyMaxHp?: number;
  /** Grant `zeus_strike` alongside `dionysus_strike`. */
  readonly alsoZeus?: boolean;
}

function makeRig(options: RigOptions = {}): Rig {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: 5 });
  const enemy = EnemyFactory.spawn(sim.world, {
    x: ENEMY_X,
    y: 0,
    facingRadians: 0,
    maxSpeed: 5,
    // Conditional spreads: `exactOptionalPropertyTypes` forbids passing an explicit
    // `undefined` for an optional field.
    ...(options.enemyHurtboxRadius === undefined
      ? {}
      : { hurtboxRadius: options.enemyHurtboxRadius }),
    ...(options.enemyMaxHp === undefined ? {} : { maxHp: options.enemyMaxHp }),
  });
  addModifier(sim.world, player, DIONYSUS_BLIGHT_MODIFIER);
  if (options.alsoZeus ?? false) addModifier(sim.world, player, ZEUS_STRIKE_MODIFIER);
  return { sim, player, enemy };
}

/**
 * Schedule a press-and-release attack on `tick`.
 *
 * The release has to be a separate, earlier event: the attack pulse is a rising
 * EDGE, so holding the key down would never produce a second attack (spec 03 §4.3).
 * The release is placed `ATTACK_CYCLE_TICKS - 1` ticks earlier, i.e. while the
 * previous attack is still committed — and, crucially, on a tick where the player is
 * frozen, which proves input binding is not freeze-gated.
 */
function scheduleAttack(sim: GameSimulator, tick: number): void {
  if (tick > 0) {
    sim.inject({ kind: 'keyUp', tick: tick - (ATTACK_CYCLE_TICKS - 1), key: ATTACK_KEY });
  }
  sim.inject({ kind: 'keyDown', tick, key: ATTACK_KEY });
}

/* --- traces --------------------------------------------------------------- */

function hpOf(sim: GameSimulator, id: EntityId): number {
  const health = sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: entity is missing HealthComponent');
  return health.hp;
}

function enemyHp(rig: Rig): number {
  return hpOf(rig.sim, rig.enemy);
}

/**
 * Step `ticks` ticks and return the enemy's hp after each one. `trace[i]` is the hp
 * at the END of the tick that `rig.sim` was about to run, so the caller knows the
 * absolute tick window it just sampled (and passes it to {@link changeTicks}).
 */
function hpTrace(rig: Rig, ticks: number): number[] {
  const trace: number[] = [];
  for (let i = 0; i < ticks; i += 1) {
    rig.sim.step(1);
    trace.push(enemyHp(rig));
  }
  return trace;
}

/**
 * Absolute ticks on which the value changed. `trace[0]` is tick `firstTick`, so a
 * trace that starts at tick 18 reports tick 47 — not array index 30.
 */
function changeTicks(baseline: number, trace: readonly number[], firstTick = 1): number[] {
  const ticks: number[] = [];
  let previous = baseline;
  for (const [index, value] of trace.entries()) {
    if (value !== previous) {
      ticks.push(firstTick + index);
      previous = value;
    }
  }
  return ticks;
}

/** Absolute ticks whose frame satisfies `predicate`. `frames[0]` is tick `firstTick`. */
function ticksWhere<T>(
  frames: readonly T[],
  predicate: (frame: T) => boolean,
  firstTick = 1,
): number[] {
  const ticks: number[] = [];
  for (const [index, frame] of frames.entries()) {
    if (predicate(frame)) ticks.push(firstTick + index);
  }
  return ticks;
}

interface FeedbackTrace {
  readonly hp: number;
  readonly enemyX: number;
  readonly frozen: boolean;
  readonly state: ActionState;
}

function feedbackTrace(rig: Rig, ticks: number): FeedbackTrace[] {
  const trace: FeedbackTrace[] = [];
  for (let i = 0; i < ticks; i += 1) {
    rig.sim.step(1);
    const state = rig.sim.world.getComponent(rig.enemy, StateComponent);
    if (state === undefined) throw new Error('QA: enemy is missing StateComponent');
    const transform = rig.sim.world.getComponent(rig.enemy, TransformComponent);
    if (transform === undefined) throw new Error('QA: enemy is missing TransformComponent');
    trace.push({
      hp: enemyHp(rig),
      enemyX: transform.x,
      frozen: isFrozen(rig.sim.world, rig.enemy),
      state: state.state,
    });
  }
  return trace;
}

function ctxAt(tick: number): SystemContext {
  return { tick, elapsedSeconds: tick * (1 / FPS), fixedDeltaSeconds: 1 / FPS, input: [] };
}

/* ------------------------------------------------------------------ *
 * G0 · StatusEffectComponent + free functions                         *
 * ------------------------------------------------------------------ */
describe('G0 · StatusEffectComponent stores many statuses (AC-01)', () => {
  it('mounts lazily and records stacks / cap / duration / interval', () => {
    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;

    expect(sim.world.getComponent(id, StatusEffectComponent)).toBeUndefined();
    expect(hasStatusEffect(sim.world, id, POISON_STATUS_ID)).toBe(false);

    applyStatusEffect(sim.world, id, POISON_STATUS_SPEC);

    const effect = getStatusEffect(sim.world, id, POISON_STATUS_ID);
    if (effect === undefined) throw new Error('QA: applyStatusEffect did not mount the status');
    expect(effect.stacks).toBe(1);
    expect(effect.maxStacks).toBe(DEFAULT_POISON_MAX_STACKS);
    expect(effect.remainingTicks).toBe(DEFAULT_POISON_DURATION_TICKS);
    expect(effect.intervalTicks).toBe(DEFAULT_POISON_INTERVAL_TICKS);
    expect(effect.ticksUntilProc).toBe(DEFAULT_POISON_INTERVAL_TICKS);
    expect(effect.damagePerStack).toBe(DEFAULT_POISON_DAMAGE_PER_STACK);
  });

  it('holds SEVERAL statuses at once, sorted by id and unique by id', () => {
    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;

    const vulnerable: StatusEffectSpec = {
      id: VULNERABLE_STATUS_ID,
      maxStacks: 1,
      durationTicks: 60,
      intervalTicks: 60,
      damagePerStack: 0,
    };
    const burn: StatusEffectSpec = {
      id: BURN_STATUS_ID,
      maxStacks: 3,
      durationTicks: 90,
      intervalTicks: 45,
      damagePerStack: 2,
    };

    applyStatusEffect(sim.world, id, POISON_STATUS_SPEC);
    applyStatusEffect(sim.world, id, vulnerable);
    applyStatusEffect(sim.world, id, burn);

    const component = sim.world.getComponent(id, StatusEffectComponent);
    if (component === undefined) throw new Error('QA: entity is missing StatusEffectComponent');
    expect(component.effects.map((effect) => effect.id)).toEqual([
      BURN_STATUS_ID, // 'burn'
      POISON_STATUS_ID, // 'poison'
      VULNERABLE_STATUS_ID, // 'vulnerable'
    ]);
    // Multiplicity lives in `stacks`, never in duplicated entries.
    expect(component.effects).toHaveLength(3);
    expect(hasStatusEffect(sim.world, id, BURN_STATUS_ID)).toBe(true);
  });

  it('stacks on re-application and CLAMPS at maxStacks', () => {
    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;

    for (let i = 0; i < 3; i += 1) applyStatusEffect(sim.world, id, POISON_STATUS_SPEC);
    expect(getStatusEffect(sim.world, id, POISON_STATUS_ID)?.stacks).toBe(3);

    for (let i = 0; i < 5; i += 1) applyStatusEffect(sim.world, id, POISON_STATUS_SPEC);
    expect(getStatusEffect(sim.world, id, POISON_STATUS_ID)?.stacks).toBe(DEFAULT_POISON_MAX_STACKS);
  });

  it('removes one status without unmounting the component (stable snapshot shape)', () => {
    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;
    applyStatusEffect(sim.world, id, POISON_STATUS_SPEC);

    removeStatusEffect(sim.world, id, POISON_STATUS_ID);
    expect(hasStatusEffect(sim.world, id, POISON_STATUS_ID)).toBe(false);
    expect(sim.world.hasComponent(id, StatusEffectComponent)).toBe(true);
    removeStatusEffect(sim.world, id, 'not_running'); // no-op, must not throw
  });

  it('rejects an unusable spec, and ignores a dead entity instead of throwing', () => {
    const sim = new GameSimulator();
    const dead = sim.world.createEntity().id;
    sim.world.destroyEntity(dead);
    applyStatusEffect(sim.world, dead, POISON_STATUS_SPEC); // no throw, no component
    expect(sim.world.hasComponent(dead, StatusEffectComponent)).toBe(false);

    const alive = sim.world.createEntity().id;
    expect(() =>
      applyStatusEffect(sim.world, alive, { ...POISON_STATUS_SPEC, intervalTicks: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      applyStatusEffect(sim.world, alive, { ...POISON_STATUS_SPEC, maxStacks: 0 }),
    ).toThrow(RangeError);
  });

  it('mounts an EMPTY StatusEffectComponent on every prefab-assembled combatant', () => {
    const rig = makeRig();
    for (const id of [rig.player, rig.enemy]) {
      const component = rig.sim.world.getComponent(id, StatusEffectComponent);
      if (component === undefined) throw new Error('QA: combatant is missing StatusEffectComponent');
      expect(component.effects).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * G1 · Dionysus Blight applies poison                                 *
 * ------------------------------------------------------------------ */
describe('G1 · Dionysus Blight poisons the victim on a landed hit (AC-02)', () => {
  it('applies one stack on the hit tick, and nothing before it', () => {
    const rig = makeRig();
    expect(hasStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID)).toBe(false);

    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — base hit lands, ModifierSystem poisons the victim

    expect(enemyHp(rig)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE); // 90
    const effect = getStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID);
    if (effect === undefined) throw new Error('QA: expected the victim to be poisoned');
    expect(effect.stacks).toBe(1);
    expect(effect.maxStacks).toBe(DEFAULT_POISON_MAX_STACKS);
    // The application tick is NOT counted by the status clock (StatusEffectSystem
    // already ran this tick), so both timers are still at their seeded values.
    expect(effect.remainingTicks).toBe(DEFAULT_POISON_DURATION_TICKS);
    expect(effect.ticksUntilProc).toBe(DEFAULT_POISON_INTERVAL_TICKS);
  });

  it('does not poison when the ATTACKER lacks the boon', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: 5 });
    const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: 5 });
    addModifier(sim.world, enemy, DIONYSUS_BLIGHT_MODIFIER); // the VICTIM holds it

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(20);

    expect(hasStatusEffect(sim.world, enemy, POISON_STATUS_ID)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * G2 · stacking + refresh                                             *
 * ------------------------------------------------------------------ */
describe('G2 · a second hit stacks and RESTARTS the clock (AC-02)', () => {
  it('doubles the per-tick damage and re-measures the duration from hit 2', () => {
    const rig = makeRig({ enemyHurtboxRadius: 30 });
    scheduleAttack(rig.sim, 0);
    scheduleAttack(rig.sim, ATTACK_CYCLE_TICKS);

    rig.sim.step(1); // tick 0 — hit 1
    expect(enemyHp(rig)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE); // 90
    expect(getStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID)?.stacks).toBe(1);

    rig.sim.step(ATTACK_CYCLE_TICKS - 1); // ticks 1..16
    expect(enemyHp(rig)).toBe(90); // no damage tick yet — the interval is 30

    rig.sim.step(1); // tick 17 — hit 2
    expect(enemyHp(rig)).toBe(90 - DEFAULT_ATTACK_DAMAGE); // 80
    const stacked = getStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID);
    if (stacked === undefined) throw new Error('QA: expected the victim to still be poisoned');
    expect(stacked.stacks).toBe(2);
    // BOTH timers are re-seeded, so the countdown restarts from THIS hit.
    expect(stacked.remainingTicks).toBe(DEFAULT_POISON_DURATION_TICKS);
    expect(stacked.ticksUntilProc).toBe(DEFAULT_POISON_INTERVAL_TICKS);

    // Damage ticks now land at 17 + k*30 -> 47, 77, 107, 137, at DOUBLE the damage.
    const trace = hpTrace(rig, 150); // ticks 18..167
    expect(changeTicks(80, trace, 18)).toEqual([
      ATTACK_CYCLE_TICKS + DEFAULT_POISON_INTERVAL_TICKS,
      ATTACK_CYCLE_TICKS + 2 * DEFAULT_POISON_INTERVAL_TICKS,
      ATTACK_CYCLE_TICKS + 3 * DEFAULT_POISON_INTERVAL_TICKS,
      ATTACK_CYCLE_TICKS + 4 * DEFAULT_POISON_INTERVAL_TICKS,
    ]);

    const perTick = DEFAULT_POISON_DAMAGE_PER_STACK * 2;
    expect(perTick).toBe(2 * DEFAULT_POISON_DAMAGE_PER_STACK); // "跳字伤害翻倍"
    expect(enemyHp(rig)).toBe(80 - 4 * perTick); // 48
  });

  it('keeps the status alive past the FIRST application lifetime (proof of refresh)', () => {
    const rig = makeRig({ enemyHurtboxRadius: 30 });
    scheduleAttack(rig.sim, 0);
    scheduleAttack(rig.sim, ATTACK_CYCLE_TICKS);

    rig.sim.step(130); // ticks 0..129
    // A single application would have expired at the END of tick 120.
    expect(hasStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID)).toBe(true);

    rig.sim.step(7); // ticks 130..136
    expect(hasStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID)).toBe(true);

    rig.sim.step(1); // tick 137 — the last damage tick AND the expiry tick
    expect(hasStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * G3 · stack cap                                                      *
 * ------------------------------------------------------------------ */
describe('G3 · six hits against a cap of five stop at five stacks (AC-02)', () => {
  it('clamps at DEFAULT_POISON_MAX_STACKS and deals cap-sized damage ticks', () => {
    const rig = makeRig({ enemyHurtboxRadius: 40, enemyMaxHp: 1000 });
    for (let i = 0; i < 6; i += 1) scheduleAttack(rig.sim, i * ATTACK_CYCLE_TICKS);

    rig.sim.step(1); // tick 0 — hit 1
    for (let hit = 1; hit < 6; hit += 1) {
      rig.sim.step(ATTACK_CYCLE_TICKS); // ticks ... -> hit `hit + 1` lands
      const effect = getStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID);
      if (effect === undefined) throw new Error('QA: expected the victim to be poisoned');
      expect(effect.stacks).toBe(Math.min(hit + 1, DEFAULT_POISON_MAX_STACKS));
    }

    // Tick 85: six applications, five stacks — the cap held.
    const capped = getStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID);
    if (capped === undefined) throw new Error('QA: expected the victim to be poisoned');
    expect(capped.stacks).toBe(DEFAULT_POISON_MAX_STACKS);
    expect(capped.stacks).toBe(5);

    // The next damage tick (85 + 30 = 115) deals exactly cap * per-stack damage.
    rig.sim.step(DEFAULT_POISON_INTERVAL_TICKS - 1); // ticks 86..114
    const beforeProc = enemyHp(rig);
    rig.sim.step(1); // tick 115
    expect(beforeProc - enemyHp(rig)).toBe(
      DEFAULT_POISON_MAX_STACKS * DEFAULT_POISON_DAMAGE_PER_STACK,
    );
  });
});

/* ------------------------------------------------------------------ *
 * G4 · DoT tick timing                                                *
 * ------------------------------------------------------------------ */
describe('G4 · the DoT ticks on the exact interval and expires on time (AC-03)', () => {
  it('deals exactly four damage ticks, 30 ticks apart, then stops forever', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — the base hit

    const trace = hpTrace(rig, 160); // ticks 1..160
    expect(changeTicks(90, trace)).toEqual([
      DEFAULT_POISON_INTERVAL_TICKS, // 30
      2 * DEFAULT_POISON_INTERVAL_TICKS, // 60
      3 * DEFAULT_POISON_INTERVAL_TICKS, // 90
      4 * DEFAULT_POISON_INTERVAL_TICKS, // 120
    ]);
    expect(DEFAULT_POISON_DURATION_TICKS).toBe(4 * DEFAULT_POISON_INTERVAL_TICKS);

    const totalDot = 4 * DEFAULT_POISON_DAMAGE_PER_STACK;
    expect(enemyHp(rig)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE - totalDot); // 74
    expect(enemyHp(rig)).toBe(74);

    // ... and the status is gone, so ticks 121..160 must be flat.
    expect(hasStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID)).toBe(false);
  });

  it('counts down one tick per tick, reloading the proc counter after each tick', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0

    rig.sim.step(1); // tick 1 — the first countdown step
    const afterOne = getStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID);
    if (afterOne === undefined) throw new Error('QA: expected the victim to be poisoned');
    expect(afterOne.remainingTicks).toBe(DEFAULT_POISON_DURATION_TICKS - 1);
    expect(afterOne.ticksUntilProc).toBe(DEFAULT_POISON_INTERVAL_TICKS - 1);

    rig.sim.step(DEFAULT_POISON_INTERVAL_TICKS - 2); // ticks 2..29
    const justBefore = getStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID);
    if (justBefore === undefined) throw new Error('QA: expected the victim to be poisoned');
    expect(justBefore.ticksUntilProc).toBe(1);
    expect(enemyHp(rig)).toBe(90); // the damage tick has not happened yet

    rig.sim.step(1); // tick 30 — the damage tick
    const afterProc = getStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID);
    if (afterProc === undefined) throw new Error('QA: expected the victim to be poisoned');
    expect(enemyHp(rig)).toBe(90 - DEFAULT_POISON_DAMAGE_PER_STACK); // 86
    expect(afterProc.ticksUntilProc).toBe(DEFAULT_POISON_INTERVAL_TICKS); // reloaded
  });
});

/* ------------------------------------------------------------------ *
 * G5 · DoT is TRUE damage                                             *
 * ------------------------------------------------------------------ */
describe('G5 · the DoT applies damage and NOTHING else (AC-03)', () => {
  it('never freezes or stuns the victim, and never injects a hitbox or an entity', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — the base hit, so the trace below starts at tick 1

    const early = feedbackTrace(rig, 20); // ticks 1..20
    // By tick 20 the base hitbox (15-tick lifespan) is long gone.
    const entitiesAfterEarly = rig.sim.world.entityCount;
    expect(rig.sim.world.query(HitboxComponent)).toEqual([]);

    const late = feedbackTrace(rig, 140); // ticks 21..160
    const trace = [...early, ...late];

    // Hitstop belongs to the BASE hit only: the canonical 4 frozen ticks (1..4).
    expect(ticksWhere(trace, (frame) => frame.frozen)).toEqual([1, 2, 3, 4]);
    // ... and HITSTUN is the base hit's stun: entered on tick 0, exited on tick 12,
    // so it is observable at the end of ticks 1..11 (spec 04 §6).
    expect(ticksWhere(trace, (frame) => frame.state === ActionState.HITSTUN)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);

    // Damage ticks at 30 / 60 / 90 / 120, with ZERO feedback attached to them.
    for (const tick of [30, 60, 90, 120]) {
      const frame = trace[tick - 1];
      if (frame === undefined) throw new Error(`QA: missing trace frame for tick ${tick}`);
      expect(frame.frozen).toBe(false);
      expect(frame.state).not.toBe(ActionState.HITSTUN);
    }

    // The knockback displacement is exactly the base hit's 1.6 units — a DoT that
    // re-wrote KnockbackComponent would have pushed the victim further.
    const last = trace[trace.length - 1];
    if (last === undefined) throw new Error('QA: empty trace');
    expect(last.enemyX).toBeCloseTo(ENEMY_X + 1.6, 9);
    expect(last.hp).toBe(74);

    // No entity was ever created after the base attack: the DoT injects no hitbox
    // and no probe entity, it just decrements hp.
    expect(rig.sim.world.entityCount).toBe(entitiesAfterEarly);
    expect(rig.sim.world.query(HitboxComponent)).toEqual([]);
  });

  it('publishes NO HitEvent for a damage tick (nothing can re-enter the pipeline)', () => {
    const events = new EventQueue();
    const tap = new HitEventTap(events);
    const sim = makeTapSim(events, tap);
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: 5 });
    const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: 5 });
    addModifier(sim.world, player, DIONYSUS_BLIGHT_MODIFIER);

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(150);

    // Exactly ONE event in 150 ticks: the base hit. The four poison ticks emitted none.
    expect(tap.hits).toHaveLength(1);
    const onlyHit = tap.hits[0];
    if (onlyHit === undefined) throw new Error('QA: expected the base hit to be published');
    expect(onlyHit.sourceModifier).toBeNull();
    expect(onlyHit.damage).toBe(DEFAULT_ATTACK_DAMAGE);

    expect(hpOf(sim, enemy)).toBe(74); // the DoT really did run
    expect(events.size).toBe(0); // the bus is empty at every tick boundary
  });
});

/* ------------------------------------------------------------------ *
 * G6 · the modifier registry                                          *
 * ------------------------------------------------------------------ */
describe('G6 · ModifierSystem dispatches through the registry (AC-04)', () => {
  it('registers the shipped boons and exposes them in a stable order', () => {
    const registry = createDefaultModifierRegistry();
    expect(registry.size).toBe(2);
    expect(registry.ids).toEqual([DIONYSUS_BLIGHT_MODIFIER, ZEUS_STRIKE_MODIFIER]); // ascending
    expect(registry.has(ZEUS_STRIKE_MODIFIER)).toBe(true);
    expect(registry.get(ZEUS_STRIKE_MODIFIER)).toBeInstanceOf(ZeusStrikeModifier);
    expect(registry.get(DIONYSUS_BLIGHT_MODIFIER)).toBeInstanceOf(DionysusBlightModifier);
    expect(registry.get('no_such_boon')).toBeUndefined();

    // A duplicate registration is a wiring bug, so it fails loudly.
    expect(() => registry.register(new ZeusStrikeModifier())).toThrow(/already registered/);

    // Two registries are independent instances (never shared between simulators).
    expect(createDefaultModifierRegistry()).not.toBe(registry);
  });

  it('calls the registered handler with the event and a context carrying the world', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: 5 });
    const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: 5 });
    addModifier(sim.world, player, 'test_boon');

    const handler = new RecordingHandler('test_boon');
    const registry = new ModifierRegistry();
    registry.register(handler);

    const events = new EventQueue();
    const modifiers = new ModifierSystem(events, registry);
    const event: HitEvent = {
      tick: 9,
      attackerId: player,
      targetId: enemy,
      hitboxEntityId: 999,
      position: vec2(ENEMY_X, 0),
      damage: DEFAULT_ATTACK_DAMAGE,
      sourceModifier: null,
    };

    events.emit(event);
    modifiers.update(sim.world, ctxAt(9));

    expect(handler.hits).toEqual([event]);
    expect(handler.worldSeen).toBe(sim.world);
    expect(handler.tickSeen).toBe(9); // SystemContext survives the extension
    expect(events.size).toBe(0);
  });

  it('keeps the ANTI-RECURSION gate FIRST: a tagged event never reaches a handler', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: 5 });
    const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: 5 });
    addModifier(sim.world, player, 'test_boon'); // the holder DOES own the boon

    const handler = new RecordingHandler('test_boon');
    const registry = new ModifierRegistry();
    registry.register(handler);

    const events = new EventQueue();
    const modifiers = new ModifierSystem(events, registry);

    events.emit({
      tick: 0,
      attackerId: player,
      targetId: enemy,
      hitboxEntityId: 999,
      position: vec2(ENEMY_X, 0),
      damage: 1,
      sourceModifier: 'test_boon', // provenance => dispatch must stop here
    });
    modifiers.update(sim.world, ctxAt(0));
    expect(handler.hits).toHaveLength(0);

    // Control: the same event untagged reaches the handler.
    events.emit({
      tick: 1,
      attackerId: player,
      targetId: enemy,
      hitboxEntityId: 999,
      position: vec2(ENEMY_X, 0),
      damage: 1,
      sourceModifier: null,
    });
    modifiers.update(sim.world, ctxAt(1));
    expect(handler.hits).toHaveLength(1);
  });

  it('skips an unregistered modifier id silently, and is a strict no-op on an empty queue', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: 5 });
    const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: 5 });
    addModifier(sim.world, player, 'boon_from_a_future_build');

    const events = new EventQueue();
    const modifiers = new ModifierSystem(events, new ModifierRegistry());

    const before = sim.world.entityCount;
    events.emit({
      tick: 0,
      attackerId: player,
      targetId: enemy,
      hitboxEntityId: 999,
      position: vec2(ENEMY_X, 0),
      damage: 1,
      sourceModifier: null,
    });
    modifiers.update(sim.world, ctxAt(0));
    expect(sim.world.entityCount).toBe(before); // no behaviour => no side effect
    expect(events.size).toBe(0); // still fully drained

    const snapshotBefore = sim.snapshot();
    modifiers.update(sim.world, ctxAt(7)); // empty queue
    expect(sim.snapshot()).toEqual(snapshotBefore);
  });

  it('runs BOTH boons when one attacker holds both', () => {
    const rig = makeRig({ alsoZeus: true });
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0

    // Dionysus: poisoned.
    expect(hasStatusEffect(rig.sim.world, rig.enemy, POISON_STATUS_ID)).toBe(true);
    // Zeus: one bolt injected (a hitbox carrying the zeus provenance tag).
    const bolts = rig.sim.world.query(TransformComponent, HitboxComponent).filter((id) => {
      const hitbox = rig.sim.world.getComponent(id, HitboxComponent);
      return hitbox !== undefined && hitbox.sourceModifier === ZEUS_STRIKE_MODIFIER;
    });
    expect(bolts).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * G7 · pipeline order + determinism                                   *
 * ------------------------------------------------------------------ */
describe('G7 · canonical 10-segment pipeline and deterministic replay (AC-08/09)', () => {
  it('runs ... Collision -> StatusEffect -> Modifier -> Lifespan, keeping Lifespan last', () => {
    const names = createDefaultSystems().map((system) => system.name);
    expect(names).toEqual([
      'PlayerControllerSystem',
      'FreezeSystem',
      'MovementSystem',
      'DashSystem',
      'StateSystem',
      'CombatActionSystem',
      'CollisionSystem',
      'StatusEffectSystem',
      'ModifierSystem',
      'LifespanSystem',
    ]);

    // StatusEffectSystem MUST precede ModifierSystem: a status applied by a modifier
    // on tick T is then first counted on T+1, which is what makes the interval and
    // the duration read exactly as documented (spec 06 §4.2 / §5.2).
    expect(names.indexOf('StatusEffectSystem')).toBeGreaterThan(names.indexOf('CollisionSystem'));
    expect(names.indexOf('StatusEffectSystem')).toBeLessThan(names.indexOf('ModifierSystem'));
    expect(names.indexOf('LifespanSystem')).toBe(names.length - 1);
  });

  it('replays a poison script identically, tick by tick, in two simulators', () => {
    const runScript = (): Snapshot[] => {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
      const player = PlayerFactory.spawn(sim.world, {
        x: 0,
        y: 0,
        facingRadians: 0,
        maxSpeed: 5,
      });
      EnemyFactory.spawn(sim.world, {
        x: ENEMY_X,
        y: 0,
        facingRadians: 0,
        maxSpeed: 5,
        hurtboxRadius: 30,
      });
      addModifier(sim.world, player, DIONYSUS_BLIGHT_MODIFIER);
      addModifier(sim.world, player, ZEUS_STRIKE_MODIFIER);
      addModifier(sim.world, player, 'athena_dash');

      scheduleAttack(sim, 0);
      scheduleAttack(sim, ATTACK_CYCLE_TICKS);

      const frames: Snapshot[] = [];
      for (let i = 0; i < 150; i += 1) {
        sim.step(1);
        frames.push(sim.snapshot());
      }
      return frames;
    };

    const a = runScript();
    const b = runScript();
    expect(a).toHaveLength(150);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]).toEqual(b[i]);
    }
    expect(a).toEqual(b);
  });
});

/* ------------------------------------------------------------------ *
 * Test doubles                                                        *
 * ------------------------------------------------------------------ */

/** Records every HitEvent it sees, then re-publishes it so the real consumer still runs. */
class HitEventTap implements System {
  public readonly name = 'HitEventTap';
  public readonly hits: HitEvent[] = [];

  private readonly events: EventQueue;

  constructor(events: EventQueue) {
    this.events = events;
  }

  public update(): void {
    for (const event of this.events.drain()) {
      this.hits.push(event);
      this.events.emit(event); // FIFO order preserved, so dispatch is unchanged
    }
  }
}

/** The canonical pipeline with a tap spliced in between Collision and StatusEffect. */
function makeTapSim(events: EventQueue, tap: HitEventTap): GameSimulator {
  return new GameSimulator({
    fps: FPS,
    systems: [
      new PlayerControllerSystem(),
      new FreezeSystem(),
      new MovementSystem(),
      new DashSystem(),
      new StateSystem(),
      new CombatActionSystem(),
      new CollisionSystem(events),
      tap,
      new StatusEffectSystem(),
      new ModifierSystem(events),
      new LifespanSystem(),
    ],
  });
}

/** A stand-in handler that just remembers what it was called with. */
class RecordingHandler implements IModifierHandler {
  public readonly id: string;
  public readonly hits: HitEvent[] = [];
  public worldSeen: World | undefined;
  public tickSeen: number | undefined;

  constructor(id: string) {
    this.id = id;
  }

  public onHit(event: HitEvent, context: ModifierContext): void {
    this.hits.push(event);
    this.worldSeen = context.world;
    this.tickSeen = context.tick;
  }
}
