/**
 * M6-T02 · Elite super-armor + dash boons acceptance tests.
 * See specs/12_armor_and_dash_boons_spec.md §4 (semantics), §6 (tick-by-tick
 * contract) and §7 (AC-01 .. AC-06).
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
 * TICK NUMBERING (`sim.step(n)` processes ticks `0 .. n-1`, leaving `sim.tick === n`):
 *   a fresh sim needs `step(1)` to have processed tick 0, and `step(5)` to have
 *   processed ticks 0..4. Everything below is indexed by the PROCESSED tick.
 *
 * GEOMETRY (shared by G1/G2): player at (0, 0) facing +x; its melee hitbox is
 * centred at (0.75, 0) with radius 1.0, and an elite's hurtbox radius is 0.8 — so
 * the 1.5-unit gap is well inside the 2.55 reach and the swing lands on the tick it
 * is thrown. The elite starts at (1.5, 0) with `attackRadius = 4`, so it enters its
 * WINDUP on processed tick 0 and stays rooted for the whole test — which is exactly
 * what makes "did the armour break the telegraph?" observable.
 *
 * FEEDBACK PHASE (spec 04 §6, unchanged by this milestone): a hit on tick `T` arms
 * the freeze at the END of `T`, so ticks `T+1 .. T+4` are frozen and recovery is on
 * `T+5`. Hitstop PAUSES the FSM, so a stunned enemy only reaches AISystem's HITSTUN
 * branch on `T+5` — hence the "ticks 6..9 frozen, interrupt on 10" tables below.
 *
 * Grouping:
 *   G0 · armor primitives: absorb / spill / break / conservation            (AC-02)
 *   G1 · super armor: absorbs a non-breaking hit and keeps its plan          (AC-01)
 *   G2 · the breaking hit: exact spillover + a real stagger                  (AC-02)
 *   G3 · Poseidon Dash: a self-centred blast on dash entry                   (AC-03/04)
 *   G4 · the DashEvent bus contract                                          (AC-03)
 *   G5 · pipeline unchanged + zero regression / elite assembly               (AC-05/06)
 */

import { describe, expect, it } from 'vitest';
import {
  AIControllerComponent,
  AIState,
  ATTACK_KEY,
  ActionState,
  ArmorComponent,
  DASH_KEY,
  DEFAULT_ARMOR,
  DEFAULT_ATTACK_DAMAGE,
  DEFAULT_HITSTOP_TICKS,
  DEFAULT_KNOCKBACK_FORCE,
  DEFAULT_MAX_HP,
  EnemyFactory,
  EventQueue,
  Faction,
  GameSimulator,
  HealthComponent,
  HitboxComponent,
  HurtboxComponent,
  KnockbackComponent,
  POSEIDON_DASH_MODIFIER,
  PlayerFactory,
  StateComponent,
  TransformComponent,
  addModifier,
  applyDamageWithArmor,
  createDefaultSystems,
  hasModifier,
  isArmored,
  isFrozen,
  vec2,
} from '../../src';
import type { DashEvent, EntityDeathEvent, EntityId, System } from '../../src';
import { SchemaError } from '../../src';
import { testEnemy, testElite } from '../harness/config-fixtures';

const FPS = 60;
const MAX_SPEED = 5;
/** Per-tick integration accumulates float rounding; measured drift is ~1e-15. */
const TOLERANCE = 1e-9;

/*
 * M10-T01 · the balance numbers this suite pins.
 *
 * These used to be exported by `EnemyFactory` (`DEFAULT_ELITE_*`) and
 * `ModifierComponent` (`DEFAULT_POSEIDON_DASH_*`). They now live in
 * `assets/data/enemies.json` / `assets/data/modifiers.json`, and are restated here
 * as LITERALS on purpose: an assertion of the form "the field equals the constant
 * that built it" is tautological, so a re-tuned JSON would silently redefine what
 * every expectation below means. Spelling the numbers out is what makes this file
 * fail when the data moves.
 */
const DEFAULT_ELITE_MAX_HP = 300;
const DEFAULT_ELITE_ARMOR = 60;
const DEFAULT_ELITE_HURTBOX_RADIUS = 0.8;
const DEFAULT_POSEIDON_DASH_RADIUS = 3;
const DEFAULT_POSEIDON_DASH_DAMAGE = 5;
const DEFAULT_POSEIDON_DASH_KNOCKBACK = 40;
const DEFAULT_POSEIDON_DASH_HITSTOP_TICKS = 0;
const DEFAULT_POSEIDON_DASH_LIFESPAN_TICKS = 2;

