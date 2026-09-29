/**
 * M4-T02 · Death lifecycle + room / wave scheduling acceptance tests.
 * See specs/08_encounter_and_death_spec.md §4 (semantics), §6 (tick-by-tick
 * contract) and §7 (AC-01 .. AC-10).
 *
 * Fresh-eyes harness suite: every assertion drives the REAL GameSimulator with the
 * canonical 17-segment pipeline (TransformSnapshotSystem -> PlayerControllerSystem
 * -> FreezeSystem -> AISystem -> HazardSystem -> MovementSystem -> DashSystem ->
 * StateSystem -> CombatActionSystem -> CollisionSystem -> StatusEffectSystem ->
 * ModifierSystem -> DeathSystem -> EncounterSystem -> RewardSystem -> PickupSystem
 * -> LifespanSystem) and REAL
 * prefab-assembled entities. Nothing is mocked, and ticks are advanced one at a
 * time so the timing contract is pinned per tick.
 *
 * TICK NUMBERING (the classic off-by-one trap — spec 08 §6):
 *   `sim.step(n)` processes processed-ticks `0 .. n-1`, leaving `sim.tick === n`.
 *   A fresh sim therefore needs `step(p + 1)` to have processed tick `p`.
 *
 * GEOMETRY (used to derive every expected tick):
 *   melee hitbox centre = attacker + 0.75 along `facingRadians`, radius 1.0;
 *   hurtbox radius 0.5 => effective reach 2.25.
 *   An enemy at (1.0, 0) with the player at (0, 0) facing +x is therefore inside
 *   the swing on the very tick it is raised.
 *
 * Grouping:
 *   G0 · component + config contracts (markDead / isDead / isWaveCleared / factory)  (AC-02/AC-05/AC-06)
 *   G1 · the death transition: tag at the END of the killing tick, one event only  (AC-01/AC-06)
 *   G2 · a corpse is not interactive: target gate / owner gate / same-tick gate     (AC-01/AC-04)
 *   G3 · a corpse produces no intent: AI path and player hardware path              (AC-01/AC-04)
 *   G4 · single-wave room: cleared on the tick the last member dies                 (AC-03)
 *   G5 · multi-wave scheduling: wave 2 spawns exactly `delayTicks` after the wipe   (AC-03)
 *   G6 · canonical 17-segment pipeline order                                        (AC-07)
 *   G7 · deterministic replay of a full encounter script                            (AC-08)
 *   G8 · zero regression + the death bus is bounded to one tick                     (AC-09/AC-10)
 */

import { describe, expect, it } from 'vitest';
import {
  AIControllerComponent,
  AIState,
  ATTACK_KEY,
  ActionState,
  DEFAULT_ATTACK_DAMAGE,
  DEFAULT_HITSTOP_TICKS,
  ENCOUNTER_WAVE_UNSCHEDULED,
  EncounterFactory,
  EncounterState,
  EncounterStateComponent,
  EnemyFactory,
  EventQueue,
  Faction,
  FactionComponent,
  FreezeComponent,
  GameSimulator,
  HealthComponent,
  HitboxComponent,
  INVULNERABLE_TAG,
  IntentComponent,
  KnockbackComponent,
  POISON_STATUS_SPEC,
  PlayerFactory,
  StateComponent,
  TransformComponent,
  applyDamage,
  applyStatusEffect,
  createDefaultSystems,
  getStatusEffect,
  hasTag,
  isDead,
  isWaveCleared,
  markDead,
  resolveEncounterConfig,
  vec2,
} from '../../src';
import type {
  EntityDeathEvent,
  EntityId,
  HitEvent,
  Snapshot,
  System,
  SystemContext,
  World,
} from '../../src';
import { SchemaError } from '../../src';
import { testEnemy, testEnemyRef } from '../harness/config-fixtures';

const FPS = 60;
const MAX_SPEED = 5;

/** Positional accessor with a loud guard (the repo runs `noUncheckedIndexedAccess`). */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`QA: no sample at index ${String(index)}`);
  }
  return value;
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
 * CollisionSystem, so a landed hit can be observed as a FACT.
 *
 * The probe OWNS the hit bus (it drains it), which is why ModifierSystem — the other
 * consumer — sees an empty queue here. That is deliberate: this suite asserts that
 * a hit happened (or did not), never what a boon does about it (spec 05 §6.5).
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

/* --- component accessors -------------------------------------------------- */

function hpOf(sim: GameSimulator, id: EntityId): number {
  const health = sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: entity is missing HealthComponent');
  return health.hp;
}

function stateOf(sim: GameSimulator, id: EntityId): StateComponent {
  const state = sim.world.getComponent(id, StateComponent);
  if (state === undefined) throw new Error('QA: entity is missing StateComponent');
  return state;
}

function intentOf(sim: GameSimulator, id: EntityId): IntentComponent {  const intent = sim.world.getComponent(id, IntentComponent);
  if (intent === undefined) throw new Error('QA: entity is missing IntentComponent');
  return intent;
}

function aiOf(sim: GameSimulator, id: EntityId): AIControllerComponent {
  const ai = sim.world.getComponent(id, AIControllerComponent);
  if (ai === undefined) throw new Error('QA: entity is missing AIControllerComponent');
  return ai;
}

function factionOf(sim: GameSimulator, id: EntityId): Faction {
  const component = sim.world.getComponent(id, FactionComponent);
  if (component === undefined) throw new Error('QA: entity is missing FactionComponent');
  return component.faction;
}

