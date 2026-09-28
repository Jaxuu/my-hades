/**
 * M3-T01 · Boon / modifier engine acceptance tests.
 * See specs/05_boon_modifier_spec.md §6 (tick-by-tick contract) and §7
 * (AC-01 .. AC-09).
 *
 * Fresh-eyes harness suite: every behavioural assertion drives the REAL
 * GameSimulator with the canonical pipeline
 * (PlayerControllerSystem -> FreezeSystem -> MovementSystem -> DashSystem ->
 * StateSystem -> CombatActionSystem -> CollisionSystem -> StatusEffectSystem ->
 * ModifierSystem -> LifespanSystem) and REAL prefab-assembled entities. Nothing is mocked, and ticks
 * are advanced one at a time so the timing contract is pinned per tick.
 *
 * Geometry: player at (0, 0) facing +x attacks on tick 0; its hitbox is centred at
 * (0.75, 0) with radius 1.0, and the enemy (hurtbox radius 0.5) at (1.5, 0) is
 * within the 1.5 reach, so the base hit lands on tick 0 (the "trigger tick" T).
 *
 * Tick derivation for the Zeus Strike (T = 0, spec 05 §6.2):
 *   - tick 0: base hit deals DEFAULT_ATTACK_DAMAGE (10)  -> hp 90; ModifierSystem
 *     injects the bolt at the victim's position with activeTicks = 2, which
 *     LifespanSystem decrements to 1 (alive).
 *   - tick 1: the bolt is collision-tested ONCE and deals DEFAULT_ZEUS_STRIKE_DAMAGE
 *     (20) -> hp 70; its own HitEvent carries sourceModifier = 'zeus_strike', so
 *     ModifierSystem drops it; LifespanSystem decrements 1 -> 0 (destroyed).
 *   - tick 2+: hp stays 70. Nesting depth is exactly 1.
 *
 * Grouping:
 *   G0 · ModifierComponent + free-function semantics                     (AC-02)
 *   G1 · HitEvent hook: exact fields, no event on an i-frame hit         (AC-01)
 *   G2 · Zeus Strike: injection contract + the two damage settlements    (AC-03)
 *   G3 · anti-recursion: depth is exactly 1, hp converges                (AC-04)
 *   G4 · no-boon control: one settlement, zero bolts                     (AC-03/C9)
 *   G5 · the bolt is a PURE-DAMAGE tick: feedback timeline is untouched  (AC-03)
 *   G6 · EventQueue contract: FIFO, copy-on-drain, empty at tick bounds  (AC-07)
 *   G7 · canonical pipeline order (9 segments)                           (AC-08)
 *   G8 · deterministic replay of the injection path                      (AC-06)
 */

import { describe, expect, it } from 'vitest';
import {
  ATTACK_KEY,
  ActionState,
  CollisionSystem,
  CombatActionSystem,
  DEFAULT_ATTACK_DAMAGE,
  DEFAULT_ATTACK_HITBOX_OFFSET,
  DEFAULT_HITSTOP_TICKS,
  DEFAULT_HITSTUN_TICKS,
  DEFAULT_KNOCKBACK_FORCE,
  DEFAULT_MAX_HP,
  DEFAULT_ZEUS_STRIKE_DAMAGE,
  DEFAULT_ZEUS_STRIKE_LIFESPAN_TICKS,
  DEFAULT_ZEUS_STRIKE_RADIUS,
  DashSystem,
  EnemyFactory,
  EventQueue,
  Faction,
  FreezeSystem,
  GameSimulator,
  HealthComponent,
  HitboxComponent,
  INVULNERABLE_TAG,
  IntentComponent,
  KnockbackComponent,
  LifespanSystem,
  ModifierComponent,
  ModifierSystem,
  MovementSystem,
  PlayerControllerSystem,
  PlayerFactory,
  StateComponent,
  StateSystem,
  TransformComponent,
  ZEUS_STRIKE_MODIFIER,
  addModifier,
  addTag,
  createDefaultSystems,
  hasModifier,
  isFrozen,
  removeModifier,
  vec2,
} from '../../src';
import type { EntityId, HitEvent, Snapshot, System, SystemContext } from '../../src';