/** Elite spawn X: 0.75 < 2.55 reach, so the base swing lands on the tick it is thrown. */
const ELITE_X = 1.5;
/** The processed tick the player swings on, in every armour rig. */
const HIT_TICK = 5;

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

function armorOf(sim: GameSimulator, id: EntityId): ArmorComponent {
  const armor = sim.world.getComponent(id, ArmorComponent);
  if (armor === undefined) throw new Error('QA: entity is missing ArmorComponent');
  return armor;
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

function aiOf(sim: GameSimulator, id: EntityId): AIControllerComponent {
  const ai = sim.world.getComponent(id, AIControllerComponent);
  if (ai === undefined) throw new Error('QA: entity is missing AIControllerComponent');
  return ai;
}

function hurtboxOf(sim: GameSimulator, id: EntityId): HurtboxComponent {
  const hurtbox = sim.world.getComponent(id, HurtboxComponent);
  if (hurtbox === undefined) throw new Error('QA: entity is missing HurtboxComponent');
  return hurtbox;
}

function hitboxOf(sim: GameSimulator, id: EntityId): HitboxComponent {
  const hitbox = sim.world.getComponent(id, HitboxComponent);
  if (hitbox === undefined) throw new Error('QA: entity is missing HitboxComponent');
  return hitbox;
}

function knockbackOf(sim: GameSimulator, id: EntityId): KnockbackComponent {
  const knockback = sim.world.getComponent(id, KnockbackComponent);
  if (knockback === undefined) throw new Error('QA: entity is missing KnockbackComponent');
  return knockback;
}

/** Ids of every live Poseidon blast, ascending. A blast is a tagged hitbox. */
function poseidonBlasts(sim: GameSimulator): EntityId[] {
  return sim.world.query(TransformComponent, HitboxComponent).filter((id) => {
    const hitbox = sim.world.getComponent(id, HitboxComponent);
    return hitbox !== undefined && hitbox.sourceModifier === POSEIDON_DASH_MODIFIER;
  });
}

/* --- rigs ----------------------------------------------------------------- */

interface EliteRig {
  readonly sim: GameSimulator;
  readonly player: EntityId;
  readonly elite: EntityId;
}

/**
 * A player at (0, 0) facing +x, and an ELITE at (1.5, 0) that starts telegraphing
 * on processed tick 0. `armor` is the elite's whole armour pool, so a test can pick
 * "the swing cannot break it" (40 vs 10) or "it breaks exactly" (6 vs 10).
 */
function makeEliteRig(options: { armor: number }): EliteRig {
  const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, {
    x: 0,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
  });
  const elite = EnemyFactory.spawnElite(sim.world, ...testElite({
    x: ELITE_X,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
    armor: options.armor,
    ai: {
      targetEntityId: player,
      sightRadius: 10,
      attackRadius: 4,
      windupTicks: 30,
      cooldownTicks: 60,
    },
  }));
  return { sim, player, elite };
}

/* ========================================================================== *
 * G0 · armor primitives                                                      *
 * ========================================================================== */