function transformOf(sim: GameSimulator, id: EntityId): { x: number; y: number } {
  const transform = sim.world.getComponent(id, TransformComponent);
  if (transform === undefined) throw new Error('QA: entity is missing TransformComponent');
  return { x: transform.x, y: transform.y };
}

function hitboxOf(sim: GameSimulator, id: EntityId): HitboxComponent {
  const hitbox = sim.world.getComponent(id, HitboxComponent);
  if (hitbox === undefined) throw new Error('QA: entity is missing HitboxComponent');
  return hitbox;
}

function encounterOf(sim: GameSimulator, id: EntityId): EncounterStateComponent {
  const encounter = sim.world.getComponent(id, EncounterStateComponent);
  if (encounter === undefined) throw new Error('QA: entity is missing EncounterStateComponent');
  return encounter;
}

/** Ids of every live Player-faction hitbox, in ascending order. */
function playerHitboxes(sim: GameSimulator): EntityId[] {
  return sim.world.query(TransformComponent, HitboxComponent).filter((id) => {
    const hitbox = sim.world.getComponent(id, HitboxComponent);
    return hitbox !== undefined && hitbox.faction === Faction.Player;
  });
}

/**
 * Hand-assemble a Player-faction hitbox owned by `owner`, centred on (x, y).
 *
 * Used where a REAL swing cannot express the scenario: the target gate and the owner
 * gate must be probed with a hitbox whose `hitEntities` ledger is still EMPTY, and a
 * real swing that already killed its target has that target in its ledger. This is
 * not a mock — it is a real entity built from the real components, driven through
 * the real CollisionSystem.
 */
function spawnProbeHitbox(
  sim: GameSimulator,
  options: {
    x: number;
    y: number;
    owner: EntityId;
    activeTicks?: number;
    hitstopTicks?: number;
    knockbackForce?: number;
  },
): EntityId {
  const entity = sim.world.createEntity();
  sim.world.addComponent(entity.id, new TransformComponent(options.x, options.y, 0));
  sim.world.addComponent(
    entity.id,
    new HitboxComponent(
      1,
      DEFAULT_ATTACK_DAMAGE,
      options.activeTicks ?? 5,
      Faction.Player,
      options.owner,
      options.hitstopTicks ?? DEFAULT_HITSTOP_TICKS,
      options.knockbackForce ?? 12,
    ),
  );
  return entity.id;
}

/* ========================================================================== *
 * G0 · component + config contracts                                          *
 * ========================================================================== */
describe('G0 · death marker and room config contracts (AC-02/AC-05/AC-06)', () => {
  it('markDead is idempotent and isDead distinguishes dead from destroyed', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    const enemy = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, maxHp: 10, hp: 10 }));

    expect(isDead(sim.world, enemy)).toBe(false);

    markDead(sim.world, enemy);
    markDead(sim.world, enemy); // idempotent: the transition can never be applied twice
    expect(isDead(sim.world, enemy)).toBe(true);
    // Death is a STATE, not a delete (spec 08 §3.1): the corpse is still in the world.
    expect(sim.world.isAlive(enemy)).toBe(true);
    expect(hpOf(sim, enemy)).toBe(10);

    sim.world.destroyEntity(enemy);
    // "Gone" has two INDEPENDENT reasons. A destroyed id is not "dead" — callers must
    // treat the two separately, which is what keeps `isWaveCleared` honest.
    expect(isDead(sim.world, enemy)).toBe(false);
    expect(sim.world.isAlive(enemy)).toBe(false);
  });

  it('isWaveCleared: an EMPTY roster is "not spawned yet", never "cleared"', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    const alive = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, maxHp: 10, hp: 10 }));
    const dead = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 1, y: 0, maxHp: 10, hp: 10 }));
    const destroyed = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 2, y: 0, maxHp: 10, hp: 10 }));
    markDead(sim.world, dead);
    sim.world.destroyEntity(destroyed);

    expect(isWaveCleared(sim.world, [])).toBe(false);
    expect(isWaveCleared(sim.world, [dead])).toBe(true);
    expect(isWaveCleared(sim.world, [destroyed])).toBe(true);
    expect(isWaveCleared(sim.world, [alive])).toBe(false);
    expect(isWaveCleared(sim.world, [dead, alive])).toBe(false);
  });

  it('EncounterFactory.spawn mounts one component and starts IN_PROGRESS, wave 0, unscheduled', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    const room = EncounterFactory.spawn(sim.world, {
      waves: [{ delayTicks: 0, enemies: [testEnemyRef({ x: 5, y: 0 })] }],
    });

    expect(sim.world.entityCount).toBe(1);
    expect(sim.world.listComponents(room).map((component) => component.constructor.name)).toEqual([
      'EncounterStateComponent',
    ]);

    const encounter = encounterOf(sim, room);
    expect(encounter.state).toBe(EncounterState.IN_PROGRESS);
    expect(encounter.currentWaveIndex).toBe(0);
    expect(encounter.nextSpawnTick).toBe(ENCOUNTER_WAVE_UNSCHEDULED);
    expect(encounter.trackedEntityIds).toEqual([]);
    // The room does NOT spawn its opening wave at load time — spawning is a per-tick
    // decision that belongs to EncounterSystem (spec 08 §3.4).
    expect(sim.world.entityCount).toBe(1);
  });

  it('resolveEncounterConfig rejects every structurally invalid room, before any tick runs', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });

    expect(() => resolveEncounterConfig({ waves: [] })).toThrow(RangeError);
    expect(() => resolveEncounterConfig({ waves: [{ delayTicks: -1, enemies: [testEnemyRef({})] }] })).toThrow(
      RangeError,
    );
    expect(() => resolveEncounterConfig({ waves: [{ delayTicks: 1.5, enemies: [testEnemyRef({})] }] })).toThrow(
      RangeError,
    );
    // A wave with no enemies would wedge the room forever: an empty tracked roster is
    // the "not spawned yet" marker (spec 08 §3.2 / §8).
    expect(() => resolveEncounterConfig({ waves: [{ delayTicks: 0, enemies: [] }] })).toThrow(
      RangeError,
    );
    // Per-enemy rules are validated by DRY-RUNNING the real assembly, so a wave that
    // names an enemy TYPE the config table does not know is caught here rather than
    // aborting a simulation mid-tick (AC-05). A malformed enemy CONFIG never reaches
    // this point at all: it fails the schema during Bootstrap (spec 16 AC-02), which
    // is why the pre-M10 `{ maxHp: -1 }` probe now has to be a bad TYPE id.
    expect(() =>
      resolveEncounterConfig({ waves: [{ delayTicks: 0, enemies: [{ enemyId: 'no_such_enemy' }] }] }),
    ).toThrow(SchemaError);

    // Loading fails BEFORE the room entity is created, so a rejected room is inert.
    expect(() =>
      EncounterFactory.spawn(sim.world, {
        waves: [{ delayTicks: 0, enemies: [{ enemyId: 'no_such_enemy' }] }],
      }),
    ).toThrow(SchemaError);
    expect(sim.world.entityCount).toBe(0);
  });
});