const FPS = 60;
const MAX_SPEED = 5;
const TOLERANCE = 1e-9;

/** Enemy spawn X used by every rig: 0.75 < 1.5 reach, so the base hit lands on tick 0. */
const ENEMY_X = 1.5;

/** Knockback total over the full stun: 12 * 8 * (1/60) = 1.6 -> enemy ends at 3.1. */
const KNOCKBACK_TOTAL = DEFAULT_KNOCKBACK_FORCE * DEFAULT_HITSTUN_TICKS * (1 / FPS);

interface Rig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
  readonly enemy: EntityId;
}

/**
 * A hit-lands-on-tick-0 rig. `boon` grants `zeus_strike` to the PLAYER only, so
 * the attacker is the boon holder and the enemy is the victim.
 */
function makeRig(options: { boon?: boolean; enemyX?: number } = {}): Rig {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
  const enemy = EnemyFactory.spawn(sim.world, {
    x: options.enemyX ?? ENEMY_X,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
  });
  if (options.boon ?? true) addModifier(sim.world, player, ZEUS_STRIKE_MODIFIER);
  return { sim, player, enemy };
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

function transformOf(sim: GameSimulator, id: EntityId): TransformComponent {
  const transform = sim.world.getComponent(id, TransformComponent);
  if (transform === undefined) throw new Error('QA: entity is missing TransformComponent');
  return transform;
}

function hitboxOf(sim: GameSimulator, id: EntityId): HitboxComponent {
  const hitbox = sim.world.getComponent(id, HitboxComponent);
  if (hitbox === undefined) throw new Error('QA: entity is missing HitboxComponent');
  return hitbox;
}

/** Ids of every live Zeus bolt, ascending. A bolt is a hitbox with the boon tag. */
function boltsOf(sim: GameSimulator): EntityId[] {
  return sim.world.query(TransformComponent, HitboxComponent).filter((id) => {
    const hitbox = sim.world.getComponent(id, HitboxComponent);
    return hitbox !== undefined && hitbox.sourceModifier === ZEUS_STRIKE_MODIFIER;
  });
}

/** Ids of every live BASE (non-modifier-sourced) hitbox, ascending. */
function baseHitboxesOf(sim: GameSimulator): EntityId[] {
  return sim.world.query(TransformComponent, HitboxComponent).filter((id) => {
    const hitbox = sim.world.getComponent(id, HitboxComponent);
    return hitbox !== undefined && hitbox.sourceModifier === null;
  });
}

function ctxAt(tick: number): SystemContext {
  return { tick, elapsedSeconds: tick * (1 / FPS), fixedDeltaSeconds: 1 / FPS, input: [] };
}

/** Records every HitEvent it sees, draining the bus exactly like a consumer would. */
class EventSpy implements System {
  public readonly name = 'EventSpy';
  public readonly hits: HitEvent[] = [];

  private readonly events: EventQueue;

  constructor(events: EventQueue) {
    this.events = events;
  }

  public update(): void {
    for (const event of this.events.drain()) this.hits.push(event);
  }
}

/**
 * The pipeline with a probe spliced in right after CollisionSystem, so the emitted
 * HitEvent can be inspected field by field. ModifierSystem is deliberately ABSENT
 * here: the probe owns the bus, and this suite only wants to assert the FACT that
 * CollisionSystem published. (StatusEffectSystem is absent for the same reason —
 * no status is ever applied in these cases, so it would be a no-op.)
 */
function makeSpySim(events: EventQueue, spy: EventSpy): GameSimulator {
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
      spy,
      new LifespanSystem(),
    ],
  });
}

/* ------------------------------------------------------------------ *
 * G0 · ModifierComponent + free functions                             *
 * ------------------------------------------------------------------ */
