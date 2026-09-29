/**
 * M9-T01 · Economy (loot drops + pickups) + multi-room sequence + win state.
 * See specs/15_economy_and_victory_spec.md §4 (semantics), §5 (AC-01 .. AC-10)
 * and §6 (tick-by-tick contract).
 *
 * Fresh-eyes harness suite: every assertion drives the REAL GameSimulator with the
 * canonical 17-segment pipeline (TransformSnapshotSystem -> PlayerControllerSystem
 * -> FreezeSystem -> AISystem -> HazardSystem -> MovementSystem -> DashSystem ->
 * StateSystem -> CombatActionSystem -> CollisionSystem -> StatusEffectSystem ->
 * ModifierSystem -> DeathSystem -> EncounterSystem -> RewardSystem -> PickupSystem
 * -> LifespanSystem) and REAL prefab-assembled entities. Nothing is mocked, and
 * ticks are advanced one at a time where the timing is the point.
 *
 * TICK NUMBERING (the classic off-by-one trap — spec 15 §6):
 *   `sim.step(n)` processes processed-ticks `0 .. n-1`, leaving `sim.tick === n`.
 *   A fresh sim therefore needs `step(p + 1)` to have processed tick `p`.
 *
 * THE PICKUP'S TICK ARITHMETIC (derived once, used everywhere):
 *   - `DeathSystem` (index 12) spawns the drops, `PickupSystem` (index 15) tests
 *     them, `LifespanSystem` (index 16) ages and removes them. All three run in the
 *     SAME tick, so a drop is collectable on the very tick its owner died, and a
 *     collected pickup is gone by the end of that tick.
 *   - A pickup spawned with `lifespanTicks = N` on tick `T` is decremented at the
 *     end of `T` and destroyed at the end of `T + N - 1`: exactly `N` ticks of life,
 *     the same contract `HitboxComponent.activeTicks` follows.
 *
 * Grouping:
 *   G0 · assembly, validation and structural invisibility                     (AC-01/AC-02/AC-10)
 *   G1 · the drop: one pickup per declared drop, at the corpse's feet         (AC-01)
 *   G2 · the pickup: overlap, effect, cleanup — and the exact boundary        (AC-02)
 *   G3 · the fuse: exactly `lifespanTicks` ticks of life                      (AC-01)
 *   G4 · it is NOT a hit: no hitstop, no HITSTUN, no event, no blocking,
 *        no projectile absorption                                             (AC-05/AC-06)
 *   G5 · the run: rooms advance, the last room WINS                           (AC-03/AC-04)
 *   G6 · restartRun clears gold, gear and room progress; determinism          (AC-07/AC-08)
 *   G7 · pipeline slot and zero regression                                    (AC-09/AC-10)
 */

import { describe, expect, it } from 'vitest';
import {
  ATTACK_KEY,
  ActionState,
  DEFAULT_GOLD_AMOUNT,
  DEFAULT_HEAL_AMOUNT,
  DEFAULT_PICKUP_LIFESPAN_TICKS,
  DEFAULT_PICKUP_RADIUS,
  DEFAULT_REWARD_DRAFT_COUNT,
  EncounterFactory,
  EncounterState,
  EncounterStateComponent,
  EnemyFactory,
  DEPTH_SPAWN_SPACING_UNITS,
  EventQueue,
  Faction,
  FreezeComponent,
  GameSimulator,
  GameStateFactory,
  GameStatus,
  HealthComponent,
  HitboxComponent,
  HurtboxComponent,
  IntentComponent,
  InventoryComponent,
  LOOT_DROP_SPACING_UNITS,
  LootComponent,
  ModifierComponent,
  PickupComponent,
  PickupKind,
  PlayerFactory,
  PlayerInputComponent,
  Random,
  StateComponent,
  TransformComponent,
  VelocityComponent,
  addGold,
  addModifier,
  applyDamage,
  createDefaultSystems,
  findGameState,
  findPlayerInventory,
  findRewardDraft,
  hasModifier,
  isDead,
  isFinalRoom,
  isFrozen,
  isRunOver,
  isRunWon,
  markRunWon,
  readGold,
  resolveEncounterRooms,
  resolveLootDrops,
  spawnPickup,
  spawnProjectile,
  vec2,
} from '../../src';
import type {
  EncounterWaveConfig,
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

/** Per-tick locomotion displacement at `maxSpeed = 5`, 60fps. */
const STEP = MAX_SPEED / FPS;

/** Positional accessor with a loud guard (the repo runs `noUncheckedIndexedAccess`). */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`QA: no sample at index ${String(index)}`);
  }
  return value;
}

/* --- component accessors -------------------------------------------------- */

function transformOf(sim: GameSimulator, id: EntityId): TransformComponent {
  const transform = sim.world.getComponent(id, TransformComponent);
  if (transform === undefined) throw new Error('QA: entity is missing TransformComponent');
  return transform;
}

function pickupOf(sim: GameSimulator, id: EntityId): PickupComponent {
  const pickup = sim.world.getComponent(id, PickupComponent);
  if (pickup === undefined) throw new Error('QA: entity is missing PickupComponent');
  return pickup;
}

function inventoryOf(sim: GameSimulator, id: EntityId): InventoryComponent {
  const inventory = sim.world.getComponent(id, InventoryComponent);
  if (inventory === undefined) throw new Error('QA: entity is missing InventoryComponent');
  return inventory;
}

function stateOf(sim: GameSimulator, id: EntityId): StateComponent {
  const state = sim.world.getComponent(id, StateComponent);
  if (state === undefined) throw new Error('QA: entity is missing StateComponent');
  return state;
}

