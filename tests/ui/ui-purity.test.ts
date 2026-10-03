/**
 * Presentation-layer purity (specs/027-hud-boon-ui T036 · FR-030 / SC-007 / SC-012).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * M19 is a PURE presentation-layer refactor: `src/` must be byte-identical, the
 * dependency arrow must still point one way (`client -> src`, never back), and the
 * 17-segment pipeline must be unchanged. All three are asserted here rather than
 * assumed, because each fails silently and independently:
 *
 *  - a stray `import` in `src/` would not break a build, only the layering;
 *  - a new system would still run, just a different simulation;
 *  - a changed `src/` file is the one thing a snapshot digest cannot localise.
 *
 * WHY A CONTENT HASH AND NOT `git status`
 * ---------------------------------------
 * The natural guard is `git status --short -- src/`. It is not usable from inside
 * this project's vitest worker threads: spawning a child process (`execSync` via
 * `cmd.exe`, or `execFileSync('git', …)`) fails with `EBUSY` in the Windows sandbox.
 * The hermetic equivalent is a content hash of the whole `src/` tree, pinned to the
 * value measured on the pre-M19 commit — a changed, added or deleted file under
 * `src/` moves it. (The `git status` / `git diff --stat` output is recorded in
 * production/m19-evidence.md alongside this.)
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createDefaultSystems } from '../../src';
import { collectSources, stripComments } from '../harness/ui-source';

/**
 * The `src/` tree's aggregate digest, measured on the pre-M19 commit.
 *
 * SHA-256 over `path \0 content \0` for every `.ts` file under `src/`, sorted by
 * path. A legitimate future change to `src/` re-pins it; M19 may not.
 */
const SRC_TREE_DIGEST = '27ec06ead427c1aa8911368f1bd1dfe94f75349f50d83355066085175d2aad8f';
const SRC_FILE_COUNT = 85;

/** SHA-256 over the whole `src/` tree, in a stable order, line-ending independent. */
function hashSrcTree(): string {
  const hash = createHash('sha256');
  for (const file of collectSources('src')) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.source.replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The canonical 17-segment pipeline (spec 05 C7 / spec 08 §5.2). */
const PIPELINE = [
  'TransformSnapshotSystem',
  'PlayerControllerSystem',
  'FreezeSystem',
  'AISystem',
  'HazardSystem',
  'MovementSystem',
  'DashSystem',
  'StateSystem',
  'CombatActionSystem',
  'CollisionSystem',
  'StatusEffectSystem',
  'ModifierSystem',
  'DeathSystem',
  'EncounterSystem',
  'RewardSystem',
  'PickupSystem',
  'LifespanSystem',
] as const;

describe('T036 · src/ is untouched by the presentation layer (FR-030 / SC-007)', () => {
  it('keeps the whole src/ tree byte-identical to the pre-M19 commit', () => {
    expect(hashSrcTree()).toBe(SRC_TREE_DIGEST);
    // Guard against a vacuous pass: the tree really was read.
    expect(collectSources('src')).toHaveLength(SRC_FILE_COUNT);
  });

  it('never imports the client from src/ (one-way dependency)', () => {
    const sources = collectSources('src');
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const code = stripComments(file.source);
      expect(code).not.toMatch(/from\s+['"][^'"]*client\//);
      expect(code).not.toMatch(/import\(\s*['"][^'"]*client\//);
    }
  });
});

describe('T036 · the 17-segment pipeline is unchanged (SC-012)', () => {
  it('still runs the canonical 17 systems in order', () => {
    const names = createDefaultSystems().map((system) => system.name);
    expect(names).toEqual([...PIPELINE]);
    expect(names).toHaveLength(17);
  });

  it('keeps LifespanSystem last and the reward chain in order', () => {
    const names = createDefaultSystems().map((system) => system.name);
    expect(names[names.length - 1]).toBe('LifespanSystem');
    expect(names.indexOf('RewardSystem')).toBeGreaterThan(names.indexOf('EncounterSystem'));
    expect(names.indexOf('ModifierSystem')).toBeLessThan(names.indexOf('LifespanSystem'));
  });
});
