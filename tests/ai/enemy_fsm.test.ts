/**
 * M4-T01 · Enemy FSM AI + attack telegraphing acceptance tests.
 * See specs/07_enemy_ai_spec.md §4 (semantics), §6 (tick-by-tick contract) and
 * §7 (AC-01 .. AC-10).
 *
 * Fresh-eyes harness suite: every assertion drives the REAL GameSimulator with the
 * canonical 15-segment pipeline (TransformSnapshotSystem -> PlayerControllerSystem
 * -> FreezeSystem -> AISystem -> MovementSystem -> DashSystem -> StateSystem ->
 * CombatActionSystem -> CollisionSystem -> StatusEffectSystem -> ModifierSystem ->
 * DeathSystem -> EncounterSystem -> RewardSystem -> LifespanSystem) and
 * REAL prefab-assembled entities. Nothing is mocked, and ticks are advanced one at
 * a time so the timing contract is pinned per tick.
 *
 * TICK NUMBERING (the classic off-by-one trap — spec 07 §6):
 *   `sim.step(n)` processes processed-ticks `0 .. n-1`, leaving `sim.tick === n`.
 *   Everything below is indexed by the PROCESSED tick `p`, i.e. `frames[p]` is the
 *   state after the step that processed tick `p`. A fresh sim needs `step(p + 1)`
 *   (or `runTo(p + 1)`) to have processed tick `p`.
 *
 * GEOMETRY (used to derive every expected tick):
 *   melee hitbox centre = attacker + 0.75 along `facingRadians`, radius 1.0;
 *   hurtbox radius 0.5 => effective reach 0.75 + 1.0 + 0.5 = 2.25.
 *   `attackRadius = 3.0` with the player parked at 2.5 therefore WINDUP without the
 *   swing ever connecting, which keeps the FSM timing free of hitstop.
 *
 * NOTICE TICK (spec 07 §4.3): the tick an enemy goes IDLE -> CHASING flips the state
 * but does NOT emit a chase vector — `IDLE` is standby, so pursuit starts one tick
 * later. That reaction tick is a pinned contract, not an accident, and several
 * assertions below depend on it.
 *
 * Grouping:
 *   G0 · component + AI tuning contracts (validation / opt-in mounting)  (AC-02/AC-08)
 *   G1 · the AI is the sole author of an AI entity's intent              (AC-01)
 *   G2 · FSM state flow: IDLE / CHASING / WINDUP / COOLDOWN              (AC-02/AC-05)
 *   G3 · pure chase: normalized vector, updated every tick               (AC-03)
 *   G4 · full attack cycle timing + facing lock                          (AC-04/AC-05)
 *   G5 · hitstun interrupts the windup; hitstop only pauses it           (AC-06)
 *   G6 · hitstop pauses the cooldown without eating frames               (AC-06)
 *   G7 · canonical 15-segment pipeline order                             (AC-07)
 *   G8 · deterministic replay of a full AI script                        (AC-09)
 *   G9 · zero regression for entities without an AI controller           (AC-08)
 */

import { describe, expect, it } from 'vitest';
import {
  AIControllerComponent,
  AIState,
  ATTACK_KEY,
  ActionState,
  EnemyFactory,
  GameSimulator,
  HitboxComponent,
  IntentComponent,
  PlayerFactory,
  StateComponent,
  TransformComponent,
  createDefaultSystems,
  lengthVec2,
  normalizeVec2,
  resolveAITuning,
  vec2,
} from '../../src';
import type { EntityId, Snapshot, System, SystemContext, Vec2, World } from '../../src';

const FPS = 60;

/** Positional accessor with a loud guard (the repo runs `noUncheckedIndexedAccess`). */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`QA: no sample for processed tick ${String(index)}`);
  }
  return value;
}

/* --- rig ------------------------------------------------------------------ */

interface AirOptions {
  readonly playerX?: number;
  readonly playerY?: number;
  readonly playerFacingRadians?: number;
  readonly enemyX?: number;
  readonly enemyY?: number;
  readonly sightRadius?: number;
  readonly attackRadius?: number;
  readonly windupTicks?: number;
  readonly cooldownTicks?: number;
  /** When true the enemy starts with NO target and must auto-acquire one. */
  readonly autoAcquire?: boolean;
}

interface AIRig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
  readonly enemy: EntityId;
}