function hpOf(sim: GameSimulator, id: EntityId): number {
  const health = sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: entity is missing HealthComponent');
  return health.hp;
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

/** Every live pickup, ascending. */
function pickupsOf(sim: GameSimulator): EntityId[] {
  return sim.world.query(PickupComponent);
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

/**
 * The canonical pipeline with a hit-event probe spliced in IMMEDIATELY AFTER
 * CollisionSystem, so "did a pickup register as a hit?" is answered as a FACT.
 *
 * The probe OWNS the hit bus (it drains it), so ModifierSystem — the other
 * consumer — sees an empty queue. That is deliberate: this suite asserts that a
 * pickup produced no hit at all, never what a boon would do about one.
 */
function makeObservableSim(): { sim: GameSimulator; spy: HitSpy } {
  const hitEvents = new EventQueue();
  const spy = new HitSpy(hitEvents);
  const base = createDefaultSystems(hitEvents);
  const collisionIndex = base.findIndex((system) => system.name === 'CollisionSystem');
  if (collisionIndex === -1) throw new Error('QA: the canonical pipeline has no CollisionSystem');
  const systems = [...base.slice(0, collisionIndex + 1), spy, ...base.slice(collisionIndex + 1)];
  return { sim: new GameSimulator({ fps: FPS, systems }), spy };
}

/* ========================================================================== *
 * G0 · assembly, validation and structural invisibility                      *
 * ========================================================================== */
describe('G0 · pickup assembly and its structural invisibility (AC-01/AC-02)', () => {
  it('spawnPickup mounts EXACTLY Transform + Pickup — no hitbox, hurtbox, faction or velocity', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    const id = spawnPickup(sim.world, { x: 1, y: 2, kind: PickupKind.GOLD, amount: 7 });

    // Sorted by component type name (UTF-16): 'PickupComponent' < 'TransformComponent'.
    expect(sim.world.listComponents(id).map((component) => component.constructor.name)).toEqual([
      'PickupComponent',
      'TransformComponent',
    ]);

    const pickup = pickupOf(sim, id);
    expect(pickup.kind).toBe(PickupKind.GOLD);
    expect(pickup.amount).toBe(7);
    expect(pickup.radius).toBe(DEFAULT_PICKUP_RADIUS);
    expect(pickup.lifespanTicks).toBe(DEFAULT_PICKUP_LIFESPAN_TICKS);
    expect(transformOf(sim, id).x).toBe(1);
    expect(transformOf(sim, id).y).toBe(2);

    // The milestone's hard requirements, made STRUCTURAL rather than conventional:
    // the pickup cannot deal damage, cannot be hit, cannot be auto-acquired by the
    // AI and cannot be wall-resolved, because it owns none of the components those
    // systems query. Every one of these lines is a mutation target: add the
    // component and the corresponding guarantee dies.
    expect(sim.world.getComponent(id, HitboxComponent)).toBeUndefined();
    expect(sim.world.getComponent(id, HurtboxComponent)).toBeUndefined();
    expect(sim.world.getComponent(id, FreezeComponent)).toBeUndefined();
    expect(sim.world.getComponent(id, StateComponent)).toBeUndefined();
    expect(sim.world.getComponent(id, IntentComponent)).toBeUndefined();
    expect(sim.world.getComponent(id, HealthComponent)).toBeUndefined();

    // The combat queries themselves must not see it.
    expect(sim.world.query(TransformComponent, HitboxComponent)).toEqual([]);
    expect(
      sim.world.query(TransformComponent, HurtboxComponent, HealthComponent),
    ).toEqual([]);
    // ...and neither must the wall resolver's target set (Transform + Velocity),
    // which is the mechanical reason a pickup can never push a walker off course.
    expect(sim.world.query(TransformComponent, VelocityComponent)).toEqual([]);
    expect(sim.world.getComponent(id, VelocityComponent)).toBeUndefined();
  });

  it('spawnPickup rejects malformed input before creating anything', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    spawnPickup(sim.world, { x: 0, y: 0 });

    expect(() => spawnPickup(sim.world, { x: Number.NaN, y: 0 })).toThrow(RangeError);
    expect(() => spawnPickup(sim.world, { x: 0, y: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => spawnPickup(sim.world, { x: 0, y: 0, radius: 0 })).toThrow(RangeError);
    expect(() => spawnPickup(sim.world, { x: 0, y: 0, radius: Number.NaN })).toThrow(RangeError);
    expect(() => spawnPickup(sim.world, { x: 0, y: 0, amount: 0 })).toThrow(RangeError);
    expect(() => spawnPickup(sim.world, { x: 0, y: 0, amount: -1 })).toThrow(RangeError);
    expect(() => spawnPickup(sim.world, { x: 0, y: 0, lifespanTicks: 0 })).toThrow(RangeError);
    expect(() => spawnPickup(sim.world, { x: 0, y: 0, lifespanTicks: 1.5 })).toThrow(RangeError);

    // A rejected pickup leaks no entity: still exactly the one spawned up front.
    expect(sim.world.entityCount).toBe(1);
  });

  it('the `loot` spawn option is a capability switch, not a new default', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    const plain = EnemyFactory.spawn(sim.world, {});
    const dropper = EnemyFactory.spawn(sim.world, {
      loot: [{ kind: PickupKind.GOLD, amount: 3 }, { kind: PickupKind.HEAL }],
    });

    // Omit it and the component set is untouched (spec 15 AC-10 zero regression).
    expect(sim.world.getComponent(plain, LootComponent)).toBeUndefined();

    const loot = sim.world.getComponent(dropper, LootComponent);
    expect(loot).toBeDefined();
    expect(loot?.drops).toHaveLength(2);
    expect(loot?.drops[0]).toEqual({
      kind: PickupKind.GOLD,
      amount: 3,
      radius: DEFAULT_PICKUP_RADIUS,
      lifespanTicks: DEFAULT_PICKUP_LIFESPAN_TICKS,
    });
    // An omitted `amount` falls back to the kind's default, not to zero.
    expect(loot?.drops[1]).toEqual({
      kind: PickupKind.HEAL,
      amount: DEFAULT_HEAL_AMOUNT,
      radius: DEFAULT_PICKUP_RADIUS,
      lifespanTicks: DEFAULT_PICKUP_LIFESPAN_TICKS,
    });

    // Validation happens at the assembly seam, like every other opt-in capability.
    expect(() => EnemyFactory.spawn(sim.world, { loot: [] })).toThrow(RangeError);
    expect(() => EnemyFactory.spawn(sim.world, { loot: [{ kind: PickupKind.GOLD, amount: 0 }] })).toThrow(
      RangeError,
    );
    expect(() =>
      EnemyFactory.spawn(sim.world, { loot: [{ kind: PickupKind.GOLD, lifespanTicks: -1 }] }),
    ).toThrow(RangeError);
    expect(sim.world.entityCount).toBe(2);
  });

  it('resolveLootDrops rejects an empty table rather than silently dropping nothing', () => {
    expect(() => resolveLootDrops([])).toThrow(RangeError);
    expect(resolveLootDrops([{ kind: PickupKind.GOLD }])).toHaveLength(1);
  });

  it('the wallet rides with the device: the player has one, an enemy does not', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    const player = PlayerFactory.spawn(sim.world, {});
    const enemy = EnemyFactory.spawn(sim.world, {});

    expect(inventoryOf(sim, player).gold).toBe(0);
    expect(sim.world.getComponent(enemy, InventoryComponent)).toBeUndefined();
    // The read-side accessor answers for the whole world, and `0` when there is none.
    expect(readGold(sim.world)).toBe(0);
    expect(findPlayerInventory(sim.world)).toBe(inventoryOf(sim, player));

    // `addGold` is the write path, and it clamps at zero so a future "spend" needs
    // no second API.
    expect(addGold(sim.world, player, 12)).toBe(true);
    expect(inventoryOf(sim, player).gold).toBe(12);
    expect(addGold(sim.world, player, -99)).toBe(true);
    expect(inventoryOf(sim, player).gold).toBe(0);
    // An entity with no wallet is a no-op, not a crash.
    expect(addGold(sim.world, enemy, 5)).toBe(false);
  });

  it('exposes the constants this milestone pins its timing and payout against', () => {
    // Literal pinning rather than "the field equals the constant that built it":
    // re-tuning the fuse would silently invalidate the tick-by-tick contract below.
    expect(DEFAULT_PICKUP_RADIUS).toBe(0.6);
    expect(DEFAULT_PICKUP_LIFESPAN_TICKS).toBe(600);
    expect(DEFAULT_GOLD_AMOUNT).toBe(5);
    expect(DEFAULT_HEAL_AMOUNT).toBe(20);
    expect(LOOT_DROP_SPACING_UNITS).toBe(1.2);
  });

  it('a world with no pickups is never touched by PickupSystem', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    EnemyFactory.spawn(sim.world, { x: 3, y: 0 });
    const before = sim.world.entityCount;

    sim.step(30);

    expect(sim.world.entityCount).toBe(before);
    expect(pickupsOf(sim)).toEqual([]);
  });
});

