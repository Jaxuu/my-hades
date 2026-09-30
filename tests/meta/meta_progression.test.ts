/**
 * M13-T01 · Out-of-run progression (SaveState), darkness banking, the hub state,
 * and meta upgrades. See specs/21_hub_and_meta_progression_spec.md §4 (AC-01 ..
 * AC-04), §5 and §6.
 *
 * Fresh-eyes harness suite: every assertion drives the REAL `GameSimulator` with
 * the canonical 17-segment pipeline (unchanged by this milestone — see G5) and REAL
 * prefab-assembled entities. Nothing is mocked, and ticks are advanced one at a time
 * where the timing is the point.
 *
 * TICK NUMBERING (the classic off-by-one trap — spec 15 §6, unchanged here):
 *   `sim.step(n)` processes processed-ticks `0 .. n-1`, leaving `sim.tick === n`.
 *
 * THE BANKING TIMELINE (derived once, used everywhere — spec 21 §6):
 *   - a `DARKNESS` pickup is collected by `PickupSystem` on the tick the walk
 *     completes, and lands on the PLAYER'S WALLET (`InventoryComponent.darkness`);
 *   - the wallet is RUN-LOCAL: nothing writes `SaveState` while a run is live;
 *   - `sim.enterHub()` is the ONE settlement point: it moves the wallet's tally
 *     into `SaveState.darkness` and zeroes the tally, then flips the status to
 *     `HUB`;
 *   - `sim.restartRun()` rebuilds the world and hands the (untouched) save to
 *     `runSetup`, which is where purchased upgrades become a stronger player.
 *
 * Grouping:
 *   G0 · SaveState: the storage-agnostic persistence contract               (AC-01)
 *   G1 · the meta-upgrade config table                                      (§3.2)
 *   G2 · darkness: drop → pickup → wallet → banked at settlement            (AC-02)
 *   G3 · the hub: status, idempotence, and buying a talent                  (AC-03)
 *   G4 · meta bonuses: applied at assembly, inherited across runs           (AC-04)
 *   G5 · pipeline slot, snapshot shape and zero regression                  (§6.7)
 */

import {
  DataManager,
  DEFAULT_DARKNESS_AMOUNT,
  DEFAULT_MAX_HP,
  GameSimulator,
  GameStateFactory,
  GameStatus,
  HealthComponent,
  InventoryComponent,
  NO_META_BONUSES,
  PickupComponent,
  PickupKind,
  PlayerFactory,
  PlayerInputComponent,
  SaveState,
  addDarkness,
  applyDamage,
  createDefaultSystems,
  defaultLootAmount,
  findGameState,
  isInHub,
  isRunFailed,
  isRunOver,
  readDarkness,
  readGold,
  resolveMetaBonuses,
  spawnPickup,
  EnemyFactory,
  DashStatsComponent,
  VelocityComponent,
} from '../../src';
import type { EntityId, World } from '../../src';

const FPS = 60;
const SEED = 0x0badf00d;

/** The shipped `thick_skin` numbers, restated as LITERALS (never read from config). */
const THICK_SKIN_COST = 30;
const THICK_SKIN_MAX_HP = 50;

/* ========================================================================== *
 * Harness helpers                                                            *
 * ========================================================================== */

/**
 * Assemble one run the way a composition root does: a meta-aware player plus the
 * run-state singleton. Uses `spawnWithMeta`, i.e. the SAME entry point
 * `client/main.ts` uses, so the suite exercises the production assembly path.
 */
function buildRun(world: World, saveState: SaveState): void {
  PlayerFactory.spawnWithMeta(world, saveState, { x: 0, y: 0 });
  GameStateFactory.spawn(world);
}

/** A simulator whose run is already assembled, exactly like the browser entry. */
function makeSim(saveState: SaveState = SaveState.empty()): GameSimulator {
  const sim = new GameSimulator({
    fps: FPS,
    systems: createDefaultSystems(),
    seed: SEED,
    runSetup: buildRun,
    initialSaveState: saveState,
  });
  buildRun(sim.world, sim.saveState);
  return sim;
}

/** The device-driven entity, i.e. the player. */
function requirePlayer(world: World): EntityId {
  const id = world.query(PlayerInputComponent)[0];
  if (id === undefined) throw new Error('QA: the world has no player');
  return id;
}

function healthOf(sim: GameSimulator, id: EntityId): HealthComponent {
  const health = sim.world.getComponent(id, HealthComponent);
  if (health === undefined) throw new Error('QA: entity has no HealthComponent');
  return health;
}

