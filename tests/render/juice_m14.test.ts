/**
 * M14-T01 · Audio & juice — the ENGINEERING net for the client-side presentation
 * additions (spec 22 AC-01 / AC-02 / AC-03).
 *
 * WHAT THIS SUITE COVERS
 * ----------------------
 *  - `ClientEventBridge` / `TeeEventQueue`: the tee retains a copy of every emitted
 *    event WHILE still feeding the base queue, survives the producer-side
 *    `clear()` (the death bus), and is dropped on `clear()`.
 *  - Screen shake: a landed hit arms it, it decays to EXACTLY zero, and an idle
 *    frame leaves the camera byte-for-byte the pre-M14 follow.
 *  - Hit/dash sparks: they spawn on a LAZY layer that exists only while alive, so
 *    the frozen M5/M12 scene-graph contracts (spec 20 I13) are restored the moment
 *    the sparks expire.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER
 * -----------------------------------
 * `AudioManager` is not imported HERE: this suite is about the render-side juice
 * (bridge / shake / sparks), and the audio channel has its OWN suite
 * (`tests/audio/audio_manager.test.ts`), which pins its silent degradation (spec 22
 * I9). NOTE the reason `AudioManager` must stay out of `GameRenderer`'s import graph
 * is NOT "howler blows up in node" — that premise was MEASURED false (howler imports
 * cleanly, `new Howl` does not throw). It is that the module referenced a bare DOM
 * global (`window`), which — pulled into `tests/**` via `GameRenderer` — would break
 * the DOM-less `npm run typecheck` (`lib: ES2022`) with TS2304 (it now guards with
 * `globalThis.window`). Live playback still needs a browser `AudioContext`
 * (spec 22 §6.3).
 *
 * The rig is the same duck-typed `Application` (`{ stage, ticker }`) the other
 * render suites use. PixiJS v8 under plain Node: never read `.width` / `.height` /
 * bounds on a `Text` (lazy canvas measurement throws). Only `.x` / `.y` / `.parent`
 * / `.children` are touched.
 */

import { describe, expect, it, vi } from 'vitest';
import { Container, Graphics, Text } from 'pixi.js';
import type { Application } from 'pixi.js';

import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { LevelLoader } from '../../src/core/LevelLoader';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { EnemyFactory } from '../../src/ecs/prefabs/EnemyFactory';
import { ATTACK_KEY } from '../../src/ecs/components/PlayerInputComponent';
import { addModifier, ZEUS_STRIKE_MODIFIER } from '../../src';
import { vec2 } from '../../src/core/math';
import type { DashEvent, EntityDeathEvent, HitEvent } from '../../src/ecs/events';
import { GameRenderer } from '../../client/GameRenderer';
import {
  ClientEventBridge,
  EMPTY_FRAME_EVENTS,
  TeeEventQueue,
} from '../../client/ClientEventBridge';
import type { FrameEvents } from '../../client/ClientEventBridge';
import { testEnemy } from '../harness/config-fixtures';

/* ========================================================================== *
 * Stand-ins + helpers                                                         *
 * ========================================================================== */

interface FakeTicker {
  deltaMS: number;
  add: () => void;
  remove: () => void;
}

