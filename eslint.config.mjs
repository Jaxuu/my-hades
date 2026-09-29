// ESLint flat config (ESLint 9 / Node 22).
//
// Purpose (M2-T02 tech-debt fix): replace the CI `grep` pure-logic gate with a real
// AST-based gate. The old regex `\b(window\.|document\.|Date\.now\(\)|Math\.random\(\))`
// false-positived on ordinary prose in comments (e.g. a sentence ending in "window."),
// which forced comment-wording gymnastics. ESLint inspects actual AST nodes, so
// comments can never trip the gate, while real browser-global / wall-clock /
// randomness ACCESSES are still rejected.
//
// The pure-logic prohibitions (window, document, Math.random, Date.now) and, as of
// M4-T01, the environment-dependent-comparison prohibitions (localeCompare, the
// toLocale* family, Intl) are scoped to `src/**/*.ts` ONLY and MUST NOT be relaxed.
//
// M5-T01 (specs/09_renderer_bridge_spec.md AC-01) adds the ENFORCED one-way
// dependency gate: `src/**/*.ts` may not import the render layer. `client/` is the
// opposite side of that gate — it is ALLOWED to touch DOM / BOM (window, document,
// canvas, requestAnimationFrame) and to import pixi.js, because it is the
// presentation layer. None of the `src/` rule blocks below apply to `client/**` or
// `vite.config.ts`; that is exactly the intent. Do NOT widen any `src/` block to
// cover `client/`, and do NOT weaken a `src/` block to accommodate the renderer.

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
    // Pure-logic gate — src/ must stay headless and deterministic (ADR-001 R1/R2/R6,
    // specs/00_harness_spec.md §6.1). These restrictions are non-negotiable.
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
        {
          // R6: `localeCompare` collates under the ambient locale / ICU data, so the
          // SAME two strings can order differently on two machines. `World.listComponents`
          // feeds `snapshot()`, so a locale-sensitive sort makes replay comparison
          // environment dependent. `a < b` on strings is a pure UTF-16 code-unit
          // comparison — use that instead.
          selector: 'CallExpression[callee.property.name="localeCompare"]',
          message:
            'src/ must stay environment-independent — no `localeCompare`; compare strings with `<` / `>` (ADR-001 R6).',
        },
        {
          // The `toLocale*` family is the same hazard in another disguise:
          // toLocaleLowerCase / toLocaleUpperCase / toLocaleString / toLocaleDateString
          // all consult the ambient locale.
          selector: 'CallExpression[callee.property.name=/^toLocale/]',
          message:
            'src/ must stay environment-independent — no `toLocale*` methods; use the locale-free variants (ADR-001 R6).',
        },
        {
          // `Intl` is locale/ICU-backed by definition.
          selector: 'NewExpression[callee.object.name="Intl"], NewExpression[callee.name="Intl"]',
          message: 'src/ must stay environment-independent — no `Intl` (ADR-001 R6).',
        },
      ],
      // AC-01 one-way dependency gate (specs/09_renderer_bridge_spec.md): the
      // render layer may import `src/`, but `src/` may NEVER import the render
      // layer or any browser/graphics runtime. This is the machine-executable form
      // of ADR-001 R1 (headless core) applied to the new `client/` directory.
      //
      // `paths` catches the bare package specifier; `patterns` catches the
      // relative shapes that point at the sibling `client/` tree. `..` is a
      // "dot" path segment, so a bare `**/client/**` glob does NOT match
      // `../client/x`; the explicit relative groups below close that gap.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pixi.js',
              message:
                'src/ must stay renderer-free — never import the render layer or its libraries (ADR-001 R1, spec 09 AC-01).',
            },
          ],
          patterns: [
            {
              group: [
                'pixi.js/*',
                '**/client',
                '**/client/**',
                '../client',
                '../client/**',
                '../../client',
                '../../client/**',
                '../../../client',
                '../../../client/**',
              ],
              message:
                'src/ must stay renderer-free — never import from client/ (ADR-001 R1, spec 09 AC-01).',
            },
          ],
        },
      ],
    },
  },
);