function buildRig(systems: readonly System[], options: AirOptions): AIRig {
  const sim = new GameSimulator({ fps: FPS, systems });
  const player = PlayerFactory.spawn(sim.world, {
    x: options.playerX ?? 2.5,
    y: options.playerY ?? 0,
    facingRadians: options.playerFacingRadians ?? 0,
    maxSpeed: 5,
  });
  const enemy = EnemyFactory.spawn(sim.world, {
    x: options.enemyX ?? 0,
    y: options.enemyY ?? 0,
    facingRadians: 0,
    maxSpeed: 5,
    ai: {
      targetEntityId: options.autoAcquire === true ? null : player,
      sightRadius: options.sightRadius ?? 8,
      attackRadius: options.attackRadius ?? 3,
      windupTicks: options.windupTicks ?? 30,
      cooldownTicks: options.cooldownTicks ?? 60,
    },
  });
  return { sim, player, enemy };
}

/** The canonical 15-segment pipeline. */
function makeAIRig(options: AirOptions = {}): AIRig {
  return buildRig(createDefaultSystems(), options);
}

/**
 * The canonical pipeline with a probe spliced in IMMEDIATELY AFTER AISystem.
 *
 * `wantsToAttack` is a single-tick pulse that CombatActionSystem consumes later in
 * the SAME tick, so a probe placed at the end of the pipeline would always see
 * `false`. Splicing right after the producer is the only way to observe the pulse
 * as it was raised (spec 07 AC-05).
 */
function makeProbedRig(probe: IntentProbe, options: AirOptions = {}): AIRig {
  const base = createDefaultSystems();
  // Pin the splice point BY NAME: if the pipeline ever moves AISystem, fail loudly
  // here rather than silently probing the wrong segment (mirrors the
  // `CollisionSystem` lookup in tests/combat/death_and_encounter.test.ts).
  const aiIndex = base.findIndex((system) => system.name === 'AISystem');
  if (aiIndex === -1) throw new Error('QA: the canonical pipeline has no AISystem');
  return buildRig([...base.slice(0, aiIndex + 1), probe, ...base.slice(aiIndex + 1)], options);
}

/* --- component accessors -------------------------------------------------- */

function aiOf(sim: GameSimulator, id: EntityId): AIControllerComponent {
  const c = sim.world.getComponent(id, AIControllerComponent);
  if (c === undefined) throw new Error('QA: entity is missing AIControllerComponent');
  return c;
}

function stateOf(sim: GameSimulator, id: EntityId): StateComponent {
  const c = sim.world.getComponent(id, StateComponent);
  if (c === undefined) throw new Error('QA: entity is missing StateComponent');
  return c;
}

function intentOf(sim: GameSimulator, id: EntityId): IntentComponent {
  const c = sim.world.getComponent(id, IntentComponent);
  if (c === undefined) throw new Error('QA: entity is missing IntentComponent');
  return c;
}

function transformOf(sim: GameSimulator, id: EntityId): TransformComponent {
  const c = sim.world.getComponent(id, TransformComponent);
  if (c === undefined) throw new Error('QA: entity is missing TransformComponent');
  return c;
}

/** Ids of every live hitbox owned by `owner`, ascending. */
function hitboxesOf(sim: GameSimulator, owner: EntityId): EntityId[] {
  const out: EntityId[] = [];
  for (const id of sim.world.query(TransformComponent, HitboxComponent)) {
    const hitbox = sim.world.getComponent(id, HitboxComponent);
    if (hitbox !== undefined && hitbox.ownerEntityId === owner) out.push(id);
  }
  return out;
}

/** The transform of the enemy's single live hitbox; throws if the count is not 1. */
function soleHitboxTransform(sim: GameSimulator, owner: EntityId): TransformComponent {
  const ids = hitboxesOf(sim, owner);
  const first = ids[0];
  if (ids.length !== 1 || first === undefined) {
    throw new Error(`QA: expected exactly one hitbox for ${String(owner)}, found ${String(ids.length)}`);
  }
  return transformOf(sim, first);
}

/* --- intent probe --------------------------------------------------------- */

interface IntentSample {
  readonly moveX: number;
  readonly moveY: number;
  readonly wantsToAttack: boolean;
  readonly aimRadians: number | null;
}

/** Records every entity's intent as it stands right after AISystem runs. */
class IntentProbe implements System {
  public readonly name = 'IntentProbe';
  private readonly frames = new Map<number, Map<EntityId, IntentSample>>();

