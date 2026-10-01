/**
 * main — the composition root of the presentation layer.
 * See specs/09_renderer_bridge_spec.md §1.2 / §5.3,
 * specs/11_roguelike_loop_spec.md §4.5,
 * specs/14_aoe_and_run_lifecycle_spec.md §4.5 / §4.6 and
 * specs/15_economy_and_victory_spec.md §4.6.
 *
 * Wires the headless simulation core to PixiJS AND to the DOM:
 *   GameSimulator (17-system pipeline)  ->  GameRenderer (read-only)  ->  PixiJS
 *   GameSimulator                       ->  UIManager    (read-only)  ->  #ui-layer
 *   GameSimulator                       ->  UIManager    (read-only)  ->  #gold
 *   KeyboardInput  ->  per-tick injection  ->  GameSimulator.step(1)
 *   UIManager click ->  selectReward injection  ->  GameSimulator.step(1)
 *   UIManager  R key ->  onEnterHub callback    ->  GameSimulator.enterHub()
 *   UIManager talent ->  onPurchase callback    ->  GameSimulator.purchaseMetaUpgrade()
 *   UIManager  start ->  onStartRun callback    ->  GameSimulator.restartRun()
 *   localStorage     ->  SaveStore  ->  initialSaveState  ->  GameSimulator
 *   GameSimulator.saveState  ->  SaveStore  ->  localStorage   (on every mutation)
 *
 * M6-T01 replaced the hand-placed enemies with a REAL `EncounterFactory` room, so
 * the roguelike loop is observable end to end: clear both waves -> the room rolls
 * a three-option draft -> the overlay appears -> picking a boon descends the room
 * and spawns a bigger wave.
 *
 * M8-T01 closed the loop at both ends:
 *   - `buildRun` is handed to the simulator as its `runSetup`, so "what a run
 *     looks like" is declared ONCE and `restartRun()` can rebuild it without the
 *     simulator learning a single game concept (spec 14 §4.5);
 *   - dying now shows the death overlay and `R` starts a fresh run, with the
 *     player id re-resolved every frame rather than captured — after a restart the
 *     player is a BRAND NEW entity, and a captured id would point at a corpse.
 *
 * M9-T01 gives the run a middle and an end:
 *   - the room is declared as a MULTI-room run, so the boon draft leads somewhere
 *     instead of re-running the same room forever (spec 15 AC-03);
 *   - enemies drop gold and flasks, the player's wallet is on screen, and clearing
 *     the LAST room ends the run with the victory overlay instead of a draft
 *     (spec 15 AC-01 / AC-02 / AC-04). `R` restarts from either terminal overlay.
 *
 * M10-T02 moves the run's SHAPE out of this file and adds the dev loop that makes
 * data edits visible without a page reload:
 *   - the rooms come from `assets/data/encounters.json` via
 *     `EncounterFactory.spawnFromData` (read BY DEPTH), so this file no longer
 *     declares a wave roster at all (spec 17 AC-01 / AC-02);
 *   - `client/bundled.ts` owns the raw JSON imports and installs a Vite HMR hook:
 *     editing a table re-validates it through `DataManager.loadAll` and re-opens the
 *     same run against it, with the render layer reset so no FX survive (AC-03).
 *
 * M12-T01 gives the run a PLACE to happen in:
 *   - `buildRun` now assembles the opening room's TILEMAP through
 *     `LevelLoader.enterRoom` — one `WallComponent` per `1` tile of
 *     `assets/data/rooms.json`, the player hard-reset onto the room's `2` tile, and
 *     the room's `3` tiles published as the enemy landing pool (spec 19 §4.3);
 *   - because `restartRun` re-runs `buildRun`, a restart rebuilds room 0's geometry
 *     and re-places the player exactly, with no extra code here;
 *   - `GameRenderer` draws the floor and the walls as flat colour blocks, so the
 *     room's SHAPE is visible in the browser (spec 19 AC-08).
 *
 * M13-T01 closes the loop between runs:
 *   - the SAVE is read once, from `localStorage` via `client/SaveStore.ts`, and
 *     INJECTED into the simulator (`initialSaveState`) — `src/` never learns what a
 *     storage medium is (spec 21 AC-01);
 *   - `buildRun` receives it and spawns the player with `PlayerFactory.spawnWithMeta`,
 *     so a purchased talent is a stronger body from the first tick of the next run
 *     (AC-04);
 *   - a terminal overlay's `R` now SETTLES the run (`sim.enterHub`) instead of
 *     restarting it: darkness is banked, the camp screen appears, and the only way
 *     onward is its start button (AC-02 / AC-03);
 *   - every write to the save is followed by a `persistSaveState`, so progression
 *     survives a page reload — and every write is a run-boundary event, never a
 *     per-tick one.
 *
 * M14-T01 gives the run a VOICE and an IMPACT, still with `src/` untouched:
 *   - a `ClientEventBridge` is injected as the pipeline's three event buses
 *     (`createDefaultSystems(bridge.hitQueue, bridge.deathQueue, bridge.dashQueue)`),
 *     so the hit / death / dash facts the engine already publishes are retained for
 *     the render layer (spec 22 AC-01);
 *   - the `GameLoop` drains that bridge once per frame and fans it out to the
 *     renderer (screen shake + hit sparks) and to the `AudioManager` (hit / dash
 *     chimes). The bridge is dropped at every run boundary (`onStartRun`, the data
 *     hot reload), because `restartRun` destroys the entities its events reference;
 *   - the coin chime is driven by a per-frame GOLD read (there is no pickup event),
 *     purely observational.
 *
 * This file is the ONLY place `src/` and the presentation layer are joined — the
 * one-way dependency stays intact (client -> src). It is also the only place the
 * seed is chosen and the only place the save is stored, which is what keeps the
 * wall clock, any entropy, and every storage medium out of `src/` (ADR-004 §3,
 * spec 21 I1).
 */

