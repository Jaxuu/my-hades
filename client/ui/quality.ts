/**
 * Quality (rarity) — the STATIC, purely cosmetic tier of a boon (M19).
 * See specs/027-hud-boon-ui/data-model.md §3 and design/engineering-architecture.md §5.4.
 *
 * Rarity is DECLARED, never rolled. It carries no number, no probability and no
 * behaviour: the three tiers differ only in how a card LOOKS. That is the whole
 * contract (FR-016 / FR-031) — folding a tier into the draw algorithm or into a
 * damage formula would break determinism, and this module is deliberately too
 * small to hide such a thing.
 *
 * The module is DOM-free, pixi-free and random-free so it can be unit-tested in
 * node (there is no jsdom in this project). The CLASS-NAME hooks (`boon-rarity-*`,
 * `boon-icon-frame--*`) are owned by `client/UIManager.ts` instead — the skin
 * contract test scans the manager for them, and DOM literals belong with the DOM
 * owner.
 */

/** The three cosmetic tiers, in ascending order of prestige. */
export type Rarity = 'common' | 'epic' | 'legendary';

/** Every tier, in a fixed order (deterministic iteration for tests / tooling). */
export const RARITIES: readonly Rarity[] = Object.freeze(['common', 'epic', 'legendary']);

/** The tier a boon falls back to when its metadata is missing or malformed. */
export const DEFAULT_RARITY: Rarity = 'common';

/**
 * The three colours, pinned as LITERALS.
 *
 * These are the single source of the rarity palette (mirrored into `index.html` as
 * `--rarity-common|epic|legendary`). A test asserts the three are pairwise
 * different, so a mapping that collapsed to one colour could not pass.
 */
export const RARITY_COLORS: Readonly<Record<Rarity, string>> = Object.freeze({
  common: '#3f6ea8',
  epic: '#8a5cd0',
  legendary: '#ffcd4a',
});

/** Chinese tier labels — the COLOUR-BLIND channel (FR-017 / SC-014). */
export const RARITY_LABELS: Readonly<Record<Rarity, string>> = Object.freeze({
  common: '普通',
  epic: '史诗',
  legendary: '传说',
});

/** Pip count (1 / 2 / 3) — a second colour-blind channel, machine-assertable. */
export const RARITY_PIPS: Readonly<Record<Rarity, number>> = Object.freeze({
  common: 1,
  epic: 2,
  legendary: 3,
});

/**
 * Icon-frame silhouette, a third colour-blind channel.
 *
 * The manager maps these shapes to the `boon-icon-frame--square|cut|crown` class
 * hooks; keeping the SHAPE here (rather than the class string) means the class
 * literals live only in the DOM owner.
 */
export type RarityShape = 'square' | 'cut' | 'crown';

export const RARITY_SHAPES: Readonly<Record<Rarity, RarityShape>> = Object.freeze({
  common: 'square',
  epic: 'cut',
  legendary: 'crown',
});

/** Narrowing predicate: is `value` one of the three tiers? */
export function isRarity(value: unknown): value is Rarity {
  return typeof value === 'string' && (RARITIES as readonly string[]).includes(value);
}

/** Coerce anything to a tier, falling back to {@link DEFAULT_RARITY}. Never throws. */
export function normalizeRarity(value: unknown): Rarity {
  return isRarity(value) ? value : DEFAULT_RARITY;
}

/** The colour for `rarity` (a literal from {@link RARITY_COLORS}). */
export function qualityColor(rarity: Rarity): string {
  return RARITY_COLORS[rarity];
}

/** The Chinese label for `rarity`. */
export function qualityLabel(rarity: Rarity): string {
  return RARITY_LABELS[rarity];
}

/** The pip count for `rarity`. */
export function qualityPips(rarity: Rarity): number {
  return RARITY_PIPS[rarity];
}

/** The icon-frame silhouette for `rarity`. */
export function qualityShape(rarity: Rarity): RarityShape {
  return RARITY_SHAPES[rarity];
}