/* ========================================================================== *
 * G1 · the death transition                                                  *
 * ========================================================================== */
describe('G1 · the death transition happens at the END of the killing tick (AC-01/AC-06)', () => {
  it('tags the corpse, neutralises its intent and publishes exactly one EntityDeathEvent', () => {
    const { sim, deathEvents } = makeObservableSim();
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, ...testEnemy({
      x: 1.0,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
      maxHp: DEFAULT_ATTACK_DAMAGE,
      hp: DEFAULT_ATTACK_DAMAGE,
    }));

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // processed tick 0 — the killing tick

    expect(hpOf(sim, enemy)).toBe(0);
    expect(isDead(sim.world, enemy)).toBe(true);
    expect(sim.world.isAlive(enemy)).toBe(true); // retained, not recycled (AC-06)

    // AC-01 second half, made observable rather than merely implied: the corpse's
    // intent is zeroed at the moment of death (spec 08 §4.1 step 2).
    const intent = intentOf(sim, enemy);
    expect(intent.moveVector).toEqual(vec2(0, 0));
    expect(intent.wantsToDash).toBe(false);
    expect(intent.wantsToAttack).toBe(false);
    expect(intent.aimRadians).toBeNull();

    const deaths = deathEvents.drain();
    expect(deaths).toHaveLength(1);
    expect(at(deaths, 0)).toEqual({ tick: 0, entityId: enemy });

    // Running on never publishes a second event for the same entity, and never
    // destroys it (spec 08 §3.3 / AC-06).
    sim.step(20);
    expect(deathEvents.size).toBe(0);
    expect(sim.world.isAlive(enemy)).toBe(true);
    expect(isDead(sim.world, enemy)).toBe(true);
    expect(hpOf(sim, enemy)).toBe(0);
  });
});

/* ========================================================================== *
 * G2 · a corpse is not interactive                                           *
 * ========================================================================== */