  public update(world: World, ctx: SystemContext): void {
    const frame = new Map<EntityId, IntentSample>();
    for (const id of world.query(IntentComponent)) {
      const intent = world.getComponent(id, IntentComponent);
      if (intent === undefined) continue;
      frame.set(id, {
        moveX: intent.moveVector.x,
        moveY: intent.moveVector.y,
        wantsToAttack: intent.wantsToAttack,
        aimRadians: intent.aimRadians,
      });
    }
    this.frames.set(ctx.tick, frame);
  }

  public at(processedTick: number, id: EntityId): IntentSample | undefined {
    return this.frames.get(processedTick)?.get(id);
  }
}

function sampleOf(probe: IntentProbe, processedTick: number, id: EntityId): IntentSample {
  const sample = probe.at(processedTick, id);
  if (sample === undefined) {
    throw new Error(`QA: no intent sample for tick ${String(processedTick)} / entity ${String(id)}`);
  }
  return sample;
}

/* ========================================================================== *
 * G0 · component + AI tuning contracts                                       *
 * ========================================================================== */
describe('G0 · AIControllerComponent + AI tuning contracts (AC-02 / AC-08)', () => {
  it('exposes the four FSM states', () => {
    expect(Object.values(AIState).sort()).toEqual(['CHASING', 'COOLDOWN', 'IDLE', 'WINDUP']);
  });

  it('defaults the tuning and rejects impossible configurations', () => {
    expect(resolveAITuning()).toEqual({
      targetEntityId: null,
      sightRadius: 8,
      attackRadius: 1.5,
      windupTicks: 30,
      cooldownTicks: 60,
    });

    expect(() => resolveAITuning({ sightRadius: 0 })).toThrow(RangeError);
    expect(() => resolveAITuning({ attackRadius: -1 })).toThrow(RangeError);
    expect(() => resolveAITuning({ windupTicks: 0 })).toThrow(RangeError);
    expect(() => resolveAITuning({ cooldownTicks: 1.5 })).toThrow(RangeError);
    // "Can attack something it cannot see" is always a config bug.
    expect(() => resolveAITuning({ sightRadius: 2, attackRadius: 3 })).toThrow(RangeError);
  });

  it('mounts the AI controller only when the caller opts in', () => {
    const sim = new GameSimulator();
    const scripted = EnemyFactory.spawn(sim.world, { x: 0, y: 0 });
    const driven = EnemyFactory.spawn(sim.world, { x: 0, y: 0, ai: {} });

    expect(sim.world.getComponent(scripted, AIControllerComponent)).toBeUndefined();
    const ai = sim.world.getComponent(driven, AIControllerComponent);
    expect(ai).toBeDefined();
    expect(ai?.state).toBe(AIState.IDLE);
    expect(ai?.ticksRemaining).toBe(0);
    expect(ai?.sightRadius).toBe(8);
    expect(ai?.attackRadius).toBe(1.5);
    expect(ai?.windupTicks).toBe(30);
    expect(ai?.cooldownTicks).toBe(60);
  });

  it('refuses AI tuning on a hardware-driven combatant', () => {
    const sim = new GameSimulator();
    expect(() => PlayerFactory.spawn(sim.world, { ai: {} })).toThrow(RangeError);
  });
});

/* ========================================================================== *
 * G1 · the AI owns the intent                                                *
 * ========================================================================== */
