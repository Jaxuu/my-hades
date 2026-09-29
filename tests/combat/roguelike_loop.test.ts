/**
 * M6-T01 · Deterministic PRNG + boon draft (roguelike loop) acceptance tests.
 * See specs/11_roguelike_loop_spec.md §4 (semantics), §6 (tick-by-tick contract)
 * and §7 (AC-01 .. AC-06), plus docs/architecture/ADR-004-deterministic-prng.md.
 *
 * Fresh-eyes harness suite: every assertion drives the REAL GameSimulator with the
 * canonical 15-segment pipeline (TransformSnapshotSystem -> PlayerControllerSystem
 * -> FreezeSystem -> AISystem -> MovementSystem -> DashSystem -> StateSystem ->
 * CombatActionSystem -> CollisionSystem -> StatusEffectSystem -> ModifierSystem ->
 * DeathSystem -> EncounterSystem -> RewardSystem -> LifespanSystem) and REAL
 * prefab-assembled entities. Nothing is mocked, and ticks are advanced one at a time
 * so the timing contract is pinned per tick.
 *
 * TICK NUMBERING (`sim.step(n)` processes ticks `0 .. n-1`, leaving `sim.tick === n`):
 *   - a fresh sim needs `step(1)` to have processed tick 0;
 *   - `EncounterFactory.spawn` does NOT spawn the opening wave, so that first
 *     `step(1)` is what puts wave 0 on the field;
 *   - killing the last wave member is detected on the SAME tick the death resolves
 *     (DeathSystem runs before EncounterSystem), so the draft appears immediately.
 *
 * Grouping:
 *   G0 · PRNG primitives (seed purity / ranges / pick / sample)                      (ADR-004)
 *   G1 · the draft draw: distinct, deterministic, pool-shaped                        (AC-01)
 *   G2 · clearing a room rolls a 3-option draft onto the component                   (AC-01)
 *   G3 · the world keeps ticking, but the player is held while a draft is open        (AC-02)
 *   G4 · a legal selection settles the draft, grants the reward and descends          (AC-03/AC-04)
 *   G5 · grantReward: every reward kind, idempotence, refusals                        (AC-04)
 *   G6 · only an offered option can be taken (forged / stale / duplicated)            (AC-03)
 *   G7 · each descent makes the next wave bigger                                     (AC-04)
 *   G8 · the whole loop replays bit-for-bit from a seed                              (ADR-004)
 *   G9 · RewardSystem's pipeline slot                                                 (AC-05)
 */

import { describe, expect, it } from 'vitest';
import {
  ATTACK_KEY,
  DASH_KEY,
  DASH_UP_COOLDOWN_REDUCTION,
  DEFAULT_RANDOM_SEED,
  DEFAULT_REWARD_DRAFT_COUNT,
  DEPTH_SPAWN_SPACING_UNITS,
  DashStatsComponent,
  ENCOUNTER_WAVE_UNSCHEDULED,
  EncounterFactory,
  EncounterState,
  EncounterStateComponent,
  GameSimulator,
  HP_UP_AMOUNT,
  HealthComponent,
  HitboxComponent,
  IntentComponent,
  MIN_DASH_COOLDOWN_TICKS,
  ModifierComponent,
  PlayerFactory,
  REWARD_DASH_UP,
  REWARD_HP_UP,
  REWARD_POOL,
  Random,
  TransformComponent,
  applyDamage,
  buildWaveRoster,
  createDefaultSystems,
  draftRewards,
  findRewardDraft,
  getRewardDefinition,
  grantReward,
  hasModifier,
  isRewardId,
  vec2,
} from '../../src';
import type { EntityId, Snapshot } from '../../src';

const FPS = 60;
const SEED = 0x12345678;

/** Positional accessor with a loud guard (the repo runs `noUncheckedIndexedAccess`). */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`QA: no sample at index ${String(index)}`);
  }
  return value;
}

/* --- accessors ------------------------------------------------------------ */

function encounterOf(sim: GameSimulator, room: EntityId): EncounterStateComponent {
  const encounter = sim.world.getComponent(room, EncounterStateComponent);
  if (encounter === undefined) throw new Error('QA: room is missing EncounterStateComponent');
  return encounter;
}