describe('G2 · a corpse is not interactive from the very next tick (AC-01/AC-04)', () => {
  it('the swing that killed it keeps overlapping for 15 ticks and never re-hits it', () => {
    const { sim, spy } = makeObservableSim();
    const player = PlayerFactory.spawn(sim.world, {
      x: 0,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    const enemy = EnemyFactory.spawn(sim.world, ...testEnemy({
      x: 1.0,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
      maxHp: DEFAULT_ATTACK_DAMAGE,
      hp: DEFAULT_ATTACK_DAMAGE,
    }));

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // tick 0 — the kill

    const hitboxes = playerHitboxes(sim);
    expect(hitboxes).toHaveLength(1);
    const swing = at(hitboxes, 0);
    expect(hitboxOf(sim, swing).hitEntities).toEqual([enemy]);
    expect(spy.hits).toHaveLength(1);

    // Snapshot the corpse AFTER the killing tick; every value below must stay put.
    const restingTransform = transformOf(sim, enemy);
    const freezeAtDeath = sim.world.getComponent(enemy, FreezeComponent);
    expect(freezeAtDeath?.remainingTicks).toBe(DEFAULT_HITSTOP_TICKS + 1);
    // The KILLING hit legitimately wrote feedback (spec 08 §4.2: a hit that landed on
    // the tick its target dies still counts). What must NOT happen is a re-write.
    const knockbackAtDeath = sim.world.getComponent(enemy, KnockbackComponent)?.velocity;
    expect(knockbackAtDeath).toEqual(vec2(12, 0));

    // Ticks 1..13: the swing is still alive and still overlapping the corpse.
    for (let tick = 1; tick <= 13; tick += 1) {
      sim.step(1);
      expect(sim.world.isAlive(swing)).toBe(true);
      expect(hitboxOf(sim, swing).hitEntities).toEqual([enemy]); // ledger frozen
      expect(hpOf(sim, enemy)).toBe(0);
      expect(transformOf(sim, enemy)).toEqual(restingTransform); // not displaced at all
    }

    sim.step(1); // tick 14 — LifespanSystem retires the swing
    expect(sim.world.isAlive(swing)).toBe(false);

    // Across the whole 15-tick window exactly ONE hit ever landed.
    expect(spy.hits).toHaveLength(1);
    // No feedback was re-written on the corpse: the knockback is bit-for-bit the one
    // written by the killing hit, and the freeze was never re-armed.
    expect(sim.world.getComponent(enemy, KnockbackComponent)?.velocity).toEqual(knockbackAtDeath);
    expect(sim.world.getComponent(enemy, FreezeComponent)?.remainingTicks).toBe(
      DEFAULT_HITSTOP_TICKS + 1,
    );
    // TRAP (spec 08 §6.4): a corpse keeps the ActionState it died in, and its
    // `ticksInState` stops advancing. Never read the action state as evidence that a
    // corpse was *not* hit.
    expect(stateOf(sim, enemy).state).toBe(ActionState.HITSTUN);
    expect(stateOf(sim, enemy).ticksInState).toBe(1);
    expect(transformOf(sim, enemy)).toEqual(restingTransform);
    expect(isDead(sim.world, player)).toBe(false); // the killer survives its own swing
  });

  it('target gate: identical hitboxes, only the DEAD target is skipped', () => {
    const { sim, spy, deathEvents } = makeObservableSim();
    const attacker = PlayerFactory.spawn(sim.world, { x: -5, y: -5, maxSpeed: MAX_SPEED });
    const corpse = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, maxHp: 100, hp: 0 }));
    const victim = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 10, y: 0, maxHp: 100, hp: 100 }));
    markDead(sim.world, corpse);

    const atCorpse = spawnProbeHitbox(sim, { x: 0, y: 0, owner: attacker });
    const atVictim = spawnProbeHitbox(sim, { x: 10, y: 0, owner: attacker });
    const corpseBefore = transformOf(sim, corpse);

    sim.step(1);

    // Same geometry, same owner, same damage — the ONLY difference is the death tag.
    expect(hitboxOf(sim, atCorpse).hitEntities).toEqual([]);
    expect(hpOf(sim, corpse)).toBe(0);
    expect(sim.world.getComponent(corpse, FreezeComponent)).toBeUndefined();
    expect(sim.world.getComponent(corpse, KnockbackComponent)).toBeUndefined();
    expect(stateOf(sim, corpse).state).not.toBe(ActionState.HITSTUN);
    expect(transformOf(sim, corpse)).toEqual(corpseBefore);

    expect(hitboxOf(sim, atVictim).hitEntities).toEqual([victim]);
    expect(hpOf(sim, victim)).toBe(90);

    // The control proves the setup itself is sound: the identical hitbox DOES land
    // when the target is alive.
    expect(spy.hits).toHaveLength(1);
    expect(at(spy.hits, 0).targetId).toBe(victim);
    // DeathSystem does not re-publish for an already-tagged corpse.
    expect(deathEvents.drain()).toEqual([]);
  });

  it('owner gate: a corpse swings for nothing, a live owner still connects', () => {
    const { sim, spy } = makeObservableSim();
    const liveOwner = PlayerFactory.spawn(sim.world, { x: -5, y: -5, maxSpeed: MAX_SPEED });
    const deadOwner = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 20, y: 20, maxHp: 10, hp: 0 }));
    markDead(sim.world, deadOwner);
    const victim = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, maxHp: 100, hp: 100 }));

    const fromCorpse = spawnProbeHitbox(sim, { x: 0, y: 0, owner: deadOwner });
    const fromLive = spawnProbeHitbox(sim, { x: 0, y: 0, owner: liveOwner });

    sim.step(1);

    // Exactly ONE settlement: without the owner gate both swings would land (hp 80).
    expect(hpOf(sim, victim)).toBe(90);
    expect(hitboxOf(sim, fromCorpse).hitEntities).toEqual([]);
    expect(hitboxOf(sim, fromLive).hitEntities).toEqual([victim]);
    expect(spy.hits).toHaveLength(1);
    expect(at(spy.hits, 0).attackerId).toBe(liveOwner);
  });

  it('same-tick gate: one entity settles at most once per tick, even when it dies mid-tick', () => {
    const { sim, spy, deathEvents } = makeObservableSim();
    const attacker = PlayerFactory.spawn(sim.world, { x: -5, y: -5, maxSpeed: MAX_SPEED });
    const victim = EnemyFactory.spawn(sim.world, ...testEnemy({
      x: 0,
      y: 0,
      maxHp: DEFAULT_ATTACK_DAMAGE,
      hp: DEFAULT_ATTACK_DAMAGE,
    }));

    const first = spawnProbeHitbox(sim, { x: 0, y: 0, owner: attacker });
    const second = spawnProbeHitbox(sim, { x: 0, y: 0, owner: attacker });

    sim.step(1); // tick 0

    // The first swing empties the pool; the second one must NOT settle again. The tag
    // does not exist yet at this point — DeathSystem runs later in the tick — so the
    // `hp <= 0` predicate is what closes the hole (spec 08 §4.2 gate c).
    expect(hpOf(sim, victim)).toBe(0);
    expect(hitboxOf(sim, first).hitEntities).toEqual([victim]);
    expect(hitboxOf(sim, second).hitEntities).toEqual([]);
    expect(spy.hits).toHaveLength(1); // no second HitEvent => no chained hitstop

    const deaths = deathEvents.drain();
    expect(deaths).toHaveLength(1);
    expect(at(deaths, 0)).toEqual({ tick: 0, entityId: victim });
  });

  it('the skip is keyed on the DEATH TAG, not on the hit-point number', () => {
    const { sim } = makeObservableSim();
    const attacker = PlayerFactory.spawn(sim.world, { x: -5, y: -5, maxSpeed: MAX_SPEED });
    // A tagged entity whose pool is still FULL. Normal play never produces this, and
    // that is exactly why it is worth pinning: every gate in the engine reads
    // `isDead`, so the TAG must be the authority — not a re-derived `hp <= 0` check
    // that would silently stop protecting the moment a heal / revive path lands.
    const tagged = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0, maxHp: 100, hp: 100 }));
    markDead(sim.world, tagged);

    const hitbox = spawnProbeHitbox(sim, { x: 0, y: 0, owner: attacker });
    sim.step(1);

    expect(hitboxOf(sim, hitbox).hitEntities).toEqual([]);
    expect(hpOf(sim, tagged)).toBe(100);
    expect(sim.world.getComponent(tagged, FreezeComponent)).toBeUndefined();
    expect(sim.world.getComponent(tagged, KnockbackComponent)).toBeUndefined();
  });

  it('movement gate: a corpse does not slide, even with an in-flight knockback and no freeze', () => {
    const { sim } = makeObservableSim();
    const attacker = PlayerFactory.spawn(sim.world, { x: -5, y: -5, maxSpeed: MAX_SPEED });
    const victim = EnemyFactory.spawn(sim.world, ...testEnemy({
      x: 0,
      y: 0,
      maxHp: DEFAULT_ATTACK_DAMAGE,
      hp: DEFAULT_ATTACK_DAMAGE,
    }));

    // A PURE-KNOCKBACK swing: `hitstopTicks = 0` means `applyFreeze` is a no-op, so the
    // corpse keeps an armed knockback with NO freeze to accidentally hold it in place.
    // This is what makes MovementSystem's own death gate the only thing left to stop
    // the slide — the freeze gate cannot silently cover for it.
    spawnProbeHitbox(sim, { x: 0, y: 0, owner: attacker, hitstopTicks: 0, knockbackForce: 12 });
    sim.step(1); // tick 0

    expect(hpOf(sim, victim)).toBe(0);
    expect(isDead(sim.world, victim)).toBe(true);
    expect(sim.world.getComponent(victim, FreezeComponent)).toBeUndefined();
    expect(sim.world.getComponent(victim, KnockbackComponent)?.velocity).toEqual(vec2(12, 0));
    expect(stateOf(sim, victim).state).toBe(ActionState.HITSTUN);

    const restingTransform = transformOf(sim, victim);

    // Ticks 1..4: the knockback is still armed and the entity is NOT frozen. Without
    // the death gate, MovementSystem's HITSTUN branch would integrate 12 u/s and the
    // body would drift 0.2 u per tick; without StateSystem's gate, `ticksInState`
    // would advance too.
    for (let tick = 1; tick <= 4; tick += 1) {
      sim.step(1);
      expect(transformOf(sim, victim)).toEqual(restingTransform);
      expect(stateOf(sim, victim).state).toBe(ActionState.HITSTUN);
      expect(stateOf(sim, victim).ticksInState).toBe(1);
    }
  });

  it('combat-action gate: a corpse holding an attack pulse raises no hitbox', () => {
    const { sim } = makeObservableSim();
    const corpse = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 5, y: 5, maxSpeed: MAX_SPEED }));
    markDead(sim.world, corpse);

    // Adversarial probe: hand the corpse a pulse that no producer would ever write.
    // The gate must skip BEFORE the read-and-clear, so the pulse is neither executed
    // nor buffered (spec 08 §4.2).
    intentOf(sim, corpse).wantsToAttack = true;
    const entitiesBefore = sim.world.entityCount;

    sim.step(1);

    expect(sim.world.query(HitboxComponent)).toEqual([]);
    expect(sim.world.entityCount).toBe(entitiesBefore);
    expect(intentOf(sim, corpse).wantsToAttack).toBe(true);
  });

  it('dash gate: a corpse holding a dash pulse never dashes and never gains i-frames', () => {
    const { sim } = makeObservableSim();
    const corpse = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 5, y: 5, maxSpeed: MAX_SPEED }));
    markDead(sim.world, corpse);

    intentOf(sim, corpse).wantsToDash = true;
    sim.step(1);

    expect(stateOf(sim, corpse).state).not.toBe(ActionState.DASHING);
    expect(hasTag(sim.world, corpse, INVULNERABLE_TAG)).toBe(false);
  });

  it('status gate: a corpse stops taking damage over time', () => {
    const { sim } = makeObservableSim();
    const corpse = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 5, y: 5, maxHp: 100, hp: 100 }));
    applyStatusEffect(sim.world, corpse, POISON_STATUS_SPEC);
    const poisonAtDeath = getStatusEffect(sim.world, corpse, POISON_STATUS_SPEC.id);
    expect(poisonAtDeath?.ticksUntilProc).toBe(POISON_STATUS_SPEC.intervalTicks);
    markDead(sim.world, corpse);

    sim.step(5); // ticks 0..4

    // Both clocks are frozen: without the gate `ticksUntilProc` would be 25 and
    // `remainingTicks` 115 (spec 08 §4.2).
    const poisonAfter = getStatusEffect(sim.world, corpse, POISON_STATUS_SPEC.id);
    expect(poisonAfter?.ticksUntilProc).toBe(POISON_STATUS_SPEC.intervalTicks);
    expect(poisonAfter?.remainingTicks).toBe(POISON_STATUS_SPEC.durationTicks);
  });
});

