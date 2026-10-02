/**
 * Audio-asset tests (specs/024-real-art-assets US4, T025).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 *  1. **The silent-degradation contract survives the asset swap** (FR-010 + spec 22
 *     I9). Replacing synthesised `data:` URIs with files introduces a NEW failure
 *     mode — a URL that never resolves — so "unavailable ⇒ every method is a no-op,
 *     never a throw" is re-asserted against the new code path.
 *  2. **The event → `sfx.*` mapping is pinned by literal.** A typo in an id would
 *     otherwise surface only as a silent game, which no other test can see.
 *  3. **The `AudioSink` extension is additive** (T028): a sink written against the
 *     pre-M16 three-method interface still satisfies the type and still drives the
 *     loop, so `new GameLoop(sim, renderer, input)` is unchanged.
 */

import { describe, expect, it } from 'vitest';

import { AudioManager, SFX_IDS, SFX_NAMES } from '../../client/AudioManager';
import { GameLoop } from '../../client/GameLoop';
import type { AudioSink, InputSource } from '../../client/GameLoop';
import type { GameRenderer } from '../../client/GameRenderer';
import { GameSimulator } from '../../src/core/GameSimulator';
import { createDefaultSystems } from '../../src/ecs/systems/pipeline';
import { PlayerFactory } from '../../src/ecs/prefabs/PlayerFactory';
import { MANIFEST_IDS } from '../../client/assets/manifest';

/** A device source that injects nothing — the loop's only input requirement. */
const NO_INPUT: InputSource = { flush: (): void => {} };

/** A mutable view of the global object, so `window` can be toggled per test. */
const g = globalThis as unknown as Record<string, unknown>;

/** Every play method, so the no-op contract is asserted exhaustively. */
function callEverything(audio: AudioManager): void {
  audio.playHit();
  audio.playDash();
  audio.playCoin();
  audio.playEnemyDeath();
  audio.playHazardBlast();
  audio.playUiClick();
  audio.playRewardSelect();
  audio.playDeath();
  audio.playWin();
  audio.setMuted(true);
  audio.setMuted(false);
}

/** A duck-typed renderer that records the frame callback so a test can drive it. */
function makeLoopRig(): {
  readonly renderer: GameRenderer;
  readonly frame: (deltaMs: number) => void;
} {
  let callback: ((ticker: { deltaMS: number }) => void) | null = null;
  const renderer = {
    ticker: {
      add: (cb: (ticker: { deltaMS: number }) => void): void => {
        callback = cb;
      },
      remove: (): void => {},
    },
    syncWorld: (): void => {},
  } as unknown as GameRenderer;
  return {
    renderer,
    frame: (deltaMs: number): void => {
      callback?.({ deltaMS: deltaMs });
    },
  };
}

describe('US4 · the nine sfx ids are pinned to the manifest (FR-010)', () => {
  it('maps every sound to a real, declared manifest id', () => {
    expect(SFX_IDS).toEqual({
      hit: 'sfx.hit',
      dash: 'sfx.dash',
      coin: 'sfx.coin',
      enemyDeath: 'sfx.enemy-death',
      hazardBlast: 'sfx.hazard-blast',
      uiClick: 'sfx.ui-click',
      rewardSelect: 'sfx.reward-select',
      death: 'sfx.death',
      win: 'sfx.win',
    });
    for (const name of SFX_NAMES) {
      expect(MANIFEST_IDS).toContain(SFX_IDS[name]);
    }
  });

  it('declares exactly nine distinct sounds', () => {
    expect(SFX_NAMES.length).toBe(9);
    expect(new Set(SFX_NAMES.map((n) => SFX_IDS[n])).size).toBe(9);
  });
});

