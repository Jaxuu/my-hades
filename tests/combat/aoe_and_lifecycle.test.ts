/**
 * M8-T01 · Delayed AoE hazards + run lifecycle acceptance tests.
 * See specs/14_aoe_and_run_lifecycle_spec.md §4 (semantics), §5 (AC-01 .. AC-11)
 * and §6 (tick-by-tick contract).
 *
 * Fresh-eyes harness suite: every assertion drives the REAL GameSimulator with the
 * canonical 16-segment pipeline (TransformSnapshotSystem -> PlayerControllerSystem
 * -> FreezeSystem -> AISystem -> HazardSystem -> MovementSystem -> DashSystem ->
 * StateSystem -> CombatActionSystem -> CollisionSystem -> StatusEffectSystem ->
 * ModifierSystem -> DeathSystem -> EncounterSystem -> RewardSystem ->
 * LifespanSystem) and REAL prefab-assembled entities. Nothing is mocked, and ticks
 * are advanced one at a time where the timing is the point.
 *
 * TICK NUMBERING (the classic off-by-one trap — spec 14 §6):
 *   `sim.step(n)` processes processed-ticks `0 .. n-1`, leaving `sim.tick === n`.
 *   A fresh sim therefore needs `step(p + 1)` to have processed tick `p`.
 *
 * THE HAZARD'S TICK ARITHMETIC (derived once, used everywhere):
 *   A hazard planted with `delayTicks = N` and decremented by phase B of
 *   `HazardSystem` on the tick it is planted reaches `0` at the end of tick
 *   `T + N - 1` and DETONATES on tick `T + N`. `N` is therefore exactly the number
 *   of telegraph ticks, and the blast's own hitbox lives 1 tick (spawned before
 *   CollisionSystem, aged by LifespanSystem at the end of that same tick).
 *
 * Grouping:
 *   G0 · hazard assembly + validation + invisibility to the combat queries  (AC-01/AC-02)
 *   G1 · the fuse: exact tick-by-tick damage, owner death, immunity to freeze (AC-01/AC-03)
 *   G2 · pulse gating: corpses and frozen entities hold no bomb             (AC-04)
 *   G3 · RUN_FAILED: written on the killing tick, and it stops the run      (AC-05/AC-06)
 *   G4 · restartRun: clean slate, new seed, no id rewind, determinism       (AC-07/AC-08/AC-09)
 *   G5 · pipeline slot, AI planting end to end, zero regression             (AC-10/AC-11)
 */

import { describe, expect, it } from 'vitest';
import {
  AIControllerComponent,
  AIState,
  ATTACK_KEY,
  DEFAULT_HAZARD_BLAST_ACTIVE_TICKS,
  DEFAULT_HAZARD_DAMAGE,
  DEFAULT_HAZARD_DELAY_TICKS,
  EncounterFactory,
  EncounterState,
  EncounterStateComponent,
  EnemyFactory,
  EventQueue,
  Faction,
  FactionComponent,
  GameSimulator,
  GameStateFactory,
  GameStatus,
  HazardComponent,
  HazardCasterComponent,
  HealthComponent,
  HitboxComponent,
  HurtboxComponent,
  IntentComponent,
  PlayerFactory,
  PlayerInputComponent,
  TransformComponent,
  applyDamage,
  applyFreeze,
  createDefaultSystems,
  findGameState,
  isDead,
  isFrozen,
  isRunFailed,
  markDead,
  spawnHazard,
  spawnProjectile,
  vec2,
} from '../../src';
import type {
  EncounterWaveConfig,
  EntityDeathEvent,
  EntityId,
  HitEvent,
  Snapshot,
  System,
  SystemContext,
  World,
} from '../../src';

const FPS = 60;
const MAX_SPEED = 5;
const SEED = 0x12345678;

/** Positional accessor with a loud guard (the repo runs `noUncheckedIndexedAccess`). */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`QA: no sample at index ${String(index)}`);
  }
  return value;
}

/* --- component accessors -------------------------------------------------- */

function hpOf(sim: GameSimulator, id: EntityId): number {
  const health = sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: entity is missing HealthComponent');
  return health.hp;
}

function hazardOf(sim: GameSimulator, id: EntityId): HazardComponent {
  const hazard = sim.world.getComponent(id, HazardComponent);
  if (hazard === undefined) throw new Error('QA: entity is missing HazardComponent');
  return hazard;
}

function intentOf(sim: GameSimulator, id: EntityId): IntentComponent {
  const intent = sim.world.getComponent(id, IntentComponent);
  if (intent === undefined) throw new Error('QA: entity is missing IntentComponent');
  return intent;
}