/* ========================================================================== *
 * G3 · a corpse produces no intent                                           *
 * ========================================================================== */
describe('G3 · a corpse produces no intent, on both intent-generation paths (AC-01/AC-04)', () => {
  it('an AI enemy stops writing intent the moment it dies', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, ...testEnemy({
      x: 5,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
      ai: {
        targetEntityId: player,
        sightRadius: 10,
        attackRadius: 3,
        windupTicks: 30,
        cooldownTicks: 60,
      },
    }));

    sim.step(1); // tick 0 — the "discovery" tick flips IDLE -> CHASING, no vector
    expect(aiOf(sim, enemy).state).toBe(AIState.CHASING);
    sim.step(1); // tick 1 — pursuit is live, so the AI owns a non-zero intent
    expect(intentOf(sim, enemy).moveVector.x).toBeLessThan(0);

    // Kill it between ticks. DeathSystem tags it at the END of tick 2, i.e. after
    // AISystem has already written (and DeathSystem has already neutralised) its
    // intent for that tick.
    applyDamage(sim.world, enemy, 999);
    sim.step(1); // tick 2
    expect(isDead(sim.world, enemy)).toBe(true);
    expect(intentOf(sim, enemy).moveVector).toEqual(vec2(0, 0));
    expect(intentOf(sim, enemy).aimRadians).toBeNull();

    const restingTransform = transformOf(sim, enemy);
    const aiTicks = aiOf(sim, enemy).ticksRemaining;

    // From tick 3 on, AISystem's death gate (Gate -1) keeps the intent neutral. Without
    // it the FSM would re-fill `moveVector` every tick and the corpse would walk.
    for (let tick = 3; tick <= 8; tick += 1) {
      sim.step(1);
      expect(intentOf(sim, enemy).moveVector).toEqual(vec2(0, 0));
      expect(intentOf(sim, enemy).wantsToAttack).toBe(false);
      expect(intentOf(sim, enemy).aimRadians).toBeNull();
      expect(aiOf(sim, enemy).ticksRemaining).toBe(aiTicks); // FSM frozen in place
      expect(transformOf(sim, enemy)).toEqual(restingTransform); // and not displaced
    }
  });

  it('a dead player is not re-derived from a stick that is still held', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });

    sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    sim.step(1); // tick 0 — the stick vector is PERSISTENT, so it survives empty frames
    expect(intentOf(sim, player).moveVector).toEqual(vec2(1, 0));
    const movingX = transformOf(sim, player).x;
    expect(movingX).toBeGreaterThan(0);

    applyDamage(sim.world, player, 999);
    sim.step(1); // tick 1 — dies here; DeathSystem neutralises at the END of the tick
    expect(isDead(sim.world, player)).toBe(true);
    expect(intentOf(sim, player).moveVector).toEqual(vec2(0, 0));

    const restingTransform = transformOf(sim, player);

    // Ticks 2..6: the stick is STILL held. Without PlayerControllerSystem's death gate
    // on phase 2, `deriveIntent` would copy (1, 0) straight back onto the corpse and
    // "no intent output" would have lasted exactly one tick.
    for (let tick = 2; tick <= 6; tick += 1) {
      sim.step(1);
      expect(intentOf(sim, player).moveVector).toEqual(vec2(0, 0));
      expect(transformOf(sim, player)).toEqual(restingTransform);
    }
  });
});