describe('G0 · ModifierComponent holds a boon list (AC-02)', () => {
  it('mounts lazily, keeps the list sorted + deduplicated, and is idempotent', () => {
    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;

    expect(sim.world.getComponent(id, ModifierComponent)).toBeUndefined();
    expect(hasModifier(sim.world, id, ZEUS_STRIKE_MODIFIER)).toBe(false);

    addModifier(sim.world, id, 'zeta_boon');
    addModifier(sim.world, id, 'alpha_boon');
    addModifier(sim.world, id, 'zeta_boon'); // duplicate -> no-op

    const modifiers = sim.world.getComponent(id, ModifierComponent);
    if (modifiers === undefined) throw new Error('QA: addModifier did not mount ModifierComponent');
    expect(modifiers.modifiers).toEqual(['alpha_boon', 'zeta_boon']); // ascending + deduplicated
    expect(hasModifier(sim.world, id, 'alpha_boon')).toBe(true);

    removeModifier(sim.world, id, 'alpha_boon');
    expect(modifiers.modifiers).toEqual(['zeta_boon']);
    removeModifier(sim.world, id, 'not_held'); // no-op
    expect(modifiers.modifiers).toEqual(['zeta_boon']);

    // Revoking the last boon leaves an EMPTY component rather than removing it —
    // the same stable-shape rule FreezeComponent follows, so snapshots do not churn.
    removeModifier(sim.world, id, 'zeta_boon');
    expect(modifiers.modifiers).toEqual([]);
  });

  it('mounts an empty ModifierComponent on every prefab-assembled combatant', () => {
    const rig = makeRig({ boon: false });
    expect(rig.sim.world.hasComponent(rig.player, ModifierComponent)).toBe(true);
    expect(rig.sim.world.hasComponent(rig.enemy, ModifierComponent)).toBe(true);
    expect(hasModifier(rig.sim.world, rig.player, ZEUS_STRIKE_MODIFIER)).toBe(false);
  });

  it('supports holding MULTIPLE modifiers at once', () => {
    const rig = makeRig();
    addModifier(rig.sim.world, rig.player, 'athena_dash');
    const modifiers = rig.sim.world.getComponent(rig.player, ModifierComponent);
    if (modifiers === undefined) throw new Error('QA: player is missing ModifierComponent');
    expect(modifiers.modifiers).toEqual(['athena_dash', ZEUS_STRIKE_MODIFIER]);
  });
});

/* ------------------------------------------------------------------ *
 * G1 · the OnHit event hook                                           *
 * ------------------------------------------------------------------ */
describe('G1 · CollisionSystem publishes a HitEvent for every landed hit (AC-01)', () => {
  it('emits exactly one event per landed hit, with the four required fields exact', () => {
    const events = new EventQueue();
    const spy = new EventSpy(events);
    const sim = makeSpySim(events, spy);
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // tick 0 — the base hit lands

    expect(spy.hits).toHaveLength(1);
    const hit = spy.hits[0];
    if (hit === undefined) throw new Error('QA: expected one HitEvent');

    expect(hit.tick).toBe(0);
    expect(hit.attackerId).toBe(player);
    expect(hit.targetId).toBe(enemy);
    expect(hit.damage).toBe(DEFAULT_ATTACK_DAMAGE);
    expect(hit.sourceModifier).toBeNull(); // a base attack carries no provenance
    expect(hit.position.x).toBeCloseTo(DEFAULT_ATTACK_HITBOX_OFFSET, 9); // impact point = hitbox centre
    expect(hit.position.y).toBeCloseTo(0, 9);

    // The reported hitbox really is the base attack hitbox that just connected.
    const baseHitboxes = baseHitboxesOf(sim);
    expect(baseHitboxes).toHaveLength(1);
    expect(hit.hitboxEntityId).toBe(baseHitboxes[0]);
    expect(hitboxOf(sim, hit.hitboxEntityId).sourceModifier).toBeNull();

    // The producer is a full-drain bus: nothing is left dangling.
    expect(events.size).toBe(0);
  });

  it('emits NOTHING for an invulnerable hit (the i-frame is ignored entirely)', () => {
    const events = new EventQueue();
    const spy = new EventSpy(events);
    const sim = makeSpySim(events, spy);
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    addTag(sim.world, enemy, INVULNERABLE_TAG);

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1);

    expect(hpOf(sim, enemy)).toBe(DEFAULT_MAX_HP); // no damage
    expect(spy.hits).toHaveLength(0); // ... and no event for a modifier to latch onto
    expect(events.size).toBe(0);
  });

  it('keeps the event bus EMPTY at every tick boundary (it is a wire, not state)', () => {
    const events = new EventQueue();
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(events) });
    const player = PlayerFactory.spawn(sim.world, {
      x: 0,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    addModifier(sim.world, player, ZEUS_STRIKE_MODIFIER);

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    for (let i = 0; i < 20; i += 1) {
      sim.step(1);
      expect(events.size).toBe(0); // ModifierSystem drained everything this tick
    }
  });
});