function aiOf(sim: GameSimulator, id: EntityId): AIControllerComponent {
  const ai = sim.world.getComponent(id, AIControllerComponent);
  if (ai === undefined) throw new Error('QA: entity is missing AIControllerComponent');
  return ai;
}

function transformOf(sim: GameSimulator, id: EntityId): { x: number; y: number } {
  const transform = sim.world.getComponent(id, TransformComponent);
  if (transform === undefined) throw new Error('QA: entity is missing TransformComponent');
  return { x: transform.x, y: transform.y };
}

function encounterOf(sim: GameSimulator, id: EntityId): EncounterStateComponent {
  const encounter = sim.world.getComponent(id, EncounterStateComponent);
  if (encounter === undefined) throw new Error('QA: entity is missing EncounterStateComponent');
  return encounter;
}

/** The player entity, resolved structurally (the ONLY device-driven entity). */
function playerIdOf(sim: GameSimulator): EntityId {
  const id = sim.world.query(PlayerInputComponent)[0];
  if (id === undefined) throw new Error('QA: the world has no player');
  return id;
}

/** The room singleton, resolved by component (there is normally exactly one). */
function roomIdOf(sim: GameSimulator): EntityId {
  const id = sim.world.query(EncounterStateComponent)[0];
  if (id === undefined) throw new Error('QA: the world has no encounter room');
  return id;
}

/* --- buses + spy ---------------------------------------------------------- */

/** Records every HitEvent it sees, draining the bus exactly like a consumer would. */
class HitSpy implements System {
  public readonly name = 'HitSpy';
  public readonly hits: HitEvent[] = [];
  private readonly events: EventQueue;

  constructor(events: EventQueue) {
    this.events = events;
  }

  public update(_world: World, _ctx: SystemContext): void {
    for (const event of this.events.drain()) this.hits.push(event);
  }
}

interface ObservableSim {
  readonly sim: GameSimulator;
  readonly hitEvents: EventQueue;
  readonly deathEvents: EventQueue<EntityDeathEvent>;
  readonly spy: HitSpy;
}

/**
 * The canonical pipeline with a hit-event probe spliced in IMMEDIATELY AFTER
 * CollisionSystem, so a landed blast can be observed as a FACT.
 *
 * The probe OWNS the hit bus (it drains it), so ModifierSystem — the other
 * consumer — sees an empty queue. That is deliberate: this suite asserts that a
 * blast landed (or did not), never what a boon would do about it.
 */
function makeObservableSim(): ObservableSim {
  const hitEvents = new EventQueue();
  const deathEvents = new EventQueue<EntityDeathEvent>();
  const spy = new HitSpy(hitEvents);
  const base = createDefaultSystems(hitEvents, deathEvents);
  const collisionIndex = base.findIndex((system) => system.name === 'CollisionSystem');
  if (collisionIndex === -1) throw new Error('QA: the canonical pipeline has no CollisionSystem');
  const systems = [...base.slice(0, collisionIndex + 1), spy, ...base.slice(collisionIndex + 1)];
  return { sim: new GameSimulator({ fps: FPS, systems }), hitEvents, deathEvents, spy };
}

/* ========================================================================== *
 * G0 · hazard assembly, validation and query invisibility                    *
 * ========================================================================== */
