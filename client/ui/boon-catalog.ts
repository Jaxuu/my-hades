/**
 * Boon catalog — the presentation layer's own, READ-ONLY view of `boons.json` (M19).
 * See specs/027-hud-boon-ui/contracts/ui-boon-data-table.md and data-model.md §2.
 *
 * `boons.json` carries appearance metadata only: a cosmetic `rarity`, an `icon`
 * GLYPH TOKEN (a CSS-drawn glyph, per user ruling U3 — no icon asset is shipped),
 * and a description TEMPLATE whose numbers are `{placeholders}` resolved from the
 * logic layer elsewhere.
 *
 * WHY IT LIVES UNDER `client/`
 * ----------------------------
 * Placing the table under `client/` gives STRUCTURAL isolation: `src/` cannot
 * import it without a path that does not make sense, and `src/data/bundled.ts`
 * loads its tables by NAME (it never enumerates a directory), so the logic core is
 * blind to this file (FR-030 / FR-036).
 *
 * DEGRADE, NEVER THROW
 * --------------------
 * The engine forbids `step()`-time validation and the interface must never crash on
 * a bad table (FR-050), so a missing field is normalised to a default here and the
 * "loud failure" for a malformed table lives in the test suite. This module is
 * DOM-free, pixi-free and random-free.
 */

import boonsJson from '../assets/boons.json';

import { normalizeRarity, type Rarity } from './quality';

/** One boon's presentation metadata, normalised and ready to render. */
export interface BoonMeta {
  readonly id: string;
  readonly rarity: Rarity;
  /** A CSS glyph token (NOT an asset id — user ruling U3). */
  readonly icon: string;
  /** A description template containing `{slot}` placeholders, or `''`. */
  readonly description: string;
}

/**
 * Glyph token -> the CSS character drawn for it.
 *
 * `default` is the fallback the contract names (`◆`). Any unknown or missing token
 * resolves here, so a typo in `boons.json` degrades to a visible placeholder rather
 * than a blank icon.
 */
export const ICON_GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  lightning: '↯',
  grape: '☣',
  trident: '◎',
  heart: '♥',
  boot: '»',
  default: '◆',
});

/** The fallback glyph token used for an unknown / missing token. */
export const DEFAULT_ICON_TOKEN = 'default';

/** The glyph character for a token, falling back to the default glyph. */
export function iconGlyph(token: string): string {
  return ICON_GLYPHS[token] ?? ICON_GLYPHS[DEFAULT_ICON_TOKEN] ?? '◆';
}

/** Coerce anything to a known glyph token, falling back to {@link DEFAULT_ICON_TOKEN}. */
export function normalizeIconToken(token: unknown): string {
  if (typeof token === 'string' && token.length > 0 && ICON_GLYPHS[token] !== undefined) {
    return token;
  }
  return DEFAULT_ICON_TOKEN;
}

/** The raw, unvalidated shape of one `boons.json` entry. */
interface RawBoonEntry {
  readonly rarity?: unknown;
  readonly icon?: unknown;
  readonly description?: unknown;
}

/** The parsed `boons.json`, still `unknown`-shaped until {@link parseBoonTable}. */
const RAW_TABLE = boonsJson as Readonly<Record<string, RawBoonEntry | undefined>>;

/**
 * Normalise one raw entry into a {@link BoonMeta}.
 *
 * Every field is optional at this seam: a missing `rarity` becomes `common`, a
 * missing / unknown `icon` becomes the default glyph token, and a missing
 * `description` becomes the empty string (which the presentation layer turns into
 * the reward's own label).
 */
function parseEntry(id: string, entry: RawBoonEntry | undefined): BoonMeta {
  return {
    id,
    rarity: normalizeRarity(entry?.rarity),
    icon: normalizeIconToken(entry?.icon),
    description: typeof entry?.description === 'string' ? entry.description : '',
  };
}

/** The normalised table, keyed by reward id. Frozen so nothing can mutate it. */
export const BOON_TABLE: Readonly<Record<string, BoonMeta>> = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW_TABLE).map(([id, entry]) => [id, parseEntry(id, entry)]),
  ),
);

/** Every id the table declares, ascending (deterministic). */
export function boonTableIds(): readonly string[] {
  return Object.keys(BOON_TABLE).sort();
}

/** The metadata for `id`, or `undefined` when the table does not declare it. */
export function getBoonMeta(id: string): BoonMeta | undefined {
  return BOON_TABLE[id];
}

/** The two ways a table can disagree with the logic layer's reward pool. */
export interface BoonTableValidation {
  /** Ids in the table that are NOT rewards in this build. */
  readonly dangling: readonly string[];
  /** Reward ids the table does NOT cover. */
  readonly missing: readonly string[];
}

/**
 * Compare the table against the logic layer's authoritative reward ids.
 *
 * Pure and total: it reports the disagreement rather than throwing, so a caller
 * (or a test) decides what a dangling / missing id means. In production a
 * disagreement is survivable — an unknown id renders with default metadata, and a
 * missing id falls back to its label (FR-035).
 */
export function validateBoonTable(poolIds: readonly string[]): BoonTableValidation {
  const tableIds = new Set(Object.keys(BOON_TABLE));
  const pool = new Set(poolIds);
  return {
    dangling: [...tableIds].filter((id) => !pool.has(id)).sort(),
    missing: [...pool].filter((id) => !tableIds.has(id)).sort(),
  };
}