/* ------------------------------------------------------------------ *
 * G2 · Zeus Strike injection contract                                 *
 * ------------------------------------------------------------------ */
describe('G2 · Zeus Strike injects a directionless lightning hitbox (AC-03)', () => {
  it('deals a SECOND damage settlement exactly one tick after the base hit', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });

    rig.sim.step(1); // tick 0 — base hit
    expect(hpOf(rig.sim, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE); // 90

    rig.sim.step(1); // tick 1 — the bolt connects
    expect(hpOf(rig.sim, rig.enemy)).toBe(
      DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE - DEFAULT_ZEUS_STRIKE_DAMAGE, // 70
    );

    rig.sim.step(10); // ticks 2..11 — nothing else may ever land
    expect(hpOf(rig.sim, rig.enemy)).toBe(70);
    expect(rig.sim.tick).toBe(12);
  });

  it('spawns the bolt with the documented geometry, damage, lifespan and provenance', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0

    const bolts = boltsOf(rig.sim);
    expect(bolts).toHaveLength(1);
    const boltId = bolts[0];
    if (boltId === undefined) throw new Error('QA: expected one Zeus bolt');

    const bolt = hitboxOf(rig.sim, boltId);
    expect(bolt.damage).toBe(DEFAULT_ZEUS_STRIKE_DAMAGE);
    expect(bolt.radius).toBe(DEFAULT_ZEUS_STRIKE_RADIUS);
    expect(bolt.faction).toBe(Faction.Player); // inherits the triggering attack's side
    expect(bolt.ownerEntityId).toBe(rig.player);
    expect(bolt.sourceModifier).toBe(ZEUS_STRIKE_MODIFIER); // AC-04 provenance tag
    expect(bolt.hitEntities).toEqual([]); // not yet resolved
    // LifespanSystem has already aged it once this tick: 2 -> 1.
    expect(bolt.activeTicks).toBe(DEFAULT_ZEUS_STRIKE_LIFESPAN_TICKS - 1);
    expect(DEFAULT_ZEUS_STRIKE_LIFESPAN_TICKS).toBeGreaterThanOrEqual(2); // §4.4 phase rule

    // It lands on the victim, with no direction of its own.
    const boltTransform = transformOf(rig.sim, boltId);
    expect(boltTransform.x).toBeCloseTo(ENEMY_X, 9);
    expect(boltTransform.y).toBeCloseTo(0, 9);
    expect(boltTransform.facingRadians).toBe(0);

    // Exactly ONE collision test: alive at the end of tick 0, gone at the end of tick 1.
    rig.sim.step(1);
    expect(rig.sim.world.isAlive(boltId)).toBe(false);
    expect(boltsOf(rig.sim)).toHaveLength(0);
  });

  it('never damages the attacker: the bolt is on the attacker side (no friendly fire)', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(2); // ticks 0..1
    expect(hpOf(rig.sim, rig.player)).toBe(DEFAULT_MAX_HP);
  });

  it("strikes the victim's CURRENT (post-movement) position, not the impact point", () => {
    const rig = makeRig({ enemyX: 1.4 });
    // Drive the ENEMY through its intent: MovementSystem runs before CollisionSystem,
    // so the victim walks this tick and the bolt must land where it ended up.
    const intent = rig.sim.world.getComponent(rig.enemy, IntentComponent);
    if (intent === undefined) throw new Error('QA: enemy is missing IntentComponent');
    intent.moveVector = vec2(-1, 0);

    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0

    const bolts = boltsOf(rig.sim);
    expect(bolts).toHaveLength(1);
    const boltId = bolts[0];
    if (boltId === undefined) throw new Error('QA: expected one Zeus bolt');

    const walked = 1.4 - MAX_SPEED * (1 / FPS);
    const boltTransform = transformOf(rig.sim, boltId);
    expect(boltTransform.x).toBeCloseTo(walked, 9);
    expect(boltTransform.x).not.toBe(1.4); // not the pre-movement spawn point
    expect(Math.abs(boltTransform.x - DEFAULT_ATTACK_HITBOX_OFFSET)).toBeGreaterThan(0.5); // not the impact point

    // ... and it still connects on the next tick, because the victim is hitstop-frozen.
    rig.sim.step(1);
    expect(hpOf(rig.sim, rig.enemy)).toBe(
      DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE - DEFAULT_ZEUS_STRIKE_DAMAGE,
    );
  });

  it('does not fire when the ATTACKER lacks the boon, but the victim has it', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    addModifier(sim.world, enemy, ZEUS_STRIKE_MODIFIER); // the VICTIM holds it

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(2);

    expect(boltsOf(sim)).toHaveLength(0);
    expect(hpOf(sim, enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
    expect(hpOf(sim, player)).toBe(DEFAULT_MAX_HP);
  });
});