/** Every pickup on the ground, ascending id. */
function pickupsOf(sim: GameSimulator): readonly EntityId[] {
  return sim.world.query(PickupComponent);
}

/** Kill `id` and let exactly one tick resolve the death. */
function killAndStep(sim: GameSimulator, id: EntityId): void {
  applyDamage(sim.world, id, 9999);
  sim.step(1);
}

/** Drop `count` darkness gems of `amount` each at the origin, where the player stands. */
function dropDarkness(sim: GameSimulator, count: number, amount: number): void {
  for (let i = 0; i < count; i += 1) {
    spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.DARKNESS, amount });
  }
}

/* ========================================================================== *
 * G0 · SaveState: the persistence contract (AC-01)                           *
 * ========================================================================== */
describe('G0 · SaveState is a storage-agnostic record (AC-01)', () => {
  it('starts empty: no currency, nothing unlocked', () => {
    const save = SaveState.empty();
    expect(save.darkness).toBe(0);
    expect(save.unlockedUpgrades).toEqual([]);
    expect(save.hasUpgrade('thick_skin')).toBe(false);
  });

  it('adds darkness and clamps at zero — a spend is a negative delta', () => {
    const save = new SaveState();
    expect(save.addDarkness(50)).toBe(50);
    expect(save.addDarkness(-30)).toBe(20);
    // The clamp is the ledger's only rule; affordability is the caller's job.
    expect(save.addDarkness(-999)).toBe(0);
  });

  it('unlocks an id at most once, and reports whether anything changed', () => {
    const save = SaveState.empty();
    expect(save.unlockUpgrade('thick_skin')).toBe(true);
    expect(save.unlockUpgrade('thick_skin')).toBe(false);
    expect(save.hasUpgrade('thick_skin')).toBe(true);
    expect(save.unlockedUpgrades).toEqual(['thick_skin']);
  });

  it('lists unlocked ids ASCENDING, so the same progress always serializes the same', () => {
    const save = new SaveState(0, ['swift_boots', 'adrenal_gland', 'thick_skin']);
    expect(save.unlockedUpgrades).toEqual(['adrenal_gland', 'swift_boots', 'thick_skin']);
  });

  it('round-trips through its own serialized form', () => {
    const save = new SaveState(42, ['thick_skin']);
    const json = save.toJSON();
    // The serialized form is plain data: a JSON round trip must be lossless.
    const revived = SaveState.from(JSON.parse(JSON.stringify(json)) as unknown);
    expect(revived.darkness).toBe(42);
    expect(revived.unlockedUpgrades).toEqual(['thick_skin']);
    expect(revived).not.toBe(save);
  });

  it('rejects a malformed save rather than coercing it', () => {
    expect(() => SaveState.from(null)).toThrow(TypeError);
    expect(() => SaveState.from([])).toThrow(TypeError);
    expect(() => SaveState.from({ darkness: -1, unlockedUpgrades: [] })).toThrow(RangeError);
    expect(() => SaveState.from({ darkness: Number.NaN, unlockedUpgrades: [] })).toThrow(RangeError);
    expect(() => SaveState.from({ darkness: 0, unlockedUpgrades: 'nope' })).toThrow(TypeError);
    expect(() => SaveState.from({ darkness: 0, unlockedUpgrades: [''] })).toThrow(TypeError);
  });

  it('is NOT part of the world snapshot — replay comparison ignores progression', () => {
    const sim = makeSim(new SaveState(999, ['thick_skin']));
    // The snapshot's shape is exactly the pre-M13 one, and `unlockedUpgrades`
    // exists ONLY on the save — so progression can never leak into a replay diff.
    expect(Object.keys(sim.snapshot())).toEqual(['tick', 'elapsedSeconds', 'entities']);
    expect(JSON.stringify(sim.snapshot())).not.toContain('unlockedUpgrades');
  });

  it('a simulator built without a save still has a total, empty one', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    expect(sim.saveState.darkness).toBe(0);
    expect(sim.saveState.unlockedUpgrades).toEqual([]);
  });

  it('the save is handed to `runSetup`, and survives every restart untouched', () => {
    const save = new SaveState(7, ['thick_skin']);
    const seen: SaveState[] = [];
    const sim = new GameSimulator({
      fps: FPS,
      systems: createDefaultSystems(),
      seed: SEED,
      initialSaveState: save,
      runSetup: (world: World, handed: SaveState) => {
        seen.push(handed);
        GameStateFactory.spawn(world);
      },
    });

    sim.restartRun();
    sim.restartRun();

    // Same INSTANCE every time — not a copy that could drift from the caller's handle.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(save);
    expect(seen[1]).toBe(save);
    expect(sim.saveState).toBe(save);
    expect(sim.saveState.darkness).toBe(7);
    expect(sim.saveState.unlockedUpgrades).toEqual(['thick_skin']);
  });
});