function makeApp(deltaMs = 20): Application {
  const ticker: FakeTicker = { deltaMS: deltaMs, add: () => {}, remove: () => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

/** The render root: the CAMERA's LAST child (the static layer, if any, is index 0). */
function renderRoot(renderer: GameRenderer): Container {
  const camera = renderer.camera;
  const root = camera.children[camera.children.length - 1];
  if (root === undefined) throw new Error('QA: no render root under the camera');
  return root;
}

/** Every `Text` node anywhere under `container`, depth-first. */
function allTexts(container: Container): Text[] {
  const out: Text[] = [];
  for (const child of container.children) {
    if (child instanceof Text) out.push(child);
    if (child instanceof Container) out.push(...allTexts(child));
  }
  return out;
}

function hitEvent(x = 3, y = 0): HitEvent {
  return {
    tick: 0,
    attackerId: 0,
    targetId: 1,
    hitboxEntityId: 2,
    position: vec2(x, y),
    damage: 10,
    sourceModifier: null,
  };
}

function dashEvent(): DashEvent {
  return { tick: 0, entityId: 0, position: vec2(2, 2), direction: vec2(1, 0) };
}

function frameWith(partial: Partial<FrameEvents>): FrameEvents {
  return {
    hits: partial.hits ?? [],
    deaths: partial.deaths ?? [],
    dashes: partial.dashes ?? [],
  };
}

/* ========================================================================== *
 * B · ClientEventBridge / TeeEventQueue                                       *
 * ========================================================================== */
describe('B · ClientEventBridge is a pass-through tee (AC-01)', () => {
  it('TeeEventQueue retains a copy AND still feeds the base queue', () => {
    const queue = new TeeEventQueue<number>();
    queue.emit(1);
    queue.emit(2);

    expect(queue.frameSize).toBe(2); // client copy
    expect(queue.size).toBe(2); // producer/consumer wire

    // Draining the base queue (what ModifierSystem does) leaves the copy intact.
    expect(queue.drain()).toEqual([1, 2]);
    expect(queue.size).toBe(0);
    expect(queue.frameSize).toBe(2);

    expect(queue.drainFrame()).toEqual([1, 2]);
    expect(queue.frameSize).toBe(0);
    // A fresh array every drain: nothing to re-publish.
    expect(queue.drainFrame()).toEqual([]);
  });

  it('the client buffer survives the producer-side clear() (the death bus)', () => {
    const queue = new TeeEventQueue<EntityDeathEvent>();
    queue.emit({ tick: 0, entityId: 7 });

    // Exactly what DeathSystem does at the START of every update.
    queue.clear();
    expect(queue.size).toBe(0); // base queue emptied
    expect(queue.frameSize).toBe(1); // client copy retained
    expect(queue.drainFrame()).toEqual([{ tick: 0, entityId: 7 }]);
  });

  it('drainFrame() fans the three buses out and empties them', () => {
    const bridge = new ClientEventBridge();
    bridge.hitQueue.emit(hitEvent());
    bridge.deathQueue.emit({ tick: 0, entityId: 5 });
    bridge.dashQueue.emit(dashEvent());

    const frame = bridge.drainFrame();
    expect(frame.hits).toHaveLength(1);
    expect(frame.deaths).toHaveLength(1);
    expect(frame.dashes).toHaveLength(1);

    // Consumed EXACTLY once.
    const second = bridge.drainFrame();
    expect(second.hits).toHaveLength(0);
    expect(second.deaths).toHaveLength(0);
    expect(second.dashes).toHaveLength(0);
  });

  it('clear() drops buffered events WITHOUT touching the base queues', () => {
    const bridge = new ClientEventBridge();
    bridge.hitQueue.emit(hitEvent());
    bridge.deathQueue.emit({ tick: 0, entityId: 5 });
    bridge.dashQueue.emit(dashEvent());

    bridge.clear();

    expect(bridge.hitQueue.frameSize).toBe(0);
    expect(bridge.deathQueue.frameSize).toBe(0);
    expect(bridge.dashQueue.frameSize).toBe(0);
    // The logic-side wires are left alone — the scheduler already reset those.
    expect(bridge.hitQueue.size).toBe(1);
    expect(bridge.deathQueue.size).toBe(1);
    expect(bridge.dashQueue.size).toBe(1);
  });

  it('captures a REAL engine hit end-to-end and drives the renderer', () => {
    const app = makeApp(20);
    const bridge = new ClientEventBridge();
    const sim = new GameSimulator({
      systems: createDefaultSystems(bridge.hitQueue, bridge.deathQueue, bridge.dashQueue),
    });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 }); // id 0, facing +x
    EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0.75, y: 0, hp: 100, maxHp: 100 })); // id 1

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1);

    const events = bridge.drainFrame();
    // The pipeline STILL consumed the hit bus internally (the base queue is empty)...
    expect(bridge.hitQueue.size).toBe(0);
    // ...and the client copy saw it.
    expect(events.hits).toHaveLength(1);

    // The event the client sees is a REAL engine fact, not a re-constructed constant:
    // every field is pinned to a LITERAL. Player (id 0) at (0,0) faces +x, enemy
    // (id 1) at (0.75, 0); the hitbox centre is the impact point and the base attack
    // deals 10.
    const hit = events.hits[0];
    expect(hit?.attackerId).toBe(0);
    expect(hit?.targetId).toBe(1);
    expect(hit?.hitboxEntityId).toBe(2);
    expect(hit?.position.x).toBe(0.75);
    expect(hit?.position.y).toBe(0);
    expect(hit?.damage).toBe(10);
    expect(hit?.sourceModifier).toBe(null);

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world, 1, events);

    expect(renderer.sparkCount).toBe(6);
    expect(renderer.shakeTimeRemainingMs).toBe(180);
  });

  it('the tee FEEDS the live pipeline — an on-hit modifier still fires (forwarding proof)', () => {
    // `TeeEventQueue.emit` must copy AND delegate. This is the end-to-end proof that
    // the BASE wire still works: a real `zeus_strike` modifier only injects its bolt
    // if `ModifierSystem` DRAINS the hit off the base queue. If `emit` ever stopped
    // calling `super.emit`, no bolt would spawn and the modifier-sourced hit would be
    // absent — an assertion the "client copy" tests cannot make on their own.
    const bridge = new ClientEventBridge();
    const sim = new GameSimulator({
      systems: createDefaultSystems(bridge.hitQueue, bridge.deathQueue, bridge.dashQueue),
    });
    const player = PlayerFactory.spawn(sim.world, { x: 0, y: 0 }); // id 0, facing +x
    EnemyFactory.spawn(sim.world, ...testEnemy({ x: 0.75, y: 0, hp: 100, maxHp: 100 })); // id 1
    addModifier(sim.world, player, ZEUS_STRIKE_MODIFIER);

    sim.inject({ kind: 'keyDown', tick: 0, key: ATTACK_KEY });
    sim.step(1); // tick 0 — the base hit; ModifierSystem must SEE it to arm the bolt
    sim.step(1); // tick 1 — the bolt connects and publishes a modifier-sourced hit

    const events = bridge.drainFrame();
    // Two facts crossed the tee in this frame: the base attack (no provenance) and the
    // Zeus bolt (provenance = 'zeus_strike').
    expect(events.hits.map((h) => h.sourceModifier)).toEqual([null, ZEUS_STRIKE_MODIFIER]);
    expect(events.hits[0]?.damage).toBe(10);
    expect(events.hits[1]?.targetId).toBe(1);
  });
});