import { Application } from 'pixi.js';

import { GameSimulator } from '../src/core/GameSimulator';
import type { SaveState } from '../src/core/SaveState';
import type { World } from '../src/ecs/World';
import type { EntityId } from '../src/ecs/Entity';
import { createDefaultSystems } from '../src/ecs/systems/pipeline';
import { PlayerFactory } from '../src/ecs/prefabs/PlayerFactory';
import { EncounterFactory } from '../src/ecs/prefabs/EncounterFactory';
import { GameStateFactory } from '../src/ecs/prefabs/GameStateFactory';
import { HealthComponent } from '../src/ecs/components/HealthComponent';
import { readDarkness, readGold } from '../src/ecs/components/InventoryComponent';
import { PlayerInputComponent } from '../src/ecs/components/PlayerInputComponent';
import {
  EncounterStateComponent,
  currentRoomId,
  findRewardDraft,
} from '../src/ecs/components/EncounterStateComponent';
import { findGameState, GameStatus } from '../src/ecs/components/GameStateComponent';
import { LevelLoader } from '../src/core/LevelLoader';

import { GameRenderer } from './GameRenderer';
import { GameLoop } from './GameLoop';
import { KeyboardInput } from './KeyboardInput';
import { UIManager } from './UIManager';
import { ClientEventBridge } from './ClientEventBridge';
import { AudioManager } from './AudioManager';
import { bootstrapClientData, installDataHotReload } from './bundled';
import { loadSaveState, persistSaveState } from './SaveStore';

/**
 * The run's seed. Fixed here so a reload reproduces the same drafts; `restartRun`
 * increments it, so each ending gives a genuinely different next run while staying
 * fully deterministic (spec 14 AC-08).
 */
const SEED = 0x12345678;

/**
 * `window.localStorage`, or `null` when the browser refuses it (private mode, a
 * blocked-cookies frame).
 *
 * The access itself can throw, which is why it is wrapped HERE rather than inside
 * `SaveStore`: the store's contract is "given a medium, read/write it best-effort",
 * and "is there a medium at all" is the composition root's question (spec 21 §4.1).
 */
function resolveStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // No persistence this session; the save still works in memory.
    return null;
  }
}

function mountCanvas(app: Application): void {
  const mount = document.getElementById('app');
  if (mount !== null) {
    mount.appendChild(app.canvas);
  }
}