function intentOf(sim: GameSimulator, id: EntityId): IntentComponent {
  const intent = sim.world.getComponent(id, IntentComponent);
  if (intent === undefined) throw new Error('QA: entity is missing IntentComponent');
  return intent;
}

function transformOf(sim: GameSimulator, id: EntityId): { x: number; y: number } {
  const transform = sim.world.getComponent(id, TransformComponent);
  if (transform === undefined) throw new Error('QA: entity is missing TransformComponent');
  return { x: transform.x, y: transform.y };
}

/** The player's complete reward-relevant state, for before/after comparison. */
interface PlayerStats {
  readonly maxHp: number;
  readonly hp: number;
  readonly cooldownTicks: number;
  readonly modifiers: readonly string[];
}

function playerStats(sim: GameSimulator, id: EntityId): PlayerStats {
  const health = sim.world.getComponent(id, HealthComponent);
  const dash = sim.world.getComponent(id, DashStatsComponent);
  const modifiers = sim.world.getComponent(id, ModifierComponent);
  if (health === undefined || dash === undefined || modifiers === undefined) {
    throw new Error('QA: player is missing Health / DashStats / Modifier');
  }
  return {
    maxHp: health.maxHp,
    hp: health.hp,
    cooldownTicks: dash.cooldownTicks,
    modifiers: [...modifiers.modifiers],
  };
}

/**
 * The state a player should be in after taking `rewardId`, derived INDEPENDENTLY of
 * `grantReward` (from the spec's stated effect), so a before/after `toEqual` proves
 * the chosen reward applied and the two un-chosen ones did not.
 */
function expectedAfterTaking(before: PlayerStats, rewardId: string): PlayerStats {
  const next = {
    maxHp: before.maxHp,
    hp: before.hp,
    cooldownTicks: before.cooldownTicks,
    modifiers: [...before.modifiers],
  };
  if (rewardId === REWARD_HP_UP) {
    next.maxHp += HP_UP_AMOUNT;
    next.hp = Math.min(next.maxHp, next.hp + HP_UP_AMOUNT);
  } else if (rewardId === REWARD_DASH_UP) {
    next.cooldownTicks = Math.max(MIN_DASH_COOLDOWN_TICKS, next.cooldownTicks - DASH_UP_COOLDOWN_REDUCTION);
  } else {
    next.modifiers.push(rewardId);
    next.modifiers.sort();
  }
  return next;
}

/* --- drivers -------------------------------------------------------------- */

function makeSim(seed: number = SEED): GameSimulator {
  return new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed });
}

/**
 * A one-wave room holding a single static enemy (no `ai`, so it never moves or
 * attacks — the room is a pure reward harness). Plus a player, so a reward has a
 * recipient and the hold gate has a subject.
 */
function makeRewardRoom(
  sim: GameSimulator,
  enemyHp = 10,
): { readonly player: EntityId; readonly room: EntityId } {
  const player = PlayerFactory.spawn(sim.world, { x: -10, y: 0, maxSpeed: 5 });
  const room = EncounterFactory.spawn(sim.world, {
    waves: [{ delayTicks: 0, enemies: [{ x: 6, y: 0, maxHp: enemyHp, hp: enemyHp }] }],
  });
  return { player, room };
}

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

/* ========================================================================== *
 * G0 · PRNG primitives                                                       *
 * ========================================================================== */
