/**
 * GameSimulator — the deterministic, headless simulation core.
 * See specs/00_harness_spec.md §3–§6.
 *
 * Rendering-agnostic: this module never touches DOM/Canvas/WebGL. Time is
 * advanced ONLY via `step()`; the wall clock is never read.
 *
 * M13-T01 widens the class by exactly two META-BOUNDARY operations — `enterHub`
 * and `purchaseMetaUpgrade` — plus the `saveState` it owns. They are here for the
 * same reason `restartRun` is: a run boundary is not a simulation input, it is a
 * command the CALLER issues against the simulator (the hub's talent screen is a
 * DOM menu, not a tick-aligned event). The cost is that `src/core` now names two
 * game concepts it did not before; the alternative — a save the caller owns and
 * mutates behind the simulator's back — would make "who banks the darkness, and
 * when" a question with several answers.
 *
 * The save itself stays OUTSIDE the simulation: it is injected, never read from
 * any storage medium here, and never appears in `snapshot()` (spec 21 §3.1).
 */

import { FixedClock } from './clock';
import type { InputEvent } from './input';
import { InputQueue } from './input';
import { Scheduler } from './scheduler';
import { cloneValue, deepFreeze } from './snapshot-utils';
import { bankRunDarkness, tryPurchaseMetaUpgrade } from './MetaProgression';
import { SaveState } from './SaveState';
import type { System, SystemContext } from '../ecs/System';
import { World } from '../ecs/World';
import type { EntityId } from '../ecs/Entity';
import { markRunHub, findGameState } from '../ecs/components/GameStateComponent';

export interface GameSimulatorOptions {
  /** Logical ticks per second. Defaults to 60. */
  readonly fps?: number;
  /** Systems to register up-front, in execution order. */
  readonly systems?: readonly System[];
  /**
   * Seed for the world's deterministic PRNG (M6-T01). Defaults to
   * `DEFAULT_RANDOM_SEED`, so a simulator built without a seed is reproducible —
   * which is what makes test suites and replays stable. A real roguelike run
   * passes a varied seed here; that choice belongs to the caller, never to the
   * logic layer (ADR-004 §Decision 3).
   */
  readonly seed?: number;
  /**
   * How to ASSEMBLE a run (M8-T01, spec 14 AC-03).
   *
   * A callback the caller supplies, invoked by `GameSimulator.restartRun` to
   * rebuild the world after it has been cleared. It is a CONSTRUCTOR option
   * rather than a `restartRun` parameter so that the restart signature stays the
   * one the milestone asks for (`restartRun(newSeed?)`) while `GameSimulator`
   * stays free of game concepts: the simulator does not know what a player, a
   * room or a game state is — it only knows that a caller can build one.
   *
   * Omit it and `restartRun` still clears the world, reseeds and rewinds the
   * clock; the world is simply left empty. That is the honest behaviour for a
   * simulator whose caller never declared a run shape.
   *
   * M12-T01 — THE ROOM-TOPOLOGY CONTRACT, and why it is expressed HERE rather than
   * as a new option. As of M12 a run's opening room has a TILEMAP: walls to build,
   * a spawn tile to place the player on, and a pool of enemy landing spots. That
   * work is `LevelLoader.enterRoom`, and it belongs to `runSetup` — the callback
   * that already answers "what does a run look like". Adding an `initialRoomId`
   * option would move the same assembly from the caller into the simulator and make
   * `src/core` — which deliberately knows nothing about players, rooms or waves
   * (see the class docstring) — start knowing about all three. The contract is
   * therefore: a `runSetup` that has a topology calls `LevelLoader.enterRoom` for
   * room 0, and because `restartRun` calls `runSetup` on EVERY restart, a restarted
   * run necessarily gets room 0's walls and an exactly-placed player
   * (spec 19 §4.3, pinned by `tests/world/tilemap_and_topology.test.ts` G2).
   *
   * M13-T01 — THE SECOND PARAMETER, and why the SAVE travels through it rather
   * than being read from the world. A run must be assembled differently depending
   * on the meta upgrades the player owns (AC-04: `thick_skin` means the player is
   * built with +50 max HP), and the save is precisely NOT world state — it outlives
   * every restart and is invisible to `snapshot()`. Handing it to the assembler is
   * the constructor-injection seam of AC-01 taken one step further: the simulator
   * still does not know what a player is, it only knows that the caller's assembler
   * may want to see the save it is rebuilding the run for.
   *
   * The parameter is ADDITIVE — a one-argument `runSetup` keeps type-checking and
   * behaving exactly as before — so every pre-M13 caller is untouched.
   */
  readonly runSetup?: (world: World, saveState: SaveState) => void;
  /**
   * The out-of-run progression record to run against (M13-T01, AC-01).
   *
   * INJECTED, never loaded here: `src/` must stay ignorant of the storage medium,
   * so the caller (in practice `client/main.ts`, via `client/SaveStore.ts`) reads
   * whatever it wants — `localStorage`, a file, nothing at all — and hands the
   * simulator an already-constructed `SaveState`. Omit it and the simulator starts
   * with a fresh, empty save (`SaveState.empty()`), which is what every pre-M13
   * test and every caller that does not care about meta progression gets.
   *
   * The instance is held by reference for the simulator's whole life: it is NOT
   * rebuilt by `restartRun`, and it is NOT part of `snapshot()`. That is the whole
   * of AC-01's "独立于 World 存在，且重启不被清空".
   */
  readonly initialSaveState?: SaveState;
}

