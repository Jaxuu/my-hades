/**
 * SaveState — the OUT-OF-RUN progression record (M13-T01).
 * See specs/21_hub_and_meta_progression_spec.md §3.1 (AC-01).
 *
 * WHY THIS IS NOT A COMPONENT
 * ---------------------------
 * Everything else that survives a tick in this engine is component data on a
 * `World` entity (spec 00 §6.1), and that is exactly what it must NOT be here.
 * A `World` is thrown away wholesale by `GameSimulator.restartRun` — that is the
 * whole point of a restart — so a component would be destroyed by the very
 * operation the save is supposed to survive. `SaveState` therefore lives BESIDE
 * the world, owned by the simulator, and the run only ever READS it.
 *
 * WHY IT IS NOT PERSISTED HERE EITHER
 * -----------------------------------
 * This class knows the SHAPE of the save and nothing about where it is kept. It
 * never touches `localStorage`, a file, or the network; `src/` is forbidden from
 * doing so at all (the ESLint AST gate), and that restriction is not a formality
 * — a storage read is synchronous I/O with a failure mode (quota, private mode,
 * a corrupt value) that has no place inside a deterministic simulation.
 *
 * The contract is therefore two pure conversions, and the CALLER owns the medium:
 *
 *     toJSON()  : SaveState -> SaveStateData     (a plain, JSON-safe object)
 *     from()    : unknown   -> SaveState         (parsed, validated)
 *
 * `client/SaveStore.ts` is the one place that binds those to `localStorage`, and
 * the simulator receives an already-constructed instance through
 * `GameSimulatorOptions.initialSaveState` (constructor injection — AC-01). A
 * different medium (a file, a server, an in-memory stub in a test) needs no
 * change to `src/` at all.
 *
 * DETERMINISM
 * -----------
 * This object is deliberately OUTSIDE `GameSimulator.snapshot()`. Two runs of the
 * same script must produce byte-identical snapshots whether or not the player
 * owns meta upgrades, and a snapshot that embedded the save would make replay
 * comparison depend on unrelated progress. The save is observable through
 * `sim.saveState`, which is where a test or the hub UI reads it.
 */

/**
 * The serialized form of a save — plain data, safe to `JSON.stringify`.
 *
 * `unlockedUpgrades` is an ARRAY rather than a set or a map because it is the
 * literal shape of the file. It is stored SORTED (see `SaveState`) so the same
 * progress always serializes to the same bytes, which is what makes "did this
 * save change?" a diff rather than a guess.
 */
export interface SaveStateData {
  /** Out-of-run currency, earned by banking a run's collected darkness. Non-negative. */
  readonly darkness: number;
  /** Ids of the meta upgrades bought so far, ascending. */
  readonly unlockedUpgrades: readonly string[];
}

/** @throws TypeError / RangeError with a `save.*` path, so a bad file names its field. */
function assertNonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative finite number, received: ${String(value)}`);
  }
  return value;
}

/** @throws TypeError if `value` is not a non-empty string. */
function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string, received: ${String(value)}`);
  }
  return value;
}

export class SaveState {
  /**
   * Out-of-run currency. Written by `GameSimulator.enterHub` (which banks a run's
   * collected darkness) and by a purchase; never negative.
   */
  public darkness: number;

  /**
   * Unlocked upgrade ids. A `Set` rather than an array so "is this unlocked?" and
   * "unlock it once" are both O(1) and cannot produce a duplicate — the two
   * operations a purchase performs.
   *
   * Private: the read side is the `unlockedUpgrades` getter, so no caller can
   * push into it and bypass the dedup.
   */
  private readonly unlocked: Set<string>;

  constructor(darkness = 0, unlockedUpgrades: readonly string[] = []) {
    this.darkness = assertNonNegativeFinite(darkness, 'save.darkness');
    this.unlocked = new Set<string>();
    for (const id of unlockedUpgrades) {
      this.unlocked.add(assertNonEmptyString(id, 'save.unlockedUpgrades[]'));
    }
  }

  /**
   * The unlocked ids, ASCENDING (UTF-16 code units — never `localeCompare`).
   *
   * A fresh array per call, sorted, for two reasons: the hub UI diffs it against
   * the previous frame to decide whether to re-render, and the save file must be
   * byte-stable. Handing out the live set would allow both to drift.
   */
  public get unlockedUpgrades(): readonly string[] {
    return [...this.unlocked].sort(compareCodeUnits);
  }

  /** Whether `id` is unlocked. */
  public hasUpgrade(id: string): boolean {
    return this.unlocked.has(id);
  }

  /**
   * Unlock `id`.
   *
   * @returns `true` when it was newly unlocked, `false` when it already was — so a
   *   caller that has just paid can tell "this purchase bought something" from
   *   "this purchase was a duplicate", without a second lookup.
   */
  public unlockUpgrade(id: string): boolean {
    if (this.unlocked.has(id)) return false;
    this.unlocked.add(assertNonEmptyString(id, 'save.unlockedUpgrades[]'));
    return true;
  }

  /**
   * Add `amount` darkness, clamped at `0`. Returns the new total.
   *
   * Negative amounts are legal (they are what a purchase uses) and clamp rather
   * than throwing, mirroring `addGold`: the affordability check belongs to the
   * caller that knows the price, not to the ledger.
   */
  public addDarkness(amount: number): number {
    if (!Number.isFinite(amount)) {
      throw new RangeError(`save.darkness delta must be a finite number, received: ${String(amount)}`);
    }
    this.darkness = Math.max(0, this.darkness + amount);
    return this.darkness;
  }

  /** A plain, JSON-safe copy. The ONLY way out of this class. */
  public toJSON(): SaveStateData {
    return { darkness: this.darkness, unlockedUpgrades: this.unlockedUpgrades };
  }

  /** A brand-new, empty save: no currency, nothing unlocked. */
  public static empty(): SaveState {
    return new SaveState();
  }

  /**
   * Parse a persisted save.
   *
   * STRICT, and deliberately so: this is the one boundary where data comes from
   * OUTSIDE the process (a file the user could have hand-edited, a value written
   * by an older build), so a wrong type is reported rather than coerced — the same
   * "validate at the seam, loudly" rule `src/data/schemas.ts` applies to JSON
   * config. The caller decides what a bad save means; `client/SaveStore.ts`
   * answers "start over" rather than crashing the boot.
   *
   * @throws TypeError / RangeError naming the offending field.
   */
  public static from(data: unknown): SaveState {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new TypeError('save must be an object with { darkness, unlockedUpgrades }');
    }
    const source = data as Record<string, unknown>;
    const darkness = assertNonNegativeFinite(source.darkness, 'save.darkness');
    const rawUpgrades = source.unlockedUpgrades;
    if (!Array.isArray(rawUpgrades)) {
      throw new TypeError('save.unlockedUpgrades must be an array of upgrade ids');
    }
    return new SaveState(darkness, rawUpgrades as readonly string[]);
  }
}

/**
 * Deterministic (locale-free) string ordering — UTF-16 code units, not collation
 * (ADR-001 R6). A local copy rather than an import, because `SaveState` is the
 * bottom of the core layer and must depend on nothing.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