describe('G0 · hazard assembly and contract (AC-01/AC-02)', () => {
  it('spawnHazard mounts EXACTLY Transform + Hazard — no hitbox, no hurtbox, no faction', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    const id = spawnHazard(sim.world, {
      x: 1,
      y: 2,
      radius: 3,
      damage: 25,
      delayTicks: 30,
      faction: Faction.Enemy,
      ownerEntityId: 7,
    });

    // Sorted by component type name (UTF-16): 'HazardComponent' < 'TransformComponent'.
    expect(sim.world.listComponents(id).map((component) => component.constructor.name)).toEqual([
      'HazardComponent',
      'TransformComponent',
    ]);

    const hazard = hazardOf(sim, id);
    expect(hazard.radius).toBe(3);
    expect(hazard.damage).toBe(25);
    expect(hazard.delayTicks).toBe(30);
    expect(hazard.totalDelayTicks).toBe(30);
    expect(hazard.faction).toBe(Faction.Enemy);
    expect(hazard.ownerEntityId).toBe(7);

    // I1/I2/I3 made structural, not conventional: the telegraph cannot deal
    // damage, cannot be hit, cannot be targeted by AI and cannot be wall-resolved,
    // because it owns none of the components those systems query.
    expect(sim.world.getComponent(id, HitboxComponent)).toBeUndefined();
    expect(sim.world.getComponent(id, HurtboxComponent)).toBeUndefined();
    expect(sim.world.getComponent(id, FactionComponent)).toBeUndefined();

    // The one property that matters for the AI: the hazard is NOT in the target set.
    expect(sim.world.query(TransformComponent, HurtboxComponent, FactionComponent, HealthComponent)).toEqual(
      [],
    );
  });

  it('spawnHazard rejects malformed geometry before creating anything', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    spawnHazard(sim.world, { x: 0, y: 0 });

    expect(() => spawnHazard(sim.world, { x: 0, y: 0, radius: 0 })).toThrow(RangeError);
    expect(() => spawnHazard(sim.world, { x: 0, y: 0, radius: Number.NaN })).toThrow(RangeError);
    expect(() => spawnHazard(sim.world, { x: 0, y: 0, damage: -1 })).toThrow(RangeError);
    expect(() => spawnHazard(sim.world, { x: 0, y: 0, delayTicks: -1 })).toThrow(RangeError);
    expect(() => spawnHazard(sim.world, { x: 0, y: 0, delayTicks: 1.5 })).toThrow(RangeError);
    expect(() => spawnHazard(sim.world, { x: Number.NaN, y: 0 })).toThrow(RangeError);
    expect(() => spawnHazard(sim.world, { x: 0, y: Number.POSITIVE_INFINITY })).toThrow(RangeError);

    // A rejected hazard leaks no entity: still exactly the one spawned up front.
    expect(sim.world.entityCount).toBe(1);
  });

  it('the `hazard` spawn option is a capability switch, not a new default', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    const plain = EnemyFactory.spawn(sim.world, {});
    const caster = EnemyFactory.spawn(sim.world, {
      hazard: { radius: 4, damage: 30, delayTicks: 45 },
    });

    // Omit it and the component set is untouched (spec 14 AC-11 zero regression).
    expect(sim.world.getComponent(plain, HazardCasterComponent)).toBeUndefined();

    const tuning = sim.world.getComponent(caster, HazardCasterComponent);
    expect(tuning).toBeDefined();
    expect(tuning?.radius).toBe(4);
    expect(tuning?.damage).toBe(30);
    expect(tuning?.delayTicks).toBe(45);

    // Validation happens at the assembly seam, like every other opt-in capability.
    expect(() => EnemyFactory.spawn(sim.world, { hazard: { radius: -1 } })).toThrow(RangeError);
    expect(() => EnemyFactory.spawn(sim.world, { hazard: { delayTicks: 2.5 } })).toThrow(RangeError);
    expect(sim.world.entityCount).toBe(2);
  });

  it('exposes the blast constants this milestone pins its timing against', () => {
    // Literal pinning rather than "the field equals the constant that built it":
    // re-tuning the blast to live 2 ticks would silently invalidate the whole
    // tick-by-tick contract below, and this assertion is what refuses that.
    expect(DEFAULT_HAZARD_BLAST_ACTIVE_TICKS).toBe(1);
    expect(DEFAULT_HAZARD_DELAY_TICKS).toBe(30);
    expect(DEFAULT_HAZARD_DAMAGE).toBe(25);
  });
});

/* ========================================================================== *
 * G1 · the fuse                                                              *
 * ========================================================================== */
