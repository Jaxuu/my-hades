/**
 * SaveStore — the ONLY place a save meets a storage medium (M13-T01).
 * See specs/21_hub_and_meta_progression_spec.md §3.1 / §4.1 (AC-01).
 *
 * WHY THIS FILE EXISTS AT ALL, given `SaveState` already knows its own shape.
 * Because "what a save IS" and "where a save LIVES" are different questions with
 * different owners. `src/core/SaveState.ts` answers the first and is forbidden from
 * answering the second — `src/` may not touch `localStorage`, a file or the network
 * (the ESLint AST gate enforces it), and the ban is not ceremonial: a storage read
 * is synchronous I/O whose failure modes (quota, private browsing, a hand-edited
 * value) have no place inside a deterministic simulation.
 *
 * So the medium lives here, in `client/`, behind two functions and a `Storage`
 * parameter. That parameter is the dependency-injection seam: `main.ts` passes
 * `window.localStorage`, a test could pass an in-memory stub, and a future desktop
 * build could pass a file-backed shim — with no change to `src/` and none to this
 * module either.
 *
 * EVERYTHING HERE IS BEST-EFFORT, NEVER FATAL. A save is a convenience, and the
 * failure it must never cause is "the game will not start": an unreadable,
 * unparsable, or unwritable save degrades to "start over" rather than throwing out
 * of the boot sequence. That is the opposite of the data layer's rule (a malformed
 * `assets/data/*.json` MUST abort), and deliberately so — one is a build artifact
 * the developer controls, the other is user state that can be corrupted by a
 * hundred things outside this program.
 */

import { SaveState } from '../src/core/SaveState';

/**
 * The storage key, versioned.
 *
 * The `.v1` suffix is a promise about the FORMAT rather than the key: a future
 * incompatible change to `SaveStateData` mints `v2` and simply stops reading `v1`,
 * which is a clean "old saves are ignored" rather than a migration path nobody
 * tests.
 */
export const SAVE_STORAGE_KEY = 'my-hades.save.v1';

/**
 * Read the save, or a fresh empty one.
 *
 * `storage` may be `null` — the caller's way of saying "this environment has no
 * persistence" (private mode, a blocked-cookies frame, a headless render). A null
 * storage, a missing key, a value that is not JSON, and a value that is JSON but
 * not a save ALL return `SaveState.empty()`, because from the player's point of
 * view those four are the same situation: no usable progress.
 */
export function loadSaveState(storage: Storage | null): SaveState {
  if (storage === null) return SaveState.empty();
  try {
    const raw = storage.getItem(SAVE_STORAGE_KEY);
    if (raw === null) return SaveState.empty();
    return SaveState.from(JSON.parse(raw) as unknown);
  } catch {
    // A corrupt save is discarded, not repaired: half-trusting a value we could
    // not parse is how a player ends up with negative currency.
    return SaveState.empty();
  }
}

/**
 * Write the save. A failure is swallowed — a full disk must not end the session.
 *
 * `toJSON()` is what goes over the wire, so the stored bytes are exactly the
 * documented `SaveStateData` shape and nothing else (no class, no prototype, no
 * `Set`).
 */
export function persistSaveState(storage: Storage | null, state: SaveState): void {
  if (storage === null) return;
  try {
    storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(state.toJSON()));
  } catch {
    // Quota exceeded / storage disabled. Nothing to do and nothing to say: the
    // in-memory save is still authoritative for this session.
  }
}