/* ------------------------------------------------------------------ *
 * G3 · anti-recursion                                                 *
 * ------------------------------------------------------------------ */
describe('G3 · a modifier-sourced hit never re-enters modifier dispatch (AC-04)', () => {
  it('keeps nesting depth at exactly 1: the bolt lands once and spawns nothing', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });

    rig.sim.step(1); // tick 0 — 1 bolt in flight
    expect(boltsOf(rig.sim)).toHaveLength(1);

    rig.sim.step(1); // tick 1 — the bolt hits; if recursion existed a 2nd bolt would exist NOW
    expect(boltsOf(rig.sim)).toHaveLength(0);

    rig.sim.step(20); // ticks 2..21 — nothing may ever be injected again
    expect(boltsOf(rig.sim)).toHaveLength(0);
    expect(hpOf(rig.sim, rig.enemy)).toBe(
      DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE - DEFAULT_ZEUS_STRIKE_DAMAGE,
    );
  });

  it('drops a modifier-sourced event at the gate, and injects for the same event untagged', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    addModifier(sim.world, player, ZEUS_STRIKE_MODIFIER);

    const events = new EventQueue();
    const modifiers = new ModifierSystem(events);
    const before = sim.world.entityCount;

    // The anti-recursion gate must fire BEFORE the holder check: even though the
    // attacker DOES hold zeus_strike, a tagged event injects nothing.
    events.emit({
      tick: 0,
      attackerId: player,
      targetId: enemy,
      hitboxEntityId: 999, // deliberately not a real hitbox — exercises the faction fallback
      position: vec2(ENEMY_X, 0),
      damage: DEFAULT_ZEUS_STRIKE_DAMAGE,
      sourceModifier: ZEUS_STRIKE_MODIFIER,
    });
    modifiers.update(sim.world, ctxAt(0));

    expect(sim.world.entityCount).toBe(before); // nothing injected
    expect(events.size).toBe(0); // drained in full regardless

    // Control: the SAME event without provenance does inject exactly one bolt.
    events.emit({
      tick: 0,
      attackerId: player,
      targetId: enemy,
      hitboxEntityId: 999,
      position: vec2(ENEMY_X, 0),
      damage: DEFAULT_ATTACK_DAMAGE,
      sourceModifier: null,
    });
    modifiers.update(sim.world, ctxAt(0));

    expect(sim.world.entityCount).toBe(before + 1);
    expect(boltsOf(sim)).toHaveLength(1);
  });

  it('ignores an event whose attacker does not hold the boon', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });

    const events = new EventQueue();
    const modifiers = new ModifierSystem(events);
    const before = sim.world.entityCount;

    events.emit({
      tick: 0,
      attackerId: player,
      targetId: enemy,
      hitboxEntityId: 999,
      position: vec2(ENEMY_X, 0),
      damage: DEFAULT_ATTACK_DAMAGE,
      sourceModifier: null,
    });
    modifiers.update(sim.world, ctxAt(0));

    expect(sim.world.entityCount).toBe(before);
  });

  it('is a strict no-op on an empty queue (the C9 zero-side-effect guarantee)', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });

    const modifiers = new ModifierSystem(new EventQueue());
    const snapshotBefore = sim.snapshot();
    modifiers.update(sim.world, ctxAt(7));
    expect(sim.snapshot()).toEqual(snapshotBefore);
  });
});