describe('G0 · armor is a second damage ledger in front of HP (AC-01 / AC-02)', () => {
  it('defaults to a standing pool and reports it through isArmored', () => {
    const armor = new ArmorComponent();
    expect(armor.current).toBe(DEFAULT_ARMOR);
    expect(armor.max).toBe(DEFAULT_ARMOR);

    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;
    expect(isArmored(sim.world, id)).toBe(false); // no component at all
    sim.world.addComponent(id, new ArmorComponent(0, 30));
    expect(isArmored(sim.world, id)).toBe(false); // broken armour is not "armored"
    armorOf(sim, id).current = 1;
    expect(isArmored(sim.world, id)).toBe(true);
  });

  it('routes damage through armor first and conserves it EXACTLY', () => {
    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;
    sim.world.addComponent(id, new HealthComponent(100, 100));
    sim.world.addComponent(id, new ArmorComponent(30, 30));

    // 12 < 30: fully absorbed, HP untouched.
    const first = applyDamageWithArmor(sim.world, id, 12);
    expect(first.absorbed).toBe(12);
    expect(first.spill).toBe(0);
    expect(first.armoredThrough).toBe(true);
    expect(first.absorbed + first.spill).toBe(12);
    expect(armorOf(sim, id).current).toBe(18);
    expect(armorOf(sim, id).max).toBe(30);
    expect(hpOf(sim, id)).toBe(100);

    // 25 > 18: the armour breaks and exactly 7 reaches HP.
    const second = applyDamageWithArmor(sim.world, id, 25);
    expect(second.absorbed).toBe(18);
    expect(second.spill).toBe(7);
    expect(second.armoredThrough).toBe(false); // the BREAKING hit is not armored-through
    expect(second.absorbed + second.spill).toBe(25);
    expect(armorOf(sim, id).current).toBe(0);
    expect(hpOf(sim, id)).toBe(93);
    expect(isArmored(sim.world, id)).toBe(false);
  });

  it('breaks on an EXACT armour hit, spilling nothing but still reporting a break', () => {
    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;
    sim.world.addComponent(id, new HealthComponent(100, 100));
    sim.world.addComponent(id, new ArmorComponent(10, 10));

    const result = applyDamageWithArmor(sim.world, id, 10);
    expect(result.absorbed).toBe(10);
    expect(result.spill).toBe(0);
    expect(result.absorbed + result.spill).toBe(10);
    // `current === 0` after the hit is what "broken" means, even with zero spill.
    expect(result.armoredThrough).toBe(false);
    expect(armorOf(sim, id).current).toBe(0);
    expect(hpOf(sim, id)).toBe(100);
  });

  it('passes damage straight through once the armour is already broken', () => {
    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;
    sim.world.addComponent(id, new HealthComponent(100, 100));
    sim.world.addComponent(id, new ArmorComponent(0, 30));

    const result = applyDamageWithArmor(sim.world, id, 7);
    expect(result.absorbed).toBe(0);
    expect(result.spill).toBe(7);
    expect(result.armoredThrough).toBe(false);
    expect(armorOf(sim, id).current).toBe(0);
    expect(hpOf(sim, id)).toBe(93);
  });

  it('is a plain HP hit for an entity with no ArmorComponent at all', () => {
    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;
    sim.world.addComponent(id, new HealthComponent(100, 100));

    const result = applyDamageWithArmor(sim.world, id, 13);
    expect(result.absorbed).toBe(0);
    expect(result.spill).toBe(13);
    expect(result.armoredThrough).toBe(false);
    expect(hpOf(sim, id)).toBe(87);
  });

  it('conserves FRACTIONAL damage too — no rounding may swallow a spill', () => {
    const sim = new GameSimulator();
    const id = sim.world.createEntity().id;
    sim.world.addComponent(id, new HealthComponent(100, 100));
    sim.world.addComponent(id, new ArmorComponent(2.5, 2.5));

    const result = applyDamageWithArmor(sim.world, id, 4.75);
    expect(result.absorbed).toBe(2.5);
    expect(result.spill).toBe(2.25);
    expect(result.absorbed + result.spill).toBe(4.75);
    expect(armorOf(sim, id).current).toBe(0);
    expect(hpOf(sim, id)).toBeCloseTo(100 - 2.25, 12);
  });
});

/* ========================================================================== *
 * G1 · super armor                                                           *
 * ========================================================================== */
