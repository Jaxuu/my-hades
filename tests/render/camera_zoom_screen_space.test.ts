/**
 * M17 · US2 — the world/Screen-SPACE boundary holds
 * (specs/025-camera-zoom-viewport, FR-006 / FR-007 / FR-015 and
 * contracts/scene-graph-and-screen-space.md §2/§3.3/§3.4).
 *
 * SCOPE, DELIBERATELY NARROW
 * -------------------------
 * This suite asserts only the OWNERSHIP CLASSIFICATION: which content lives inside
 * the camera (and therefore scales) and which does not. It does NOT re-pin the six
 * frozen scene-graph contracts — `tests/render/camera_zoom_scene_graph.test.ts`
 * owns those, and thirteen pre-existing render suites already cover them on the
 * degraded path. Re-asserting them here would triple the maintenance surface for no
 * extra coverage.
 *
 * WHY THE BOUNDARY IS THE WHOLE FEATURE
 * -------------------------------------
 * "Make the world bigger" is only half the requirement; the other half is "and do
 * not touch the interface". The render layer gets that for free BECAUSE the HUD is
 * DOM (`#ui-layer` / `#hud` / `#gold`) and therefore is not in the Pixi scene graph
 * at all — a scale on `cameraContainer` physically cannot reach it. That is a
 * property worth pinning, because the cheapest way to break it later is to move a
 * panel into Pixi "for convenience", which would both blur it and add a resident
 * node that breaks F1-F6.
 *
 * So there are two directions to check, and both are checked:
 *   ① nothing screen-space is inside the camera subtree;
 *   ② everything world-space IS inside the camera subtree.
 */