/* ========================================================================== *
 * G4 · single-wave room                                                      *
 * ========================================================================== */
describe('G4 · a single-wave room is cleared on the tick its last member dies (AC-03)', () => {
  it('spawns the wave on the first processed tick, then goes ROOM_CLEARED once, and stays inert', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const room = EncounterFactory.spawn(sim.world, {
      waves: [
        {
          delayTicks: 0,
          enemies: [
            testEnemyRef({ x: 6, y: 0, maxHp: 10, hp: 10 }),
            testEnemyRef({ x: 7, y: 0, maxHp: 10, hp: 10 }),
          ],
        },
      ],
    });

    sim.step(1); // tick 0 — the opening wave appears
    const encounter = encounterOf(sim, room);
    expect(encounter.state).toBe(EncounterState.IN_PROGRESS);
    expect(encounter.trackedEntityIds).toHaveLength(2);
    expect(sim.world.entityCount).toBe(3); // the room + its two enemies

    const first = at(encounter.trackedEntityIds, 0);
    const second = at(encounter.trackedEntityIds, 1);
    // The room spawns REAL prefab enemies through the REAL factory (AC-05).
    expect(hpOf(sim, first)).toBe(10);
    expect(factionOf(sim, first)).toBe(Faction.Enemy);
    expect(factionOf(sim, second)).toBe(Faction.Enemy);

    // One member down: the wave is NOT cleared, so the room must not advance.
    applyDamage(sim.world, first, 999);
    sim.step(1); // tick 1
    expect(isDead(sim.world, first)).toBe(true);
    expect(encounterOf(sim, room).state).toBe(EncounterState.IN_PROGRESS);

    // Last member down: the clear is detected on the SAME tick the death resolves,
    // because DeathSystem runs before EncounterSystem (spec 08 §5.2).
    applyDamage(sim.world, second, 999);
    sim.step(1); // tick 2
    expect(isDead(sim.world, second)).toBe(true);
    expect(encounterOf(sim, room).state).toBe(EncounterState.ROOM_CLEARED);
    expect(encounterOf(sim, room).currentWaveIndex).toBe(0);
    // The FINAL wave's roster is RETAINED on the terminal transition (only a
    // promotion to a next wave empties it). An empty roster means "not spawned yet",
    // which would be a lie about a room that has already been fought — so a
    // ROOM_CLEARED room keeps the ids of the wave it just finished.
    expect(encounterOf(sim, room).trackedEntityIds).toEqual([first, second]);
    expect(sim.world.entityCount).toBe(3); // corpses are retained, nothing new spawns

    sim.step(30); // a finished room is inert: no spawn, no state churn
    expect(encounterOf(sim, room).state).toBe(EncounterState.ROOM_CLEARED);
    expect(sim.world.entityCount).toBe(3);
    expect(encounterOf(sim, room).trackedEntityIds).toEqual([first, second]);
  });
});

