import { defineConfig } from 'vitest/config';
import os from 'node:os';

export default defineConfig({
  test: {
    // Pure-logic headless tests: node environment only. NO jsdom.
    environment: 'node',
    // `tests/**/*.test.ts` deliberately covers the QA-owned adversarial suite
    // (tests/harness/independent-verify.test.ts) as well, so independent
    // verification runs on EVERY commit and in CI — not only during review.
    // See docs/architecture/ADR-001-headless-ecs-foundation.md §6.1.
    include: ['tests/**/*.test.ts'],
    // M10-T01 (spec 16 AC-03): the config table is filled ONCE per worker, before
    // the test module is imported, by the same `bootstrapData()` the browser entry
    // point calls. Doing it here — rather than in a `beforeAll` — is what lets a
    // test call `EnemyFactory.spawn` at module scope, and it is what makes "the
    // engine is never constructed against an empty table" true for every suite
    // rather than for the suites that remembered.
    setupFiles: ['./tests/harness/setup-config.ts'],
    globals: true,
    clearMocks: true,
    // Use worker threads (in-memory module transfer). The default `forks` pool
    // writes transformed modules to temp files, which some sandboxed/CI
    // environments deny (EPERM). Threads keeps the run hermetic and portable.
    pool: 'threads',
    // M17-T01: cap the worker pool BELOW the core count.
    //
    // `tests/performance/stress.test.ts` G2 asserts a WALL-CLOCK ratio (300-enemy
    // time / 50-enemy time < 9, typical ~7.1). Its own comment records that the
    // absolute numbers drift by up to 2x with load, so it is only meaningful when
    // the machine is not oversubscribed — and the default (`maxThreads` = core
    // count, 8 here) runs one worker per core PLUS the main process, so the two
    // halves of that ratio are measured against a saturated CPU. M17 measured the
    // effect directly: with the pool saturated, adding 8 test files moved the
    // ratio from ~7 to ~10 and the assertion failed 4 runs in 5; leaving one core
    // of headroom is the standard remedy and does not touch a single assertion.
    poolOptions: {
      threads: {
        maxThreads: Math.max(1, Math.floor((os.availableParallelism?.() ?? 4) / 2)),
        minThreads: 1,
      },
    },
  },
});