/* ========================================================================== *
 * G1 · the drop                                                              *
 * ========================================================================== */
describe('G1 · a death drops one pickup per declared drop, at the corpse (AC-01)', () => {
  it('spawns the drops on the killing tick, spaced along +x, and not before', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, {
      x: 6,
      y: 2,
      maxHp: 10,
      hp: 10,
      loot: [{ kind: PickupKind.GOLD, amount: 5 }, { kind: PickupKind.HEAL, amount: 20 }],
    });

    sim.step(1); // tick 0 — nothing has died, so nothing has dropped
    expect(pickupsOf(sim)).toEqual([]);
    expect(readGold(sim.world)).toBe(0);

    applyDamage(sim.world, enemy, 999);
    sim.step(1); // tick 1 — the death resolves and the loot appears

    expect(isDead(sim.world, enemy)).toBe(true);

    const drops = pickupsOf(sim);
    expect(drops).toHaveLength(2);

    // Drop order follows declaration order, and the offset is the deterministic
    // constant rather than a random scatter (spec 15 I3).
    expect(transformOf(sim, at(drops, 0)).x).toBe(6);
    expect(transformOf(sim, at(drops, 0)).y).toBe(2);
    expect(transformOf(sim, at(drops, 1)).x).toBe(6 + LOOT_DROP_SPACING_UNITS);
    expect(transformOf(sim, at(drops, 1)).y).toBe(2);

    expect(pickupOf(sim, at(drops, 0)).kind).toBe(PickupKind.GOLD);
    expect(pickupOf(sim, at(drops, 0)).amount).toBe(5);
    expect(pickupOf(sim, at(drops, 1)).kind).toBe(PickupKind.HEAL);
    expect(pickupOf(sim, at(drops, 1)).amount).toBe(20);

    // `DeathSystem` (idx 12) runs BEFORE `LifespanSystem` (idx 16), so the fresh
    // drops were already aged once this tick. One tick of life consumed, none lost.
    expect(pickupOf(sim, at(drops, 0)).lifespanTicks).toBe(DEFAULT_PICKUP_LIFESPAN_TICKS - 1);

    // The player is far away, so the drops are still on the ground.
    expect(readGold(sim.world)).toBe(0);
    expect(pickupsOf(sim)).toHaveLength(2);
    expect(sim.world.isAlive(player)).toBe(true);
  });

  it('an enemy with no loot table drops nothing (the M1-M8 behaviour)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const enemy = EnemyFactory.spawn(sim.world, { x: 6, y: 0, maxHp: 10, hp: 10 });

    applyDamage(sim.world, enemy, 999);
    sim.step(1);
    sim.step(5);

    expect(isDead(sim.world, enemy)).toBe(true);
    expect(pickupsOf(sim)).toEqual([]);
  });
});

/* ========================================================================== *
 * G2 · the pickup                                                            *
 * ========================================================================== */