export interface ComponentSnapshot {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface EntitySnapshot {
  readonly id: EntityId;
  readonly components: readonly ComponentSnapshot[];
}

export interface Snapshot {
  readonly tick: number;
  readonly elapsedSeconds: number;
  readonly entities: readonly EntitySnapshot[];
}

export class GameSimulator {
  public readonly world: World;

  /**
   * The out-of-run progression record (M13-T01).
   *
   * A REFERENCE to the instance the caller injected, so a caller that kept its own
   * handle sees every change (`enterHub` banking, a purchase) without asking the
   * simulator for it again. Never replaced, never rebuilt by `restartRun`, never
   * part of `snapshot()`.
   */
  public readonly saveState: SaveState;

  private readonly clock: FixedClock;
  private readonly input: InputQueue;
  private readonly scheduler: Scheduler;
  private readonly runSetup: ((world: World, saveState: SaveState) => void) | undefined;

  constructor(options: GameSimulatorOptions = {}) {
    this.clock = new FixedClock(options.fps !== undefined ? { fps: options.fps } : {});
    // The seed is forwarded to the World, which owns the ONE PRNG stream every
    // randomness consumer shares (M6-T01, ADR-004). Guarded rather than passed
    // through directly because `exactOptionalPropertyTypes` forbids handing an
    // explicit `undefined` to an optional property.
    this.world = options.seed !== undefined ? new World({ seed: options.seed }) : new World();
    this.input = new InputQueue();
    this.scheduler = new Scheduler();
    // An omitted save is a FRESH one, not `undefined`: every read path below
    // (`saveState.darkness`, `enterHub`'s banking) then has a total answer, and no
    // caller has to guard. The default is a plain `SaveState`, so a caller that
    // never persists anything behaves exactly like one that does.
    this.saveState = options.initialSaveState ?? SaveState.empty();
    this.runSetup = options.runSetup;
    for (const system of options.systems ?? []) {
      this.scheduler.register(system);
    }
  }

  public get fps(): number {
    return this.clock.fps;
  }

  public get fixedDeltaSeconds(): number {
    return this.clock.fixedDeltaSeconds;
  }

  public get tickDurationMs(): number {
    return this.clock.tickDurationMs;
  }

  /** Accumulated tick count (integer, monotonically non-decreasing). */
  public get tick(): number {
    return this.clock.totalTicks;
  }

  /** Accumulated simulated seconds. */
  public get elapsedSeconds(): number {
    return this.clock.elapsedSeconds;
  }

  public get systemCount(): number {
    return this.scheduler.size;
  }