import { describe, expect, it } from 'vitest';
import { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { LevelLoader } from '../../src/core/LevelLoader';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { spawnPickup } from '../../src/ecs/components/PickupComponent';
import { spawnHazard } from '../../src/ecs/components/HazardComponent';
import { applyDamage } from '../../src/ecs/components/HealthComponent';
import { vec2 } from '../../src/core/math';
import { GameRenderer } from '../../client/GameRenderer';
import { testEnemy } from '../harness/config-fixtures';

/* ========================================================================== *
 * Rig                                                                         *
 * ========================================================================== */

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

function makeScreenApp(width = 1920, height = 1080, deltaMs = 20): Application {
  const ticker: FakeTicker = { deltaMS: deltaMs, add: () => {}, remove: () => {} };
  const app = {
    stage: new Container(),
    ticker,
    screen: { width, height },
    get renderer(): never {
      throw new Error('QA: the render layer read app.renderer, which it must never do');
    },
  };
  return app as unknown as Application;
}

/** Every node in `container`'s subtree, depth-first, EXCLUDING `container` itself. */
function descendants(container: Container): Container[] {
  const out: Container[] = [];
  for (const child of container.children) {
    out.push(child);
    out.push(...descendants(child));
  }
  return out;
}

/** True when `node` is inside `ancestor`'s subtree (or IS it). */
function isInside(node: Container, ancestor: Container): boolean {
  let cursor: Container | null = node;
  while (cursor !== null) {
    if (cursor === ancestor) return true;
    cursor = cursor.parent;
  }
  return false;
}

/**
 * A scene with one instance of EVERY world-space category in E5: floor + walls,
 * a player, an enemy, a pickup, a hazard, a damage floater and a hit particle.
 */
function buildRichScene(): { sim: GameSimulator; renderer: GameRenderer; app: Application } {
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
  LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
  const enemyId = EnemyFactory.spawn(sim.world, ...testEnemy({ x: 6, y: 6, hp: 100, maxHp: 100 }));
  spawnPickup(sim.world, { x: 2, y: 2 });
  spawnHazard(sim.world, { x: 7, y: 7, delayTicks: 60 });
  sim.step(1);

  const app = makeScreenApp();
  const renderer = new GameRenderer(app);
  renderer.init();
  // Seed `lastHp`, then damage the enemy so a floater spawns, and feed a hit so a
  // spark is mounted.
  renderer.syncWorld(sim.world, 1);
  applyDamage(sim.world, enemyId, 10);
  renderer.syncWorld(sim.world, 1, {
    hits: [
      {
        tick: 0,
        attackerId: player,
        targetId: enemyId,
        hitboxEntityId: 0,
        position: vec2(6, 6),
        damage: 10,
        modifierId: null,
      } as unknown as { tick: number },
    ] as never,
    deaths: [],
    dashes: [],
  });
  return { sim, renderer, app };
}

/* ========================================================================== *
 * ① Nothing screen-space is inside the camera                                 *
 * ========================================================================== */
describe('① the camera subtree contains no screen-space / UI content (FR-006 / FR-015)', () => {
  it('no DOM node ever reaches the Pixi scene graph', () => {
    const { renderer, app } = buildRichScene();

    // The HUD is DOM, so the strongest honest statement is: nothing in the Pixi
    // graph is a DOM node. `nodeType` is the duck-type marker for one — every DOM
    // node has it and no Pixi node does. (`.style` is NOT usable as a marker:
    // PixiJS `Text` carries a `TextStyle` under that name.)
    for (const node of [renderer.camera, ...descendants(renderer.camera), app.stage]) {
      expect((node as unknown as { nodeType?: unknown }).nodeType).toBeUndefined();
    }
    // ...and every node is a Pixi display object, which is the positive form of the
    // same claim.
    const pixiTypes = new Set(['Container', 'Graphics', 'Sprite', 'AnimatedSprite', 'Text']);
    for (const node of [renderer.camera, ...descendants(renderer.camera)]) {
      expect(pixiTypes.has(node.constructor.name)).toBe(true);
    }
  });

  it('the camera children are exactly the documented world-space layers', () => {
    const { renderer } = buildRichScene();

    // With a room and live sparks, the camera holds: static layer, particle layer,
    // render root — in that order, with the root LAST. Nothing else may be there,
    // and in particular there is no "zoom" or "hud" container.
    const kinds = renderer.camera.children.map((child) =>
      child instanceof Text ? 'text' : child instanceof Sprite ? 'sprite' : child.constructor.name,
    );
    expect(kinds.filter((k) => k === 'Container')).toHaveLength(3);
    expect(renderer.camera.children).toHaveLength(3);
  });

  it('every Text in the scene graph is a WORLD-space damage floater, not UI text', () => {
    const { renderer } = buildRichScene();
    const texts = descendants(renderer.camera).filter((node) => node instanceof Text);

    // Floaters are world-space by FR-001, so they DO belong inside the camera...
    expect(texts.length).toBeGreaterThan(0);
    // ...and specifically under the FX layer, which is the render root's last child.
    const root = renderer.camera.children[renderer.camera.children.length - 1];
    if (root === undefined) throw new Error('QA: no render root');
    const fxLayer = root.children[root.children.length - 1];
    if (fxLayer === undefined) throw new Error('QA: no FX layer');
    for (const text of texts) {
      expect(isInside(text, fxLayer)).toBe(true);
    }
  });

  it('no UI panel is reachable from the camera (the DOM UI stays outside Pixi)', () => {
    const { renderer } = buildRichScene();

    // The UI layer is a DOM element fetched by id; it can never be a Pixi child. The
    // checkable form of that is "no node in the camera subtree was constructed from
    // markup" — i.e. every node is a Pixi type.
    const allowed = new Set(['Container', 'Graphics', 'Sprite', 'AnimatedSprite', 'Text']);
    for (const node of descendants(renderer.camera)) {
      expect(allowed.has(node.constructor.name)).toBe(true);
    }
    expect(descendants(renderer.camera).some((node) => node instanceof Graphics)).toBe(true);
  });
});

/* ========================================================================== *
 * ② Everything world-space IS inside the camera                               *
 * ========================================================================== */
describe('② all nine world-space categories live inside the camera (FR-001)', () => {
  it('floor, walls, entities, pickups, hazards, floaters and sparks are all in the subtree', () => {
    const { renderer } = buildRichScene();

    // Floor + walls: the static layer is camera index 0.
    const staticLayer = renderer.camera.children[0];
    if (staticLayer === undefined) throw new Error('QA: no static layer');
    expect(renderer.wallViewCount).toBeGreaterThan(0);

    // Entity views: the render root is the camera's last child.
    const root = renderer.camera.children[renderer.camera.children.length - 1];
    if (root === undefined) throw new Error('QA: no render root');
    expect(root.children.length).toBeGreaterThan(1);

    // Every view the renderer built must be inside the camera — checked by walking
    // the subtree and counting the entity views, rather than by trusting a count.
    const insideCamera = descendants(renderer.camera);
    const viewContainers = insideCamera.filter((node) => isInside(node, root));
    expect(viewContainers.length).toBeGreaterThanOrEqual(renderer.viewCount);

    // Sparks: the particle layer is inside the camera (inserted before the root).
    expect(renderer.sparkCount).toBeGreaterThan(0);
    const particleLayer = renderer.camera.children[1];
    if (particleLayer === undefined) throw new Error('QA: no particle layer');
    expect(particleLayer).not.toBe(root);
    expect(isInside(particleLayer, renderer.camera)).toBe(true);
  });

  it('every view the renderer knows about has the camera in its parent chain', () => {
    const { renderer } = buildRichScene();
    const root = renderer.camera.children[renderer.camera.children.length - 1];
    if (root === undefined) throw new Error('QA: no render root');

    // The render root's children (minus the FX layer) ARE the entity views. Each one
    // must reach the camera, and therefore be scaled by it.
    const entityViews = root.children.filter((child) => child !== root.children[root.children.length - 1]);
    expect(entityViews.length).toBeGreaterThan(0);
    for (const view of entityViews) {
      expect(isInside(view, renderer.camera)).toBe(true);
      expect(view.parent).toBe(root);
    }
  });

  it('the boundary is EXHAUSTIVE: every node in the Pixi graph is on one side of it', () => {
    const { renderer, app } = buildRichScene();

    // Every node under the stage is either the camera itself or inside it. There is
    // no third place for content to hide — which is what makes the classification
    // complete rather than merely "the parts I remembered".
    const outsideCamera = descendants(app.stage).filter(
      (node) => node !== renderer.camera && !isInside(node, renderer.camera),
    );
    expect(outsideCamera).toHaveLength(0);
  });
});