/* ========================================================================== *
 * G5 · multi-wave scheduling                                                 *
 * ========================================================================== */
describe('G5 · wave 2 spawns exactly delayTicks after the wipe was detected (AC-03)', () => {
  it('waits 30 ticks, then spawns the next wave and finishes the room', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const room = EncounterFactory.spawn(sim.world, {
      waves: [
        { delayTicks: 0, enemies: [testEnemyRef({ x: 6, y: 0, maxHp: 10, hp: 10 })] },
        {
          delayTicks: 30,
          enemies: [
            testEnemyRef({ x: 7, y: 0, maxHp: 10, hp: 10 }),
            testEnemyRef({ x: 8, y: 0, maxHp: 10, hp: 10 }),
          ],
        },
      ],
    });

    sim.step(1); // tick 0 — wave 1 (index 0) spawns
    const encounter = encounterOf(sim, room);
    expect(encounter.state).toBe(EncounterState.IN_PROGRESS);
    expect(encounter.trackedEntityIds).toHaveLength(1);
    const waveOne = at(encounter.trackedEntityIds, 0);
    expect(sim.world.entityCount).toBe(2); // room + wave-1 enemy

    applyDamage(sim.world, waveOne, 999);
    sim.step(1); // tick 1 — the wipe is detected on this very tick
    expect(isDead(sim.world, waveOne)).toBe(true);
    expect(encounter.state).toBe(EncounterState.WAVE_CLEAR);
    expect(encounter.currentWaveIndex).toBe(1);
    // The deadline is absolute and counted from the WIPE-DETECTION tick (spec 08 §6.2).
    expect(encounter.nextSpawnTick).toBe(31);
    expect(encounter.trackedEntityIds).toEqual([]);

    // Ticks 2..30: still waiting. Nothing spawns, nothing changes.
    for (let tick = 2; tick <= 30; tick += 1) {
      sim.step(1);
      expect(encounterOf(sim, room).state).toBe(EncounterState.WAVE_CLEAR);
      expect(encounterOf(sim, room).trackedEntityIds).toEqual([]);
      expect(sim.world.entityCount).toBe(2);
    }

    // Tick 31 — exactly 30 ticks after the wipe at tick 1.
    sim.step(1);
    expect(encounterOf(sim, room).state).toBe(EncounterState.IN_PROGRESS);
    expect(encounterOf(sim, room).nextSpawnTick).toBe(ENCOUNTER_WAVE_UNSCHEDULED);
    expect(encounterOf(sim, room).trackedEntityIds).toHaveLength(2);
    expect(sim.world.entityCount).toBe(4); // room + wave-1 corpse + wave-2 enemies
    expect(at(encounterOf(sim, room).trackedEntityIds, 0)).not.toBe(waveOne);

    const waveTwo = [...encounterOf(sim, room).trackedEntityIds];
    applyDamage(sim.world, at(waveTwo, 0), 999);
    sim.step(1); // tick 32
    expect(encounterOf(sim, room).state).toBe(EncounterState.IN_PROGRESS);

    applyDamage(sim.world, at(waveTwo, 1), 999);
    sim.step(1); // tick 33 — the last wave is wiped, so the room is DONE
    expect(encounterOf(sim, room).state).toBe(EncounterState.ROOM_CLEARED);

    sim.step(20);
    expect(encounterOf(sim, room).state).toBe(EncounterState.ROOM_CLEARED);
    expect(sim.world.entityCount).toBe(4);
  });

  it('a wave spawned on tick T first ACTS on T+1 (the pipeline-phase property)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    // The AI needs a hostile in sight, or it would stay IDLE and this test would be
    // asserting nothing. The player stands far from the spawn point but inside the
    // sight radius.
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const room = EncounterFactory.spawn(sim.world, {
      waves: [
        {
          delayTicks: 0,
          enemies: [
            testEnemyRef({ x: 5, y: 0, maxSpeed: MAX_SPEED, ai: { sightRadius: 10, attackRadius: 3 } }),
          ],
        },
      ],
    });

    sim.step(1); // tick 0 — spawned at the very END of the tick
    const enemy = at(encounterOf(sim, room).trackedEntityIds, 0);
    // Every per-entity system has already run this tick, so the AI has not acted yet.
    expect(intentOf(sim, enemy).moveVector).toEqual(vec2(0, 0));
    expect(aiOf(sim, enemy).state).toBe(AIState.IDLE);

    sim.step(1); // tick 1 — now the FSM sees the world and flips IDLE -> CHASING
    expect(aiOf(sim, enemy).state).toBe(AIState.CHASING);
  });
});