describe('G1 · super armor absorbs a non-breaking hit and keeps the plan (AC-01)', () => {
  it('drains armour, holds HP, writes hitstop, and never staggers', () => {
    const rig = makeEliteRig({ armor: 40 });
    const sim = rig.sim;

    sim.step(1); // tick 0 — the elite notices the player and starts telegraphing
    expect(aiOf(sim, rig.elite).state).toBe(AIState.WINDUP);
    expect(aiOf(sim, rig.elite).ticksRemaining).toBe(30);

    sim.step(4); // ticks 1..4 — the telegraph counts down
    expect(aiOf(sim, rig.elite).ticksRemaining).toBe(26);
    expect(stateOf(sim, rig.elite).state).toBe(ActionState.IDLE);

    sim.inject({ kind: 'keyDown', tick: HIT_TICK, key: ATTACK_KEY });
    sim.step(1); // tick 5 — the swing lands

    // (a) the armour ate the WHOLE hit; not one HP was lost.
    const absorbed = 40 - armorOf(sim, rig.elite).current;
    expect(absorbed).toBe(DEFAULT_ATTACK_DAMAGE);
    expect(absorbed + (DEFAULT_ELITE_MAX_HP - hpOf(sim, rig.elite))).toBe(DEFAULT_ATTACK_DAMAGE);
    expect(armorOf(sim, rig.elite).current).toBe(30);
    expect(hpOf(sim, rig.elite)).toBe(DEFAULT_ELITE_MAX_HP);
    expect(isArmored(sim.world, rig.elite)).toBe(true);

    // (b) NO stagger: no HITSTUN, no knockback channel written at all.
    expect(stateOf(sim, rig.elite).state).toBe(ActionState.IDLE);
    expect(sim.world.getComponent(rig.elite, KnockbackComponent)).toBeUndefined();

    // (c) ... but the hitstop IS written, on both sides. Armor blocks the REACTION,
    // never the juice.
    expect(isFrozen(sim.world, rig.elite)).toBe(true);
    expect(isFrozen(sim.world, rig.player)).toBe(true);

    // (d) the telegraph is PAUSED, not discarded: the counter is frozen in place
    // while the hitstop runs (ticks 6..9).
    for (let i = 0; i < DEFAULT_HITSTOP_TICKS; i += 1) {
      sim.step(1);
      expect(aiOf(sim, rig.elite).state).toBe(AIState.WINDUP);
      expect(aiOf(sim, rig.elite).ticksRemaining).toBe(25);
      expect(stateOf(sim, rig.elite).state).toBe(ActionState.IDLE);
    }

    // (e) ... and it RESUMES from where it stopped on tick 10 — never reset to 0.
    sim.step(1); // tick 10
    expect(isFrozen(sim.world, rig.elite)).toBe(false);
    expect(aiOf(sim, rig.elite).state).toBe(AIState.WINDUP);
    expect(aiOf(sim, rig.elite).ticksRemaining).toBe(24);
  });

  it('is a bit-identical no-op for an enemy with no armour component', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(sim.world, ...testEnemy({
      x: ELITE_X,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    }));
    expect(sim.world.hasComponent(enemy, ArmorComponent)).toBe(false);

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // tick 0

    // The pre-M6 settlement, exactly: full damage to HP + a real stagger.
    expect(hpOf(sim, enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE);
    expect(stateOf(sim, enemy).state).toBe(ActionState.HITSTUN);
    expect(knockbackOf(sim, enemy).velocity.x).toBeCloseTo(DEFAULT_KNOCKBACK_FORCE, 9);
  });
});

/* ========================================================================== *
 * G2 · the breaking hit                                                      *
 * ========================================================================== */