describe('G2 · walking over a pickup takes it, exactly once (AC-02)', () => {
  it('walks in, the gold lands, the pickup is cleaned up in the same tick', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: -5, y: 0, maxSpeed: MAX_SPEED });
    const pickup = spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.GOLD, amount: 7 });

    // Hold +x for the whole run: a PERSISTENT `move` event, so every tick moves.
    sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });

    // 46 movement ticks put the player at ~-1.1667, i.e. 1.1667 away — still
    // OUTSIDE the 1.1 sum of radii (0.6 + 0.5).
    sim.step(46);
    expect(transformOf(sim, player).x).toBeCloseTo(-5 + 46 * STEP, 9);
    expect(readGold(sim.world)).toBe(0);
    expect(sim.world.isAlive(pickup)).toBe(true);

    // The 47th movement tick brings it to ~-1.0833 — inside. One more step.
    sim.step(1);

    expect(readGold(sim.world)).toBe(7);
    expect(inventoryOf(sim, player).gold).toBe(7);
    // AC-02's cleanup: gone by the end of the very tick it was taken.
    expect(sim.world.isAlive(pickup)).toBe(false);
    expect(pickupsOf(sim)).toEqual([]);

    // ...and it does not come back, however far the player keeps walking.
    sim.step(30);
    expect(readGold(sim.world)).toBe(7);
    expect(pickupsOf(sim)).toEqual([]);
  });

  it('the overlap predicate is the strict `<`: touching is NOT collecting', () => {
    // Exactly at the boundary: dist === radiusSum (1.1) => not taken.
    const touching = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(touching.world, { x: -1.1, y: 0, maxSpeed: MAX_SPEED });
    const edge = spawnPickup(touching.world, { x: 0, y: 0, kind: PickupKind.GOLD, amount: 7 });
    touching.step(1);
    expect(readGold(touching.world)).toBe(0);
    expect(touching.world.isAlive(edge)).toBe(true);

    // CONTROL: one tenth of a unit closer, and the same setup DOES take it — so the
    // assertion above is measuring the boundary rather than a broken script.
    const inside = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(inside.world, { x: -1, y: 0, maxSpeed: MAX_SPEED });
    const near = spawnPickup(inside.world, { x: 0, y: 0, kind: PickupKind.GOLD, amount: 7 });
    inside.step(1);
    expect(readGold(inside.world)).toBe(7);
    expect(inside.world.isAlive(near)).toBe(false);
  });

  it('HEAL restores hit points and clamps at maxHp', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxHp: 100, hp: 100 });
    applyDamage(sim.world, player, 50);
    spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.HEAL, amount: 20 });

    sim.step(1);
    expect(hpOf(sim, player)).toBe(70);

    // A flask taken at (nearly) full health must not overshoot the ceiling — an
    // overshoot would be invisible in the HUD and would silently destroy value.
    spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.HEAL, amount: 999 });
    sim.step(1);
    expect(hpOf(sim, player)).toBe(100);
  });

  it('two drops from one enemy are taken one at a time, in ascending id order', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const first = spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.GOLD, amount: 5 });
    // Deliberately placed OUTSIDE the 1.1 sum of radii, so the first tick can only
    // take one of the two.
    const second = spawnPickup(sim.world, { x: 3, y: 0, kind: PickupKind.GOLD, amount: 9 });

    sim.step(1);
    expect(readGold(sim.world)).toBe(5);
    expect(sim.world.isAlive(first)).toBe(false);
    expect(sim.world.isAlive(second)).toBe(true);

    sim.inject({ kind: 'move', tick: sim.tick, vector: vec2(1, 0) });
    sim.step(30); // ~2.5 units of walking: enough to reach x = 3
    expect(readGold(sim.world)).toBe(14);
    expect(sim.world.isAlive(second)).toBe(false);
  });

  it('a dead player collects nothing', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxHp: 100, hp: 100 });
    spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.GOLD, amount: 7 });
    applyDamage(sim.world, player, 999);

    sim.step(1); // tick 0 — the player dies here; the pickup is on the corpse
    expect(isDead(sim.world, player)).toBe(true);
    expect(readGold(sim.world)).toBe(0);

    sim.step(5);
    expect(readGold(sim.world)).toBe(0);
  });
});

/* ========================================================================== *
 * G3 · the fuse                                                              *
 * ========================================================================== */
describe('G3 · a pickup lives exactly `lifespanTicks` ticks (AC-01)', () => {
  it('is gone after exactly N ticks and takes nothing with it', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    // Far from the player, so the fuse is the only thing that can remove it.
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const pickup = spawnPickup(sim.world, { x: 40, y: 0, kind: PickupKind.GOLD, lifespanTicks: 5 });

    // Ticks 0..3 — still on the ground (spawned before LifespanSystem this tick,
    // so tick 0 already consumed one of the five).
    sim.step(4);
    expect(sim.world.isAlive(pickup)).toBe(true);
    expect(pickupOf(sim, pickup).lifespanTicks).toBe(1);

    // Tick 4 — the fuse reaches zero: removed at the END of this tick.
    sim.step(1);
    expect(sim.world.isAlive(pickup)).toBe(false);

    sim.step(5);
    expect(pickupsOf(sim)).toEqual([]);
    expect(readGold(sim.world)).toBe(0);
  });

  it('two pickups from the same drop expire independently', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const short = spawnPickup(sim.world, { x: 40, y: 0, lifespanTicks: 3 });
    const long = spawnPickup(sim.world, { x: 50, y: 0, lifespanTicks: 30 });

    sim.step(3);
    expect(sim.world.isAlive(short)).toBe(false);
    expect(sim.world.isAlive(long)).toBe(true);
    expect(pickupOf(sim, long).lifespanTicks).toBe(27);
  });
});

/* ========================================================================== *
 * G4 · it is NOT a hit                                                       *
 * ========================================================================== */
describe('G4 · taking a pickup is not a hit (AC-05)', () => {
  it('writes no hitstop, no HITSTUN and no HitEvent', () => {
    const { sim, spy } = makeObservableSim();
    const player = PlayerFactory.spawn(sim.world, { x: -5, y: 0, maxSpeed: MAX_SPEED });
    spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.GOLD, amount: 7 });

    sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });

    // Walk all the way through the pickup.
    sim.step(60);

    // The pickup really was taken (otherwise every assertion below is vacuous).
    expect(readGold(sim.world)).toBe(7);

    // (a) no hitstop, at any point: the entity is not frozen and carries no
    //     non-zero freeze counter.
    expect(isFrozen(sim.world, player)).toBe(false);
    const freeze = sim.world.getComponent(player, FreezeComponent);
    expect(freeze === undefined || freeze.remainingTicks === 0).toBe(true);

    // (b) no HITSTUN: the player is walking (or idle), never staggered.
    expect(stateOf(sim, player).state).not.toBe(ActionState.HITSTUN);

    // (c) no hit event was published by the pickup's collection. (The swing the
    //     player threw may have connected with nothing — there is no enemy here —
    //     so the bus is empty for the whole run.)
    expect(spy.hits).toEqual([]);

    // (d) the pickup's own death is a real death-tagged state, and it did not
    //     manufacture a combat reaction anywhere.
    expect(sim.world.query(HitboxComponent)).toEqual([]);
  });

  it('the same script WITH a hit does produce hitstop + HITSTUN (falsifiability)', () => {
    // The mirror image of the test above: if a pickup's collection had silently
    // written feedback, this control shows what that would have looked like. A
    // swing that connects freezes BOTH sides, so the ATTACKER is frozen here.
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, { x: 1, y: 0, maxHp: 100, hp: 100 });

    sim.inject({ kind: 'move', tick: 0, vector: vec2(0, 0) });
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // tick 0 — the swing is raised at 0.75, radius 1.0: it connects

    // The hit really landed...
    expect(hpOf(sim, enemy)).toBeLessThan(100);
    // ...and it DID write feedback: the attacker is frozen by its own hitstop, and
    // the victim is staggered. Neither of these ever happens for a pickup.
    expect(isFrozen(sim.world, player)).toBe(true);
    expect(stateOf(sim, enemy).state).toBe(ActionState.HITSTUN);
  });
});

