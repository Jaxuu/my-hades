import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Pure-logic headless tests: node environment only. NO jsdom.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    clearMocks: true,
    // Use worker threads (in-memory module transfer). The default `forks` pool
    // writes transformed modules to temp files, which some sandboxed/CI
    // environments deny (EPERM). Threads keeps the run hermetic and portable.
    pool: 'threads',
  },
});