/* ========================================================================== *
 * S · Screen shake (AC-02)                                                    *
 * ========================================================================== */
describe('S · screen shake is armed by a hit and decays to exactly zero (AC-02)', () => {
  it('a hit arms it; nine idle frames decay it to 0; the camera then re-converges', () => {
    const app = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    // Player at (1.5, 1.5) -> px (15, 15); no screen => target = -playerPx = (-15, -15).
    PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);
    expect(renderer.shakeTimeRemainingMs).toBe(0);

    renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
    expect(renderer.shakeTimeRemainingMs).toBe(180);

    // 180ms / 20ms = 9 frames to decay to exactly 0.
    for (let i = 0; i < 9; i += 1) renderer.syncWorld(sim.world, 1);
    expect(renderer.shakeTimeRemainingMs).toBe(0);

    // With the shake gone, the follow lerp re-converges to the EXACT target — the
    // proof that the shake offset is truly 0 and not a tiny residual.
    for (let i = 0; i < 120; i += 1) renderer.syncWorld(sim.world, 1);
    expect(renderer.camera.x).toBeCloseTo(-1.5 * 10, 6);
    expect(renderer.camera.y).toBeCloseTo(-1.5 * 10, 6);
  });

  it('an EMPTY frame and a no-arg sync both leave the shake at rest', () => {
    const app = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 2, y: 2 });

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world); // the frozen single-arg call shape
    expect(renderer.shakeTimeRemainingMs).toBe(0);
    expect(renderer.sparkCount).toBe(0);

    renderer.syncWorld(sim.world, 1, EMPTY_FRAME_EVENTS);
    expect(renderer.shakeTimeRemainingMs).toBe(0);
    expect(renderer.sparkCount).toBe(0);
  });

  it('a hit ACTUALLY displaces the camera — the offset is applied, not merely armed', () => {
    // `Math.random` is the presentation-layer entropy the shake reads; pinning it to 0
    // makes the offset deterministic: `(0 - 0.5) * 6 = -3` on each axis. This is the
    // assertion that FAILS if `syncCamera` ever stops ADDING the shake to the lerp
    // (a hole the "armed / decays / reconverges" tests above do not close).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const app = makeApp(20);
      const sim = new GameSimulator({ systems: createDefaultSystems() });
      // Player at (1.5, 1.5) -> px (15, 15); no screen => target = -playerPx = (-15, -15).
      PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });

      const renderer = new GameRenderer(app);
      renderer.init();
      // First sync arms the shake BEFORE syncCamera samples it, so it lands this frame.
      renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));

      // Pure lerp from 0: 0 + (-15 - 0) * 0.2 = -3. Shake adds exactly -3 => -6.
      expect(renderer.camera.x).toBeCloseTo(-6, 9);
      expect(renderer.camera.y).toBeCloseTo(-6, 9);
      // And the shake really was armed (guards against a vacuous pass).
      expect(renderer.shakeTimeRemainingMs).toBe(180);
    } finally {
      randomSpy.mockRestore();
    }
  });
});