describe('G1 · the AI is the sole author of an AI entity intent (AC-01)', () => {
  it('overwrites a hand-written intent on an AI-driven enemy', () => {
    const rig = makeAIRig({ playerX: 5, playerY: 0, sightRadius: 8, attackRadius: 3 });
    const intent = intentOf(rig.sim, rig.enemy);

    // Hand-write an intent the AI must never honour.
    intent.moveVector = vec2(9, 9);
    intent.wantsToAttack = true;
    intent.aimRadians = 1.23;

    // Processed tick 0 is the "notice" tick (spec 07 §4.3): IDLE -> CHASING, still
    // rooted. What matters here is that the hand-written intent is GONE — the
    // pending attack pulse would otherwise have spawned a hitbox in this very tick.
    rig.sim.step(1);
    expect(intent.moveVector).toEqual(vec2(0, 0));
    expect(intent.wantsToAttack).toBe(false);
    expect(intent.aimRadians).toBeNull();
    expect(hitboxesOf(rig.sim, rig.enemy)).toHaveLength(0);

    // Processed tick 1: the chase proper, still overwriting whatever was there.
    intent.moveVector = vec2(9, 9);
    rig.sim.step(1);
    expect(intent.moveVector.x).toBeCloseTo(1, 12);
    expect(intent.moveVector.y).toBeCloseTo(0, 12);
  });

  it('leaves a script-driven enemy intent untouched (AC-08)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const enemy = EnemyFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: 5 });
    const intent = intentOf(sim, enemy);

    intent.moveVector = vec2(1, 0);
    sim.step(3);

    // Nothing rewrites a script-driven enemy's intent: it keeps walking +x.
    expect(intent.moveVector.x).toBe(1);
    expect(intent.moveVector.y).toBe(0);
    expect(transformOf(sim, enemy).x).toBeCloseTo((3 * 5) / FPS, 12);
  });

  it('never drives the player', () => {
    const rig = makeAIRig();
    const playerIntent = intentOf(rig.sim, rig.player);

    rig.sim.step(1);

    expect(rig.sim.world.getComponent(rig.player, AIControllerComponent)).toBeUndefined();
    expect(playerIntent.moveVector).toEqual(vec2(0, 0));
    expect(playerIntent.wantsToAttack).toBe(false);
  });
});

/* ========================================================================== *
 * G2 · FSM state flow                                                        *
 * ========================================================================== */
describe('G2 · FSM state flow (AC-02 / AC-05)', () => {
  it('stays IDLE when the target is out of sight', () => {
    const rig = makeAIRig({ playerX: 20, playerY: 0, sightRadius: 8, attackRadius: 3 });

    rig.sim.step(5);

    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.IDLE);
    expect(aiOf(rig.sim, rig.enemy).ticksRemaining).toBe(0);
    expect(intentOf(rig.sim, rig.enemy).moveVector).toEqual(vec2(0, 0));
    expect(transformOf(rig.sim, rig.enemy).x).toBe(0);
  });

  it('chases when in sight but out of attack range, and drops back to IDLE when sight is lost', () => {
    const rig = makeAIRig({ playerX: 5, playerY: 0, sightRadius: 8, attackRadius: 3 });

    // Tick 0 — the notice tick: the state flips to CHASING but the enemy is rooted.
    rig.sim.step(1);
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.CHASING);
    expect(intentOf(rig.sim, rig.enemy).moveVector).toEqual(vec2(0, 0));

    // Tick 1 — the chase proper.
    rig.sim.step(1);
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.CHASING);
    expect(intentOf(rig.sim, rig.enemy).moveVector.x).toBeCloseTo(1, 12);
    expect(intentOf(rig.sim, rig.enemy).moveVector.y).toBeCloseTo(0, 12);

    // Teleport the player far outside the sight radius: the chase is dropped.
    const playerTransform = transformOf(rig.sim, rig.player);
    playerTransform.x = 50;
    rig.sim.step(1);
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.IDLE);
    expect(intentOf(rig.sim, rig.enemy).moveVector).toEqual(vec2(0, 0));
  });

  it('auto-acquires the nearest hostile entity when no target is set (AC-03)', () => {
    const rig = makeAIRig({ playerX: 3, playerY: 0, autoAcquire: true, sightRadius: 8, attackRadius: 1.5 });

    expect(aiOf(rig.sim, rig.enemy).targetEntityId).toBeNull();
    rig.sim.step(1);

    expect(aiOf(rig.sim, rig.enemy).targetEntityId).toBe(rig.player);
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.CHASING);
  });

  it('runs WINDUP -> COOLDOWN -> CHASING -> WINDUP on the documented cycle', () => {
    const rig = makeAIRig({
      enemyX: 0,
      enemyY: 0,
      playerX: 2.5,
      playerY: 0,
      sightRadius: 8,
      attackRadius: 3,
      windupTicks: 30,
      cooldownTicks: 60,
    });

    // `runTo(p + 1)` processes ticks 0 .. p, so these read the state AFTER tick p.
    const stateAt = (p: number): AIState => {
      rig.sim.runTo(p + 1);
      return aiOf(rig.sim, rig.enemy).state;
    };

    expect(stateAt(0)).toBe(AIState.WINDUP);
    expect(stateAt(29)).toBe(AIState.WINDUP);
    expect(stateAt(30)).toBe(AIState.COOLDOWN);
    expect(stateAt(89)).toBe(AIState.COOLDOWN);
    // Cooldown expiry hands control back to the DECISION states, never straight to a
    // new windup: that "+1" tick is what makes the cycle windup + cooldown + 1.
    expect(stateAt(90)).toBe(AIState.CHASING);
    expect(stateAt(91)).toBe(AIState.WINDUP);
  });
});