describe('G1 · the delayed blast resolves on exactly the delayTicks-th tick (AC-01)', () => {
  it('does nothing for N ticks, deals exactly `damage` on tick N, and is gone on N+1', () => {
    const { sim, spy } = makeObservableSim();
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const hazardId = spawnHazard(sim.world, {
      x: 0,
      y: 0,
      radius: 2.5,
      damage: DEFAULT_HAZARD_DAMAGE,
      delayTicks: 30,
      faction: Faction.Enemy,
      ownerEntityId: -1,
    });

    // Ticks 0..28 — the telegraph burns down, and NOTHING lands.
    for (let step = 0; step < 29; step += 1) {
      sim.step(1);
      expect(hpOf(sim, player)).toBe(100);
      expect(sim.world.isAlive(hazardId)).toBe(true);
    }
    expect(sim.tick).toBe(29);
    expect(hazardOf(sim, hazardId).delayTicks).toBe(1);
    expect(spy.hits).toEqual([]);

    // Tick 29 — the LAST telegraph tick: fused to zero, still not blown.
    sim.step(1);
    expect(hazardOf(sim, hazardId).delayTicks).toBe(0);
    expect(sim.world.isAlive(hazardId)).toBe(true);
    expect(hpOf(sim, player)).toBe(100);

    // Tick 30 — detonation: the blast lands on the SAME tick the telegraph dies.
    sim.step(1);
    expect(hpOf(sim, player)).toBe(100 - DEFAULT_HAZARD_DAMAGE);
    expect(sim.world.isAlive(hazardId)).toBe(false);

    // The blast hitbox lived exactly ONE tick: spawned before CollisionSystem,
    // aged by LifespanSystem at the end of that same tick.
    expect(sim.world.query(HitboxComponent)).toEqual([]);

    // Exactly one settlement, carrying the hazard's own numbers.
    expect(spy.hits).toHaveLength(1);
    const hit = at(spy.hits, 0);
    expect(hit.targetId).toBe(player);
    expect(hit.damage).toBe(DEFAULT_HAZARD_DAMAGE);
    // A hazard is a BASE hit — never a boon-injected one, so a modifier may react.
    expect(hit.sourceModifier).toBeNull();
    // Its owner is the (already destroyed) hazard, NOT the thrower: see below.
    expect(hit.attackerId).toBe(hazardId);

    // Tick 31 — nothing lingers.
    sim.step(1);
    expect(hpOf(sim, player)).toBe(100 - DEFAULT_HAZARD_DAMAGE);
    expect(sim.world.isAlive(hazardId)).toBe(false);
    expect(spy.hits).toHaveLength(1);
  });

  it('still detonates after its AUTHOR dies — a planted bomb outlives its planter', () => {
    // The trap this pins (spec 14 risk R3): CollisionSystem's owner gate skips a
    // swing whose owner is DEAD. If the blast were owned by the enemy, killing the
    // enemy during the telegraph window would silently disarm the bomb — the one
    // situation a delayed AoE exists to punish.
    const { sim, spy } = makeObservableSim();
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const author = EnemyFactory.spawn(sim.world, { x: 20, y: 20, maxHp: 10, hp: 10 });
    const hazardId = spawnHazard(sim.world, {
      x: 0,
      y: 0,
      delayTicks: 5,
      faction: Faction.Enemy,
      ownerEntityId: author,
    });

    applyDamage(sim.world, author, 999);
    sim.step(1); // tick 0 — the author dies (tagged at the END of the tick)
    expect(isDead(sim.world, author)).toBe(true);

    sim.step(5); // ticks 1..5 — detonation on tick 5
    expect(sim.world.isAlive(hazardId)).toBe(false);
    expect(hpOf(sim, player)).toBe(100 - DEFAULT_HAZARD_DAMAGE);
    expect(spy.hits).toHaveLength(1);
  });

  it('is NOT gated on freeze — the fuse is the environment clock, not an action (AC-03)', () => {
    const { sim } = makeObservableSim();
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const hazardId = spawnHazard(sim.world, {
      x: 0,
      y: 0,
      delayTicks: 10,
      faction: Faction.Enemy,
      ownerEntityId: -1,
    });

    // An absurd freeze: 1000 ticks, i.e. ~16 seconds of hitstop.
    applyFreeze(sim.world, hazardId, 1000);

    sim.step(10); // ticks 0..9 — the fuse reaches 0 despite being frozen solid
    expect(isFrozen(sim.world, hazardId)).toBe(true);
    expect(hazardOf(sim, hazardId).delayTicks).toBe(0);
    expect(hpOf(sim, player)).toBe(100);

    sim.step(1); // tick 10 — it blows anyway
    expect(hpOf(sim, player)).toBe(100 - DEFAULT_HAZARD_DAMAGE);
    expect(sim.world.isAlive(hazardId)).toBe(false);
  });

  it('a zero-fuse hazard blows on its very first tick (the N = 0 limit of T + N)', () => {
    const { sim } = makeObservableSim();
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    spawnHazard(sim.world, { x: 0, y: 0, delayTicks: 0, faction: Faction.Enemy, ownerEntityId: -1 });

    // No "wait at least one tick" special case: the fuse is already at zero, so the
    // first update detonates. The arithmetic reads "now", and this pins that.
    sim.step(1); // tick 0
    expect(hpOf(sim, player)).toBe(100 - DEFAULT_HAZARD_DAMAGE);
  });
});

/* ========================================================================== *
 * G2 · pulse gating                                                          *
 * ========================================================================== */