/* ========================================================================== *
 * G1 · the meta-upgrade config table (§3.2)                                  *
 * ========================================================================== */
describe('G1 · the meta-upgrade table is loaded and validated (§3.2)', () => {
  it('ships thick_skin at the documented price and magnitude', () => {
    const config = DataManager.getMetaUpgradeConfig('thick_skin');
    expect(config.id).toBe('thick_skin');
    expect(config.cost).toBe(THICK_SKIN_COST);
    expect(config.type).toBe('MAX_HP');
    expect(config.value).toBe(THICK_SKIN_MAX_HP);
    expect(DataManager.hasMetaUpgrade('thick_skin')).toBe(true);
  });

  it('lists ids ascending and reports an unknown id as unknown (never as empty)', () => {
    const ids = DataManager.metaUpgradeIds;
    expect([...ids].sort()).toEqual([...ids]);
    expect(ids).toContain('thick_skin');
    expect(DataManager.hasMetaUpgrade('nope')).toBe(false);
    expect(() => DataManager.getMetaUpgradeConfig('nope')).toThrow(/unknown meta upgrade id 'nope'/);
  });

  it('rejects a malformed entry at load time — the price and the type are both checked', () => {
    const load = (data: unknown): void => {
      DataManager.loadAll({
        enemies: { grunt: { maxHp: 1, maxSpeed: 1, hurtboxRadius: 1 } },
        modifiers: {},
        metaUpgrades: { broken: data },
      });
    };
    expect(() => load({ type: 'MAX_HP', value: 10 })).toThrow(/meta_upgrades\.broken\.cost/);
    expect(() => load({ cost: 0, type: 'MAX_HP', value: 10 })).toThrow(
      /meta_upgrades\.broken\.cost must be a positive integer/,
    );
    expect(() => load({ cost: 2.5, type: 'MAX_HP', value: 10 })).toThrow(
      /meta_upgrades\.broken\.cost must be a positive integer/,
    );
    expect(() => load({ cost: 10, type: 'NOT_A_TYPE', value: 10 })).toThrow(
      /meta_upgrades\.broken\.type must be one of/,
    );
    expect(() => load({ cost: 10, type: 'MAX_HP', value: 0 })).toThrow(
      /meta_upgrades\.broken\.value must be a positive finite number/,
    );
    // `loadAll` is atomic: every rejection above aborted BEFORE the install, so the
    // shipped table is still the one the rest of this suite runs against.
    expect(DataManager.hasMetaUpgrade('thick_skin')).toBe(true);
  });
});

/* ========================================================================== *
 * G2 · darkness: drop → pickup → wallet → banked at settlement (AC-02)        *
 * ========================================================================== */