/* ------------------------------------------------------------------ *
 * G4 · no-boon control                                                *
 * ------------------------------------------------------------------ */
describe('G4 · without the boon there is exactly ONE settlement (AC-03 / C9)', () => {
  it('deals only the base damage and never injects a bolt', () => {
    const rig = makeRig({ boon: false });
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });

    rig.sim.step(1); // tick 0
    expect(hpOf(rig.sim, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
    expect(boltsOf(rig.sim)).toHaveLength(0);

    rig.sim.step(12); // ticks 1..12
    expect(hpOf(rig.sim, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
    expect(boltsOf(rig.sim)).toHaveLength(0);
  });

  it('produces a BIT-IDENTICAL hp trace whether the enemy (not the attacker) holds the boon', () => {
    const run = (holder: 'none' | 'enemy'): number[] => {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
      PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
      const enemy = EnemyFactory.spawn(sim.world, { x: ENEMY_X, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
      if (holder === 'enemy') addModifier(sim.world, enemy, ZEUS_STRIKE_MODIFIER);

      sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
      const trace: number[] = [];
      for (let i = 0; i < 14; i += 1) {
        sim.step(1);
        trace.push(hpOf(sim, enemy));
      }
      return trace;
    };

    expect(run('enemy')).toEqual(run('none'));
  });
});

/* ------------------------------------------------------------------ *
 * G5 · the bolt is a pure-damage tick                                 *
 * ------------------------------------------------------------------ */
interface Trace {
  readonly enemyX: number;
  readonly enemyState: ActionState;
  readonly enemyTicksInState: number;
  readonly playerState: ActionState;
  readonly playerTicksInState: number;
  readonly playerFrozen: boolean;
  readonly enemyFrozen: boolean;
}

/**
 * Per-tick feedback trace, EXCLUDING hp. Comparing the boon trace against the
 * no-boon trace proves the bolt changed nothing except the victim's hit points:
 * not the hitstop window, not the HITSTUN span, not the knockback displacement.
 */
function feedbackTrace(boon: boolean, ticks: number): Trace[] {
  const rig = makeRig({ boon });
  rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
  const trace: Trace[] = [];
  for (let i = 0; i < ticks; i += 1) {
    rig.sim.step(1);
    trace.push({
      enemyX: transformOf(rig.sim, rig.enemy).x,
      enemyState: stateOf(rig.sim, rig.enemy).state,
      enemyTicksInState: stateOf(rig.sim, rig.enemy).ticksInState,
      playerState: stateOf(rig.sim, rig.player).state,
      playerTicksInState: stateOf(rig.sim, rig.player).ticksInState,
      playerFrozen: isFrozen(rig.sim.world, rig.player),
      enemyFrozen: isFrozen(rig.sim.world, rig.enemy),
    });
  }
  return trace;
}

describe('G5 · the bolt injects damage and NOTHING else (AC-03 / spec 05 §4.6)', () => {
  it('leaves the hitstop / hitstun / knockback timeline bit-identical to the no-boon run', () => {
    expect(feedbackTrace(true, 20)).toEqual(feedbackTrace(false, 20));
  });

  it('still walks the canonical M2 feedback timeline (freeze 4, knockback 8 ticks, ends at 3.1)', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1); // tick 0 — hit, both sides frozen

    // Ticks 1..4: frozen, so neither the victim's position nor its counter moves.
    for (let i = 0; i < DEFAULT_HITSTOP_TICKS; i += 1) {
      const x = transformOf(rig.sim, rig.enemy).x;
      const ticks = stateOf(rig.sim, rig.enemy).ticksInState;
      rig.sim.step(1);
      expect(transformOf(rig.sim, rig.enemy).x).toBe(x);
      expect(stateOf(rig.sim, rig.enemy).ticksInState).toBe(ticks);
    }

    // Ticks 5..12: exactly DEFAULT_HITSTUN_TICKS knockback ticks of 0.2 each.
    rig.sim.step(DEFAULT_HITSTUN_TICKS);
    expect(transformOf(rig.sim, rig.enemy).x).toBeCloseTo(ENEMY_X + KNOCKBACK_TOTAL, 9);
    expect(transformOf(rig.sim, rig.enemy).x).toBeCloseTo(3.1, 9);
    expect(stateOf(rig.sim, rig.enemy).state).toBe(ActionState.IDLE); // stun exited on tick 12
    expect(Math.abs(transformOf(rig.sim, rig.enemy).x - 3.1)).toBeLessThan(TOLERANCE);
  });

  it('does not re-arm the hitstop: the freeze lapses on tick 5, not tick 6', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1 + DEFAULT_HITSTOP_TICKS); // ticks 0..4 — the whole freeze
    expect(isFrozen(rig.sim.world, rig.player)).toBe(true);
    expect(isFrozen(rig.sim.world, rig.enemy)).toBe(true);

    rig.sim.step(1); // tick 5 — recovery. A bolt re-arming the freeze would keep this true.
    expect(isFrozen(rig.sim.world, rig.player)).toBe(false);
    expect(isFrozen(rig.sim.world, rig.enemy)).toBe(false);
  });

  it('does not overwrite the victim knockback with a zero vector', () => {
    const rig = makeRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    rig.sim.step(1 + DEFAULT_HITSTOP_TICKS + 1); // ticks 0..5 — one knockback tick

    const knockback = rig.sim.world.getComponent(rig.enemy, KnockbackComponent);
    if (knockback === undefined) throw new Error('QA: enemy is missing KnockbackComponent');
    // The bolt lands on tick 1, BETWEEN the hit and this displacement. A bolt that
    // wrote its own (zero) knockback would have wiped this channel out.
    expect(knockback.velocity.x).toBeCloseTo(DEFAULT_KNOCKBACK_FORCE, 9);
    expect(Math.abs(knockback.velocity.y)).toBeLessThan(TOLERANCE);

    expect(transformOf(rig.sim, rig.enemy).x).toBeCloseTo(
      ENEMY_X + DEFAULT_KNOCKBACK_FORCE * (1 / FPS),
      9,
    );
  });
});

