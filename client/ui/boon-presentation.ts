/**
 * Boon presentation — turn a reward id into the three things a card shows (M19).
 * See specs/027-hud-boon-ui/data-model.md §4 and design/engineering-architecture.md §4.
 *
 * A card carries THREE elements (FR-011/012/013):
 *   1. a cosmetic QUALITY (colour + label + pips + silhouette),
 *   2. an ICON (a CSS glyph token, U3),
 *   3. a NUMERIC description.
 *
 * THE DESCRIPTION'S NUMBERS COME FROM THE LOGIC LAYER, READ-ONLY
 * --------------------------------------------------------------
 * This module owns NO effect number. `{damage}`, `{knockbackForce}`, `{amount}`,
 * `{reduction}` and the poison figures are all read from the SAME sources the
 * simulation uses (`DataManager.getModifierConfig`, `POISON_STATUS_SPEC`,
 * `HP_UP_AMOUNT`, `DASH_UP_COOLDOWN_REDUCTION`), so a re-tuned boon re-tunes its
 * card for free and the two can never drift (FR-014 / SC-004).
 *
 * A description whose template asks for a slot this module cannot resolve falls
 * back to the reward's own label — a number-free, honest string. It NEVER renders
 * `undefined` / `NaN` (Edge Cases, third bullet).
 *
 * DOM-free, pixi-free, random-free: node-unit-testable.
 */

import { DataManager } from '../../src/data/DataManager';
import { POISON_STATUS_SPEC } from '../../src/ecs/components/StatusEffectComponent';
import {
  DASH_UP_COOLDOWN_REDUCTION,
  HP_UP_AMOUNT,
  getRewardDefinition,
} from '../../src/ecs/rewards/RewardPool';

import { getBoonMeta, iconGlyph, normalizeIconToken } from './boon-catalog';
import {
  normalizeRarity,
  qualityColor,
  qualityLabel,
  qualityPips,
  qualityShape,
  type Rarity,
  type RarityShape,
} from './quality';

/** The numeric slots a description template can ask for. */
export type LogicNumbers = Readonly<Record<string, number>>;

/**
 * Format a number for display: at most three decimals, no trailing zeros.
 *
 * The rounding is load-bearing rather than cosmetic: a seconds value derived from
 * ticks (`intervalTicks * fixedDeltaSeconds`) is `0.49999999999999994` in IEEE-754,
 * and rendering that verbatim would be both ugly and wrong-looking. `Number(x.toFixed(3))`
 * gives `0.5`.
 */
export function formatBoonNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return String(Number(value.toFixed(3)));
}

/**
 * The logic-layer numbers a boon's description is allowed to quote, by reward id.
 *
 * `tickSeconds` is INJECTED (the composition root passes `sim.fixedDeltaSeconds`) so
 * this module never hard-codes a frame duration — the engine's fixed step is the
 * single source of truth for "how long is a tick" (Principle II).
 *
 * `dionysus_strike` is a status DoT and is deliberately NOT in `modifiers.json`, so
 * it is read from `POISON_STATUS_SPEC`; the two modifier boons are read from
 * `DataManager`, guarded by `hasModifier` because `getModifierConfig` throws for an
 * unknown id.
 */
export function boonEffectNumbers(id: string, tickSeconds: number): LogicNumbers {
  switch (id) {
    case 'zeus_strike': {
      if (!DataManager.hasModifier(id)) return {};
      const config = DataManager.getModifierConfig(id);
      return { damage: config.damage };
    }
    case 'poseidon_dash': {
      if (!DataManager.hasModifier(id)) return {};
      const config = DataManager.getModifierConfig(id);
      return { damage: config.damage, knockbackForce: config.knockbackForce };
    }
    case 'dionysus_strike': {
      return {
        intervalSeconds: POISON_STATUS_SPEC.intervalTicks * tickSeconds,
        damagePerStack: POISON_STATUS_SPEC.damagePerStack,
        maxStacks: POISON_STATUS_SPEC.maxStacks,
      };
    }
    case 'hp_up': {
      return { amount: HP_UP_AMOUNT };
    }
    case 'dash_up': {
      return { reduction: DASH_UP_COOLDOWN_REDUCTION };
    }
    default: {
      return {};
    }
  }
}

/**
 * Substitute `{slot}` placeholders in `template` with `numbers`.
 *
 * @returns the rendered description, or `fallback` when the template is empty, a
 *   slot cannot be resolved, or the result would leak a marker (`{`, `NaN`,
 *   `undefined`). The fallback is a number-free, always-readable string.
 */
export function renderBoonDescription(
  template: string,
  numbers: LogicNumbers,
  fallback: string,
): string {
  if (template.length === 0) return fallback;
  const slots = [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '');
  let out = template;
  for (const slot of slots) {
    const value = numbers[slot];
    if (value === undefined || !Number.isFinite(value)) return fallback;
    out = out.split(`{${slot}}`).join(formatBoonNumber(value));
  }
  if (out.includes('{') || out.includes('}') || out.includes('NaN') || out.includes('undefined')) {
    return fallback;
  }
  return out;
}

/** Everything a card (or a status-panel row) draws for one boon. */
export interface BoonCardView {
  readonly id: string;
  /** The logic layer's display name (single source; never a UI-side copy). */
  readonly label: string;
  readonly rarity: Rarity;
  /** Chinese tier label (colour-blind channel 1). */
  readonly rarityLabel: string;
  readonly color: string;
  /** Pip count (colour-blind channel 2). */
  readonly pips: number;
  /** Icon-frame silhouette (colour-blind channel 3). */
  readonly shape: RarityShape;
  /** A CSS glyph token (NOT an asset id). */
  readonly iconToken: string;
  /** The glyph character drawn for {@link iconToken}. */
  readonly iconGlyph: string;
  /** The rendered, numeric description. */
  readonly description: string;
}

/**
 * Build the card view for `id`.
 *
 * Degrades gracefully on every axis (FR-017): an id with no metadata gets the
 * default quality, the default glyph and a safe description; an id that is not even
 * a reward still renders (label = the raw id). Never throws.
 */
export function buildBoonCard(id: string, tickSeconds: number): BoonCardView {
  const meta = getBoonMeta(id);
  const definition = getRewardDefinition(id);
  const label = definition?.label ?? id;
  const rarity = normalizeRarity(meta?.rarity);
  const iconToken = normalizeIconToken(meta?.icon);
  const description = renderBoonDescription(
    meta?.description ?? '',
    boonEffectNumbers(id, tickSeconds),
    label,
  );
  return {
    id,
    label,
    rarity,
    rarityLabel: qualityLabel(rarity),
    color: qualityColor(rarity),
    pips: qualityPips(rarity),
    shape: qualityShape(rarity),
    iconToken,
    iconGlyph: iconGlyph(iconToken),
    description,
  };
}
