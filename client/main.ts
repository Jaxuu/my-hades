/**
 * main — the composition root of the presentation layer.
 * See specs/09_renderer_bridge_spec.md §1.2 / §5.3 and
 * specs/11_roguelike_loop_spec.md §4.5.
 *
 * Wires the headless simulation core to PixiJS AND to the DOM:
 *   GameSimulator (15-system pipeline)  ->  GameRenderer (read-only)  ->  PixiJS
 *   GameSimulator                       ->  UIManager    (read-only)  ->  #ui-layer
 *   KeyboardInput  ->  per-tick injection  ->  GameSimulator.step(1)
 *   UIManager click ->  selectReward injection  ->  GameSimulator.step(1)
 *
 * M6-T01 replaces the hand-placed enemies with a REAL `EncounterFactory` room, so the
 * roguelike loop is observable end to end: clear both waves -> the room rolls a
 * three-option draft -> the overlay appears -> picking a boon descends the room and
 * spawns a bigger wave. The player is deliberately granted NO boons up front — boons
 * now arrive through the draft, which is the whole point of the milestone.
 *
 * This file is the ONLY place `src/` and the presentation layer are joined — the
 * one-way dependency stays intact (client -> src). It is also the only place the
 * seed is chosen, which is what keeps the wall clock and any entropy out of `src/`
 * (ADR-004 §Decision 3).
 */

import { Application } from 'pixi.js';

import { GameSimulator } from '../src/core/GameSimulator';
import { createDefaultSystems } from '../src/ecs/systems/pipeline';
import { PlayerFactory } from '../src/ecs/prefabs/PlayerFactory';
import { EncounterFactory } from '../src/ecs/prefabs/EncounterFactory';
import { HealthComponent } from '../src/ecs/components/HealthComponent';
import { findRewardDraft } from '../src/ecs/components/EncounterStateComponent';

import { GameRenderer } from './GameRenderer';
import { GameLoop } from './GameLoop';
import { KeyboardInput } from './KeyboardInput';
import { UIManager } from './UIManager';

/**
 * The run's seed. Fixed here so a reload reproduces the same drafts; swap it for a
 * per-run value (UI entropy, a clock read, a user-supplied code) to vary the run —
 * the logic layer stays deterministic either way (ADR-004 §4.3).
 */
const SEED = 0x12345678;

const PLAYER_MAX_HP = 100;
const ENEMY_MAX_HP = 40;

function mountCanvas(app: Application): void {
  const mount = document.getElementById('app');
  if (mount !== null) {
    mount.appendChild(app.canvas);
  }
}

function main(): void {
  const app = new Application();

  // v8: async init; the canvas is `app.canvas` (NOT `app.view`).
  void app
    .init({
      background: 0x14161c,
      resizeTo: window,
      antialias: true,
    })
    .then(() => {
      start(app);
    });
}

function start(app: Application): void {
  mountCanvas(app);

  const sim = new GameSimulator({ systems: createDefaultSystems(), seed: SEED });

  const playerId = PlayerFactory.spawn(sim.world, {
    x: 0,
    y: 0,
    facingRadians: 0,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
  });

  // A two-wave room. AI enemies (`ai` and hardware input are mutually exclusive —
  // the player is the device-driven one) so the fight plays itself out.
  const enemy = (x: number, y: number) => ({
    x,
    y,
    hp: ENEMY_MAX_HP,
    maxHp: ENEMY_MAX_HP,
    ai: {
      targetEntityId: playerId,
      sightRadius: 14,
      attackRadius: 1.6,
      windupTicks: 36,
      cooldownTicks: 60,
    },
  });

  EncounterFactory.spawn(sim.world, {
    waves: [
      { delayTicks: 0, enemies: [enemy(5, 0)] },
      { delayTicks: 120, enemies: [enemy(-5, 2), enemy(5, -2)] },
    ],
  });

  const renderer = new GameRenderer(app);
  renderer.init();

  const input = new KeyboardInput(window);
  const loop = new GameLoop(sim, renderer, input);

  const uiRoot = document.getElementById('ui-layer');
  const ui =
    uiRoot === null
      ? null
      : new UIManager({
          root: uiRoot,
          onSelect: (rewardId: string) => {
            // A click is an EXTERNAL, tick-aligned command. `sim.tick` is stable
            // between frames, and `GameLoop` flushes input BEFORE `step`, so this
            // lands on the tick the player saw the option on — and can never be a
            // past tick (spec 11 AC-03).
            sim.inject({ kind: 'selectReward', tick: sim.tick, rewardId });
          },
        });

  // Start the loop FIRST, then register the observers: PixiJS runs ticker listeners
  // in registration order, so the UI and HUD then read the world AFTER this frame's
  // `step()` + `syncWorld()` rather than a frame behind it.
  loop.start();

  if (ui !== null) {
    const manager = ui;
    app.ticker.add(() => {
      manager.sync(sim.world);
    });
  }
  installHud(app, sim, renderer, playerId);
}

/** Minimal HUD: tick / player hp / counts / the live reward draft. */
function installHud(
  app: Application,
  sim: GameSimulator,
  renderer: GameRenderer,
  playerId: number,
): void {
  const hud = document.getElementById('hud');
  if (hud === null) return;

  app.ticker.add(() => {
    const health = sim.world.getComponent(playerId, HealthComponent);
    const hp = health !== undefined ? health.hp : 0;
    const maxHp = health !== undefined ? health.maxHp : 0;

    const draft = findRewardDraft(sim.world);
    const rewardLine =
      draft === undefined
        ? 'reward  —'
        : `reward  ${String(draft.pendingRewards?.length ?? 0)} options · depth ${String(draft.depth)}`;

    hud.textContent =
      `tick ${sim.tick}\n` +
      `player hp ${hp} / ${maxHp}\n` +
      `entities ${sim.world.entityCount} · views ${renderer.viewCount}\n` +
      rewardLine;
  });
}

main();