/* ========================================================================== *
 * G3 · pure chase                                                            *
 * ========================================================================== */
describe('G3 · pure chase (AC-03)', () => {
  it('outputs a NORMALIZED vector towards the player, updated every tick', () => {
    const rig = makeAIRig({ enemyX: 0, enemyY: 0, playerX: 5, playerY: 0, sightRadius: 8, attackRadius: 3 });

    // Processed tick 0 is the "notice" tick (spec 07 §4.3): the enemy switches to
    // CHASING but stays rooted, so no chase vector is emitted yet.
    rig.sim.step(1);
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.CHASING);
    expect(intentOf(rig.sim, rig.enemy).moveVector).toEqual(vec2(0, 0));

    /** Captures the pre-step geometry, steps once, and returns expected vs actual. */
    const chaseStep = (): { expected: Vec2; actual: Vec2 } => {
      const enemyTransform = transformOf(rig.sim, rig.enemy);
      const playerTransform = transformOf(rig.sim, rig.player);
      const expected = normalizeVec2(
        vec2(playerTransform.x - enemyTransform.x, playerTransform.y - enemyTransform.y),
      );
      rig.sim.step(1);
      return { expected, actual: intentOf(rig.sim, rig.enemy).moveVector };
    };

    // (1) straight ahead on +x
    const first = chaseStep();
    expect(first.actual.x).toBeCloseTo(first.expected.x, 12);
    expect(first.actual.y).toBeCloseTo(first.expected.y, 12);
    expect(lengthVec2(first.actual)).toBeCloseTo(1, 12);
    expect(first.actual.x).toBeCloseTo(1, 12);

    // (2) the player relocates; the chase turns with it on the very next tick
    const playerTransform = transformOf(rig.sim, rig.player);
    playerTransform.x = 0;
    playerTransform.y = 5;
    const second = chaseStep();
    expect(second.actual.y).toBeCloseTo(second.expected.y, 12);
    expect(second.actual.x).toBeCloseTo(second.expected.x, 12);
    expect(lengthVec2(second.actual)).toBeCloseTo(1, 12);
    expect(second.actual.y).toBeGreaterThan(0.9);

    // (3) and the enemy really did move (intent is executed, not just recorded)
    expect(transformOf(rig.sim, rig.enemy).y).toBeGreaterThan(0);
  });
});

/* ========================================================================== *
 * G4 · full attack cycle timing                                              *
 * ========================================================================== */
