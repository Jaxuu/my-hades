/**
 * main — the composition root of the presentation layer (M5-T01).
 * See specs/09_renderer_bridge_spec.md §1.2 / §5.3.
 *
 * Wires the headless simulation core to PixiJS:
 *   GameSimulator (13-system pipeline)  ->  GameRenderer (read-only)  ->  PixiJS
 *   KeyboardInput  ->  per-tick injection  ->  GameSimulator.step(1)
 *
 * The player is granted BOTH boons so the modifier engine can be observed working
 * under rendering; two AI-driven enemies provide motion and combat targets.
 *
 * This file is the ONLY place `src/` and the render layer are joined — the one-way
 * dependency stays intact (client -> src).
 */

import { Application } from 'pixi.js';

import { GameSimulator } from '../src/core/GameSimulator';
import { createDefaultSystems } from '../src/ecs/systems/pipeline';
import { PlayerFactory } from '../src/ecs/prefabs/PlayerFactory';
import { EnemyFactory } from '../src/ecs/prefabs/EnemyFactory';
import { HealthComponent } from '../src/ecs/components/HealthComponent';
import {
  addModifier,
  DIONYSUS_BLIGHT_MODIFIER,
  ZEUS_STRIKE_MODIFIER,
} from '../src/ecs/components/ModifierComponent';

import { GameRenderer } from './GameRenderer';
import { GameLoop } from './GameLoop';
import { KeyboardInput } from './KeyboardInput';

const PLAYER_MAX_HP = 100;
const ENEMY_MAX_HP = 60;

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

  const sim = new GameSimulator({ systems: createDefaultSystems() });

  // Player: hardware-driven (NO `ai` — `ai` and hardware input are mutually
  // exclusive and would throw a RangeError). Two boons prove the modifier engine
  // still works under the renderer.
  const playerId = PlayerFactory.spawn(sim.world, {
    x: 0,
    y: 0,
    facingRadians: 0,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
  });
  addModifier(sim.world, playerId, ZEUS_STRIKE_MODIFIER);
  addModifier(sim.world, playerId, DIONYSUS_BLIGHT_MODIFIER);

  // Two AI-driven enemies so the world moves and fights on its own.
  EnemyFactory.spawn(sim.world, {
    x: 4,
    y: 0,
    hp: ENEMY_MAX_HP,
    maxHp: ENEMY_MAX_HP,
    ai: {
      targetEntityId: playerId,
      sightRadius: 12,
      attackRadius: 1.5,
      windupTicks: 30,
      cooldownTicks: 60,
    },
  });
  EnemyFactory.spawn(sim.world, {
    x: -4,
    y: 3,
    hp: ENEMY_MAX_HP,
    maxHp: ENEMY_MAX_HP,
    ai: {
      targetEntityId: playerId,
      sightRadius: 12,
      attackRadius: 1.5,
      windupTicks: 30,
      cooldownTicks: 60,
    },
  });

  const renderer = new GameRenderer(app);
  renderer.init();

  const input = new KeyboardInput(window);
  const loop = new GameLoop(sim, renderer, input);

  installHud(app, sim, renderer, playerId);
  loop.start();
}

/** Minimal HUD: current tick / player hp / entity + view counts. */
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
    hud.textContent =
      `tick ${sim.tick}\n` +
      `player hp ${hp} / ${maxHp}\n` +
      `entities ${sim.world.entityCount} · views ${renderer.viewCount}`;
  });
}

main();