describe('G0 · the seeded PRNG is a pure function of its seed (ADR-004)', () => {
  it('identical seeds produce identical raw streams', () => {
    const a = new Random(SEED);
    const b = new Random(SEED);
    const seqA = Array.from({ length: 64 }, () => a.nextUint32());
    const seqB = Array.from({ length: 64 }, () => b.nextUint32());
    expect(seqB).toEqual(seqA);
    for (const value of seqA) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(4294967296);
    }
  });

  it('the default seed is a fixed constant, so an unseeded world is reproducible', () => {
    expect(new Random().nextUint32()).toBe(new Random(DEFAULT_RANDOM_SEED).nextUint32());
  });

  it('different seeds diverge', () => {
    const a = Array.from({ length: 32 }, (_, i) => new Random(1).nextUint32() + i * 0);
    const b = Array.from({ length: 32 }, (_, i) => new Random(2).nextUint32() + i * 0);
    expect(a).not.toEqual(b);
  });

  it('nextFloat is in [0, 1) — closed left, OPEN right', () => {
    const rng = new Random(SEED);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('nextInt is inclusive on BOTH ends, integral, and reaches the extremes', () => {
    const rng = new Random(SEED);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.nextInt(2, 5);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThanOrEqual(5);
      seen.add(value);
    }
    // Both ends are reachable — the classic "never the last option" off-by-one guard.
    expect([...seen].sort((left, right) => left - right)).toEqual([2, 3, 4, 5]);
    // A degenerate range is legal and constant.
    expect(rng.nextInt(7, 7)).toBe(7);
    expect(() => rng.nextInt(5, 2)).toThrow(RangeError);
    expect(() => rng.nextInt(0.5, 3)).toThrow(RangeError);
  });

  it('pick draws a member; sample draws DISTINCT members; bad pools fail loudly', () => {
    const rng = new Random(SEED);
    const items = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 200; i += 1) {
      expect(items).toContain(rng.pick(items));
    }

    const drawn = rng.sample(items, 3);
    expect(drawn).toHaveLength(3);
    expect(new Set(drawn).size).toBe(3); // no replacement
    for (const item of drawn) expect(items).toContain(item);

    // The caller's array is never mutated (the shuffle happens on a copy).
    expect(items).toEqual(['a', 'b', 'c', 'd']);
    // An unsatisfiable draw must fail at the seam, not return a short list.
    expect(() => rng.sample(items, 5)).toThrow(RangeError);
    expect(() => rng.sample(items, -1)).toThrow(RangeError);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('the generator is NOT Math.random: two instances never share state', () => {
    const a = new Random(SEED);
    const b = new Random(SEED);
    a.nextUint32();
    a.nextUint32();
    // `a` is two draws ahead; `b` must be untouched by that.
    expect(b.nextUint32()).toBe(new Random(SEED).nextUint32());
  });
});

/* ========================================================================== *
 * G1 · the draft draw                                                        *
 * ========================================================================== */
describe('G1 · the draft is a deterministic, distinct draw from the pool (AC-01)', () => {
  it('the shipped pool can satisfy a default draft, with unique ids and labels', () => {
    expect(REWARD_POOL.length).toBeGreaterThanOrEqual(DEFAULT_REWARD_DRAFT_COUNT);
    const ids = REWARD_POOL.map((reward) => reward.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const reward of REWARD_POOL) {
      expect(reward.label.length).toBeGreaterThan(0);
      expect(getRewardDefinition(reward.id)).toEqual(reward);
      expect(isRewardId(reward.id)).toBe(true);
    }
    expect(getRewardDefinition('not_a_reward')).toBeUndefined();
    expect(isRewardId('not_a_reward')).toBe(false);
  });

  it('same seed => the same three options in the same order', () => {
    const first = draftRewards(new Random(SEED));
    const second = draftRewards(new Random(SEED));
    expect(second).toEqual(first);
    expect(first).toHaveLength(DEFAULT_REWARD_DRAFT_COUNT);
    expect(new Set(first).size).toBe(DEFAULT_REWARD_DRAFT_COUNT);
    for (const id of first) expect(isRewardId(id)).toBe(true);
  });

  it('the draw really consumes the stream: different seeds yield different drafts', () => {
    const drafts = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => draftRewards(new Random(seed)).join('|'));
    expect(new Set(drafts).size).toBeGreaterThan(1);
  });

  it('a custom pool is honoured, and an unsatisfiable count throws', () => {
    const pool = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ];
    const drawn = draftRewards(new Random(SEED), 3, pool);
    expect([...drawn].sort()).toEqual(['a', 'b', 'c']);
    expect(() => draftRewards(new Random(SEED), 4, pool)).toThrow(RangeError);
  });
});

/* ========================================================================== *
 * G2 · the room rolls a draft on clear                                       *
 * ========================================================================== */