describe('G4 · a pickup does not block movement and does not absorb projectiles (AC-06)', () => {
  it('walking through a pickup lands on exactly the same coordinate as without it', () => {
    const walk = (withPickup: boolean): { readonly x: number; readonly y: number } => {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
      const player = PlayerFactory.spawn(sim.world, { x: -5, y: 0, maxSpeed: MAX_SPEED });
      if (withPickup) spawnPickup(sim.world, { x: -3, y: 0, kind: PickupKind.GOLD, amount: 7 });
      sim.inject({ kind: 'move', tick: 0, vector: vec2(1, 0) });
      sim.step(40);
      return { x: transformOf(sim, player).x, y: transformOf(sim, player).y };
    };

    const withCoin = walk(true);
    const without = walk(false);

    // `toBe`, not `toBeCloseTo`: the displacement is the SAME arithmetic in both
    // runs, so any difference at all is the pickup's fault. A pickup has no
    // `VelocityComponent`, so `MovementSystem.resolveWalls` can never visit it and
    // can never de-penetrate the player off their line.
    expect(withCoin.x).toBe(without.x);
    expect(withCoin.y).toBe(without.y);
  });

  it('a pickup is never displaced, however hard something pushes at it', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const pickup = spawnPickup(sim.world, { x: 5, y: 0, kind: PickupKind.GOLD });

    sim.step(30);
    expect(transformOf(sim, pickup).x).toBe(5);
    expect(transformOf(sim, pickup).y).toBe(0);
  });

  it('a projectile flies straight through a pickup: neither is destroyed', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    // The player is parked far off the projectile's line, so the ONLY thing the
    // projectile could interact with is the pickup.
    PlayerFactory.spawn(sim.world, { x: 0, y: -20, maxSpeed: MAX_SPEED });
    const pickup = spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.GOLD, amount: 7 });
    const projectile = spawnProjectile(sim.world, {
      x: -3,
      y: 0,
      directionRadians: 0,
      faction: Faction.Enemy,
      ownerEntityId: -1,
      lifespanTicks: 60,
    });

    sim.step(12); // ticks 0..11 — 20 u/s * 12/60 = 4 units of flight, past x = 0

    // The projectile neither died on the pickup nor was deflected by it.
    expect(sim.world.isAlive(projectile)).toBe(true);
    expect(transformOf(sim, projectile).x).toBeGreaterThan(0);
    expect(transformOf(sim, projectile).y).toBe(0);

    // ...and the pickup is untouched: no hitbox ever entered its overlap, because
    // a pickup is not in `CollisionSystem`'s target set at all (spec 15 I1).
    expect(sim.world.isAlive(pickup)).toBe(true);
    expect(pickupsOf(sim)).toEqual([pickup]);
  });
});

/* ========================================================================== *
 * G5 · the run                                                               *
 * ========================================================================== */
const ROOM_A: readonly EncounterWaveConfig[] = [
  { delayTicks: 0, enemies: [{ x: 6, y: 0, maxHp: 100, hp: 100 }] },
];
const ROOM_B: readonly EncounterWaveConfig[] = [
  { delayTicks: 0, enemies: [{ x: -6, y: 0, maxHp: 200, hp: 200 }] },
];

/** Kill every member of the current wave and advance one tick, so the wipe resolves. */
function clearCurrentWave(sim: GameSimulator, room: EntityId): void {
  for (const id of [...encounterOf(sim, room).trackedEntityIds]) {
    applyDamage(sim.world, id, 999);
  }
  sim.step(1);
}

/** Take the first offered option and advance one tick, so the settlement resolves. */
function selectFirstOption(sim: GameSimulator, room: EntityId): string {
  const pending = encounterOf(sim, room).pendingRewards ?? [];
  const chosen = at(pending, 0);
  sim.inject({ kind: 'selectReward', tick: sim.tick, rewardId: chosen });
  sim.step(1);
  return chosen;
}

interface RunRig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
  readonly room: EntityId;
}

/** A run-shaped world: player + a two-room run + the run's state singleton. */
function makeRunRig(rooms: readonly (readonly EncounterWaveConfig[])[] = [ROOM_B]): RunRig {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
  const room = EncounterFactory.spawn(sim.world, { waves: ROOM_A, rooms });
  GameStateFactory.spawn(sim.world);
  return { sim, player, room };
}