/**
 * Boot the data layer, then the presentation layer (M10-T01, spec 16 AC-03).
 *
 * `await bootstrapClientData()` is the FIRST thing that happens, and it is
 * deliberately awaited BEFORE `new Application()` and before any `GameSimulator`
 * exists: the engine's config table must be filled and validated while the process
 * is still allowed to fail, because `step()` is a synchronous loop that can neither
 * await nor recover. A malformed `assets/data/*.json` therefore aborts the boot with
 * a `SchemaError` naming the exact field, instead of producing a run whose enemies
 * have `NaN` health.
 *
 * M10-T02: the config now comes from `./bundled`, not from `src/data/index`. That is
 * a deliberate build-concern decision, not a layering change — the tables still go
 * through the same `DataManager.loadAll` validation, but the Vite entry must be the
 * module that OWNS the raw JSON imports for the dev-mode hot reload to have a
 * boundary to stop at (spec 17 §4.3).
 */
async function main(): Promise<void> {
  await bootstrapClientData();

  const app = new Application();

  // v8: async init; the canvas is `app.canvas` (NOT `app.view`).
  await app.init({
    background: 0x14161c,
    resizeTo: window,
    antialias: true,
  });

  start(app);
}

void main();

/**
 * Assemble ONE run: the player, the rooms and the run's state singleton.
 *
 * Declared as a plain function rather than a closure over `sim` so it can be
 * handed to the simulator as `runSetup` and reused for the very first run without
 * a special case — the first run and every restarted one go through the exact same
 * code, which is the only way "restart == fresh start" can be true.
 *
 * Enemies use `ai` WITHOUT an explicit `targetEntityId`: the FSM auto-acquires the
 * nearest hostile, so this function never needs to know the player's id — which
 * matters because after a restart the player has a new one.
 *
 * M10-T02: the ROOMS are no longer declared here. `EncounterFactory.spawnFromData`
 * reads the run's whole room sequence from `assets/data/encounters.json` by depth
 * (spec 17 AC-01 / AC-02), so "how many rooms, which enemy types, how many of each,
 * and how long each wave waits" is a data edit. What remains in this file is the one
 * thing data cannot express: the player's spawn, and the run's state singleton.
 *
 * This function is also the reason a data hot reload works end to end: `restartRun`
 * calls it again, so a JSON edit re-reads the (already re-installed) config table and
 * rebuilds the run from the new numbers.
 *
 * M13-T01 gives it the SAVE, and that second parameter is what makes a purchase
 * felt: `PlayerFactory.spawnWithMeta` resolves the unlocked ids into additive deltas
 * and folds them into the assembly (spec 21 AC-04). A caller with no meta
 * progression passes a `SaveState.empty()` and gets exactly the pre-M13 player, so
 * the two cases share one code path rather than branching on "is meta enabled".
 */
function buildRun(world: World, saveState: SaveState): void {
  // The player is spawned BEFORE the room so the loader has something to place.
  // Its initial pose is immediately overwritten by `LevelLoader.enterRoom` — the
  // room's `2` tile is the authority on where a run begins (M12-T01 AC-03), and
  // passing a placeholder here is what keeps "the first run and every restart go
  // through the same code" true.
  //
  // No explicit `hp` / `maxHp`: the defaults are the baseline, and the meta bonuses
  // raise them. Passing the numbers here would override the very thing AC-04 is
  // about — and would leave the player at a partial bar on a run with `thick_skin`.
  const player = PlayerFactory.spawnWithMeta(world, saveState, {
    x: 0,
    y: 0,
    facingRadians: 0,
  });

  // The run's rooms, read by depth from `assets/data/encounters.json`.
  const roomEntity = EncounterFactory.spawnFromData(world);
  const encounter = world.getComponent(roomEntity, EncounterStateComponent);

  // M12-T01: build room 0's terrain — one `WallComponent` per `1` tile, the player
  // hard-reset onto the `2` tile's centre, and the room's `3` tiles collected into
  // the enemy landing pool the encounter scheduler draws from. This is the ONE
  // place the opening room is assembled, and `restartRun` reaches it again through
  // `runSetup`, which is why a restart is a genuinely fresh room rather than a
  // reused one (spec 19 §4.3).
  const openingRoomId = encounter === undefined ? undefined : currentRoomId(encounter);
  if (encounter !== undefined && openingRoomId !== undefined) {
    LevelLoader.enterRoom(world, { roomId: openingRoomId, playerId: player, encounter });
  }

  // The run's state singleton (M8-T01). Without it a player death would be an
  // ordinary death and the death overlay could never appear (spec 14 AC-11) — and
  // without it clearing the last room could never raise the victory overlay
  // (spec 15 AC-04).
  GameStateFactory.spawn(world);
}