describe('G2 · clearing a room rolls a 3-option draft onto the component (AC-01)', () => {
  it('the draft appears exactly on the ROOM_CLEARED tick, and is seed-stable', () => {
    const run = (seed: number): string[] => {
      const sim = makeSim(seed);
      const { room } = makeRewardRoom(sim);

      sim.step(1); // tick 0 — the opening wave spawns
      const encounter = encounterOf(sim, room);
      expect(encounter.state).toBe(EncounterState.IN_PROGRESS);
      // Nothing to choose while the room is still being fought.
      expect(encounter.pendingRewards).toBeNull();
      expect(findRewardDraft(sim.world)).toBeUndefined();

      clearCurrentWave(sim, room); // tick 1 — death + ROOM_CLEARED + draft

      expect(encounterOf(sim, room).state).toBe(EncounterState.ROOM_CLEARED);
      const pending = encounterOf(sim, room).pendingRewards;
      expect(pending).not.toBeNull();
      expect(findRewardDraft(sim.world)).toBeDefined();
      return pending ?? [];
    };

    const first = run(SEED);
    const second = run(SEED);

    expect(first).toHaveLength(DEFAULT_REWARD_DRAFT_COUNT);
    expect(new Set(first).size).toBe(DEFAULT_REWARD_DRAFT_COUNT); // three REAL options
    for (const id of first) expect(isRewardId(id)).toBe(true);
    // THE core determinism assertion: same seed, same three options, same order.
    expect(second).toEqual(first);
  });

  it('a room that is never cleared never rolls a draft', () => {
    const sim = makeSim();
    const { room } = makeRewardRoom(sim, 1000);
    sim.step(30);
    expect(encounterOf(sim, room).state).toBe(EncounterState.IN_PROGRESS);
    expect(encounterOf(sim, room).pendingRewards).toBeNull();
  });
});

/* ========================================================================== *
 * G3 · the world ticks on, the player is held                                *
 * ========================================================================== */
describe('G3 · the world keeps ticking but the player is held (AC-02)', () => {
  it('time flows, the scheduler is inert, and no player action gets through', () => {
    const sim = makeSim();
    const { player, room } = makeRewardRoom(sim);
    sim.step(1); // tick 0
    clearCurrentWave(sim, room); // tick 1 — draft opens

    const entitiesAtDraft = sim.world.entityCount;
    const restingTransform = transformOf(sim, player);

    for (let tick = 2; tick <= 6; tick += 1) {
      // Hold the stick and mash dash + attack every single tick.
      sim.inject({ kind: 'move', tick, vector: vec2(1, 0) });
      sim.inject({ kind: 'keyDown', tick, key: DASH_KEY });
      sim.inject({ kind: 'keyDown', tick, key: ATTACK_KEY });
      sim.step(1);

      // (a) TIME KEEPS FLOWING — this is a hold, not a pause.
      expect(sim.tick).toBe(tick + 1);
      // (b) the player is HELD: intent zeroed, so nothing displaces it...
      expect(intentOf(sim, player).moveVector).toEqual(vec2(0, 0));
      expect(intentOf(sim, player).wantsToAttack).toBe(false);
      expect(intentOf(sim, player).wantsToDash).toBe(false);
      expect(transformOf(sim, player)).toEqual(restingTransform);
      // ...and no swing was raised (a suppressed pulse is DROPPED, never buffered).
      expect(sim.world.query(HitboxComponent)).toEqual([]);
      // (c) the scheduler is held: still ROOM_CLEARED, draft intact, nothing spawned.
      expect(encounterOf(sim, room).state).toBe(EncounterState.ROOM_CLEARED);
      expect(encounterOf(sim, room).pendingRewards).not.toBeNull();
      expect(sim.world.entityCount).toBe(entitiesAtDraft);
    }
  });

  it('the hold is released the moment the draft closes', () => {
    const sim = makeSim();
    const { player, room } = makeRewardRoom(sim);
    sim.step(1); // tick 0
    clearCurrentWave(sim, room); // tick 1 — draft opens

    sim.inject({ kind: 'move', tick: 2, vector: vec2(1, 0) });
    sim.step(1); // tick 2 — still held
    const heldX = transformOf(sim, player).x;

    selectFirstOption(sim, room); // tick 3 — draft settled, hold lifted

    sim.inject({ kind: 'move', tick: 4, vector: vec2(1, 0) });
    sim.step(1); // tick 4 — free again
    expect(transformOf(sim, player).x).toBeGreaterThan(heldX);
  });
});