describe('G5 · the room table and the final-room predicate (AC-03)', () => {
  it('the opening room is `waves`, the table is `[waves, ...rooms]`, maxRooms matches', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [] });
    const single = EncounterFactory.spawn(sim.world, { waves: ROOM_A });
    const multi = EncounterFactory.spawn(sim.world, { waves: ROOM_A, rooms: [ROOM_B, ROOM_A] });

    const one = encounterOf(sim, single);
    expect(one.maxRooms).toBe(1);
    expect(one.currentRoomIndex).toBe(0);
    expect(one.roomWaves).toHaveLength(1);
    // Identity, not a copy: the room table's first entry IS the room's live config.
    expect(at(one.roomWaves, 0)).toBe(ROOM_A);
    expect(one.waves).toBe(ROOM_A);
    expect(isFinalRoom(one)).toBe(true);

    const three = encounterOf(sim, multi);
    expect(three.maxRooms).toBe(3);
    expect(three.roomWaves).toHaveLength(3);
    expect(at(three.roomWaves, 1)).toBe(ROOM_B);
    expect(isFinalRoom(three)).toBe(false);
  });

  it('resolveEncounterRooms validates EVERY room, including ones never reached', () => {
    expect(resolveEncounterRooms({ waves: ROOM_A })).toHaveLength(1);
    expect(resolveEncounterRooms({ waves: ROOM_A, rooms: [ROOM_B, ROOM_A] })).toHaveLength(3);

    // The invalid room is the SECOND one — a run that only fails on its third room
    // is a bug that shows up ten minutes into play.
    expect(() => resolveEncounterRooms({ waves: ROOM_A, rooms: [[]] })).toThrow(RangeError);
    expect(() =>
      resolveEncounterRooms({ waves: ROOM_A, rooms: [[{ delayTicks: -1, enemies: [{}] }]] }),
    ).toThrow(RangeError);
    expect(() =>
      resolveEncounterRooms({ waves: ROOM_A, rooms: [[{ delayTicks: 0, enemies: [] }]] }),
    ).toThrow(RangeError);
    // A malformed enemy spec is caught by dry-run assembly in the far room too.
    expect(() =>
      resolveEncounterRooms({ waves: ROOM_A, rooms: [[{ delayTicks: 0, enemies: [{ maxHp: -1 }] }]] }),
    ).toThrow(RangeError);
  });

  it('a room that is NOT final rolls a draft; the final room never does', () => {
    const { sim, room } = makeRunRig();
    sim.step(1); // tick 0 — room 0's wave spawns
    clearCurrentWave(sim, room); // tick 1 — room 0 cleared: NOT final => draft

    const encounter = encounterOf(sim, room);
    expect(encounter.state).toBe(EncounterState.ROOM_CLEARED);
    expect(encounter.currentRoomIndex).toBe(0);
    expect(encounter.pendingRewards).toHaveLength(DEFAULT_REWARD_DRAFT_COUNT);
    expect(findRewardDraft(sim.world)).toBeDefined();
    expect(isRunWon(sim.world)).toBe(false);
  });
});

describe('G5 · a settled reward advances the room and loads its waves (AC-03)', () => {
  it('currentRoomIndex += 1, depth += 1, and `waves` becomes the next room config', () => {
    const { sim, room } = makeRunRig();
    sim.step(1); // tick 0
    clearCurrentWave(sim, room); // tick 1 — draft

    const encounter = encounterOf(sim, room);
    expect(encounter.waves).toBe(ROOM_A);

    selectFirstOption(sim, room); // tick 2 — settle + descend

    expect(encounter.pendingRewards).toBeNull();
    expect(findRewardDraft(sim.world)).toBeUndefined();
    expect(encounter.state).toBe(EncounterState.IN_PROGRESS);
    expect(encounter.currentRoomIndex).toBe(1);
    expect(encounter.depth).toBe(1);
    // AC-03's "load the next room's wave configuration": the live config IS the
    // table's second entry, by reference.
    expect(encounter.waves).toBe(ROOM_B);
    expect(encounter.currentWaveIndex).toBe(0);
    expect(encounter.trackedEntityIds).toEqual([]);

    // The deeper wave spawns on the FOLLOWING tick (the documented 1-tick phase).
    // Two enemies, not one: room B's base entry plus the `depth = 1` copy the M6
    // escalation rule adds (spec 11 AC-04) — the descent raised the difficulty AND
    // swapped the configuration, and both facts are asserted here.
    sim.step(1); // tick 3
    const spawned = encounterOf(sim, room).trackedEntityIds;
    expect(spawned).toHaveLength(2);
    // The base entry IS room B's: at x = -6 with 200 hp, not room A's (6, 100).
    expect(transformOf(sim, at(spawned, 0)).x).toBe(-6);
    expect(hpOf(sim, at(spawned, 0))).toBe(200);
    // The depth copy is offset along +x by the deterministic spacing constant.
    expect(transformOf(sim, at(spawned, 1)).x).toBe(-6 + DEPTH_SPAWN_SPACING_UNITS);
  });
});