/* ------------------------------------------------------------------ *
 * G6 · EventQueue contract                                            *
 * ------------------------------------------------------------------ */
describe('G6 · EventQueue is a FIFO, copy-on-drain, tick-scoped wire (AC-07)', () => {
  it('reports its size, drains in FIFO order and empties itself', () => {
    const queue = new EventQueue();
    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]);

    const first: HitEvent = {
      tick: 0,
      attackerId: 1,
      targetId: 2,
      hitboxEntityId: 3,
      position: vec2(0, 0),
      damage: 1,
      sourceModifier: null,
    };
    const second: HitEvent = { ...first, targetId: 4 };

    queue.emit(first);
    queue.emit(second);
    expect(queue.size).toBe(2);

    const drained = queue.drain();
    expect(drained).toEqual([first, second]); // FIFO
    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it('hands out a COPY, so a consumer cannot corrupt or re-publish the bus', () => {
    const queue = new EventQueue();
    const event: HitEvent = {
      tick: 0,
      attackerId: 1,
      targetId: 2,
      hitboxEntityId: 3,
      position: vec2(0, 0),
      damage: 1,
      sourceModifier: null,
    };
    queue.emit(event);

    const drained = queue.drain();
    drained.push(event); // mutate the returned array
    expect(queue.size).toBe(0); // the bus is unaffected
    expect(queue.drain()).toEqual([]);
  });

  it('clear() discards everything', () => {
    const queue = new EventQueue();
    queue.emit({
      tick: 0,
      attackerId: 1,
      targetId: 2,
      hitboxEntityId: 3,
      position: vec2(0, 0),
      damage: 1,
      sourceModifier: null,
    });
    queue.clear();
    expect(queue.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * G7 · canonical pipeline order                                       *
 * ------------------------------------------------------------------ */
describe('G7 · canonical 10-segment pipeline order (AC-08)', () => {
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

    // Explicitly pin the two positional rules ModifierSystem must satisfy (§5.2).
    expect(names.indexOf('ModifierSystem')).toBeGreaterThan(names.indexOf('CollisionSystem'));
    expect(names.indexOf('ModifierSystem')).toBeLessThan(names.indexOf('LifespanSystem'));
    // ... and the M3-T02 slot StatusEffectSystem must occupy (spec 06 §5.2).
    expect(names.indexOf('StatusEffectSystem')).toBeGreaterThan(names.indexOf('CollisionSystem'));
    expect(names.indexOf('StatusEffectSystem')).toBeLessThan(names.indexOf('ModifierSystem'));
    expect(names.indexOf('LifespanSystem')).toBe(names.length - 1);
  });

  it('gives each simulator its OWN bus, so two sims can never share events', () => {
    const a = createDefaultSystems();
    const b = createDefaultSystems();
    const nameOf = (systems: readonly System[]): string[] => systems.map((s) => s.name);
    expect(nameOf(a)).toEqual(nameOf(b));
    expect(a).not.toBe(b);
  });
});

/* ------------------------------------------------------------------ *
 * G8 · deterministic replay                                           *
 * ------------------------------------------------------------------ */
describe('G8 · deterministic replay of the injection path (AC-06)', () => {
  it('replays a boon script identically, tick by tick, including the injected bolt', () => {
    const runScript = (): Snapshot[] => {
      const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
      const player = PlayerFactory.spawn(sim.world, {
        x: 0,
        y: 0,
        facingRadians: 0,
        maxSpeed: MAX_SPEED,
      });
      const enemy = EnemyFactory.spawn(sim.world, {
        x: ENEMY_X,
        y: 0,
        facingRadians: 0,
        maxSpeed: MAX_SPEED,
      });
      addModifier(sim.world, player, ZEUS_STRIKE_MODIFIER);
      addModifier(sim.world, enemy, 'athena_dash');

      sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
      sim.inject({ kind: 'move', tick: 4, vector: vec2(0, 1) });
      sim.inject({ kind: 'keyDown', tick: 20, key: ATTACK_KEY });

      const frames: Snapshot[] = [];
      for (let i = 0; i < 30; i += 1) {
        sim.step(1);
        frames.push(sim.snapshot());
      }
      return frames;
    };

    const a = runScript();
    const b = runScript();
    expect(a).toHaveLength(30);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]).toEqual(b[i]);
    }
    expect(a).toEqual(b);
  });
});