/* ========================================================================== *
 * G4 · a legal selection settles the draft                                   *
 * ========================================================================== */
describe('G4 · a legal selection grants the reward and descends the room (AC-03/AC-04)', () => {
  it('applies ONLY the chosen option, clears the draft and resets the room', () => {
    const sim = makeSim();
    const { player, room } = makeRewardRoom(sim);
    sim.step(1); // tick 0
    clearCurrentWave(sim, room); // tick 1 — draft

    const pending = encounterOf(sim, room).pendingRewards ?? [];
    const chosen = at(pending, 0);
    const before = playerStats(sim, player);

    sim.inject({ kind: 'selectReward', tick: 2, rewardId: chosen });
    sim.step(1); // tick 2 — RewardSystem settles

    // (a) the reward landed on the player, and ONLY that one did.
    expect(playerStats(sim, player)).toEqual(expectedAfterTaking(before, chosen));

    // (b) the draft is consumed and the room is reset for the next descent.
    const encounter = encounterOf(sim, room);
    expect(encounter.pendingRewards).toBeNull();
    expect(findRewardDraft(sim.world)).toBeUndefined();
    expect(encounter.state).toBe(EncounterState.IN_PROGRESS);
    expect(encounter.depth).toBe(1);
    expect(encounter.currentWaveIndex).toBe(0);
    expect(encounter.trackedEntityIds).toEqual([]);
    expect(encounter.nextSpawnTick).toBe(ENCOUNTER_WAVE_UNSCHEDULED);

    // (c) the deeper wave spawns on the FOLLOWING tick (the documented 1-tick phase).
    sim.step(1); // tick 3
    expect(encounterOf(sim, room).state).toBe(EncounterState.IN_PROGRESS);
    expect(encounterOf(sim, room).trackedEntityIds).toHaveLength(2); // 1 base + depth 1
    for (const id of encounterOf(sim, room).trackedEntityIds) {
      expect(sim.world.isAlive(id)).toBe(true);
    }
  });

  it('a modifier reward is held on the player and is reachable through hasModifier', () => {
    const sim = makeSim();
    const { player, room } = makeRewardRoom(sim);
    sim.step(1);
    clearCurrentWave(sim, room);

    const pending = encounterOf(sim, room).pendingRewards ?? [];
    const modifierOption = pending.find(
      (id) => getRewardDefinition(id) !== undefined && id !== REWARD_HP_UP && id !== REWARD_DASH_UP,
    );
    // The pool ships at least one boon, and a 3-of-4 draft of a 4-entry pool always
    // contains two of them — so this branch is always exercised.
    if (modifierOption === undefined) throw new Error('QA: the draft contained no boon');

    sim.inject({ kind: 'selectReward', tick: 2, rewardId: modifierOption });
    sim.step(1);
    expect(hasModifier(sim.world, player, modifierOption)).toBe(true);
  });
});

/* ========================================================================== *
 * G5 · grantReward                                                           *
 * ========================================================================== */
