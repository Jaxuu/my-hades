/**
 * Boon glyph mapping (specs/027-hud-boon-ui T024 · U3).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * USER RULING U3: the boon icon is a CSS GLYPH, not an asset. `boons.json`'s
 * `icon` field is therefore a TOKEN (`lightning` / `grape` / …), and the catalogue
 * resolves it to a character. Two things must stay true:
 *
 *  1. an unknown or missing token degrades to the contract's fallback glyph (`◆`),
 *     so a typo shows a placeholder rather than a blank square;
 *  2. the catalogue NEVER reaches for the asset manifest — an icon that quietly
 *     became an asset id would re-introduce the very dependency U3 removed.
 *
 * `boon-catalog.ts` is DOM-free / pixi-free, so this is a plain node unit test.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ICON_TOKEN,
  ICON_GLYPHS,
  iconGlyph,
  normalizeIconToken,
} from '../../client/ui/boon-catalog';
import { readRepoFile } from '../harness/ui-source';

const CATALOG = readRepoFile('client/ui/boon-catalog.ts');
const RAW_BOONS = JSON.parse(readRepoFile('client/assets/boons.json')) as Record<
  string,
  { readonly icon: string }
>;

/** The five shipped tokens (U3's fixed set). */
const TOKENS = ['lightning', 'grape', 'trident', 'heart', 'boot'] as const;

describe('T024 · the icon token maps to a CSS glyph', () => {
  it.each(TOKENS)('resolves `%s` to a non-empty, distinct glyph', (token) => {
    const glyph = iconGlyph(token);
    expect(glyph.length).toBeGreaterThan(0);
    expect(glyph).not.toBe('◆'); // the five real tokens are not the fallback
  });

  it('gives the five tokens five DISTINCT glyphs', () => {
    const glyphs = TOKENS.map((token) => iconGlyph(token));
    expect(new Set(glyphs).size).toBe(TOKENS.length);
  });

  it('declares the default glyph as `◆`', () => {
    expect(ICON_GLYPHS[DEFAULT_ICON_TOKEN]).toBe('◆');
  });
});

describe('T024 · an unknown or missing token falls back to `◆`', () => {
  it('resolves an unknown token to the default glyph', () => {
    expect(iconGlyph('not-a-real-token')).toBe('◆');
  });

  it('normalises an unknown / missing / malformed token to the default token', () => {
    expect(normalizeIconToken('not-a-real-token')).toBe(DEFAULT_ICON_TOKEN);
    expect(normalizeIconToken(undefined)).toBe(DEFAULT_ICON_TOKEN);
    expect(normalizeIconToken('')).toBe(DEFAULT_ICON_TOKEN);
    expect(normalizeIconToken(42)).toBe(DEFAULT_ICON_TOKEN);
    expect(normalizeIconToken('lightning')).toBe('lightning');
  });
});

describe('T024 · the icon is a glyph token, never an asset id (U3)', () => {
  it('uses only known tokens in the shipped table', () => {
    const tokens = Object.values(RAW_BOONS).map((entry) => entry.icon);
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(Object.keys(ICON_GLYPHS)).toContain(token);
      // A token is never an asset id: no namespace, no file extension.
      expect(token).not.toContain('.png');
      expect(token).not.toContain('ui.');
    }
  });

  it('does not query the asset manifest or the catalog', () => {
    // The one structural temptation of a token -> glyph map is to smuggle in an
    // asset lookup. It is not here.
    expect(CATALOG).not.toContain('AssetCatalog');
    expect(CATALOG).not.toContain('manifest');
    expect(CATALOG).not.toContain('MANIFEST');
    expect(CATALOG).not.toContain('.png');
  });
});