/* ========================================================================== *
 * P · Sparks (AC-03)                                                          *
 * ========================================================================== */
describe('P · hit/dash sparks live on a lazy world-space layer (AC-03)', () => {
  it('a hit spawns 6 sparks on a camera child that is NOT the render root', () => {
    const app = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);
    // Idle: the camera holds exactly the render root.
    expect(renderer.camera.children).toHaveLength(1);

    renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
    expect(renderer.sparkCount).toBe(6);
    // The lazy layer is mounted just below the root, so the root stays the LAST child.
    expect(renderer.camera.children).toHaveLength(2);
    const root = renderRoot(renderer);
    expect(renderer.camera.children[renderer.camera.children.length - 1]).toBe(root);
    const layer = renderer.camera.children[0];
    expect(layer).not.toBe(root);
    expect(layer?.children).toHaveLength(6);
    // Every spark is a Graphics, never a Text — the juice Text-count contract is safe.
    expect(allTexts(root)).toHaveLength(0);
    for (const spark of layer?.children ?? []) {
      expect(spark).toBeInstanceOf(Graphics);
    }
  });

  it('a dash spawns 5 sparks', () => {
    const app = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);

    renderer.syncWorld(sim.world, 1, frameWith({ dashes: [dashEvent()] }));
    expect(renderer.sparkCount).toBe(5);
  });

  it('after the spark lifetime the layer is torn down and the graph is restored', () => {
    const app = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);
    renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
    expect(renderer.sparkCount).toBe(6);
    expect(renderer.camera.children).toHaveLength(2);

    // 180ms / 20ms = 9 frames to expire.
    for (let i = 0; i < 9; i += 1) renderer.syncWorld(sim.world, 1);
    expect(renderer.sparkCount).toBe(0);
    // Frozen contract restored: the camera holds exactly the render root again.
    expect(renderer.camera.children).toHaveLength(1);
    expect(renderer.camera.children[0]).toBe(renderRoot(renderer));
  });

  it('the fxLayer stays empty — sparks never borrow the floater layer', () => {
    const app = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);
    renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));

    const root = renderRoot(renderer);
    const fxLayer = root.children[root.children.length - 1];
    expect(fxLayer?.children).toHaveLength(0);
  });

  it('reset() drops the sparks and the shake at a run boundary', () => {
    const app = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });

    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);
    renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
    expect(renderer.sparkCount).toBe(6);
    expect(renderer.shakeTimeRemainingMs).toBe(180);

    renderer.reset();
    expect(renderer.sparkCount).toBe(0);
    expect(renderer.shakeTimeRemainingMs).toBe(0);
    // The root survives the reset (only the transient FX are dropped).
    expect(renderer.camera.children).toHaveLength(1);
  });
});

/* ========================================================================== *
 * G · ADVERSARIAL probes for the lazy-mount scene graph (spec 22 I6/I12)      *
 * ========================================================================== */
