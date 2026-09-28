/**
 * Deep-clone + deep-freeze helpers used for immutable snapshots.
 * See specs/00_harness_spec.md §5.
 */

/** Recursively clone plain data (objects/arrays/primitives). */
export function cloneValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    out[key] = cloneValue(source[key]);
  }
  return out;
}

/** Recursively freeze an object graph in place and return it as readonly. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      deepFreeze(record[key]);
    }
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