  /**
   * The seed of the world's CURRENT PRNG stream (M10-T02).
   *
   * A read-only projection of `world.rng.seed`, added so a caller that wants to
   * restart a run "as it is" — `restartRun(sim.currentSeed)` — can say so without
   * reaching into the world for the generator. That is exactly what the dev-mode
   * data hot reload needs: a config edit must re-open the SAME run against the NEW
   * numbers, so the reload is a pure config change rather than a config change
   * plus a surprise re-roll.
   *
   * Note it is NOT "the seed the run started with": `restartRun` advances it, so
   * this always reports the stream the current run is drawing from.
   */
  public get currentSeed(): number {
    return this.world.rng.seed;
  }

  public registerSystem(system: System): void {
    this.scheduler.register(system);
  }

  /**
   * Schedule an input event for a specific (current or future) tick.
   * @throws RangeError if the tick is invalid or already in the past.
   */
  public inject(event: InputEvent): void {
    if (event.tick < this.clock.totalTicks) {
      throw new RangeError(
        `Cannot inject event for past tick ${event.tick} (current tick is ${this.clock.totalTicks}).`,
      );
    }
    this.input.enqueue(event);
  }

  /** Convenience alias for {@link inject}. */
  public injectAt(tick: number, event: InputEvent): void {
    this.inject({ ...event, tick });
  }

  /**
   * Advance the simulation by `ticks` fixed steps (default 1).
   * Each step: drain the input frame for the current tick, run systems, then
   * advance the clock by exactly one tick.
   */
  public step(ticks = 1): void {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new RangeError(`step(ticks) must be a non-negative integer, received: ${String(ticks)}`);
    }
    for (let i = 0; i < ticks; i += 1) {
      const currentTick = this.clock.totalTicks;
      const inputFrame = this.input.drain(currentTick);
      const ctx: SystemContext = {
        tick: currentTick,
        elapsedSeconds: currentTick * this.clock.fixedDeltaSeconds,
        fixedDeltaSeconds: this.clock.fixedDeltaSeconds,
        input: inputFrame,
      };
      this.scheduler.run(this.world, ctx);
      this.clock.advance(1);
    }
  }

  /** Advance until the clock reaches `targetTick` (no-op if already there). */
  public runTo(targetTick: number): void {
    if (!Number.isInteger(targetTick) || targetTick < 0) {
      throw new RangeError(`runTo(targetTick) must be a non-negative integer, received: ${String(targetTick)}`);
    }
    if (targetTick < this.clock.totalTicks) {
      throw new RangeError(
        `Cannot run backwards to tick ${targetTick} (current tick is ${this.clock.totalTicks}).`,
      );
    }
    this.step(targetTick - this.clock.totalTicks);
  }

  /**
   * Throw the current run away and start a fresh one (M8-T01, spec 14 AC-03).
   *
   * The ONLY way back from `RUN_FAILED`, and the only operation in this engine
   * that rewinds anything. The steps are ordered, and the order is the contract
   * (spec 14 §4.5):
   *
   *  1. `world.clearEntities()` — every entity goes: the player, the room,
   *    corpses, armed hazards, in-flight projectiles, unspent hitboxes, and every
   *    modifier the player had accumulated. Note `World.nextId` is NOT reset, on
   *    purpose: ids must never be reused (`GameRenderer.retired` depends on it).
   *  2. `world.reseed(...)` — a NEW seed. `newSeed` if given, otherwise the
   *    previous seed plus one. Incrementing rather than rolling is what makes
   *    "restart twice from the same starting seed" reproducible (ADR-004).
   *  3. `input.clear()` — drop SCHEDULED input events. Without this the first
   *    tick of the new run would receive the previous run's last `move` / key
   *    events, which is replay contamination rather than a leftover.
   *  4. `scheduler.reset()` — let systems that own a tick-scoped bus drop its
   *    contents (the death bus deliberately keeps the tick's deaths, spec 08
   *    §3.3, and those events reference entities step 1 just destroyed).
   *  5. `clock.reset()` — back to tick `0`.
   *  6. `runSetup(world, saveState)` — rebuild the run's entities. For a run with a
   *    room topology this is also where room 0's TILEMAP is loaded: `runSetup` calls
   *    `LevelLoader.enterRoom`, so every restart rebuilds the opening room's walls
   *    and pins the player to its spawn tile (spec 19 §4.3). Note `clearEntities`
   *    in step 1 has already removed the previous run's geometry, so "build the
   *    new room" needs no teardown of its own. M13-T01: the save is handed in too,
   *    so a run assembled after a purchase is built with the purchased bonuses
   *    (AC-04) — and because `saveState` is NOT touched by steps 1–5, meta
   *    progression survives the restart by construction.
   *
   * Steps 1–2 happen BEFORE 6 so that `runSetup` sees an empty world with the new
   * generator, i.e. the same conditions a fresh construction has. Anything
   * `runSetup` draws is therefore drawn from the new stream, in the same order,
   * for the same seed — which is what makes a restarted run replayable.
   */
  public restartRun(newSeed?: number): void {
    const seed = newSeed ?? this.world.rng.seed + 1;
    this.world.clearEntities();
    this.world.reseed(seed);
    this.input.clear();
    this.scheduler.reset();
    this.clock.reset();
    this.runSetup?.(this.world, this.saveState);
  }

