/**
 * UI write-blacklist (specs/027-hud-boon-ui T037 · FR-033 · contract §3).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * The presentation layer is a READ-ONLY consumer of `World`. It may read
 * components, call `readGold`, ask `findRewardDraft` and render — it may not
 * `addComponent` / `applyDamage` / `grantReward` / advance the simulation / draw
 * from the PRNG. Every intent travels back through the composition root as an
 * input event (contract §4).
 *
 * Comments are stripped before scanning, because the manager's own docstring
 * PROMISES it does not do these things ("no `addComponent`, no `applyDamage`") and
 * a naive scan would read the promise as the violation.
 *
 * `client/GameLoop.ts` is the one sanctioned exception: it is the loop driver, and
 * `sim.step` is its whole job. Its exclusion is asserted, not assumed — the suite
 * proves it is the ONLY file that steps.
 */

import { describe, expect, it } from 'vitest';

import { collectSources, stripComments } from '../harness/ui-source';

/** Write paths the UI must never take (contract §3). */
const BLACKLIST = [
  'addComponent',
  'removeComponent',
  'applyDamage',
  'addModifier',
  'removeModifier',
  'grantReward',
  'world.rng',
  'sim.step',
  'draftRewards',
  'nextUint32',
  '.sample(',
] as const;

/** The loop driver, and the ONLY file allowed to advance the simulation. */
const LOOP_DRIVER = 'client/GameLoop.ts';

/** Every client source, comment-stripped, excluding the loop driver. */
function clientSources(): readonly { readonly path: string; readonly code: string }[] {
  return collectSources('client')
    .filter((file) => file.path !== LOOP_DRIVER)
    .map((file) => ({ path: file.path, code: stripComments(file.source) }));
}

describe('T037 · the UI never writes the world (FR-033)', () => {
  it.each(BLACKLIST)('never calls `%s` anywhere in client/ (loop driver excepted)', (term) => {
    const offenders = clientSources()
      .filter((file) => file.code.includes(term))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('scans a real, non-empty set of files (the check is not vacuous)', () => {
    expect(clientSources().length).toBeGreaterThan(5);
  });

  it('keeps the manager itself clean of every write path', () => {
    // The strictest reading: the UI OWNER (the manager) is scanned on its own.
    const manager = clientSources().find((file) => file.path === 'client/UIManager.ts');
    expect(manager).toBeDefined();
    if (manager === undefined) return;
    for (const term of BLACKLIST) {
      expect(manager.code).not.toContain(term);
    }
  });
});

describe('T037 · the loop driver is the ONE sanctioned stepper', () => {
  it('is the only client file that advances the simulation', () => {
    const steppers = collectSources('client')
      .map((file) => ({ path: file.path, code: stripComments(file.source) }))
      .filter((file) => /sim\.step\(/.test(file.code))
      .map((file) => file.path);
    expect(steppers).toEqual([LOOP_DRIVER]);
  });
});
