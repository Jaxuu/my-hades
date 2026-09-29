/**
 * Renderer-bridge regression tests (specs/09_renderer_bridge_spec.md AC-02 / AC-03).
 *
 * This file verifies the RENDER BRIDGE (`client/GameRenderer`) against a real
 * `GameSimulator` and the real PixiJS scene graph. It needs NO jsdom and no real
 * browser: PixiJS's scene-graph objects (`Container` / `Graphics`) construct fine
 * under plain Node, and `Application` is only ever used through a duck-typed
 * stand-in (`{ stage, ticker }`).
 *
 * This does NOT violate `vitest.config.ts`'s node-only rule — it USES the node
 * environment. The core simulation suite still never touches DOM / canvas; only
 * this bridge suite constructs Pixi objects, and it does so without a browser.
 *
 * Assertions read only PUBLIC observables: `renderer.viewCount` and the Pixi
 * scene graph attached to `app.stage` (never `GameRenderer`'s private fields).
 */

import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { applyDamage } from '../../src/ecs/components/HealthComponent';
import { HitboxComponent } from '../../src/ecs/components/HitboxComponent';
import { ATTACK_KEY } from '../../src/ecs/components/PlayerInputComponent';
import { GameRenderer, PX_PER_UNIT } from '../../client/GameRenderer';
import { testEnemy } from '../harness/config-fixtures';

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

/** Duck-typed `Application`: a real Container stage + a controllable ticker. */
function makeApp(deltaMs: number): { app: Application; ticker: FakeTicker } {
  const ticker: FakeTicker = { deltaMS: deltaMs, add: () => {}, remove: () => {} };
  const app = { stage: new Container(), ticker } as unknown as Application;
  return { app, ticker };
}

/** The render root the renderer attached to the stage (its only stage child). */
function renderRoot(app: Application): Container {
  const root = app.stage.children[0];
  if (root === undefined) {
    throw new Error('renderer.init() did not attach a root to app.stage');
  }
  return root;
}

describe('GameRenderer bridge (spec 09)', () => {
  it('AC-02: projects Transform onto the scene graph with PX_PER_UNIT and no sign flip', () => {
    const { app } = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    // id 0 = player, id 1 = enemy (creation order == id order == child order).
    PlayerFactory.spawn(sim.world, { x: 1.5, y: -2, facingRadians: 0.75 });
    EnemyFactory.spawn(sim.world, ...testEnemy({ x: -3, y: 4, facingRadians: -1.25 }));

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);

    const children = renderRoot(app).children;
    const playerView = children[0];
    const enemyView = children[1];
    if (playerView === undefined || enemyView === undefined) {
      throw new Error('expected one view per spawned entity');
    }

    expect(PX_PER_UNIT).toBe(10);
    expect(playerView.x).toBe(1.5 * PX_PER_UNIT);
    expect(playerView.y).toBe(-2 * PX_PER_UNIT);
    expect(playerView.rotation).toBe(0.75);
    // Negative facing must be projected as-is: rotation === facingRadians.
    expect(enemyView.x).toBe(-3 * PX_PER_UNIT);
    expect(enemyView.y).toBe(4 * PX_PER_UNIT);
    expect(enemyView.rotation).toBe(-1.25);
  });

  it('AC-03: a corpse view settles after its death FX (no resurrection loop)', () => {
    const { app } = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const enemyId = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 3, y: 0, hp: 10, maxHp: 10 }));
    sim.step(1);

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);
    expect(renderer.viewCount).toBe(2);

    applyDamage(sim.world, enemyId, 999);
    sim.step(1);

    const counts: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      renderer.syncWorld(sim.world);
      counts.push(renderer.viewCount);
    }

    // FX = 400ms / 20ms = 20 frames. Past it, the count must be a CONSTANT 1
    // (the player alone) for the whole tail — never bouncing back to 2.
    const tail = counts.slice(25);
    expect(new Set(tail).size).toBe(1);
    expect(tail[0]).toBe(1);

    // The corpse itself is retained: only the VIEW was retired (spec 08 §4.4).
    expect(sim.world.isAlive(enemyId)).toBe(true);
  });

  it('AC-03: a destroyed entity (expired hitbox) has its view recycled', () => {
    const { app } = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    const renderer = new GameRenderer(app);
    renderer.init();

    // Rising edge on tick 0 -> CombatActionSystem spawns a hitbox entity.
    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1);
    renderer.syncWorld(sim.world);

    const hitboxIds = sim.world.query(HitboxComponent);
    expect(hitboxIds.length).toBe(1);
    const hitboxId = hitboxIds[0];
    if (hitboxId === undefined) {
      throw new Error('expected the attack to spawn a hitbox entity');
    }
    expect(renderer.viewCount).toBe(2); // player + hitbox

    // LifespanSystem destroys the hitbox once its `activeTicks` run out.
    sim.step(20);
    expect(sim.world.isAlive(hitboxId)).toBe(false);

    renderer.syncWorld(sim.world);
    expect(renderer.viewCount).toBe(1); // recycled via recycleDestroyed, not retired
  });
});
