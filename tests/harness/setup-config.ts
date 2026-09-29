/**
 * Harness Bootstrap — loads the config table before ANY test file runs (M10-T01).
 * See specs/16_data_driven_pipeline_spec.md §4.3 (AC-03) and §6.
 *
 * This is the test-side twin of `client/main.ts`'s bootstrap: the same call, made
 * once per test worker, before the test module is imported. It has to happen that
 * early because a test file may call `EnemyFactory.spawn` / `createDefaultSystems`
 * while its module body is still being evaluated — and because the engine's
 * contract is that a `GameSimulator` is never constructed against an empty table.
 *
 * The top-level `await` is the point rather than a style choice: it suspends this
 * module's evaluation until the table is installed, and ESM guarantees an importer
 * waits for that. A fire-and-forget `void bootstrapData()` would race the first
 * `createDefaultSystems()` call and produce a `SchemaError` in whichever test
 * happened to lose.
 *
 * Wired in via `vitest.config.ts` → `test.setupFiles`.
 */

import { bootstrapData } from '../../src/data/index';

await bootstrapData();
