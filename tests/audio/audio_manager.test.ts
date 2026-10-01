/**
 * M14-T01 · AudioManager silent degradation (spec 22 AC-01 / I9).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * spec 22 §6.3 asserted that `AudioManager` "is NOT in node tests" because
 * `howler` touches `window` at import time and would "blow up". That premise is
 * FALSE, and was MEASURED to be false: `howler` imports cleanly with
 * `window === undefined` (`typeof window === 'undefined'`), and `new Howl(...)`
 * does not throw in node either. So the single most important property of an
 * audio channel that must never be able to break the game loop — "silent
 * degradation, NEVER a throw" (I9) — was left with ZERO coverage.
 *
 * This file closes that hole against the REAL `AudioManager` under the node test
 * environment (no jsdom), rather than declaring it an untestable hole.
 *
 * WHAT IT PROVES
 * --------------
 *  - import + construct with no `window` (the node env) => `isAvailable === false`;
 *  - every public method is a no-op that NEVER throws while unavailable (I9);
 *  - `dispose()` is safe to call twice;
 *  - with a `window` present (but no real audio backend), construction and every
 *    call still never throw — the try/catch resilience.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE (honest scope)
 * --------------------------------------------------
 * It cannot verify REAL playback, which needs a browser `AudioContext`. The three
 * `data:audio/wav;base64` placeholder sounds and the live Howl wiring stay
 * browser-only and are evidenced by `typecheck:client` + `vite build` (spec 22
 * §6.3). `howler` isolation from `GameRenderer`'s import graph (I10) is checked by
 * the source scan recorded in the M14-T01 verification report, not here.
 */

import { describe, expect, it } from 'vitest';
import { AudioManager } from '../../client/AudioManager';

/** A mutable view of the global object, so `window` can be toggled per test. */
const g = globalThis as unknown as Record<string, unknown>;

describe('AudioManager · silent degradation (AC-01 / I9)', () => {
  it('constructs with no window (the node env) and reports unavailable', () => {
    expect(g.window).toBeUndefined();
    const audio = new AudioManager();
    expect(audio.isAvailable).toBe(false);
  });

  it('every method is a no-op that never throws when unavailable (I9)', () => {
    const audio = new AudioManager();
    expect(audio.isAvailable).toBe(false);
    expect(() => {
      audio.playHit();
      audio.playDash();
      audio.playCoin();
      audio.setMuted(true);
      audio.setMuted(false);
    }).not.toThrow();
  });

  it('dispose() is safe to call twice', () => {
    const audio = new AudioManager();
    expect(() => {
      audio.dispose();
      audio.dispose();
    }).not.toThrow();
  });

  it('with a window present but no audio backend, construction and calls never throw', () => {
    g.window = {};
    try {
      const audio = new AudioManager();
      expect(() => {
        audio.playHit();
        audio.playDash();
        audio.playCoin();
        audio.setMuted(true);
        audio.dispose();
      }).not.toThrow();
      // Either branch (real Howls or a caught failure) is acceptable — the contract
      // is "never throws", not "always available".
      expect(typeof audio.isAvailable).toBe('boolean');
    } finally {
      delete g.window;
    }
  });
});