/* ========================================================================== *
 * G6 · pipeline order                                                        *
 * ========================================================================== */
describe('G6 · canonical 17-segment pipeline order (AC-07)', () => {
  it('slots Death then Encounter after every damage source, keeping Lifespan last', () => {
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

    // DeathSystem must see a FULLY resolved tick: every damage source is upstream, and
    // the boon dispatch has already reacted to the hits that landed.
    expect(names.indexOf('DeathSystem')).toBeGreaterThan(names.indexOf('CollisionSystem'));
    expect(names.indexOf('DeathSystem')).toBeGreaterThan(names.indexOf('StatusEffectSystem'));
    expect(names.indexOf('DeathSystem')).toBeGreaterThan(names.indexOf('ModifierSystem'));
    // EncounterSystem's whole input is the death tag DeathSystem just wrote.
    expect(names.indexOf('EncounterSystem')).toBeGreaterThan(names.indexOf('DeathSystem'));
    // RewardSystem settles the draft EncounterSystem rolls, so it must sit after it
    // (spec 11 §5.2) and still before LifespanSystem, which stays LAST.
    expect(names.indexOf('RewardSystem')).toBeGreaterThan(names.indexOf('EncounterSystem'));
    // LifespanSystem still runs LAST: a hitbox must never be aged before it has been
    // collision-tested this tick.
    expect(names.indexOf('LifespanSystem')).toBe(names.length - 1);
  });
});

/* ========================================================================== *
 * G7 · deterministic replay                                                  *
 * ========================================================================== */
describe('G7 · deterministic replay of a full encounter script (AC-08)', () => {
  it('replays a two-wave room identically, tick by tick, in two simulators', () => {
    const runScript = (): Snapshot[] => {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
      const room = EncounterFactory.spawn(sim.world, {
        waves: [
          {
            delayTicks: 0,
            enemies: [
              testEnemyRef({ x: 6, y: 0, maxHp: 10, hp: 10 }),
              testEnemyRef({ x: 7, y: 1, maxHp: 10, hp: 10 }),
            ],
          },
          { delayTicks: 5, enemies: [testEnemyRef({ x: 8, y: 0, maxHp: 10, hp: 10 })] },
        ],
      });
      PlayerFactory.spawn(sim.world, { x: -10, y: 0, maxSpeed: MAX_SPEED });

      const frames: Snapshot[] = [];
      sim.step(1); // tick 0
      frames.push(sim.snapshot());

      for (const id of [...encounterOf(sim, room).trackedEntityIds]) {
        applyDamage(sim.world, id, 999);
      }
      sim.step(1); // tick 1 — wipe detected
      frames.push(sim.snapshot());

      sim.step(4); // ticks 2..5
      frames.push(sim.snapshot());

      sim.step(1); // tick 6 — wave 2 spawns (tick 1 + 5)
      frames.push(sim.snapshot());

      for (const id of [...encounterOf(sim, room).trackedEntityIds]) {
        applyDamage(sim.world, id, 999);
      }
      sim.step(3); // ticks 7..9
      frames.push(sim.snapshot());
      return frames;
    };

    const first = runScript();
    const second = runScript();
    expect(second).toEqual(first);
    // Sanity: the script really did reach the terminal state.
    expect(at(first, first.length - 1).tick).toBe(10);
  });
});

/* ========================================================================== *
 * G8 · zero regression + the death bus                                       *
 * ========================================================================== */
describe('G8 · zero regression and a one-tick death bus (AC-09/AC-10)', () => {
  it('a world with no room and no death is untouched by the two new systems', () => {
    const { sim, deathEvents, spy } = makeObservableSim();
    sim.step(20);
    expect(sim.world.entityCount).toBe(0);
    expect(deathEvents.size).toBe(0);
    expect(spy.hits).toEqual([]);

    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    sim.step(20);
    expect(sim.world.entityCount).toBe(1);
    expect(deathEvents.size).toBe(0);
    expect(hpOf(sim, player)).toBeGreaterThan(0);
  });

  it('the death bus holds exactly the deaths of the tick just processed', () => {
    const { sim, deathEvents } = makeObservableSim();
    const enemies = [
      EnemyFactory.spawn(sim.world, ...testEnemy({ x: 5, y: 0, maxHp: 10, hp: 10 })),
      EnemyFactory.spawn(sim.world, ...testEnemy({ x: 6, y: 0, maxHp: 10, hp: 10 })),
      EnemyFactory.spawn(sim.world, ...testEnemy({ x: 7, y: 0, maxHp: 10, hp: 10 })),
    ];

    applyDamage(sim.world, at(enemies, 0), 999);
    sim.step(1); // tick 0
    expect(deathEvents.drain()).toEqual([{ tick: 0, entityId: at(enemies, 0) }]);

    applyDamage(sim.world, at(enemies, 1), 999);
    sim.step(1); // tick 1 — NOT two: the bus was cleared at the start of the tick
    expect(deathEvents.drain()).toEqual([{ tick: 1, entityId: at(enemies, 1) }]);

    sim.step(1); // tick 2 — nobody dies
    expect(deathEvents.size).toBe(0);

    // Two deaths in one tick are published in ascending-id order (deterministic emit).
    applyDamage(sim.world, at(enemies, 2), 999);
    applyDamage(sim.world, at(enemies, 0), 999); // already dead: no second event
    sim.step(1); // tick 3
    expect(deathEvents.drain()).toEqual([{ tick: 3, entityId: at(enemies, 2) }]);
  });
});