/** The device-driven entity, i.e. the player — re-resolved every frame. */
function findPlayerId(world: World): EntityId | undefined {
  return world.query(PlayerInputComponent)[0];
}

function start(app: Application): void {
  mountCanvas(app);

  // M13-T01: the save is read ONCE, before the simulator exists, and INJECTED.
  // `src/` never learns whether a storage medium exists at all (spec 21 AC-01 / I1);
  // `SaveStore` owns the medium and `resolveStorage` owns "is there one".
  const storage = resolveStorage();
  const saveState = loadSaveState(storage);

  // M14-T01: the client event bridge OBSERVES the logic buses WITHOUT touching
  // `src/`. Its three tee queues are injected AS the pipeline's buses, so every hit
  // / death / dash the engine already publishes is retained for this frame's
  // presentation (spec 22 §4.1). The pipeline still sees plain `EventQueue`s.
  const bridge = new ClientEventBridge();

  const sim = new GameSimulator({
    systems: createDefaultSystems(bridge.hitQueue, bridge.deathQueue, bridge.dashQueue),
    seed: SEED,
    runSetup: buildRun,
    initialSaveState: saveState,
  });

  // The FIRST run goes through the same builder every restart will use.
  buildRun(sim.world, sim.saveState);

  const renderer = new GameRenderer(app);
  renderer.init();

  const input = new KeyboardInput(window);
  // M14-T01: the audio channel is created once, after the app exists. It is
  // best-effort — every method is a silent no-op when there is no audio backend,
  // so this never throws and never blocks the boot (spec 22 §4.4).
  const audio = new AudioManager();
  const loop = new GameLoop(sim, renderer, input, bridge, audio);

  const uiRoot = document.getElementById('ui-layer');
  const ui =
    uiRoot === null
      ? null
      : new UIManager({
          root: uiRoot,
          // The gold / darkness read-out (M9-T01 / M13-T01). `null` when the markup
          // is absent, which the UIManager treats as "no HUD" rather than an error.
          hud: document.getElementById('gold'),
          onSelect: (rewardId: string) => {
            // A click is an EXTERNAL, tick-aligned command. `sim.tick` is stable
            // between frames, and `GameLoop` flushes input BEFORE `step`, so this
            // lands on the tick the player saw the option on — and can never be a
            // past tick (spec 11 AC-03).
            sim.inject({ kind: 'selectReward', tick: sim.tick, rewardId });
          },
          onEnterHub: () => {
            // `R` on a terminal overlay is an external command, but unlike a click
            // it is not tick-aligned: it is a RUN-BOUNDARY operation, not a
            // simulation input, so it does not ride the input queue (spec 14 §4.5).
            //
            // M13-T01 changes what the boundary IS: it settles the run (banking its
            // darkness) and opens the camp, rather than immediately starting the
            // next run (spec 21 AC-02 / AC-03). The same callback serves BOTH
            // terminal overlays, because a won run and a lost one are settled by
            // exactly the same operation.
            sim.enterHub();
            persistSaveState(storage, sim.saveState);
          },
          onPurchase: (upgradeId: string) => {
            // A purchase is a META-boundary command, exactly like the settlement
            // above — never a `step()` input. The simulator re-validates it, so a
            // forged id or an unaffordable price is simply refused (spec 21 §4.6).
            if (sim.purchaseMetaUpgrade(upgradeId)) {
              persistSaveState(storage, sim.saveState);
            }
          },
          onStartRun: () => {
            // The camp's ONE exit. `restartRun` rebuilds the world and hands the
            // save to `buildRun`, which is where a purchase becomes a stronger
            // player (spec 21 AC-04). Nothing changed, so nothing is persisted —
            // but the call keeps the invariant "every save mutation is followed by
            // a write" obvious rather than conditional.
            sim.restartRun();
            // M14-T01: a restart destroys the entities the bridge may still hold
            // events for, so the buffer is dropped at the SAME boundary
            // (`scheduler.reset` cannot reach a client-side buffer). spec 22 §4.1.
            bridge.clear();
            persistSaveState(storage, sim.saveState);
          },
        });

  // Start the loop FIRST, then register the observers: PixiJS runs ticker listeners
  // in registration order, so the UI and HUD then read the world AFTER this frame's
  // `step()` + `syncWorld()` rather than a frame behind it.
  loop.start();

  if (ui !== null) {
    const manager = ui;
    app.ticker.add(() => {
      // The camp needs the save (M13-T01); every other surface ignores it. The
      // simulator's instance is passed by reference, so the menu is always looking
      // at live data rather than a copy taken at boot.
      manager.sync(sim.world, sim.saveState);
    });
  }
  installHud(app, sim, renderer);

  // Dev-mode data hot reload (M10-T02, spec 17 AC-03). Editing any
  // `assets/data/*.json` re-runs `DataManager.loadAll` with the new contents and
  // then re-opens the SAME run against them:
  //
  //  - `sim.currentSeed` (not `undefined`) keeps the reload a pure CONFIG change —
  //    a data edit must not quietly become a free re-roll (ADR-004);
  //  - `renderer.reset()` drops every cached view, every damage floater and the
  //    retired-id set, so nothing from the previous run can ghost over the new one.
  //    Entity views would clean themselves up, but floaters live on REAL time and
  //    would otherwise keep rising for up to a second.
  //
  // `installDataHotReload` is a no-op in a production build (`import.meta.hot` is
  // undefined there), so this block costs a built game nothing.
  installDataHotReload({
    onReload: () => {
      sim.restartRun(sim.currentSeed);
      renderer.reset();
      // M14-T01: same run boundary as `renderer.reset()` — drop any event still
      // buffered for the run being thrown away (spec 22 §4.1).
      bridge.clear();
    },
  });

  installCoinChime(app, sim, audio);
}