  /**
   * Settle the finished run and move to the HUB (M13-T01, spec 21 AC-03).
   *
   * The run boundary between "a run has ended" and "the next run has not started".
   * It does exactly two things, in this order:
   *
   *  1. **BANK the run's darkness** into `saveState.darkness` and zero the player's
   *     tally (`bankRunDarkness`). This is AC-02's 结算 point: a run's earnings
   *     become permanent here and nowhere else, so a run that is abandoned without
   *     a settlement cannot half-bank itself, and a hub entered twice cannot pay
   *     the same run out twice.
   *  2. **Flip the run's status to `HUB`** (`markRunHub`). Like every other
   *     run-state write, this is a strict no-op for a world that never assembled a
   *     game-state singleton.
   *
   * It deliberately does NOT rebuild the world — that is `restartRun`, and keeping
   * the two apart is what lets the hub screen show the run that just ended while
   * the player spends. It also deliberately does NOT pause anything: a `HUB` run is
   * inert because `isRunOver` reports it as over, not because a system is gated on
   * a new flag (spec 21 I4).
   *
   * A world with NO game-state singleton is a strict no-op — checked BEFORE the
   * banking, not after, so that "the hub transition happened" and "the save was
   * paid out" can never be two answers that disagree (the same opt-in reading
   * spec 14 AC-11 records for a world that never assembled a run).
   *
   * Idempotent: a second call banks `0` and re-writes the same status.
   */
  public enterHub(): void {
    if (findGameState(this.world) === undefined) return;
    bankRunDarkness(this.world, this.saveState);
    markRunHub(this.world);
  }

  /**
   * Spend darkness to unlock a meta upgrade (M13-T01, spec 21 AC-03).
   *
   * @returns `true` only when the purchase happened; `false` for an unknown id, an
   *   already-unlocked upgrade, or one the save cannot afford — never a throw,
   *   because the production caller is a DOM button.
   *
   * Deliberately NOT gated on the run being in `HUB`: the hub is the only screen
   * that offers a purchase, so the gate already exists where it belongs (the UI),
   * and teaching `src/core` to inspect the run status would be a second, redundant
   * copy of it. What the player does with their currency outside the hub is not
   * this method's business.
   *
   * The effect of an unlock is felt at the NEXT `restartRun`, when `runSetup` sees
   * the new `unlockedUpgrades` and assembles a stronger player (AC-04).
   */
  public purchaseMetaUpgrade(upgradeId: string): boolean {
    return tryPurchaseMetaUpgrade(this.saveState, upgradeId);
  }

  /**
   * Export a deep-copied, deep-frozen read-only snapshot of the world.
   * The snapshot shares no mutable references with the live world.
   */
  public snapshot(): Snapshot {
    const entities: EntitySnapshot[] = this.world.listEntities().map((id) => {
      const components: ComponentSnapshot[] = this.world.listComponents(id).map((component) => {
        const data: Record<string, unknown> = {};
        const source = component as unknown as Record<string, unknown>;
        for (const key of Object.keys(source)) {
          if (key === '__component') continue;
          data[key] = cloneValue(source[key]);
        }
        return { type: component.constructor.name, data };
      });
      return { id, components };
    });

    const snap: Snapshot = {
      tick: this.clock.totalTicks,
      elapsedSeconds: this.clock.elapsedSeconds,
      entities,
    };
    return deepFreeze(snap);
  }
}