describe('G4 · attack cycle timing (AC-04 / AC-05)', () => {
  it('roots, telegraphs for exactly windupTicks, then fires on the pulse tick', () => {
    const probe = new IntentProbe();
    const rig = makeProbedRig(probe, {
      enemyX: 0,
      enemyY: 0,
      playerX: 2.5,
      playerY: 0,
      sightRadius: 8,
      attackRadius: 3,
      windupTicks: 30,
      cooldownTicks: 60,
    });

    interface Frame {
      readonly aiState: AIState;
      readonly ticksRemaining: number;
      readonly enemyX: number;
      readonly enemyY: number;
      readonly pulse: boolean;
      readonly aim: number | null;
      readonly hitboxes: number;
    }

    const frames: Frame[] = [];
    for (let p = 0; p <= 31; p += 1) {
      rig.sim.step(1);
      const ai = aiOf(rig.sim, rig.enemy);
      const transform = transformOf(rig.sim, rig.enemy);
      const sample = sampleOf(probe, p, rig.enemy);
      frames.push({
        aiState: ai.state,
        ticksRemaining: ai.ticksRemaining,
        enemyX: transform.x,
        enemyY: transform.y,
        pulse: sample.wantsToAttack,
        aim: sample.aimRadians,
        hitboxes: hitboxesOf(rig.sim, rig.enemy).length,
      });
    }

    // --- telegraph span: exactly windupTicks ticks, entry tick NOT decremented ----
    expect(at(frames, 0).aiState).toBe(AIState.WINDUP);
    expect(at(frames, 0).ticksRemaining).toBe(30);
    for (let p = 1; p <= 29; p += 1) {
      expect(at(frames, p).aiState).toBe(AIState.WINDUP);
      expect(at(frames, p).ticksRemaining).toBe(30 - p);
    }
    expect(at(frames, 29).ticksRemaining).toBe(1);

    // --- rooted + facing locked for the whole telegraph -------------------------
    for (let p = 0; p <= 29; p += 1) {
      expect(at(frames, p).enemyX).toBe(0);
      expect(at(frames, p).enemyY).toBe(0);
      expect(at(frames, p).pulse).toBe(false);
      expect(at(frames, p).aim).toBeCloseTo(0, 12);
    }

    // --- the pulse fires on the tick the counter hits zero, and ONLY then -------
    expect(at(frames, 30).pulse).toBe(true);
    expect(at(frames, 30).aiState).toBe(AIState.COOLDOWN);
    expect(at(frames, 30).ticksRemaining).toBe(60);
    // ... and CombatActionSystem consumed it in the same tick, spawning the hitbox.
    expect(at(frames, 30).hitboxes).toBe(1);
    // ... which is still alive on the next tick (lifespan 15).
    expect(at(frames, 31).hitboxes).toBe(1);
    expect(at(frames, 31).pulse).toBe(false);
    expect(at(frames, 31).ticksRemaining).toBe(59);
  });

  it('locks the attack facing to the target position at windup entry (AC-04)', () => {
    const rig = makeAIRig({
      enemyX: 0,
      enemyY: 0,
      playerX: 2.5,
      playerY: 0,
      sightRadius: 8,
      attackRadius: 3,
      windupTicks: 30,
      cooldownTicks: 60,
    });

    rig.sim.step(1); // processed tick 0: windup starts, facing locked towards +x
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.WINDUP);
    expect(aiOf(rig.sim, rig.enemy).lockedFacingRadians).toBeCloseTo(0, 12);

    // The player walks AROUND the enemy while the telegraph is up.
    const playerTransform = transformOf(rig.sim, rig.player);
    playerTransform.x = 0;
    playerTransform.y = 2.5;

    rig.sim.step(20); // processed ticks 1..20
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.WINDUP);
    expect(aiOf(rig.sim, rig.enemy).lockedFacingRadians).toBeCloseTo(0, 12);
    expect(intentOf(rig.sim, rig.enemy).aimRadians).toBeCloseTo(0, 12);
    // The lock is really applied to the transform, not merely stored.
    expect(transformOf(rig.sim, rig.enemy).facingRadians).toBeCloseTo(0, 12);
    expect(transformOf(rig.sim, rig.enemy).x).toBe(0);
    expect(transformOf(rig.sim, rig.enemy).y).toBe(0);

    // The swing therefore goes along the LOCKED facing (+x), not towards the player.
    rig.sim.step(10); // processed ticks 21..30
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.COOLDOWN);
    const bolt = soleHitboxTransform(rig.sim, rig.enemy);
    expect(bolt.x).toBeCloseTo(0.75, 12);
    expect(bolt.y).toBeCloseTo(0, 12);
  });
});

/* ========================================================================== *
 * G5 · hitstun interrupt                                                     *
 * ========================================================================== */