describe('G2 · the breaking hit spills the exact remainder and staggers (AC-02)', () => {
  it('zeroes the armour, spills the remainder into HP, and discards the windup', () => {
    const rig = makeEliteRig({ armor: 6 });
    const sim = rig.sim;

    sim.step(1); // tick 0 — telegraph starts
    sim.step(4); // ticks 1..4
    expect(aiOf(sim, rig.elite).state).toBe(AIState.WINDUP);
    expect(aiOf(sim, rig.elite).ticksRemaining).toBe(26);

    const hpBefore = hpOf(sim, rig.elite);
    const armorBefore = armorOf(sim, rig.elite).current;
    expect(armorBefore).toBe(6);

    sim.inject({ kind: 'keyDown', tick: HIT_TICK, key: ATTACK_KEY });
    sim.step(1); // tick 5 — the BREAKING hit

    // STRICT arithmetic: nothing swallowed, nothing invented (spec 12 I1).
    const absorbed = armorBefore - armorOf(sim, rig.elite).current;
    const spill = hpBefore - hpOf(sim, rig.elite);
    expect(absorbed).toBe(6);
    expect(spill).toBe(4);
    expect(absorbed + spill).toBe(DEFAULT_ATTACK_DAMAGE);
    expect(armorOf(sim, rig.elite).current).toBe(0);
    expect(hpOf(sim, rig.elite)).toBe(hpBefore - 4);

    // The breaking hit is NOT armored-through, so it staggers normally.
    expect(stateOf(sim, rig.elite).state).toBe(ActionState.HITSTUN);
    expect(stateOf(sim, rig.elite).ticksInState).toBe(1);
    const knockback = knockbackOf(sim, rig.elite);
    expect(knockback.velocity.x).toBeCloseTo(DEFAULT_KNOCKBACK_FORCE, 9);
    expect(Math.abs(knockback.velocity.y)).toBeLessThan(TOLERANCE);

    // The windup is DISCARDED: hitstop pauses it for ticks 6..9, and the stun
    // interrupt only reaches AISystem on tick 10 (spec 07 §4.6).
    for (let i = 0; i < DEFAULT_HITSTOP_TICKS; i += 1) {
      sim.step(1);
      expect(stateOf(sim, rig.elite).state).toBe(ActionState.HITSTUN);
      expect(aiOf(sim, rig.elite).state).toBe(AIState.WINDUP); // paused, not yet cancelled
    }
    sim.step(1); // tick 10
    expect(aiOf(sim, rig.elite).state).toBe(AIState.IDLE);
    expect(aiOf(sim, rig.elite).ticksRemaining).toBe(0);
  });

  it('treats an already-broken armour exactly like no armour (spec 12 I4)', () => {
    const rig = makeEliteRig({ armor: 40 });
    const sim = rig.sim;

    sim.step(5); // ticks 0..4 — telegraph up
    armorOf(sim, rig.elite).current = 0; // rig: the shield is already down

    sim.inject({ kind: 'keyDown', tick: HIT_TICK, key: ATTACK_KEY });
    sim.step(1); // tick 5

    expect(armorOf(sim, rig.elite).current).toBe(0);
    expect(hpOf(sim, rig.elite)).toBe(DEFAULT_ELITE_MAX_HP - DEFAULT_ATTACK_DAMAGE);
    expect(stateOf(sim, rig.elite).state).toBe(ActionState.HITSTUN);
    expect(knockbackOf(sim, rig.elite).velocity.x).toBeCloseTo(DEFAULT_KNOCKBACK_FORCE, 9);
  });
});

/* ========================================================================== *
 * G3 · Poseidon Dash                                                         *
 * ========================================================================== */