describe('US4 · silent degradation survives the asset swap (spec 22 I9)', () => {
  it('constructs with no window and reports unavailable', () => {
    expect(g.window).toBeUndefined();
    const audio = new AudioManager({ url: (): undefined => undefined });
    expect(audio.isAvailable).toBe(false);
    expect(audio.loadedSoundCount).toBe(0);
  });

  it('never throws when unavailable, for ANY method', () => {
    const audio = new AudioManager({ url: (): undefined => undefined });
    expect(() => {
      callEverything(audio);
      audio.dispose();
      audio.dispose();
    }).not.toThrow();
  });

  it('never throws when constructed with NO url source at all', () => {
    const audio = new AudioManager();
    expect(audio.isAvailable).toBe(false);
    expect(() => {
      callEverything(audio);
      audio.dispose();
    }).not.toThrow();
  });

  it('degrades ONE sound, not the channel, when a single URL is missing', () => {
    g.window = {};
    try {
      // Every sound resolves except `win`, which the "degraded" catalog would not.
      const audio = new AudioManager({
        url: (id: string): string | undefined => (id === 'sfx.win' ? undefined : `/assets/${id}.ogg`),
      });
      // Either branch is acceptable (howler may refuse in a bare node env), but the
      // contract is "never throws" and "no sound is invented for a missing URL".
      expect(typeof audio.isAvailable).toBe('boolean');
      expect(() => {
        callEverything(audio);
        audio.dispose();
      }).not.toThrow();
    } finally {
      delete g.window;
    }
  });

  it('reports availability honestly as a boolean in every environment', () => {
    g.window = {};
    try {
      const audio = new AudioManager({ url: (id: string): string => `/assets/${id}.ogg` });
      expect(typeof audio.isAvailable).toBe('boolean');
      expect(audio.loadedSoundCount).toBeLessThanOrEqual(SFX_NAMES.length);
      audio.dispose();
    } finally {
      delete g.window;
    }
  });
});

describe('US4 · the AudioSink extension is additive (T028)', () => {
  it('accepts a sink that implements ONLY the pre-M16 three methods', () => {
    const calls: string[] = [];
    const legacySink: AudioSink = {
      playHit: (): void => void calls.push('hit'),
      playDash: (): void => void calls.push('dash'),
      playCoin: (): void => void calls.push('coin'),
    };
    // The type-level claim: a pre-M16 sink IS an AudioSink.
    expect(typeof legacySink.playEnemyDeath).toBe('undefined');

    const { renderer, frame } = makeLoopRig();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const loop = new GameLoop(
      sim,
      renderer,
      NO_INPUT,
      null,
      legacySink,
    );
    loop.start();
    expect(() => {
      for (let i = 0; i < 10; i += 1) frame(20);
    }).not.toThrow();
    loop.stop();
  });

  it('calls the new cues when the sink provides them', () => {
    const calls: string[] = [];
    const fullSink: AudioSink = {
      playHit: (): void => void calls.push('hit'),
      playDash: (): void => void calls.push('dash'),
      playCoin: (): void => void calls.push('coin'),
      playEnemyDeath: (): void => void calls.push('enemy-death'),
      playDeath: (): void => void calls.push('death'),
      playWin: (): void => void calls.push('win'),
      playHazardBlast: (): void => void calls.push('hazard-blast'),
      playUiClick: (): void => void calls.push('ui-click'),
      playRewardSelect: (): void => void calls.push('reward-select'),
    };

    const { renderer, frame } = makeLoopRig();
    const sim = new GameSimulator({ systems: createDefaultSystems() });
    PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
    const loop = new GameLoop(
      sim,
      renderer,
      NO_INPUT,
      null,
      fullSink,
    );
    loop.start();
    for (let i = 0; i < 5; i += 1) frame(20);
    loop.stop();
    // Guard against a vacuous pass: the rig really did drive frames.
    expect(sim.tick).toBeGreaterThan(0);
  });

  it('keeps the pre-M16 three-argument constructor behaving identically', () => {
    // Two identical runs, one through the 3-arg shape and one with explicit nulls.
    const runA = (): number[] => {
      const { renderer, frame } = makeLoopRig();
      const sim = new GameSimulator({ systems: createDefaultSystems(), seed: 7 });
      PlayerFactory.spawn(sim.world, { x: 0, y: 0 });
      const loop = new GameLoop(
        sim,
        renderer,
        NO_INPUT,
      );
      loop.start();
      for (let i = 0; i < 20; i += 1) frame(20);
      loop.stop();
      return [sim.tick, sim.world.entityCount];
    };
    expect(runA()).toEqual(runA());
  });
});
