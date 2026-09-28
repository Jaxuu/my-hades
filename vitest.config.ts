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
    globals: true,
    clearMocks: true,
    // Use worker threads (in-memory module transfer). The default `forks` pool
    // writes transformed modules to temp files, which some sandboxed/CI
    // environments deny (EPERM). Threads keeps the run hermetic and portable.
    pool: 'threads',
  },
});
