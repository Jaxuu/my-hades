/**
 * Animation continuity, quantified (specs/026-hd-2d-art-assets T017 / FR-006 / SC-015).
 *
 * WHY A DEDICATED SUITE
 * ---------------------
 * FR-006 used to say the animation must be "视觉上连续流畅" and forbid "长时间僵直".
 * Neither phrase is testable, which `/speckit.analyze` flagged as a HIGH finding (A1).
 * The requirement was rewritten into FIVE countable properties, and this file is the
 * machine check for the three that a 600-frame observation window can express:
 *
 *   1. **no skipped frames** — the wall-clock interval between two consecutive frame
 *      DISPLAYS must not exceed the clip's nominal frame duration by more than 1.5x;
 *   2. **no blank frames** — every rendered frame must carry a real texture from the
 *      sheet (a switch between two clips must never show an empty quad);
 *   3. **no one-shot lock-up** — a non-`death` clip that is not a cycle must not stay
 *      on screen for more than 2x its nominal total duration.
 *
 * (The other two properties — idle/move cycle, attack/hit settle on the last frame —
 * are pinned directly in `tests/render/player_art.test.ts`, where the frame index is
 * observable one frame at a time.)
 *
 * HOW IT OBSERVES
 * ---------------
 * A REAL `GameSimulator` with the real default pipeline is stepped 600 times under a
 * fixed input script, with a real `GameRenderer` synced once per tick. The clip name
 * and frame index are read off the public scene graph (`AnimatedSprite.texture.label`
 * is the frame's own name, so no internal state is consulted).
 *
 * The nominal frame duration comes from `ANIM_FRAME_MS` — the SAME table the renderer
 * drives its clock with (quickstart §12). A copy of it here would be a second source
 * of truth and would let the two drift.
 *
 * ⚠️ The 1.5x / 2x thresholds are RATIOS against a nominal value, not wall-clock
 * budgets: the observation clock is the renderer's own `deltaMS`, which the test
 * fixes at 1000/60 ms, so the counts are reproducible on any machine.
 */

import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { AnimatedSprite, Application } from 'pixi.js';

import { ANIM_FRAME_MS, GameRenderer } from '../../client/GameRenderer';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { ATTACK_KEY } from '../../src/ecs/components/PlayerInputComponent';
import { vec2 } from '../../src/core/math';
import type { AnimationState } from '../../client/assets/sprite-map';
import { loadedCatalog } from '../harness/art-fixtures';

/** The observation window: 600 frames ~= 10 s at 60 fps (SC-015). */
const FRAMES = 600;
const FRAME_MS = 1000 / 60;

/** The clips that are cycles, so "displayed continuously" is the intended behaviour. */
const CYCLES: ReadonlySet<string> = new Set(['idle', 'move']);

interface Observation {
  readonly action: string;
  readonly frame: number;
  readonly total: number;
  readonly label: string | undefined;
}

function makeApp(): Application {
  const ticker = { deltaMS: FRAME_MS, add: (): void => {}, remove: (): void => {} };
  return { stage: new Container(), ticker } as unknown as Application;
}

/** The player's animated body, read through the public scene graph. */
function playerBody(app: Application): AnimatedSprite {
  const camera = app.stage.children[0];
  if (camera === undefined) throw new Error('no camera');
  const root = camera.children[camera.children.length - 1];
  if (root === undefined) throw new Error('no root');
  const view = root.children[0];
  if (view === undefined) throw new Error('no player view');
  const body = view.children.find((child): child is AnimatedSprite => 'totalFrames' in child);
  if (body === undefined) throw new Error('no animated body');
  return body;
}

/**
 * Run the scripted 600-frame window and return one observation per rendered frame.
 *
 * The script alternates a walk and a stop every 45 ticks and swings on a 120-tick
 * beat, so the window contains idle, move, attack and (after the swings connect)
 * hit — i.e. every property is exercised rather than only the easy state.
 */
async function observe(): Promise<readonly Observation[]> {
  const catalog = await loadedCatalog();
  const app = makeApp();
  const sim = new GameSimulator({ systems: createDefaultSystems() });
  PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
  const renderer = new GameRenderer(app, catalog);
  renderer.init();

  const observations: Observation[] = [];
  for (let tick = 0; tick < FRAMES; tick += 1) {
    // Walking for 45 ticks, standing for 45.
    sim.inject({ kind: 'move', tick, vector: tick % 90 < 45 ? vec2(1, 0) : vec2(0, 0) });
    if (tick % 120 === 0) sim.inject({ kind: 'keyDown', tick, key: ATTACK_KEY });
    if (tick % 120 === 1) sim.inject({ kind: 'keyUp', tick, key: ATTACK_KEY });

    sim.step(1);
    renderer.syncWorld(sim.world, 1);

    const body = playerBody(app);
    const label = body.texture.label;
    const action = (label ?? 'unknown').split('.')[2] ?? 'unknown';
    observations.push({ action, frame: body.currentFrame, total: body.totalFrames, label });
  }
  renderer.destroy();
  return observations;
}

describe('SC-015 · 600 frames of real animation contain zero continuity defects', () => {
  it('counts zero skipped frames, zero blank frames and zero one-shot lock-ups', async () => {
    const frames = await observe();

    // Guard against a vacuous pass: the window must have exercised real animation.
    expect(frames).toHaveLength(FRAMES);
    const actions = new Set(frames.map((f) => f.action));
    expect(actions.has('idle')).toBe(true);
    expect(actions.has('move')).toBe(true);
    expect(actions.has('attack')).toBe(true);
    expect(frames.some((f) => f.total > 1)).toBe(true);

    // ① skipped frames -------------------------------------------------------
    let skipped = 0;
    let sinceChangeMs = 0;
    let previous: Observation | undefined;
    for (const current of frames) {
      sinceChangeMs += FRAME_MS;
      if (previous !== undefined && current.label !== previous.label) {
        const settledOneShot =
          !CYCLES.has(previous.action) && previous.action !== 'death' && previous.frame === previous.total - 1;
        const nominal = ANIM_FRAME_MS[previous.action as AnimationState] ?? ANIM_FRAME_MS.idle;
        // A settled one-shot legitimately holds its last frame until the state
        // machine moves on, so its display interval carries no information about
        // skipping and is excluded.
        if (!settledOneShot && sinceChangeMs > nominal * 1.5 + 1e-6) skipped += 1;
        sinceChangeMs = 0;
      }
      previous = current;
    }

    // ② blank frames ---------------------------------------------------------
    const blank = frames.filter(
      (f) => f.label === undefined || f.total <= 0 || f.frame < 0 || f.frame >= f.total,
    ).length;

    // ③ one-shot lock-ups ----------------------------------------------------
    let lockedUp = 0;
    let runAction = '';
    let runMs = 0;
    for (const current of frames) {
      if (current.action !== runAction) {
        runAction = current.action;
        runMs = 0;
      }
      runMs += FRAME_MS;
      if (CYCLES.has(current.action) || current.action === 'death') continue;
      const nominalTotal = current.total * (ANIM_FRAME_MS[current.action as AnimationState] ?? 0);
      if (nominalTotal > 0 && runMs > nominalTotal * 2 + 1e-6) lockedUp += 1;
    }

    console.info(
      `[M18 continuity] frames=${String(frames.length)} actions=${[...actions].sort().join('/')} ` +
        `skipped=${String(skipped)} blank=${String(blank)} lockedUp=${String(lockedUp)}`,
    );
    expect(skipped).toBe(0);
    expect(blank).toBe(0);
    expect(lockedUp).toBe(0);
  });
});