describe('G5 · grantReward applies each reward kind exactly once (AC-04)', () => {
  it('hp_up raises the ceiling and tops the pool up by the same amount', () => {
    const sim = makeSim();
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxHp: 100, hp: 50 });
    expect(grantReward(sim.world, player, REWARD_HP_UP)).toBe(true);
    const stats = playerStats(sim, player);
    expect(stats.maxHp).toBe(100 + HP_UP_AMOUNT);
    expect(stats.hp).toBe(50 + HP_UP_AMOUNT);
  });

  it('hp_up never heals past the new ceiling', () => {
    const sim = makeSim();
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0, maxHp: 100, hp: 100 });
    grantReward(sim.world, player, REWARD_HP_UP);
    const stats = playerStats(sim, player);
    expect(stats.hp).toBe(stats.maxHp);
    expect(stats.maxHp).toBe(100 + HP_UP_AMOUNT);
  });

  it('dash_up shaves the cooldown and is floored, so it can never reach zero', () => {
    const sim = makeSim();
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const start = playerStats(sim, player).cooldownTicks;
    grantReward(sim.world, player, REWARD_DASH_UP);
    expect(playerStats(sim, player).cooldownTicks).toBe(start - DASH_UP_COOLDOWN_REDUCTION);

    // Drain it far past the floor.
    for (let i = 0; i < 20; i += 1) grantReward(sim.world, player, REWARD_DASH_UP);
    expect(playerStats(sim, player).cooldownTicks).toBe(MIN_DASH_COOLDOWN_TICKS);
  });

  it('a modifier reward mounts the id and is idempotent', () => {
    const sim = makeSim();
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const boon = at(REWARD_POOL, 0).id;
    expect(grantReward(sim.world, player, boon)).toBe(true);
    expect(hasModifier(sim.world, player, boon)).toBe(true);
    grantReward(sim.world, player, boon);
    expect(playerStats(sim, player).modifiers).toEqual([boon]); // no stacking
  });

  it('refuses an unknown id and a stale entity without touching anything', () => {
    const sim = makeSim();
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const before = playerStats(sim, player);
    expect(grantReward(sim.world, player, 'not_a_reward')).toBe(false);
    expect(playerStats(sim, player)).toEqual(before);

    sim.world.destroyEntity(player);
    expect(grantReward(sim.world, player, REWARD_HP_UP)).toBe(false);
  });
});

/* ========================================================================== *
 * G6 · only an offered option can be taken                                   *
 * ========================================================================== */
describe('G6 · only an option the room offered can be taken (AC-03)', () => {
  it('a forged id is ignored and the room keeps waiting', () => {
    const sim = makeSim();
    const { player, room } = makeRewardRoom(sim);
    sim.step(1);
    clearCurrentWave(sim, room);

    const before = playerStats(sim, player);
    sim.inject({ kind: 'selectReward', tick: 2, rewardId: 'not_a_reward' });
    sim.step(1);

    expect(encounterOf(sim, room).pendingRewards).not.toBeNull();
    expect(encounterOf(sim, room).state).toBe(EncounterState.ROOM_CLEARED);
    expect(encounterOf(sim, room).depth).toBe(0);
    expect(playerStats(sim, player)).toEqual(before);
  });

  it('a REAL reward id that simply was not on offer is also ignored', () => {
    const sim = makeSim();
    const { player, room } = makeRewardRoom(sim);
    sim.step(1);
    clearCurrentWave(sim, room);

    const pending = encounterOf(sim, room).pendingRewards ?? [];
    const notOffered = REWARD_POOL.map((reward) => reward.id).find((id) => !pending.includes(id));
    if (notOffered === undefined) throw new Error('QA: the draft offered the whole pool');

    const before = playerStats(sim, player);
    sim.inject({ kind: 'selectReward', tick: 2, rewardId: notOffered });
    sim.step(1);

    expect(encounterOf(sim, room).pendingRewards).not.toBeNull();
    expect(playerStats(sim, player)).toEqual(before);
  });

  it('a selection with no draft open is a strict no-op', () => {
    const sim = makeSim();
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const before = playerStats(sim, player);
    sim.inject({ kind: 'selectReward', tick: 0, rewardId: at(REWARD_POOL, 0).id });
    sim.step(1);
    expect(playerStats(sim, player)).toEqual(before);
  });

  it('two selections in one tick settle the draft exactly once', () => {
    const sim = makeSim();
    const { room } = makeRewardRoom(sim);
    sim.step(1);
    clearCurrentWave(sim, room);

    const chosen = at(encounterOf(sim, room).pendingRewards ?? [], 0);
    sim.inject({ kind: 'selectReward', tick: 2, rewardId: chosen });
    sim.inject({ kind: 'selectReward', tick: 2, rewardId: chosen });
    sim.step(1);

    expect(encounterOf(sim, room).depth).toBe(1);
    expect(encounterOf(sim, room).pendingRewards).toBeNull();
  });
});

