// ESLint flat config (ESLint 9 / Node 22).
//
// Purpose (M2-T02 tech-debt fix): replace the CI `grep` pure-logic gate with a real
// AST-based gate. The old regex `\b(window\.|document\.|Date\.now\(\)|Math\.random\(\))`
// false-positived on ordinary prose in comments (e.g. a sentence ending in "window."),
// which forced comment-wording gymnastics. ESLint inspects actual AST nodes, so
// comments can never trip the gate, while real browser-global / wall-clock /
// randomness ACCESSES are still rejected.
//
// The four pure-logic prohibitions (window, document, Math.random, Date.now) are
// scoped to `src/**/*.ts` ONLY and MUST NOT be relaxed.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Never lint build output, caches or generated Vite timestamp configs.
    ignores: [
      'node_modules/',
      'dist/',
      'coverage/',
      '.tmp/',
      '.vitest-cache/',
      'vitest.config.ts.timestamp-*.mjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Project-wide TypeScript conventions. `_`-prefixed identifiers are the
    // intentional "unused on purpose" marker: systems routinely write
    // `update(world, _ctx)` when they do not read the context. Without this,
    // the default `args: 'after-used'` would flag those parameters.
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // The prefab option interfaces deliberately use `interface X extends Y {}` as
      // named extension points (PlayerSpawnOptions / EnemySpawnOptions). That is a
      // readable project convention, not a mistake, so the generic rule is relaxed.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  {
    // Pure-logic gate — src/ must stay headless and deterministic (ADR-001 R1/R2,
    // specs/00_harness_spec.md §6.1). These four restrictions are non-negotiable.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'window',
          message: 'src/ must stay headless — no DOM globals (ADR-001 R1).',
        },
        {
          name: 'document',
          message: 'src/ must stay headless — no DOM globals (ADR-001 R1).',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'src/ must stay deterministic — no randomness (ADR-001 R2).',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'src/ must stay wall-clock free — time comes only from step() (ADR-001 R2).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // `new Date()` reads the wall clock too — same determinism hazard as
          // Date.now(), caught separately because it is a constructor call.
          selector: 'NewExpression[callee.name="Date"]',
          message: 'src/ must stay wall-clock free — no `new Date()` (ADR-001 R2).',
        },
      ],
    },
  },
);