describe('G3 · Poseidon Dash detonates a self-centred shockwave on dash entry (AC-03/04)', () => {
  /** A player with the boon, and a static script-driven enemy 2 units away. */
  function makeDashBoonRig(): {
    readonly sim: GameSimulator;
    readonly player: EntityId;
    readonly enemy: EntityId;
  } {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, {
      x: 0,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    const enemy = EnemyFactory.spawn(sim.world, ...testEnemy({
      x: 2,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    }));
    addModifier(sim.world, player, POSEIDON_DASH_MODIFIER);
    return { sim, player, enemy };
  }

  it('injects the blast on the dash tick — no attack key required', () => {
    const rig = makeDashBoonRig();
    const sim = rig.sim;
    expect(hasModifier(sim.world, rig.player, POSEIDON_DASH_MODIFIER)).toBe(true);

    sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    sim.step(1); // tick 0 — the dash starts; ModifierSystem detonates the blast

    expect(stateOf(sim, rig.player).state).toBe(ActionState.DASHING);

    const blasts = poseidonBlasts(sim);
    expect(blasts).toHaveLength(1);
    const blastId = at(blasts, 0);
    const blast = hitboxOf(sim, blastId);

    expect(blast.damage).toBe(DEFAULT_POSEIDON_DASH_DAMAGE); // low
    expect(blast.radius).toBe(DEFAULT_POSEIDON_DASH_RADIUS); // large
    expect(blast.knockbackForce).toBe(DEFAULT_POSEIDON_DASH_KNOCKBACK); // high
    expect(blast.hitstopTicks).toBe(DEFAULT_POSEIDON_DASH_HITSTOP_TICKS); // no self-freeze
    expect(blast.faction).toBe(Faction.Player);
    expect(blast.ownerEntityId).toBe(rig.player);
    expect(blast.sourceModifier).toBe(POSEIDON_DASH_MODIFIER); // anti-recursion provenance
    expect(blast.hitEntities).toEqual([]); // not resolved yet
    // LifespanSystem has already aged it once this tick: 2 -> 1.
    expect(blast.activeTicks).toBe(DEFAULT_POSEIDON_DASH_LIFESPAN_TICKS - 1);
    expect(DEFAULT_POSEIDON_DASH_LIFESPAN_TICKS).toBeGreaterThanOrEqual(2); // §4.4 phase rule

    // SELF-CENTRED: the blast sits ON the dasher, not in front of it.
    const blastTransform = transformOf(sim, blastId);
    expect(blastTransform.x).toBeCloseTo(0, 9);
    expect(blastTransform.y).toBeCloseTo(0, 9);

    // Nothing has been resolved yet: the enemy is untouched and un-pushed.
    expect(hpOf(sim, rig.enemy)).toBe(DEFAULT_MAX_HP);
    expect(sim.world.getComponent(rig.enemy, KnockbackComponent)).toBeUndefined();
    expect(sim.world.getComponent(rig.player, KnockbackComponent)).toBeUndefined();
  });

  it('connects on the NEXT tick: damage, knockback and a real displacement', () => {
    const rig = makeDashBoonRig();
    const sim = rig.sim;

    sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    sim.step(1); // tick 0 — blast injected
    const blastId = at(poseidonBlasts(sim), 0);

    sim.step(1); // tick 1 — the blast's single collision test

    expect(hpOf(sim, rig.enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_POSEIDON_DASH_DAMAGE);
    const knockback = knockbackOf(sim, rig.enemy);
    expect(knockback.velocity.x).toBeCloseTo(DEFAULT_POSEIDON_DASH_KNOCKBACK, 9);
    expect(Math.abs(knockback.velocity.y)).toBeLessThan(TOLERANCE);
    expect(stateOf(sim, rig.enemy).state).toBe(ActionState.HITSTUN);

    // Exactly ONE collision test: the blast is gone at the end of tick 1.
    expect(sim.world.isAlive(blastId)).toBe(false);
    expect(poseidonBlasts(sim)).toHaveLength(0);

    // The knockback really displaces: MovementSystem integrates it on tick 2.
    sim.step(1); // tick 2
    expect(transformOf(sim, rig.enemy).x).toBeCloseTo(
      2 + DEFAULT_POSEIDON_DASH_KNOCKBACK / FPS,
      9,
    );
  });

  it('never damages the dasher, and never fires without the boon', () => {
    const rig = makeDashBoonRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.step(2); // ticks 0..1
    expect(hpOf(rig.sim, rig.player)).toBe(DEFAULT_MAX_HP);

    // Control: the SAME script with no boon injects nothing at all.
    const plain = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    PlayerFactory.spawn(plain.world, { x: 0, y: 0, facingRadians: 0, maxSpeed: MAX_SPEED });
    const enemy = EnemyFactory.spawn(plain.world, ...testEnemy({
      x: 2,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    }));
    const before = plain.world.entityCount;
    plain.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    plain.step(5);
    expect(poseidonBlasts(plain)).toHaveLength(0);
    expect(plain.world.entityCount).toBe(before);
    expect(hpOf(plain, enemy)).toBe(DEFAULT_MAX_HP);
  });

  it('does not fire from an ATTACK: the hook is dash-entry, not hit-driven', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems() });
    const player = PlayerFactory.spawn(sim.world, {
      x: 0,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    });
    const enemy = EnemyFactory.spawn(sim.world, ...testEnemy({
      x: ELITE_X,
      y: 0,
      facingRadians: 0,
      maxSpeed: MAX_SPEED,
    }));
    addModifier(sim.world, player, POSEIDON_DASH_MODIFIER);

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(5); // ticks 0..4 — the base swing lands, onHit is a no-op

    expect(poseidonBlasts(sim)).toHaveLength(0);
    expect(hpOf(sim, enemy)).toBe(DEFAULT_MAX_HP - DEFAULT_ATTACK_DAMAGE); // the plain swing
  });
});

/* ========================================================================== *
 * G4 · the DashEvent bus contract                                            *
 * ========================================================================== */
/** Records every DashEvent it sees, draining the bus exactly like a consumer would. */
class DashSpy implements System {
  public readonly name = 'DashSpy';
  public readonly dashes: DashEvent[] = [];

  private readonly bus: EventQueue<DashEvent>;

  constructor(bus: EventQueue<DashEvent>) {
    this.bus = bus;
  }

  public update(): void {
    for (const event of this.bus.drain()) this.dashes.push(event);
  }
}

