/**
 * Seeded, deterministic pseudo-random number generator (M6-T01).
 * See docs/architecture/ADR-004-deterministic-prng.md.
 *
 * WHY THIS EXISTS: `Math.random()` is banned in `src/` (ADR-001 R2, enforced by the
 * ESLint pure-logic gate) because it makes the simulation non-reproducible — two
 * runs of the same input script would diverge the moment any system rolled a die.
 * A roguelike needs randomness (boon drafts, loot, room generation), so the engine
 * gets a PRNG whose ENTIRE state is a 32-bit integer the caller controls.
 *
 * THE CONTRACT (ADR-004):
 *  - The generator is a pure function of its seed: the same seed plus the same
 *    sequence of draws yields the same values, on every machine, forever.
 *  - The seed is an INPUT supplied from OUTSIDE the logic layer (a constant for
 *    tests/replays, a UI- or clock-derived number for a real run). The logic layer
 *    never invents one, so it stays free of wall-clock reads.
 *  - No `Math.random`, no `Date`, no `Intl` — nothing environment-dependent.
 *
 * ALGORITHM: Mulberry32 (Tommy Ettinger, public domain). It is a 32-bit state
 * generator with a single `uint32` word, a period of 2^32, and an excellent
 * quality/price ratio for a game: three `Math.imul`s and a handful of XOR/shift
 * ops per draw, no allocation. It is deliberately NOT a cryptographic generator —
 * nothing here guards against an adversary, only against non-reproducibility.
 *
 * The state transition is expressed entirely with 32-bit integer ops
 * (`>>> 0` keeps every intermediate unsigned), so it is bit-exact on any IEEE-754
 * host — which is the whole point: a float-based generator would be at the mercy
 * of rounding, and rounding is exactly what breaks cross-machine replay.
 */

/**
 * Default seed for a fresh `Random` / `World`.
 *
 * A FIXED default (rather than a time- or entropy-derived one) is a determinism
 * requirement, not a convenience: `new GameSimulator()` must behave identically in
 * every test, on every machine. A real roguelike run varies the seed explicitly —
 * `new GameSimulator({ seed })` — which is the caller's decision, made OUTSIDE the
 * logic layer (ADR-004 §Decision 3).
 */
export const DEFAULT_RANDOM_SEED = 0x12345678;

/** 2^32, the modulus of the 32-bit state space. */
const UINT32_RANGE = 4294967296;

/**
 * Read `items[index]`, throwing instead of returning `undefined`.
 *
 * `noUncheckedIndexedAccess` types every indexed read as `T | undefined` even when
 * the index is provably in range, so the two draw helpers below need a real guard.
 * Keeping it here means the range reasoning lives in ONE place and the public
 * methods stay free of casts (`as T`) and non-null assertions (`!`), both banned.
 */
function elementAt<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`Random: index ${String(index)} is out of range.`);
  }
  return value;
}

/**
 * A deterministic PRNG. One instance owns one 32-bit state word.
 *
 * Deliberately a CLASS with mutable state rather than a pure `(seed, n) => number`
 * function: a generator is consumed sequentially (draw N depends on draws 0..N-1),
 * and threading the state through every call site would be noise. The mutability is
 * contained — the state never escapes, and `World` owns exactly one instance
 * (ADR-004 §Decision 2).
 *
 * Determinism note: the state is NOT part of `World`'s snapshot. That is a
 * deliberate trade-off (ADR-004 §Trade-offs): the generator is a determinism
 * PRIMITIVE, not observable game state, and any divergence in draw order shows up
 * as a divergence in the state it produced (different boons, different waves) —
 * which the snapshot DOES capture. Including it would bloat every snapshot with a
 * value no assertion should ever need to read.
 */
export class Random {
  /** The seed this generator was constructed with (diagnostics / replay logs). */
  public readonly seed: number;

  /** Current 32-bit state word. Unsigned, always in `[0, 2^32)`. */
  private state: number;

  constructor(seed: number = DEFAULT_RANDOM_SEED) {
    if (!Number.isFinite(seed)) {
      throw new RangeError(`Random seed must be a finite number, received: ${String(seed)}`);
    }
    this.seed = seed;
    // `>>> 0` folds any finite number (including negatives and fractions) into the
    // 32-bit unsigned state space, so every seed is legal and every seed maps to
    // exactly one starting state.
    this.state = seed >>> 0;
  }

  /**
   * Draw the next raw 32-bit unsigned integer in `[0, 2^32)`.
   *
   * The primitive every other draw is built from, and the one that makes the
   * generator's behaviour fully specified: given a seed, this sequence is fixed.
   */
  public nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /**
   * Draw a float in `[0, 1)`.
   *
   * `[0, 1)` — closed on the left, OPEN on the right — is the contract every
   * downstream helper relies on: `Math.floor(nextFloat() * n)` therefore lands in
   * `[0, n - 1]` and can never index past the end.
   */
  public nextFloat(): number {
    return this.nextUint32() / UINT32_RANGE;
  }

  /**
   * Draw an integer in `[min, max]` — BOTH ENDS INCLUSIVE.
   *
   * Inclusive-on-both-ends is the natural reading of "a random integer between 2
   * and 5" and is what every caller in this codebase wants; an exclusive upper
   * bound is the silent off-by-one that produces "never the last option".
   *
   * @throws RangeError if `min` / `max` are not integers or `min > max`.
   */
  public nextInt(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new RangeError(
        `Random.nextInt(min, max) requires integers, received: ${String(min)}, ${String(max)}`,
      );
    }
    if (min > max) {
      throw new RangeError(
        `Random.nextInt(min, max) requires min <= max, received: ${String(min)}, ${String(max)}`,
      );
    }
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  /**
   * Draw one element uniformly from a non-empty array.
   *
   * @throws RangeError if the array is empty — "pick from nothing" is a caller bug,
   *   and returning `undefined` would push the failure into a `T | undefined` type
   *   every consumer would have to handle.
   */
  public pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Random.pick(items) requires a non-empty array.');
    }
    return elementAt(items, this.nextInt(0, items.length - 1));
  }

  /**
   * Draw `count` DISTINCT elements from `items`, in draw order (a partial
   * Fisher-Yates shuffle of a private copy — the caller's array is never mutated).
   *
   * "Distinct" is the property a reward draft needs: three copies of the same boon
   * would be a draft with one real option. Sampling without replacement is the
   * only way to guarantee it, and it keeps the draw count exact: exactly `count`
   * calls to `nextFloat()`, so the state advance is predictable.
   *
   * @throws RangeError if `count` is not a non-negative integer, or exceeds
   *   `items.length` (an unsatisfiable draft must fail loudly at the seam rather
   *   than silently return a short list).
   */
  public sample<T>(items: readonly T[], count: number): T[] {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`Random.sample(items, count) requires a non-negative integer count, received: ${String(count)}`);
    }
    if (count > items.length) {
      throw new RangeError(
        `Random.sample(items, count) cannot draw ${String(count)} distinct items from ${String(items.length)}.`,
      );
    }

    const pool = [...items];
    const drawn: T[] = [];
    for (let i = 0; i < count; i += 1) {
      const index = this.nextInt(0, pool.length - 1);
      drawn.push(elementAt(pool, index));
      // Remove the drawn item so it can never be drawn twice, and so the next
      // index is drawn from the SHRINKING pool (which is what makes the sample
      // uniform over all `count`-subsets, not just over permutations).
      pool.splice(index, 1);
    }
    return drawn;
  }
}