describe('G5 · clearing the FINAL room wins the run, with no draft (AC-04)', () => {
  it('maxRooms = 2: clear room 0 -> draft -> descend -> clear room 1 -> RUN_WON', () => {
    const { sim, player, room } = makeRunRig();

    sim.step(1); // tick 0 — room 0's wave
    expect(encounterOf(sim, room).currentRoomIndex).toBe(0);

    clearCurrentWave(sim, room); // tick 1 — room 0 cleared: draft
    expect(encounterOf(sim, room).pendingRewards).not.toBeNull();
    selectFirstOption(sim, room); // tick 2 — advance to room 1

    expect(encounterOf(sim, room).currentRoomIndex).toBe(1);
    expect(isFinalRoom(encounterOf(sim, room))).toBe(true);
    expect(isRunWon(sim.world)).toBe(false);

    sim.step(1); // tick 3 — room 1's wave spawns (2 enemies: base + depth 1)
    expect(encounterOf(sim, room).trackedEntityIds).toHaveLength(2);

    clearCurrentWave(sim, room); // tick 4 — the FINAL room is cleared

    // (a) the run is won, directly, on the clear tick.
    expect(isRunWon(sim.world)).toBe(true);
    expect(findGameState(sim.world)?.status).toBe(GameStatus.RUN_WON);
    expect(isRunOver(sim.world)).toBe(true);
    expect(isRunWon(sim.world)).toBe(true);

    // (b) NO draft was generated — not "a draft nobody took", but none at all.
    expect(encounterOf(sim, room).pendingRewards).toBeNull();
    expect(findRewardDraft(sim.world)).toBeUndefined();
    expect(encounterOf(sim, room).state).toBe(EncounterState.ROOM_CLEARED);
    // ...and the room index did not run off the end of the table.
    expect(encounterOf(sim, room).currentRoomIndex).toBe(1);

    // (c) the world stops accepting operation intent.
    const resting = { x: transformOf(sim, player).x, y: transformOf(sim, player).y };
    const entitiesAtWin = sim.world.entityCount;
    sim.inject({ kind: 'move', tick: sim.tick, vector: vec2(1, 0) });
    sim.inject({ kind: 'keyDown', tick: sim.tick, key: ATTACK_KEY });
    for (let tick = 5; tick <= 20; tick += 1) {
      sim.step(1);
      expect(transformOf(sim, player).x).toBe(resting.x);
      expect(transformOf(sim, player).y).toBe(resting.y);
      expect(sim.world.getComponent(player, IntentComponent)?.moveVector).toEqual(vec2(0, 0));
      expect(sim.world.getComponent(player, IntentComponent)?.wantsToAttack).toBe(false);
    }
    // No new wave was scheduled either — the scheduler is inert.
    expect(sim.world.entityCount).toBe(entitiesAtWin);
  });

  it('a won run collects nothing — the win screen is a hard stop for the wallet', () => {
    const { sim, player, room } = makeRunRig();
    sim.step(1); // tick 0
    clearCurrentWave(sim, room); // tick 1 — draft
    selectFirstOption(sim, room); // tick 2 — room 1
    sim.step(1); // tick 3 — room 1's wave
    clearCurrentWave(sim, room); // tick 4 — RUN_WON
    expect(isRunWon(sim.world)).toBe(true);

    // Hand-place a coin under the player. The player is ALIVE and standing on it,
    // which is exactly the state this gate exists for: the dead-collector gate
    // cannot cover it, because a won run leaves the player very much alive.
    const coin = spawnPickup(sim.world, {
      x: transformOf(sim, player).x,
      y: transformOf(sim, player).y,
      kind: PickupKind.GOLD,
      amount: 9,
    });
    const goldAtWin = readGold(sim.world);

    sim.step(5);

    expect(readGold(sim.world)).toBe(goldAtWin);
    // The coin was not consumed — it merely ages, because the FUSE is the
    // environment's clock and only the WALLET is gated on the run.
    expect(sim.world.isAlive(coin)).toBe(true);
    expect(pickupOf(sim, coin).lifespanTicks).toBe(DEFAULT_PICKUP_LIFESPAN_TICKS - 5);
  });

  it('the final room consumes NO randomness — a later room cannot shift the draft', () => {
    // Two runs on the same seed. `A` is a one-room run: clearing it wins, so no draw
    // is consumed. `B` is a two-room run: clearing room 0 rolls a draft, consuming
    // draws. Comparing the generator's NEXT value therefore observes the draw
    // directly — this is the only assertion that can see "no roll happened".
    const nextAfterClear = (rooms: readonly (readonly EncounterWaveConfig[])[]): number => {
      const { sim, room } = makeRunRig(rooms);
      sim.step(1);
      clearCurrentWave(sim, room);
      return sim.world.rng.nextUint32();
    };

    const noDraw = nextAfterClear([]); // maxRooms = 1 => final => no draft
    const withDraw = nextAfterClear([ROOM_B]); // maxRooms = 2 => draft rolled

    expect(noDraw).not.toBe(withDraw);
    // The untouched generator yields exactly its first value, bit for bit.
    expect(noDraw).toBe(new Random(SEED).nextUint32());
  });

  it('the settlement-side guard: a hand-opened draft on the final room wins, not descends', () => {
    // Unreachable through the shipped configuration (the final room never rolls a
    // draft), which is exactly why it is tested: the alternative to this branch is
    // an out-of-range room index.
    const { sim, player, room } = makeRunRig();
    const encounter = encounterOf(sim, room);
    const maxHpBefore = hpOf(sim, player);

    // Hand-assemble the impossible state: a draft open on the final room.
    encounter.currentRoomIndex = encounter.maxRooms - 1;
    encounter.state = EncounterState.ROOM_CLEARED;
    encounter.pendingRewards = ['hp_up'];

    selectFirstOption(sim, room);

    expect(isRunWon(sim.world)).toBe(true);
    expect(encounter.pendingRewards).toBeNull();
    // The room index did NOT advance past the end of the table.
    expect(encounter.currentRoomIndex).toBe(encounter.maxRooms - 1);
    // The reward the player picked was still granted — settling is not a punishment.
    const health = sim.world.getComponent(player, HealthComponent);
    expect(health?.maxHp).toBe(maxHpBefore + 20);
  });

  it('a world with no game state never wins — it just clears its room', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const room = EncounterFactory.spawn(sim.world, { waves: ROOM_A });

    sim.step(1);
    clearCurrentWave(sim, room);

    // A single-room run IS the final room, so no draft is rolled...
    expect(encounterOf(sim, room).state).toBe(EncounterState.ROOM_CLEARED);
    expect(encounterOf(sim, room).pendingRewards).toBeNull();
    // ...but with no run state to write, nothing can be won (spec 14 AC-11's opt-in
    // reading, extended to RUN_WON): `markRunWon` is a documented no-op.
    expect(isRunWon(sim.world)).toBe(false);
    expect(isRunOver(sim.world)).toBe(false);
    markRunWon(sim.world);
    expect(isRunWon(sim.world)).toBe(false);
  });
});

/* ========================================================================== *
 * G6 · restartRun                                                            *
 * ========================================================================== */
const RUN_WAVES: readonly EncounterWaveConfig[] = [
  { delayTicks: 0, enemies: [{ x: 6, y: 0, maxHp: 100, hp: 100 }] },
];