describe('G2 · a corpse or a frozen entity is left holding no bomb (AC-04)', () => {
  it('a corpse cannot plant, and its hand-written pulse is neither executed nor cleared', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const corpse = EnemyFactory.spawn(sim.world, { x: 5, y: 5, hazard: {} });
    markDead(sim.world, corpse);

    intentOf(sim, corpse).wantsToHazard = true;
    const entitiesBefore = sim.world.entityCount;

    sim.step(1);

    expect(sim.world.query(HazardComponent)).toEqual([]);
    expect(sim.world.entityCount).toBe(entitiesBefore);
    // Skipped BEFORE the read-and-clear, exactly like CombatActionSystem: a pulse
    // that was never read was never buffered either.
    expect(intentOf(sim, corpse).wantsToHazard).toBe(true);
  });

  it('freeze clears the pulse, so no bomb appears when the hitstop lapses', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const enemy = EnemyFactory.spawn(sim.world, { x: 5, y: 5, hazard: {} });
    applyFreeze(sim.world, enemy, 5);
    intentOf(sim, enemy).wantsToHazard = true;

    sim.step(1);

    expect(intentOf(sim, enemy).wantsToHazard).toBe(false);
    expect(sim.world.query(HazardComponent)).toEqual([]);

    sim.step(30);
    expect(sim.world.query(HazardComponent)).toEqual([]);
  });

  it('a non-planter consumes and DROPS the pulse — it is never buffered', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    // No `hazard` option => no HazardCasterComponent: this entity can never plant.
    const plain = EnemyFactory.spawn(sim.world, { x: 5, y: 5 });
    intentOf(sim, plain).wantsToHazard = true;

    sim.step(1);

    expect(sim.world.query(HazardComponent)).toEqual([]);
    // Consumed (dropped) rather than left set: the one-tick wire contract.
    expect(intentOf(sim, plain).wantsToHazard).toBe(false);
  });

  it('death neutralises the pulse on the corpse itself', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const enemy = EnemyFactory.spawn(sim.world, { x: 5, y: 5, maxHp: 10, hp: 10, hazard: {} });
    applyDamage(sim.world, enemy, 999);

    sim.step(1); // tick 0 — dies; DeathSystem neutralises its intent

    expect(isDead(sim.world, enemy)).toBe(true);
    expect(intentOf(sim, enemy).wantsToHazard).toBe(false);
  });
});

/* ========================================================================== *
 * G3 · RUN_FAILED                                                            *
 * ========================================================================== */
const TWO_WAVES: readonly EncounterWaveConfig[] = [
  { delayTicks: 0, enemies: [{ x: 5, y: 0, maxHp: 100, hp: 100 }] },
  { delayTicks: 10, enemies: [{ x: 6, y: 0, maxHp: 100, hp: 100 }] },
];

interface RunRig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
  readonly room: EntityId;
  readonly deathEvents: EventQueue<EntityDeathEvent>;
}

/** A run-shaped world: player + room + the run's state singleton. */
function makeRunRig(waves: readonly EncounterWaveConfig[] = TWO_WAVES): RunRig {
  const deathEvents = new EventQueue<EntityDeathEvent>();
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(new EventQueue(), deathEvents) });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
  const room = EncounterFactory.spawn(sim.world, { waves });
  GameStateFactory.spawn(sim.world);
  return { sim, player, room, deathEvents };
}

describe('G3 · the run fails on the tick the player dies (AC-05)', () => {
  it('writes RUN_FAILED in the same tick and the player stops acting from then on', () => {
    const { sim, player } = makeRunRig();

    expect(isRunFailed(sim.world)).toBe(false);
    expect(findGameState(sim.world)?.status).toBe(GameStatus.PLAYING);

    // Hold the stick AND tap attack, so "stops responding" is falsifiable.
    sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // tick 0 — the player really does move and swing
    expect(transformOf(sim, player).x).toBeGreaterThan(0);

    applyDamage(sim.world, player, 999);
    sim.step(1); // tick 1 — dies here; DeathSystem tags it AND fails the run

    expect(isDead(sim.world, player)).toBe(true);
    expect(isRunFailed(sim.world)).toBe(true);
    expect(findGameState(sim.world)?.status).toBe(GameStatus.RUN_FAILED);
    expect(intentOf(sim, player).moveVector).toEqual(vec2(0, 0));

    // The stick is STILL held (persistent `move`), so any movement below would be a
    // real leak rather than an absence of input.
    const resting = transformOf(sim, player);
    const hitboxesAtDeath = sim.world.query(HitboxComponent).length;
    for (let tick = 2; tick <= 8; tick += 1) {
      sim.step(1);
      expect(transformOf(sim, player)).toEqual(resting);
      expect(intentOf(sim, player).moveVector).toEqual(vec2(0, 0));
      expect(intentOf(sim, player).wantsToAttack).toBe(false);
    }
    // No new swing was raised after death (the tick-0 swing has expired by now).
    sim.step(10);
    expect(sim.world.query(HitboxComponent).length).toBeLessThanOrEqual(hitboxesAtDeath);
  });

  it('the RUN gate is not the death gate: a LIVE player in a failed run produces no intent', () => {
    const { sim, player } = makeRunRig();
    const state = findGameState(sim.world);
    if (state === undefined) throw new Error('QA: the rig has no game state');

    // Failing the run without killing anyone is only reachable by hand, and that is
    // precisely the point: it isolates the RUN gate from the death gate. Remove the
    // `isRunFailed` check in PlayerControllerSystem and this test goes red.
    state.status = GameStatus.RUN_FAILED;

    sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1);

    expect(isDead(sim.world, player)).toBe(false); // alive: nothing else can be doing this
    expect(intentOf(sim, player).moveVector).toEqual(vec2(0, 0));
    expect(intentOf(sim, player).wantsToAttack).toBe(false);
    expect(transformOf(sim, player)).toEqual({ x: 0, y: 0 });
    expect(sim.world.query(HitboxComponent)).toEqual([]);
  });
});