describe('G5 · hitstun interrupts the windup (AC-06)', () => {
  it('pauses on hitstop, cancels on hitstun, and re-evaluates afterwards', () => {
    const probe = new IntentProbe();
    const rig = makeProbedRig(probe, {
      enemyX: 1.0,
      enemyY: 0,
      playerX: 0,
      playerY: 0,
      playerFacingRadians: 0,
      sightRadius: 10,
      attackRadius: 4,
      windupTicks: 30,
      cooldownTicks: 60,
    });

    // Processed tick 0: dist 1.0 <= attackRadius 4.0 => the telegraph starts.
    // Processed tick 5: the player swings. Its hitbox (0.75, 0) r=1.0 overlaps the
    // enemy (1.0, 0) r=0.5 (dist 0.25), so the hit lands and interrupts.
    rig.sim.inject({ kind: 'keyDown', tick: 5, key: ATTACK_KEY });

    const aiStates: AIState[] = [];
    const ticksRemaining: number[] = [];
    const actionStates: ActionState[] = [];
    const hitboxCounts: number[] = [];
    for (let p = 0; p <= 60; p += 1) {
      rig.sim.step(1);
      const ai = aiOf(rig.sim, rig.enemy);
      aiStates.push(ai.state);
      ticksRemaining.push(ai.ticksRemaining);
      actionStates.push(stateOf(rig.sim, rig.enemy).state);
      hitboxCounts.push(hitboxesOf(rig.sim, rig.enemy).length);
    }

    // --- the telegraph was running -------------------------------------------
    expect(at(aiStates, 0)).toBe(AIState.WINDUP);
    expect(at(ticksRemaining, 0)).toBe(30);
    expect(at(aiStates, 5)).toBe(AIState.WINDUP);
    expect(at(ticksRemaining, 5)).toBe(25);

    // --- hitstop PAUSES the FSM: the counter is frozen, not eaten -------------
    for (let p = 6; p <= 9; p += 1) {
      expect(at(aiStates, p)).toBe(AIState.WINDUP);
      expect(at(ticksRemaining, p)).toBe(25);
    }

    // --- hitstun INTERRUPTS it: the plan is discarded --------------------------
    for (let p = 10; p <= 17; p += 1) {
      expect(at(aiStates, p)).toBe(AIState.IDLE);
      expect(at(ticksRemaining, p)).toBe(0);
    }

    // --- and the FSM re-evaluates from scratch once control returns -----------
    expect(at(aiStates, 18)).toBe(AIState.WINDUP);
    expect(at(ticksRemaining, 18)).toBe(30);

    // --- action-state cross-check (the two machines are orthogonal) -----------
    expect(at(actionStates, 4)).toBe(ActionState.IDLE);
    for (let p = 5; p <= 16; p += 1) {
      expect(at(actionStates, p)).toBe(ActionState.HITSTUN);
    }
    expect(at(actionStates, 17)).toBe(ActionState.IDLE);

    // --- the interrupted windup never fires ----------------------------------
    // The original telegraph would have landed on tick 30; the interrupted one is
    // discarded, and the fresh windup started on tick 18 fires on tick 18 + 30 = 48.
    for (let p = 0; p <= 47; p += 1) {
      expect(at(hitboxCounts, p)).toBe(0);
    }
    expect(at(hitboxCounts, 48)).toBe(1);
  });
});

/* ========================================================================== *
 * G6 · hitstop pauses the cooldown (pipeline-driven)                         *
 * ========================================================================== */
describe('G6 · hitstop pauses the FSM without eating frames (AC-06)', () => {
  it('shifts the cooldown by exactly the hitstop length when the enemy lands a hit', () => {
    const rig = makeAIRig({
      enemyX: 0,
      enemyY: 0,
      playerX: 1.5,
      playerY: 0,
      sightRadius: 8,
      attackRadius: 3,
      windupTicks: 30,
      cooldownTicks: 60,
    });

    // Tick 0: dist 1.5 <= 3 => telegraph. Tick 30: the swing LANDS on the player
    // (hitbox (0.75, 0) vs hurtbox (1.5, 0), dist 0.75 < 1.5), which freezes BOTH
    // sides -- the enemy is frozen WITHOUT being stunned, because HITSTUN is only
    // written to the victim. That is a pipeline-level source of a pure hitstop.
    rig.sim.runTo(31); // processed ticks 0..30
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.COOLDOWN);
    expect(aiOf(rig.sim, rig.enemy).ticksRemaining).toBe(60);
    expect(stateOf(rig.sim, rig.enemy).state).not.toBe(ActionState.HITSTUN);

    // Ticks 31..34: frozen, so the cooldown counter does not move at all.
    for (let p = 31; p <= 34; p += 1) {
      rig.sim.step(1);
      expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.COOLDOWN);
      expect(aiOf(rig.sim, rig.enemy).ticksRemaining).toBe(60);
    }

    // Tick 35: the freeze lapses and the FSM resumes exactly where it stopped.
    rig.sim.step(1);
    expect(aiOf(rig.sim, rig.enemy).ticksRemaining).toBe(59);

    // ... so the cooldown ends 4 ticks late (90 -> 94) instead of being shortened.
    rig.sim.runTo(94); // processed ticks 36..93
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.COOLDOWN);
    expect(aiOf(rig.sim, rig.enemy).ticksRemaining).toBe(1);

    rig.sim.step(1); // processed tick 94
    expect(aiOf(rig.sim, rig.enemy).state).toBe(AIState.CHASING);
  });
});

/* ========================================================================== *
 * G7 · pipeline order                                                        *
 * ========================================================================== */