describe('G2 · darkness is earned in the run and banked at settlement (AC-02)', () => {
  it('collects darkness into the RUN wallet, not into the save', () => {
    const sim = makeSim();
    dropDarkness(sim, 5, 10);

    sim.step(1); // tick 0 — the player is standing on all five gems

    expect(readDarkness(sim.world)).toBe(50);
    expect(pickupsOf(sim)).toEqual([]);
    // Nothing is banked while the run is live: the save is written at ONE point only.
    expect(sim.saveState.darkness).toBe(0);
    // And darkness is a separate ledger from gold.
    expect(readGold(sim.world)).toBe(0);
  });

  it('pays into the wallet only — no gold, no heal, no state change', () => {
    const sim = makeSim();
    const player = requirePlayer(sim.world);
    applyDamage(sim.world, player, 30);
    const hpBefore = healthOf(sim, player).hp;
    spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.DARKNESS, amount: 25 });

    sim.step(1);

    expect(readDarkness(sim.world)).toBe(25);
    expect(readGold(sim.world)).toBe(0);
    expect(healthOf(sim, player).hp).toBe(hpBefore);
  });

  it('uses the documented default amount when a gem declares none', () => {
    const sim = makeSim();
    spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.DARKNESS });

    sim.step(1);

    expect(readDarkness(sim.world)).toBe(DEFAULT_DARKNESS_AMOUNT);
    expect(defaultLootAmount(PickupKind.DARKNESS)).toBe(DEFAULT_DARKNESS_AMOUNT);
  });

  it('the wallet write helper mirrors `addGold`: additive, clamped, opt-in', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [], seed: SEED });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const bare = sim.world.createEntity().id; // no wallet at all

    expect(addDarkness(sim.world, player, 12)).toBe(true);
    expect(readDarkness(sim.world)).toBe(12);
    // Negative is legal and clamps, exactly like gold — affordability is the
    // caller's rule, not the ledger's.
    expect(addDarkness(sim.world, player, -99)).toBe(true);
    expect(readDarkness(sim.world)).toBe(0);
    expect(addDarkness(sim.world, bare, 5)).toBe(false);
  });

  it('a shipped enemy really drops darkness (the JSON table is wired through)', () => {
    const sim = makeSim();
    // `raider` declares gold + darkness in `assets/data/enemies.json`.
    const raider = EnemyFactory.spawn(sim.world, 'raider', { x: 6, y: 0 });

    killAndStep(sim, raider);

    const drops = pickupsOf(sim)
      .map((id) => sim.world.getComponent(id, PickupComponent))
      .filter((pickup): pickup is PickupComponent => pickup !== undefined);
    const darkness = drops.filter((drop) => drop.kind === PickupKind.DARKNESS);
    expect(darkness).toHaveLength(1);
    expect(darkness[0]?.amount).toBe(10);
    // The player is 6 units away: nothing was collected, so the save is untouched.
    expect(readDarkness(sim.world)).toBe(0);
    expect(sim.saveState.darkness).toBe(0);
  });

  it('death alone does NOT bank — the run is only settled at `enterHub`', () => {
    const sim = makeSim();
    dropDarkness(sim, 5, 10);
    sim.step(1);
    expect(readDarkness(sim.world)).toBe(50);

    killAndStep(sim, requirePlayer(sim.world));

    expect(isRunFailed(sim.world)).toBe(true);
    expect(sim.saveState.darkness).toBe(0);
  });

  it('banks exactly once, and zeroes the run tally (AC-02 + AC-03)', () => {
    const sim = makeSim();
    dropDarkness(sim, 5, 10);
    sim.step(1);
    killAndStep(sim, requirePlayer(sim.world));

    sim.enterHub();

    expect(sim.saveState.darkness).toBe(50);
    expect(readDarkness(sim.world)).toBe(0);
    expect(isInHub(sim.world)).toBe(true);

    // Idempotent: a hub entered twice cannot pay the same run out twice.
    sim.enterHub();
    expect(sim.saveState.darkness).toBe(50);
  });

  it('a run abandoned WITHOUT a settlement leaves the save untouched', () => {
    const sim = makeSim();
    dropDarkness(sim, 3, 10);
    sim.step(1);
    expect(readDarkness(sim.world)).toBe(30);

    sim.restartRun();

    // The wallet was rebuilt with the run, so the earnings are simply gone — the
    // documented cost of banking only at a settlement.
    expect(readDarkness(sim.world)).toBe(0);
    expect(sim.saveState.darkness).toBe(0);
  });

  it('`enterHub` is a no-op on a world that never assembled a run', () => {
    const save = new SaveState();
    const sim = new GameSimulator({
      fps: FPS,
      systems: createDefaultSystems(),
      seed: SEED,
      initialSaveState: save,
    });
    // A wallet with darkness but no run state: "the hub transition happened" and
    // "the save was paid out" must not be two answers that can disagree.
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const wallet = sim.world.getComponent(player, InventoryComponent);
    if (wallet === undefined) throw new Error('QA: the player has no wallet');
    wallet.darkness = 25;

    sim.enterHub();

    expect(save.darkness).toBe(0);
    expect(wallet.darkness).toBe(25);
    expect(findGameState(sim.world)).toBeUndefined();
  });
});

/* ========================================================================== *
 * G3 · the hub: status and purchases (AC-03)                                  *
 * ========================================================================== */
