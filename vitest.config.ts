import { defineConfig } from 'vitest/config';

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
  },
});