describe('G7 · canonical 15-segment pipeline order (AC-07)', () => {
  it('slots AISystem between the freeze gate and the advance systems', () => {
    const names = createDefaultSystems().map((system) => system.name);
    expect(names).toEqual([
      'TransformSnapshotSystem',
      'PlayerControllerSystem',
      'FreezeSystem',
      'AISystem',
      'MovementSystem',
      'DashSystem',
      'StateSystem',
      'CombatActionSystem',
      'CollisionSystem',
      'StatusEffectSystem',
      'ModifierSystem',
      'DeathSystem',
      'EncounterSystem',
      'RewardSystem',
      'LifespanSystem',
    ]);

    // AISystem must see the POST-decrement freeze verdict (it feeds the advance
    // systems) and must run before every intent consumer.
    expect(names.indexOf('AISystem')).toBeGreaterThan(names.indexOf('FreezeSystem'));
    expect(names.indexOf('AISystem')).toBeLessThan(names.indexOf('MovementSystem'));
    // The M1/M2 six-segment relative order is untouched and LifespanSystem is last.
    expect(names.indexOf('MovementSystem')).toBeLessThan(names.indexOf('LifespanSystem'));
    // M4-T02 (spec 08 §5.2) slotted DeathSystem after every damage source and
    // EncounterSystem immediately behind it, reading the death tag it just wrote —
    // both still ahead of the last segment.
    expect(names.indexOf('DeathSystem')).toBeGreaterThan(names.indexOf('CollisionSystem'));
    expect(names.indexOf('DeathSystem')).toBeGreaterThan(names.indexOf('ModifierSystem'));
    expect(names.indexOf('EncounterSystem')).toBeGreaterThan(names.indexOf('DeathSystem'));
    expect(names.indexOf('LifespanSystem')).toBe(names.length - 1);
  });
});

/* ========================================================================== *
 * G8 · deterministic replay                                                  *
 * ========================================================================== */
describe('G8 · deterministic replay of a full AI script (AC-09)', () => {
  it('replays chase / windup / attack / interrupt identically, tick by tick', () => {
    const runScript = (): Snapshot[] => {
      const rig = makeAIRig({
        enemyX: 1.0,
        enemyY: 0,
        playerX: 0,
        playerY: 0,
        playerFacingRadians: 0,
        sightRadius: 10,
        attackRadius: 4,
        windupTicks: 30,
        cooldownTicks: 60,
      });
      // Walk in, swing (interrupting the enemy's telegraph), then walk back out.
      rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
      rig.sim.inject({ kind: 'keyDown', tick: 5, key: ATTACK_KEY });
      rig.sim.inject({ kind: 'move', tick: 40, vector: vec2(-1, 0) });

      const snapshots: Snapshot[] = [];
      for (let p = 0; p < 120; p += 1) {
        rig.sim.step(1);
        snapshots.push(rig.sim.snapshot());
      }
      return snapshots;
    };

    const first = runScript();
    const second = runScript();

    expect(first).toHaveLength(120);
    expect(first).toEqual(second);
  });
});

/* ========================================================================== *
 * G9 · zero regression                                                       *
 * ========================================================================== */
describe('G9 · zero regression for entities without an AI controller (AC-08)', () => {
  it('produces identical snapshots with and without AISystem when no AI entity exists', () => {
    const runScript = (systems: readonly System[]): Snapshot[] => {
      const sim = new GameSimulator({ fps: FPS, systems });
      PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: 5 });
      EnemyFactory.spawn(sim.world, { x: 1.5, y: 0, maxSpeed: 5 });
      sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });

      const snapshots: Snapshot[] = [];
      for (let p = 0; p < 40; p += 1) {
        sim.step(1);
        snapshots.push(sim.snapshot());
      }
      return snapshots;
    };

    const withAi = runScript(createDefaultSystems());
    const withoutAi = runScript(
      createDefaultSystems().filter((system) => system.name !== 'AISystem'),
    );

    // Inserting AISystem into the pipeline is behaviourally invisible while no
    // entity carries an AIControllerComponent -- hitstop, hitstun, knockback and
    // i-frame consumption all come out bit-for-bit identical.
    expect(withAi).toEqual(withoutAi);
  });

  it('leaves the AI query empty when nobody opted in', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    EnemyFactory.spawn(sim.world, { x: 5, y: 0 });

    sim.step(10);

    expect(sim.world.query(AIControllerComponent)).toEqual([]);
  });
});