/**
 * The canonical pipeline with a probe spliced in IMMEDIATELY AFTER DashSystem, so
 * the emitted `DashEvent` can be inspected before ModifierSystem would consume it.
 * The splice point is pinned BY NAME (mirrors the AISystem probe in
 * `tests/ai/enemy_fsm.test.ts`): if the pipeline ever moves DashSystem, fail loudly
 * here rather than silently probing the wrong segment.
 *
 * Because the probe drains the bus first, ModifierSystem sees nothing — which is
 * exactly what a bus-contract suite wants (no blast is injected as a side effect).
 */
function makeDashSpyRig(): {
  readonly sim: GameSimulator;
  readonly player: EntityId;
  readonly spy: DashSpy;
  readonly bus: EventQueue<DashEvent>;
} {
  const bus = new EventQueue<DashEvent>();
  const base = createDefaultSystems(new EventQueue(), new EventQueue<EntityDeathEvent>(), bus);
  const dashIndex = base.findIndex((system) => system.name === 'DashSystem');
  if (dashIndex === -1) throw new Error('QA: the canonical pipeline has no DashSystem');
  const spy = new DashSpy(bus);
  const sim = new GameSimulator({
    fps: FPS,
    systems: [...base.slice(0, dashIndex + 1), spy, ...base.slice(dashIndex + 1)],
  });
  const player = PlayerFactory.spawn(sim.world, {
    x: 0,
    y: 0,
    facingRadians: 0,
    maxSpeed: MAX_SPEED,
  });
  return { sim, player, spy, bus };
}

describe('G4 · DashSystem publishes one DashEvent per dash entry (AC-03)', () => {
  it('carries the tick, the entity, the entry position and the locked direction', () => {
    const rig = makeDashSpyRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    rig.sim.step(1); // tick 0

    expect(rig.spy.dashes).toHaveLength(1);
    const event = at(rig.spy.dashes, 0);
    expect(event.tick).toBe(0);
    expect(event.entityId).toBe(rig.player);
    expect(event.position.x).toBeCloseTo(0, 9);
    expect(event.position.y).toBeCloseTo(0, 9);
    expect(event.direction.x).toBeCloseTo(1, 9);
    expect(event.direction.y).toBeCloseTo(0, 9);

    // The producer is a full-drain wire: nothing is left dangling.
    expect(rig.bus.size).toBe(0);
  });

  it('reports the LOCKED dash direction, not a stale facing', () => {
    const rig = makeDashSpyRig();
    // Steer +y for 10 ticks so the facing becomes +pi/2, then dash.
    rig.sim.inject({ kind: 'move', tick: 0, vector: vec2(0, 1) });
    rig.sim.step(10); // ticks 0..9
    expect(transformOf(rig.sim, rig.player).facingRadians).toBeCloseTo(Math.PI / 2, 9);

    rig.sim.inject({ kind: 'keyDown', tick: 10, key: DASH_KEY });
    rig.sim.step(1); // tick 10

    const event = at(rig.spy.dashes, 0);
    expect(event.direction.x).toBeCloseTo(0, 9);
    expect(event.direction.y).toBeCloseTo(1, 9);
    // MovementSystem ran BEFORE DashSystem this tick, so the position is the
    // post-movement origin: 11 walk ticks of 5/60.
    expect(event.position.y).toBeCloseTo((11 * MAX_SPEED) / FPS, 9);
  });

  it('fires exactly once per entry: a held key never repeats, and a refused pulse is silent', () => {
    const rig = makeDashSpyRig();

    rig.sim.step(10); // ticks 0..9 with no input at all
    expect(rig.spy.dashes).toHaveLength(0);

    // Dash #1.
    rig.sim.inject({ kind: 'keyDown', tick: 10, key: DASH_KEY });
    rig.sim.step(1); // tick 10
    expect(rig.spy.dashes).toHaveLength(1);

    // Release, then a FRESH press MID-DASH: the pulse is consumed and DROPPED, never
    // buffered — `DASHING` cannot be re-entered, so the event must not fire.
    rig.sim.inject({ kind: 'keyUp', tick: 11, key: DASH_KEY });
    rig.sim.step(1); // tick 11
    rig.sim.inject({ kind: 'keyDown', tick: 12, key: DASH_KEY });
    rig.sim.step(1); // tick 12
    expect(stateOf(rig.sim, rig.player).state).toBe(ActionState.DASHING);
    expect(rig.spy.dashes).toHaveLength(1);

    // Hold it for two more seconds: the dash ends and the cooldown lapses, but the
    // trigger is a RISING EDGE, not a held level (spec 03 §4.3) — still exactly one.
    rig.sim.step(120); // ticks 13..132
    expect(stateOf(rig.sim, rig.player).state).not.toBe(ActionState.DASHING);
    expect(rig.spy.dashes).toHaveLength(1);
    expect(rig.bus.size).toBe(0);
  });

  it('keeps the bus EMPTY at every tick boundary (it is a wire, not state)', () => {
    const rig = makeDashSpyRig();
    rig.sim.inject({ kind: 'keyDown', tick: 0, key: DASH_KEY });
    for (let i = 0; i < 40; i += 1) {
      rig.sim.step(1);
      expect(rig.bus.size).toBe(0);
    }
  });
});