describe('G3 · a failed run does not advance the room (AC-06)', () => {
  it('never spawns the next wave once the run has failed, where a live run does', () => {
    const failed = makeRunRig();
    failed.sim.step(1); // tick 0 — wave 0 spawns
    const waveOne = [...encounterOf(failed.sim, failed.room).trackedEntityIds];
    expect(waveOne).toHaveLength(1);

    // Wipe the wave AND die on the same tick. DeathSystem (index 12) runs before
    // EncounterSystem (index 13), so the room sees a failed run THIS tick.
    applyDamage(failed.sim.world, at(waveOne, 0), 999);
    applyDamage(failed.sim.world, failed.player, 999);
    failed.sim.step(1); // tick 1

    expect(isDead(failed.sim.world, at(waveOne, 0))).toBe(true);
    expect(isDead(failed.sim.world, failed.player)).toBe(true);
    expect(isRunFailed(failed.sim.world)).toBe(true);

    // The room never even noticed the wipe: still IN_PROGRESS, roster untouched.
    expect(encounterOf(failed.sim, failed.room).state).toBe(EncounterState.IN_PROGRESS);
    expect(encounterOf(failed.sim, failed.room).trackedEntityIds).toEqual(waveOne);
    expect(encounterOf(failed.sim, failed.room).nextSpawnTick).toBe(-1);

    const frozenCount = failed.sim.world.entityCount;
    failed.sim.step(60); // long past the 10-tick wave delay
    expect(encounterOf(failed.sim, failed.room).state).toBe(EncounterState.IN_PROGRESS);
    expect(encounterOf(failed.sim, failed.room).trackedEntityIds).toEqual(waveOne);
    expect(failed.sim.world.entityCount).toBe(frozenCount);

    // CONTROL — the identical script with a living player DOES advance, so the
    // assertion above is measuring the gate rather than a broken script.
    const alive = makeRunRig();
    alive.sim.step(1); // tick 0
    const controlWave = [...encounterOf(alive.sim, alive.room).trackedEntityIds];
    applyDamage(alive.sim.world, at(controlWave, 0), 999);
    alive.sim.step(1); // tick 1 — wipe detected
    expect(encounterOf(alive.sim, alive.room).state).toBe(EncounterState.WAVE_CLEAR);
    expect(encounterOf(alive.sim, alive.room).nextSpawnTick).toBe(11);

    alive.sim.step(10); // ticks 2..11
    expect(encounterOf(alive.sim, alive.room).trackedEntityIds).toHaveLength(1);
    expect(at(encounterOf(alive.sim, alive.room).trackedEntityIds, 0)).not.toBe(at(controlWave, 0));
  });
});

/* ========================================================================== *
 * G4 · restartRun                                                            *
 * ========================================================================== */
const RUN_WAVES: readonly EncounterWaveConfig[] = [
  { delayTicks: 0, enemies: [{ x: 5, y: 0, maxHp: 100, hp: 100 }] },
];

/**
 * The run shape used by every restart test: one wave, so one wipe clears it.
 *
 * M9-T01: the room is declared as a TWO-room run, because clearing a run's LAST
 * room now wins it outright rather than rolling a draft (spec 15 AC-04). The
 * determinism test below asserts the DRAFT the room rolls, so room 0 must not be
 * the final room. The entity count is unaffected (`EncounterFactory.spawn` still
 * creates exactly one room entity).
 */