describe('G3 · the camp: status, gates, and buying a talent (AC-03)', () => {
  /** A settled run sitting in the hub with `darkness` currency. */
  function hubWith(darkness: number): GameSimulator {
    const sim = makeSim(new SaveState(darkness));
    sim.enterHub();
    return sim;
  }

  it('HUB is a terminal status: the run stays inert, like a lost one', () => {
    const sim = hubWith(50);

    expect(findGameState(sim.world)?.status).toBe(GameStatus.HUB);
    expect(isInHub(sim.world)).toBe(true);
    expect(isRunOver(sim.world)).toBe(true);
    // HUB is NOT a verdict on the run — it is where a verdict leads.
    expect(isRunFailed(sim.world)).toBe(false);

    // The scheduler stays inert: a wave cannot spawn over the settled run.
    const before = sim.world.entityCount;
    sim.step(30);
    expect(sim.world.entityCount).toBe(before);
  });

  it('buys a talent, deducts the price, and records the unlock', () => {
    const sim = hubWith(50);

    expect(sim.purchaseMetaUpgrade('thick_skin')).toBe(true);

    expect(sim.saveState.darkness).toBe(50 - THICK_SKIN_COST);
    expect(sim.saveState.darkness).toBe(20);
    expect(sim.saveState.unlockedUpgrades).toEqual(['thick_skin']);
  });

  it('refuses a duplicate, an unknown id, and one it cannot afford — without throwing', () => {
    const sim = hubWith(50);
    expect(sim.purchaseMetaUpgrade('thick_skin')).toBe(true);
    expect(sim.saveState.darkness).toBe(20);

    // Already owned: no second charge.
    expect(sim.purchaseMetaUpgrade('thick_skin')).toBe(false);
    expect(sim.saveState.darkness).toBe(20);

    // Unknown id: refused, not crashed.
    expect(sim.purchaseMetaUpgrade('no_such_talent')).toBe(false);
    expect(sim.saveState.darkness).toBe(20);

    // Affordable check is real: `swift_boots` costs 40, the player holds 20.
    expect(DataManager.getMetaUpgradeConfig('swift_boots').cost).toBe(40);
    expect(sim.purchaseMetaUpgrade('swift_boots')).toBe(false);
    expect(sim.saveState.darkness).toBe(20);
    expect(sim.saveState.unlockedUpgrades).toEqual(['thick_skin']);
  });

  it('a restart from the hub returns to PLAYING with the save intact', () => {
    const sim = hubWith(50);
    sim.purchaseMetaUpgrade('thick_skin');

    sim.restartRun();

    expect(findGameState(sim.world)?.status).toBe(GameStatus.PLAYING);
    expect(isRunOver(sim.world)).toBe(false);
    expect(sim.saveState.darkness).toBe(20);
    expect(sim.saveState.unlockedUpgrades).toEqual(['thick_skin']);
    expect(readDarkness(sim.world)).toBe(0);
  });
});

/* ========================================================================== *
 * G4 · meta bonuses: applied at assembly, inherited across runs (AC-04)       *
 * ========================================================================== */