/* ========================================================================== *
 * G5 · pipeline + zero regression + elite assembly                           *
 * ========================================================================== */
describe('G5 · pipeline unchanged, zero regression, elite assembly (AC-05 / AC-06)', () => {
  it('keeps the canonical 17-segment order, with ModifierSystem after DashSystem', () => {
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

    // M6-T02 changes no ORDER; it only relies on two pre-existing slots.
    expect(names.filter((name) => name === 'ModifierSystem')).toHaveLength(1);
    // DashSystem must produce the DashEvent before ModifierSystem consumes it.
    expect(names.indexOf('ModifierSystem')).toBeGreaterThan(names.indexOf('DashSystem'));
    // ... and ModifierSystem must stay after CollisionSystem, which is what gives an
    // injected blast its collision test on the FOLLOWING tick (spec 12 §4.4).
    expect(names.indexOf('ModifierSystem')).toBeGreaterThan(names.indexOf('CollisionSystem'));
    expect(names.indexOf('LifespanSystem')).toBe(names.length - 1);
  });

  it('assembles an elite with standing armour, a bigger body and a bigger pool', () => {
    const sim = new GameSimulator();
    const elite = EnemyFactory.spawnElite(sim.world, ...testElite({ x: 0, y: 0 }));

    const armor = armorOf(sim, elite);
    expect(armor.current).toBe(DEFAULT_ELITE_ARMOR);
    expect(armor.max).toBe(DEFAULT_ELITE_ARMOR);
    expect(hpOf(sim, elite)).toBe(DEFAULT_ELITE_MAX_HP);
    expect(hurtboxOf(sim, elite).radius).toBe(DEFAULT_ELITE_HURTBOX_RADIUS);
    expect(isArmored(sim.world, elite)).toBe(true);

    // Every elite default is overridable, and a plain enemy stays un-armoured.
    const light = EnemyFactory.spawnElite(sim.world, ...testElite({
      x: 0,
      y: 0,
      armor: 12,
      maxHp: 40,
      hurtboxRadius: 0.5,
    }));
    expect(armorOf(sim, light).current).toBe(12);
    expect(hpOf(sim, light)).toBe(40);
    expect(hurtboxOf(sim, light).radius).toBe(0.5);

    expect(sim.world.hasComponent(EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0, y: 0 })), ArmorComponent)).toBe(
      false,
    );
  });

  it('rejects a non-positive armour instead of shipping a silent plain enemy', () => {
    // M10-T01: the rejection MOVED, and this is the stronger form of it. Before
    // M10 a bad armour value was caught at the assembly seam (RangeError) — after
    // the entity had been half-built. It is now caught by the schema when the
    // config is registered, i.e. before any entity exists at all, so the same
    // mistake can no longer reach a running simulation.
    const sim = new GameSimulator();
    expect(() => testElite({ armor: 0 })).toThrow(SchemaError);
    expect(() => testElite({ armor: -1 })).toThrow(SchemaError);
    expect(() => testElite({ armor: Number.NaN })).toThrow(SchemaError);
    expect(() => testElite({ armor: Number.POSITIVE_INFINITY })).toThrow(SchemaError);

    // Nothing was assembled at all — there is not even a half-built entity to leak.
    expect(sim.world.entityCount).toBe(0);
  });
});