function runSetup(world: World): void {
  PlayerFactory.spawn(world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
  EncounterFactory.spawn(world, { waves: RUN_WAVES, rooms: [RUN_WAVES] });
  GameStateFactory.spawn(world);
}

describe('G4 · restartRun rebuilds the world from scratch (AC-07/AC-08/AC-09)', () => {
  it('leaves no zombie entity, no stale event and no rewound id', () => {
    const deathEvents = new EventQueue<EntityDeathEvent>();
    const sim = new GameSimulator({
      fps: FPS,
      systems: createDefaultSystems(new EventQueue(), deathEvents),
      seed: SEED,
      runSetup,
    });
    runSetup(sim.world);

    // What a pristine run looks like after its opening tick — the reference count.
    const reference = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED, runSetup });
    runSetup(reference.world);
    reference.step(1);
    const initialCount = reference.world.entityCount;
    expect(initialCount).toBe(4); // player + room + game state + wave-0 enemy

    sim.step(1); // tick 0 — wave 0 spawns
    const oldPlayer = playerIdOf(sim);
    const oldRoom = roomIdOf(sim);
    const oldEnemy = at(encounterOf(sim, oldRoom).trackedEntityIds, 0);

    // Two kinds of transient the milestone is specifically about.
    spawnProjectile(sim.world, {
      x: 0,
      y: 0,
      directionRadians: 0,
      faction: Faction.Player,
      ownerEntityId: oldPlayer,
    });
    const lastIdBefore = spawnHazard(sim.world, { x: 3, y: 3, delayTicks: 100, ownerEntityId: -1 });

    // Fail the run.
    applyDamage(sim.world, oldPlayer, 999);
    sim.step(1); // tick 1
    expect(isRunFailed(sim.world)).toBe(true);
    expect(sim.tick).toBe(2);
    // The death bus deliberately keeps the deaths of the tick it just processed.
    expect(deathEvents.size).toBeGreaterThan(0);

    sim.restartRun();

    // (1) clock rewound, (2) seed advanced, (3) run live again, (4) buses dropped.
    expect(sim.tick).toBe(0);
    expect(sim.world.rng.seed).toBe(SEED + 1);
    expect(isRunFailed(sim.world)).toBe(false);
    expect(findGameState(sim.world)?.status).toBe(GameStatus.PLAYING);
    expect(deathEvents.size).toBe(0);

    // Every old entity is gone — including the two transients and the corpse.
    for (const id of [oldPlayer, oldRoom, oldEnemy, lastIdBefore]) {
      expect(sim.world.isAlive(id)).toBe(false);
    }
    expect(sim.world.query(HazardComponent)).toEqual([]);
    expect(sim.world.query(HitboxComponent)).toEqual([]);

    // The run was rebuilt, and behaves exactly like a fresh one.
    expect(sim.world.entityCount).toBe(3);
    sim.step(1);
    expect(sim.world.entityCount).toBe(initialCount);
    expect(playerIdOf(sim)).not.toBe(oldPlayer);

    // AC-09 — ids NEVER rewind. `GameRenderer.retired` depends on this: a reused id
    // would hand the new player a view slot that is permanently retired.
    expect(playerIdOf(sim)).toBeGreaterThan(lastIdBefore);
  });

  it('increments the seed by default and honours an explicit one', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED, runSetup });
    runSetup(sim.world);
    expect(sim.world.rng.seed).toBe(SEED);

    sim.restartRun();
    expect(sim.world.rng.seed).toBe(SEED + 1);
    sim.restartRun();
    expect(sim.world.rng.seed).toBe(SEED + 2);
    sim.restartRun(777);
    expect(sim.world.rng.seed).toBe(777);
  });

  it('makes a restarted run indistinguishable from a fresh run on the new seed', () => {
    // The strongest available determinism statement, asserted where randomness is
    // actually consumed: the reward draft the room rolls.
    const restarted = new GameSimulator({
      fps: FPS,
      systems: createDefaultSystems(),
      seed: SEED,
      runSetup,
    });
    runSetup(restarted.world);
    restarted.step(7); // burn some ticks, then throw the whole run away
    restarted.restartRun(); // seed -> SEED + 1

    const fresh = new GameSimulator({
      fps: FPS,
      systems: createDefaultSystems(),
      seed: SEED + 1,
      runSetup,
    });
    runSetup(fresh.world);

    const draftOf = (sim: GameSimulator): readonly string[] | null => {
      sim.step(1); // tick 0 — wave 0 spawns
      const room = roomIdOf(sim);
      for (const id of [...encounterOf(sim, room).trackedEntityIds]) {
        applyDamage(sim.world, id, 999);
      }
      sim.step(1); // tick 1 — wipe detected, room cleared, draft rolled
      return encounterOf(sim, room).pendingRewards;
    };

    const restartedDraft = draftOf(restarted);
    const freshDraft = draftOf(fresh);

    expect(restartedDraft).not.toBeNull();
    expect(restartedDraft).toHaveLength(3);
    expect(restartedDraft).toEqual(freshDraft);
    expect(encounterOf(restarted, roomIdOf(restarted)).state).toBe(EncounterState.ROOM_CLEARED);
  });

  it('two simulators restarted in lockstep stay bit-for-bit identical', () => {
    const build = (): GameSimulator => {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED, runSetup });
      runSetup(sim.world);
      return sim;
    };

    const a = build();
    const b = build();
    a.step(5);
    b.step(5);
    a.restartRun();
    b.restartRun();

    const framesA: Snapshot[] = [];
    const framesB: Snapshot[] = [];
    for (let i = 0; i < 3; i += 1) {
      a.step(1);
      b.step(1);
      framesA.push(a.snapshot());
      framesB.push(b.snapshot());
    }
    expect(framesB).toEqual(framesA);
  });
});