describe('G4 · purchased talents raise the NEXT run\'s player (AC-04)', () => {
  it('`resolveMetaBonuses` sums the unlocked ids, skipping stale ones', () => {
    expect(resolveMetaBonuses([])).toEqual(NO_META_BONUSES);
    expect(resolveMetaBonuses(['thick_skin'])).toEqual({
      maxHp: THICK_SKIN_MAX_HP,
      moveSpeed: 0,
      dashCooldownReductionTicks: 0,
    });
    // An id a later config edit removed grants nothing (it is not corruption).
    expect(resolveMetaBonuses(['deleted_in_a_patch'])).toEqual(NO_META_BONUSES);
    // A repeated id must not buy the same bonus twice.
    expect(resolveMetaBonuses(['thick_skin', 'thick_skin']).maxHp).toBe(THICK_SKIN_MAX_HP);
  });

  it('a player assembled with NO upgrades is exactly the pre-M13 player', () => {
    const plain = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const withMeta = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });

    const a = PlayerFactory.spawn(plain.world, { x: 0, y: 0 });
    const b = PlayerFactory.spawnWithMeta(withMeta.world, SaveState.empty(), { x: 0, y: 0 });

    const ha = plain.world.getComponent(a, HealthComponent);
    const hb = withMeta.world.getComponent(b, HealthComponent);
    expect(hb?.maxHp).toBe(ha?.maxHp);
    expect(hb?.maxHp).toBe(DEFAULT_MAX_HP);
  });

  it('thick_skin raises maxHp by EXACTLY the configured amount, and hp starts full', () => {
    const save = new SaveState(0, ['thick_skin']);
    const sim = makeSim(save);

    const health = healthOf(sim, requirePlayer(sim.world));

    // A LITERAL on the right: 100 (the component default) + 50 (the JSON value).
    expect(health.maxHp).toBe(150);
    expect(health.maxHp).toBe(DEFAULT_MAX_HP + THICK_SKIN_MAX_HP);
    expect(health.hp).toBe(150);
  });

  it('the other two bonus types land on the components they name', () => {
    const save = new SaveState(0, ['swift_boots', 'adrenal_gland']);
    const sim = makeSim(save);
    const player = requirePlayer(sim.world);

    // swift_boots: +1 move speed on top of the 5-unit default.
    expect(sim.world.getComponent(player, VelocityComponent)?.maxSpeed).toBe(6);
    // adrenal_gland: 30-tick default cooldown minus 10.
    expect(sim.world.getComponent(player, DashStatsComponent)?.cooldownTicks).toBe(20);
  });

  it('the bonus is INHERITED across runs — it is the save that was bought, not the body', () => {
    const sim = makeSim();
    // Earn 50, die, settle, buy.
    dropDarkness(sim, 5, 10);
    sim.step(1);
    killAndStep(sim, requirePlayer(sim.world));
    sim.enterHub();
    expect(sim.saveState.darkness).toBe(50);
    expect(sim.purchaseMetaUpgrade('thick_skin')).toBe(true);
    expect(sim.saveState.darkness).toBe(20);

    // Run 1 after the purchase.
    sim.restartRun();
    expect(healthOf(sim, requirePlayer(sim.world)).maxHp).toBe(150);

    // Die again, settle again, restart again — the bonus must still be there, and
    // the currency must NOT have been re-earned by the death.
    killAndStep(sim, requirePlayer(sim.world));
    sim.enterHub();
    expect(sim.saveState.darkness).toBe(20);
    sim.restartRun();

    expect(healthOf(sim, requirePlayer(sim.world)).maxHp).toBe(150);
    expect(sim.saveState.unlockedUpgrades).toEqual(['thick_skin']);
  });

  it('a bonus on an already-owned upgrade does not stack per run', () => {
    const sim = makeSim(new SaveState(0, ['thick_skin']));
    expect(healthOf(sim, requirePlayer(sim.world)).maxHp).toBe(150);

    sim.restartRun();
    expect(healthOf(sim, requirePlayer(sim.world)).maxHp).toBe(150);

    sim.restartRun();
    expect(healthOf(sim, requirePlayer(sim.world)).maxHp).toBe(150);
  });

  it('rejects a malformed bonus at the assembly seam', () => {
    const sim = new GameSimulator({ fps: FPS, systems: [], seed: SEED });
    expect(() =>
      PlayerFactory.spawn(sim.world, { metaBonuses: { maxHp: -1, moveSpeed: 0, dashCooldownReductionTicks: 0 } }),
    ).toThrow(/metaBonuses\.maxHp/);
    expect(() =>
      PlayerFactory.spawn(sim.world, { metaBonuses: { maxHp: 0, moveSpeed: Number.NaN, dashCooldownReductionTicks: 0 } }),
    ).toThrow(/metaBonuses\.moveSpeed/);
  });
});

/* ========================================================================== *
 * G5 · pipeline slot, snapshot shape and zero regression (§6.7)               *
 * ========================================================================== */
describe('G5 · no pipeline segment, no snapshot field, no regression (§6.7)', () => {
  it('M13-T01 adds NO system: the pipeline is still exactly 17 segments', () => {
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
    // The hub is a STATUS, not a system: nothing in the loop knows it exists.
    expect(names.filter((name) => name.includes('Hub') || name.includes('Meta'))).toEqual([]);
    expect(names[0]).toBe('TransformSnapshotSystem');
    expect(names[names.length - 1]).toBe('LifespanSystem');
  });

  it('a world with no game state reads as PLAYING forever — HUB is opt-in too', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    expect(isRunOver(sim.world)).toBe(false);
    expect(isInHub(sim.world)).toBe(false);

    // Darkness still collects — the wallet does not depend on a run existing.
    spawnPickup(sim.world, { x: 0, y: 0, kind: PickupKind.DARKNESS, amount: 12 });
    sim.step(1);
    expect(readDarkness(sim.world)).toBe(12);
  });

  it('a pre-M13-shaped run (no meta, no game state) is untouched tick after tick', () => {
    const sim = new GameSimulator({ fps: FPS, systems: createDefaultSystems(), seed: SEED });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const before = sim.world.entityCount;

    sim.step(20);

    expect(sim.world.entityCount).toBe(before);
    expect(healthOf(sim, player).maxHp).toBe(DEFAULT_MAX_HP);
    expect(readGold(sim.world)).toBe(0);
    expect(readDarkness(sim.world)).toBe(0);
    expect(sim.saveState.darkness).toBe(0);
  });
});