/** The run shape every restart test uses: two one-wave rooms, so one full run wins. */
function runSetup(world: World): void {
  PlayerFactory.spawn(world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
  EncounterFactory.spawn(world, { waves: RUN_WAVES, rooms: [RUN_WAVES] });
  GameStateFactory.spawn(world);
}

/** Play the whole two-room run to `RUN_WON`, collecting a coin and a boon on the way. */
function playToRunWon(sim: GameSimulator): void {
  const room = roomIdOf(sim);
  sim.step(1); // tick 0 — room 0's wave
  clearCurrentWave(sim, room); // tick 1 — draft
  selectFirstOption(sim, room); // tick 2 — descend to room 1
  sim.step(1); // tick 3 — room 1's wave
  clearCurrentWave(sim, room); // tick 4 — RUN_WON
}

describe('G6 · restartRun clears gold, gear and room progress (AC-07)', () => {
  it('a won run restarts as a genuinely fresh one', () => {
    const sim = new GameSimulator({
      fps: FPS,
      systems: createDefaultSystems(),
      seed: SEED,
      runSetup,
    });
    runSetup(sim.world);

    const player = playerIdOf(sim);
    playToRunWon(sim);
    expect(isRunWon(sim.world)).toBe(true);

    // Give the finished run something to lose: gold, and a boon on the player.
    addGold(sim.world, player, 42);
    addModifier(sim.world, player, 'zeus_strike');
    spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.GOLD, amount: 7 });
    expect(readGold(sim.world)).toBe(42);
    expect(hasModifier(sim.world, player, 'zeus_strike')).toBe(true);
    expect(pickupsOf(sim)).toHaveLength(1);

    sim.restartRun();

    // (1) the clock rewound, (2) the run is live again.
    expect(sim.tick).toBe(0);
    expect(findGameState(sim.world)?.status).toBe(GameStatus.PLAYING);
    expect(isRunWon(sim.world)).toBe(false);
    expect(isRunOver(sim.world)).toBe(false);

    // (3) the old player is gone, and so is everything it carried.
    expect(sim.world.isAlive(player)).toBe(false);

    // (4) a BRAND NEW player, with an empty wallet and no gear.
    const fresh = playerIdOf(sim);
    expect(fresh).not.toBe(player);
    expect(readGold(sim.world)).toBe(0);
    expect(inventoryOf(sim, fresh).gold).toBe(0);
    expect(sim.world.getComponent(fresh, ModifierComponent)?.modifiers).toEqual([]);

    // (5) the room progress is back to the opening room.
    const room = roomIdOf(sim);
    expect(encounterOf(sim, room).currentRoomIndex).toBe(0);
    expect(encounterOf(sim, room).depth).toBe(0);
    expect(encounterOf(sim, room).state).toBe(EncounterState.IN_PROGRESS);
    expect(encounterOf(sim, room).pendingRewards).toBeNull();
    expect(encounterOf(sim, room).trackedEntityIds).toEqual([]);
    expect(encounterOf(sim, room).maxRooms).toBe(2);

    // (6) no pickup survived the boundary, and the rebuilt run behaves like a fresh one.
    expect(pickupsOf(sim)).toEqual([]);
    sim.step(1);
    expect(encounterOf(sim, roomIdOf(sim)).trackedEntityIds).toHaveLength(1);
    expect(readGold(sim.world)).toBe(0);
  });

  it('a restarted run replays the win bit-for-bit from the new seed', () => {
    const frames = (): Snapshot[] => {
      const sim = new GameSimulator({
        fps: FPS,
        systems: createDefaultSystems(),
        seed: SEED,
        runSetup,
      });
      runSetup(sim.world);
      playToRunWon(sim);
      sim.restartRun(); // seed -> SEED + 1

      const out: Snapshot[] = [];
      const room = roomIdOf(sim);
      sim.step(1);
      out.push(sim.snapshot());
      clearCurrentWave(sim, room);
      out.push(sim.snapshot());
      selectFirstOption(sim, room);
      out.push(sim.snapshot());
      return out;
    };

    const first = frames();
    const second = frames();
    expect(second).toEqual(first);
    // The run really did reach the draft stage, so the frames are not all identical.
    expect(first).toHaveLength(3);
    expect(first[1]).not.toEqual(first[0]);
  });
});

/* ========================================================================== *
 * G7 · pipeline slot and zero regression                                     *
 * ========================================================================== */
describe('G7 · pipeline slot and zero regression (AC-09/AC-10)', () => {
  it('adds exactly one segment, between RewardSystem and LifespanSystem', () => {
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
    expect(names.filter((name) => name === 'PickupSystem')).toHaveLength(1);

    const pickup = names.indexOf('PickupSystem');
    // It must use the position the collector ENDED the tick at.
    expect(pickup).toBeGreaterThan(names.indexOf('MovementSystem'));
    // It must see a pickup dropped by THIS tick's deaths.
    expect(pickup).toBeGreaterThan(names.indexOf('DeathSystem'));
    // It must remove a taken pickup at the end of the same tick.
    expect(pickup).toBeLessThan(names.indexOf('LifespanSystem'));
    // The M1 hard contract is untouched, and LifespanSystem still owns the tail.
    expect(names.indexOf('DashSystem')).toBe(names.indexOf('MovementSystem') + 1);
    expect(names.indexOf('StateSystem')).toBe(names.indexOf('DashSystem') + 1);
    expect(names.indexOf('TransformSnapshotSystem')).toBe(0);
    expect(names.indexOf('LifespanSystem')).toBe(names.length - 1);
  });

  it('a pickup dropped by THIS tick is already collectable — the documented 1-tick phase', () => {
    // The pipeline slot made observable: because PickupSystem sits AFTER DeathSystem,
    // the drop and its collection share one tick boundary. A collector standing on
    // the corpse takes the coin on the very tick the enemy dies.
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, {
      x: 0,
      y: 0,
      maxHp: 10,
      hp: 10,
      loot: [{ kind: PickupKind.GOLD, amount: 5 }],
    });

    applyDamage(sim.world, enemy, 999);
    sim.step(1); // tick 0 — the enemy dies, drops, and the coin is taken

    expect(isDead(sim.world, enemy)).toBe(true);
    expect(readGold(sim.world)).toBe(5);
    expect(pickupsOf(sim)).toEqual([]);
    expect(player).toBeGreaterThanOrEqual(0);
  });

  it('a live run with no pickups anywhere is untouched, tick after tick', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxSpeed: MAX_SPEED });
    // No `loot` at all: an enemy that drops nothing, i.e. every pre-M9 enemy.
    EnemyFactory.spawn(sim.world, { x: 6, y: 0, maxHp: 100, hp: 100 });
    const before = sim.world.entityCount;

    sim.step(20);

    expect(sim.world.entityCount).toBe(before);
    expect(readGold(sim.world)).toBe(0);
    expect(hpOf(sim, player)).toBe(100);
    expect(pickupsOf(sim)).toEqual([]);
  });
});