/* ========================================================================== *
 * G7 · escalation                                                            *
 * ========================================================================== */
describe('G7 · each descent makes the next wave bigger (AC-04)', () => {
  it('buildWaveRoster is pure, additive and offset', () => {
    const base = [{ x: 6, y: 0 }];
    expect(buildWaveRoster(base, 0)).toEqual(base);
    expect(buildWaveRoster(base, -3)).toEqual(base);

    const one = buildWaveRoster(base, 1);
    expect(one).toHaveLength(2);
    expect(at(one, 0)).toEqual({ x: 6, y: 0 }); // the base entry is untouched
    expect(at(one, 1)).toEqual({ x: 6 + DEPTH_SPAWN_SPACING_UNITS, y: 0 });

    const three = buildWaveRoster(
      [
        { x: 6, y: 0 },
        { x: 7, y: 1 },
      ],
      3,
    );
    expect(three).toHaveLength(5); // 2 base + 3 depth
    // The caller's array is never mutated.
    expect(base).toEqual([{ x: 6, y: 0 }]);
  });

  it('two descents grow the wave 1 -> 2 -> 3', () => {
    const sim = makeSim();
    const { room } = makeRewardRoom(sim);

    sim.step(1); // tick 0
    expect(encounterOf(sim, room).trackedEntityIds).toHaveLength(1);
    expect(encounterOf(sim, room).depth).toBe(0);

    clearCurrentWave(sim, room); // tick 1 — draft
    selectFirstOption(sim, room); // tick 2 — descend to depth 1
    expect(encounterOf(sim, room).depth).toBe(1);
    sim.step(1); // tick 3 — wave spawns
    expect(encounterOf(sim, room).trackedEntityIds).toHaveLength(2);

    clearCurrentWave(sim, room); // tick 4 — draft
    selectFirstOption(sim, room); // tick 5 — descend to depth 2
    expect(encounterOf(sim, room).depth).toBe(2);
    sim.step(1); // tick 6 — wave spawns
    expect(encounterOf(sim, room).trackedEntityIds).toHaveLength(3);
  });
});

/* ========================================================================== *
 * G8 · whole-loop replay                                                     *
 * ========================================================================== */
describe('G8 · the whole loop replays bit-for-bit from a seed (ADR-004)', () => {
  it('two simulators on the same seed produce identical snapshots across two descents', () => {
    const run = (): Snapshot[] => {
      const sim = makeSim(SEED);
      const { room } = makeRewardRoom(sim);
      const frames: Snapshot[] = [];

      sim.step(1); // tick 0
      frames.push(sim.snapshot());

      for (let descent = 0; descent < 2; descent += 1) {
        clearCurrentWave(sim, room); // the wipe + the draft
        frames.push(sim.snapshot());
        selectFirstOption(sim, room); // settle + descend
        frames.push(sim.snapshot());
        sim.step(1); // the deeper wave spawns
        frames.push(sim.snapshot());
      }
      return frames;
    };

    const first = run();
    const second = run();
    expect(second).toEqual(first);
    // Sanity: the script really ran seven ticks and two descents.
    expect(at(first, first.length - 1).tick).toBe(7);
  });
});

/* ========================================================================== *
 * G9 · pipeline slot                                                         *
 * ========================================================================== */
describe('G9 · RewardSystem sits between EncounterSystem and LifespanSystem (AC-05)', () => {
  it('slots after the system that rolls the draft, and before Lifespan, which stays last', () => {
    const names = createDefaultSystems().map((system) => system.name);
    expect(names.filter((name) => name === 'RewardSystem')).toHaveLength(1);
    // It settles the draft EncounterSystem rolls...
    expect(names.indexOf('RewardSystem')).toBeGreaterThan(names.indexOf('EncounterSystem'));
    // ...and it must not displace LifespanSystem, which stays LAST.
    expect(names.indexOf('RewardSystem')).toBeLessThan(names.indexOf('LifespanSystem'));
    expect(names.indexOf('LifespanSystem')).toBe(names.length - 1);
  });
});
