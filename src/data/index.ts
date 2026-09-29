/**
 * Data layer barrel (M10-T01). See specs/16_data_driven_pipeline_spec.md.
 *
 * `src/data` is the ONLY place that knows about JSON config: `schemas.ts` owns
 * the shape and the validation, `DataManager` owns the parsed registry, and
 * `bundled.ts` owns the asynchronous Bootstrap. Everything else in `src/` reads
 * config through `DataManager` and never touches a raw file.
 */

export * from './schemas';
export * from './DataManager';
export * from './bundled';