describe('G · lazy mount crosses the static layer without breaking the frozen order', () => {
  it('G-B · particles-then-walls AND walls-then-particles both give [static?, particle?, root]', () => {
    // Case A: particles FIRST, walls SECOND (the particle layer is inserted below the
    // root, then the static layer must land BELOW the particle layer).
    {
      const app = makeApp(20);
      const sim = new GameSimulator({ systems: createDefaultSystems() });
      const player = PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });
      const renderer = new GameRenderer(app);
      renderer.init();
      renderer.syncWorld(sim.world);

      renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
      expect(renderer.camera.children).toHaveLength(2);
      const particleLayer = renderer.camera.children[0];
      const root = renderRoot(renderer);

      LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
      renderer.syncWorld(sim.world);

      const kids = renderer.camera.children;
      expect(kids).toHaveLength(3);
      expect(kids[0]).not.toBe(particleLayer); // static layer, behind everything
      expect(kids[1]).toBe(particleLayer); // the particle layer, pushed to the middle
      expect(kids[2]).toBe(root); // root is ALWAYS last
    }

    // Case B: walls FIRST, particles SECOND (the particle layer must slot in between
    // the static layer and the root, not above the root).
    {
      const app = makeApp(20);
      const sim = new GameSimulator({ systems: createDefaultSystems() });
      const player = PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });
      const renderer = new GameRenderer(app);
      renderer.init();
      LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
      renderer.syncWorld(sim.world);
      expect(renderer.camera.children).toHaveLength(2);
      const staticLayer = renderer.camera.children[0];
      const root = renderRoot(renderer);

      renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));

      const kids = renderer.camera.children;
      expect(kids).toHaveLength(3);
      expect(kids[0]).toBe(staticLayer); // static stays at the bottom
      expect(kids[1]).not.toBe(root);
      expect(kids[1]).not.toBe(staticLayer); // the particle layer, in the middle
      expect(kids[2]).toBe(root); // root is ALWAYS last
    }
  });

  it('G-C · six spawn -> expire rounds do not accumulate or leak a container', () => {
    const app = makeApp(20);
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const renderer = new GameRenderer(app);
    renderer.init();
    renderer.syncWorld(sim.world);
    expect(renderer.camera.children).toHaveLength(1); // idle baseline

    let firstLayer: Container | undefined;
    for (let round = 0; round < 6; round += 1) {
      renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
      expect(renderer.sparkCount).toBe(6);
      expect(renderer.camera.children).toHaveLength(2);

      const layer = renderer.camera.children[0];
      if (firstLayer === undefined) {
        firstLayer = layer;
      } else {
        // The SAME container is re-mounted every round — nothing new is allocated.
        expect(layer).toBe(firstLayer);
      }

      // 180ms / 20ms = 9 frames to expire.
      for (let i = 0; i < 9; i += 1) renderer.syncWorld(sim.world, 1);
      expect(renderer.sparkCount).toBe(0);
      // Back to the frozen idle graph: no residual container left behind.
      expect(renderer.camera.children).toHaveLength(1);
      expect(renderer.camera.children[0]).toBe(renderRoot(renderer));
    }
  });

  it('G-D · reset() drops sparks with walls present; destroy() empties the stage', () => {
    // reset() must detach the particle layer AND tear the static layer down, leaving
    // only the root.
    {
      const app = makeApp(20);
      const sim = new GameSimulator({ systems: createDefaultSystems() });
      const player = PlayerFactory.spawn(sim.world, { x: 1.5, y: 1.5 });
      const renderer = new GameRenderer(app);
      renderer.init();
      LevelLoader.enterRoom(sim.world, { roomId: 'start_room', playerId: player });
      renderer.syncWorld(sim.world);
      expect(renderer.camera.children).toHaveLength(2); // [static, root]

      renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
      expect(renderer.sparkCount).toBe(6);
      expect(renderer.camera.children).toHaveLength(3); // [static, particle, root]

      renderer.reset();
      expect(renderer.sparkCount).toBe(0);
      expect(renderer.shakeTimeRemainingMs).toBe(0);
      expect(renderer.camera.children).toHaveLength(1); // only the root survives
      expect(renderer.camera.children[0]).toBe(renderRoot(renderer));
    }

    // destroy() with a particle layer STILL mounted must not throw and must leave the
    // stage empty (the layer is detached before the recursive camera teardown).
    {
      const app = makeApp(20);
      const sim = new GameSimulator({ systems: createDefaultSystems() });
      PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
      const renderer = new GameRenderer(app);
      renderer.init();
      renderer.syncWorld(sim.world);
      renderer.syncWorld(sim.world, 1, frameWith({ hits: [hitEvent()] }));
      expect(renderer.sparkCount).toBe(6);
      expect(app.stage.children).toHaveLength(1);

      expect(() => renderer.destroy()).not.toThrow();
      expect(app.stage.children).toHaveLength(0);
    }
  });
});