/* ========================================================================== *
 * G5 · pipeline slot, AI planting, zero regression                           *
 * ========================================================================== */
describe('G5 · pipeline slot and zero regression (AC-10/AC-11)', () => {
  it('adds exactly one segment, between AISystem and MovementSystem', () => {
    const names = createDefaultSystems().map((system) => system.name);
    expect(names).toEqual([
      'TransformSnapshotSystem',
      'PlayerControllerSystem',
      'FreezeSystem',
      'AISystem',
      'HazardSystem',
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
      'PickupSystem',
      'LifespanSystem',
    ]);
    expect(names).toHaveLength(17);
    expect(names.filter((name) => name === 'HazardSystem')).toHaveLength(1);

    const hazard = names.indexOf('HazardSystem');
    // The pulse is raised by the AI THIS tick, so the consumer must follow it.
    expect(hazard).toBeGreaterThan(names.indexOf('AISystem'));
    // The blast must be collision-tested on the tick it is spawned — that is what
    // makes `activeTicks = 1` mean "exactly one test" instead of "a silent no-op".
    expect(hazard).toBeLessThan(names.indexOf('CollisionSystem'));
    // And it lands BEFORE this tick's displacement, so the telegraph marks the
    // ground the target is standing on now rather than where it ended up.
    expect(hazard).toBeLessThan(names.indexOf('MovementSystem'));
    expect(names.indexOf('LifespanSystem')).toBe(names.length - 1);
  });

  it('an AI hazard caster plants at its target feet on the tick its windup ends', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, {
      x: 1,
      y: 0,
      maxSpeed: MAX_SPEED,
      ai: { sightRadius: 10, attackRadius: 3, windupTicks: 5, cooldownTicks: 20 },
      hazard: { radius: 2, damage: 25, delayTicks: 10 },
    });

    sim.step(1); // tick 0 — the target is already in attack range => WINDUP, no pulse
    expect(aiOf(sim, enemy).state).toBe(AIState.WINDUP);
    expect(sim.world.query(HazardComponent)).toEqual([]);

    sim.step(4); // ticks 1..4 — still winding up
    expect(sim.world.query(HazardComponent)).toEqual([]);

    sim.step(1); // tick 5 — the windup ends: melee swing AND telegraph, same tick
    const hazards = sim.world.query(HazardComponent);
    expect(hazards).toHaveLength(1);

    const hazardId = at(hazards, 0);
    const hazard = hazardOf(sim, hazardId);
    expect(hazard.radius).toBe(2);
    expect(hazard.damage).toBe(25);
    expect(hazard.totalDelayTicks).toBe(10);
    // Phase A plants, phase B decrements in the SAME update, so a freshly planted
    // 10-tick fuse reads 9 at the tick boundary.
    expect(hazard.delayTicks).toBe(9);
    expect(hazard.faction).toBe(Faction.Enemy);
    expect(hazard.ownerEntityId).toBe(enemy);
    // It lands at the TARGET's feet, not the caster's.
    expect(transformOf(sim, hazardId)).toEqual(transformOf(sim, player));

    // The melee half of the attack still happened — "not just melee" means BOTH.
    expect(sim.world.query(HitboxComponent)).toHaveLength(1);

    const hpAtPlant = hpOf(sim, player);
    sim.step(10); // ticks 6..15 — detonation on tick 15
    expect(sim.world.isAlive(hazardId)).toBe(false);
    expect(hpOf(sim, player)).toBeLessThan(hpAtPlant);
  });

  it('a world with no game state is never failed — and a dead player does not crash it', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });

    expect(findGameState(sim.world)).toBeUndefined();
    expect(isRunFailed(sim.world)).toBe(false);

    // With no run state, the player's input works exactly as it did before M8.
    sim.step(20);
    sim.inject({ kind: 'move', tick: 20, vector: vec2(1, 0) });
    sim.step(1);
    expect(transformOf(sim, player).x).toBeGreaterThan(0);

    // Dying in a world that never assembled a run is an ordinary death.
    applyDamage(sim.world, player, 999);
    sim.step(1);
    expect(isDead(sim.world, player)).toBe(true);
    expect(isRunFailed(sim.world)).toBe(false);
  });

  it('a world with no hazards is untouched by HazardSystem', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const before = sim.world.entityCount;

    sim.step(30);

    expect(sim.world.entityCount).toBe(before);
    expect(sim.world.query(HazardComponent)).toEqual([]);
    expect(hpOf(sim, playerIdOf(sim))).toBe(100);
  });
});