/**
 * M14-T01: play the coin chime whenever the player's gold INCREASES.
 *
 * WHY A GOLD OBSERVER RATHER THAN A BRIDGE EVENT: the logic layer publishes no
 * "pickup collected" event (there is no pickup bus), so the only honest signal is
 * the wallet itself. This rides the same per-frame read the HUD already does —
 * purely observational, and it never touches `World` (spec 22 §7 T4).
 */
function installCoinChime(app: Application, sim: GameSimulator, audio: AudioManager): void {
  let lastGold = readGold(sim.world);
  app.ticker.add(() => {
    const gold = readGold(sim.world);
    if (gold > lastGold) {
      audio.playCoin();
    }
    lastGold = gold;
  });
}

/** Minimal diagnostics HUD: tick / run status / player hp / counts / live draft. */
function installHud(app: Application, sim: GameSimulator, renderer: GameRenderer): void {
  const hud = document.getElementById('hud');
  if (hud === null) return;

  app.ticker.add(() => {
    // Re-resolved every frame: a restart replaces the player entity, so a captured
    // id would silently report a corpse's (frozen) health forever.
    const playerId = findPlayerId(sim.world);
    const health =
      playerId === undefined ? undefined : sim.world.getComponent(playerId, HealthComponent);
    const hp = health !== undefined ? health.hp : 0;
    const maxHp = health !== undefined ? health.maxHp : 0;

    const draft = findRewardDraft(sim.world);
    const rewardLine =
      draft === undefined
        ? 'reward  —'
        : `reward  ${String(draft.pendingRewards?.length ?? 0)} options · depth ${String(draft.depth)}`;

    // The room is resolved by COMPONENT, not through `findRewardDraft` — the latter
    // only answers while a draft is open, so it would report "—" for the whole fight.
    const roomId = sim.world.query(EncounterStateComponent)[0];
    const room = roomId === undefined ? undefined : sim.world.getComponent(roomId, EncounterStateComponent);
    const roomLine =
      room === undefined
        ? 'room    —'
        : `room    ${String(room.currentRoomIndex + 1)} / ${String(room.maxRooms)} · depth ${String(room.depth)}`;

    const status = findGameState(sim.world)?.status ?? GameStatus.PLAYING;

    hud.textContent =
      `tick ${sim.tick} · ${status}\n` +
      `player hp ${hp} / ${maxHp}\n` +
      `entities ${sim.world.entityCount} · views ${renderer.viewCount}\n` +
      roomLine +
      '\n' +
      rewardLine +
      // M13-T01: run tally first, then the SAVED total — two different numbers that
      // are easy to confuse, so both are shown with their own label.
      `\ndarkness run ${readDarkness(sim.world)} · saved ${sim.saveState.darkness}`;
  });
}

main();
