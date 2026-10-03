/**
 * Graceful degradation (specs/027-hud-boon-ui T047 · FR-050).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * Every M19 surface must be USABLE with the art missing. `--ui-*` defaults to
 * `none`, and a degraded catalog leaves it there, so the plain CSS underneath has
 * to be a real surface — not a comment. The failure mode is a surface whose only
 * definition is its `border-image`/`background-image`: with no asset it renders as
 * nothing, which reads as a black screen.
 *
 * The model half proves the OTHER degradation path: a boon with no metadata still
 * renders (default quality + `◆` + a safe description), never throwing.
 */

import { describe, expect, it } from 'vitest';

import { buildBoonCard } from '../../client/ui/boon-presentation';
import { iconGlyph } from '../../client/ui/boon-catalog';
import { readRepoFile, stripComments } from '../harness/ui-source';

const INDEX_HTML = readRepoFile('index.html');
const MAIN = stripComments(readRepoFile('client/main.ts'));

/** The seven M19 slots, and the fallback surface each must leave behind. */
const SLOTS = [
  '--ui-frame-health',
  '--ui-frame-dash',
  '--ui-frame-boon-common',
  '--ui-frame-boon-epic',
  '--ui-frame-boon-legendary',
  '--ui-panel-status',
  '--ui-rule',
] as const;

describe('T047 · every M19 slot defaults to `none`', () => {
  it.each(SLOTS)('declares `%s: none`', (slot) => {
    expect(INDEX_HTML).toMatch(new RegExp(`${slot}:\\s*none;`));
  });

  it('declares the rarity colours as real values, not `none`', () => {
    // The quality colour is the card's ALWAYS-ON fallback, so it can never be none.
    expect(INDEX_HTML).toMatch(/--rarity-common:\s*#[0-9a-f]{6};/i);
    expect(INDEX_HTML).toMatch(/--rarity-epic:\s*#[0-9a-f]{6};/i);
    expect(INDEX_HTML).toMatch(/--rarity-legendary:\s*#[0-9a-f]{6};/i);
  });
});

describe('T047 · every M19 slot is CONSUMED, not merely declared', () => {
  it.each(SLOTS)('draws `%s` somewhere in the stylesheet', (slot) => {
    // The failure this guards is silent and expensive: a slot can be registered in
    // the contract, defaulted to `none`, injected by `applyUiSkin` and shipped as a
    // real PNG, and still be drawn NOWHERE — the art is loaded and never used, and
    // every other assertion in this file still passes. `--ui-frame-dash` was exactly
    // that gap: declared and injected, but no rule referenced it.
    expect(INDEX_HTML).toContain(`var(${slot})`);
  });
});

describe('T047 · each surface has a plain-CSS fallback under the art', () => {
  it('gives the material HUD a solid border colour and a background', () => {
    const block = INDEX_HTML.match(/#hud-material\s*\{[^}]+\}/)?.[0] ?? '';
    expect(block).toContain('border-color: var(--stone-dark)');
    expect(block).toContain('background-color');
  });

  it('draws the health bar as a solid fill and the dash as a conic ring', () => {
    // Neither depends on an asset: the fill is a background colour, the ring is a
    // pure-CSS conic gradient.
    const fill = INDEX_HTML.match(/\.hud-health-fill\s*\{[^}]+\}/)?.[0] ?? '';
    expect(fill).toContain('background-color');
    const ring = INDEX_HTML.match(/\.hud-dash-ring\s*\{[^}]+\}/)?.[0] ?? '';
    expect(ring).toContain('conic-gradient');
  });

  it('falls the boon card back to a solid quality border when the frame is `none`', () => {
    for (const [hook, colour] of [
      ['common', '--rarity-common'],
      ['epic', '--rarity-epic'],
      ['legendary', '--rarity-legendary'],
    ] as const) {
      const block = INDEX_HTML.match(new RegExp(`\\.boon-rarity-${hook}\\s*\\{[^}]+\\}`))?.[0] ?? '';
      expect(block).toContain('border-image-source');
      // With the frame `none`, `border-color` is what remains.
      expect(block).toContain(`border-color: var(${colour})`);
    }
  });

  it('keeps the boon icon as CSS text, so it never needs an asset', () => {
    // The glyph is a character; the icon frame is a border/clip-path, not an image.
    expect(INDEX_HTML).toContain('.boon-icon');
    expect(INDEX_HTML).toContain('.boon-icon-frame--square');
    expect(INDEX_HTML).toContain('.boon-icon-frame--cut');
    expect(INDEX_HTML).toContain('.boon-icon-frame--crown');
  });

  it('gives the status panel a solid background under its frame', () => {
    const block = INDEX_HTML.match(/\.status-panel\s*\{[^}]+\}/)?.[0] ?? '';
    expect(block).toContain('background-color');
  });
});

describe('T047 · a degraded catalog leaves the fallback in place', () => {
  it('skips an id that did not load rather than clearing the variable', () => {
    // `applyUiSkin` only SETS a variable when the id resolved; a degraded id leaves
    // its `none` default untouched.
    const apply = MAIN.slice(MAIN.indexOf('function applyUiSkin('), MAIN.indexOf('\n}', MAIN.indexOf('function applyUiSkin(')));
    expect(apply).toContain('if (url === undefined) continue;');
  });
});

describe('T047 · the models degrade without throwing (FR-017)', () => {
  it('builds a card for any id, including unknown and long ones', () => {
    for (const id of ['unknown', 'hp_up', 'a'.repeat(64), 'zeus_strike']) {
      const card = buildBoonCard(id, 1 / 60);
      expect(card.description.length).toBeGreaterThan(0);
      expect(card.iconGlyph.length).toBeGreaterThan(0);
    }
  });

  it('never throws on a degenerate (empty) id', () => {
    // An empty id never reaches production, but "never throw" is total.
    const card = buildBoonCard('', 1 / 60);
    expect(typeof card.description).toBe('string');
    expect(card.iconGlyph.length).toBeGreaterThan(0);
  });

  it('resolves an unknown glyph token to the placeholder', () => {
    expect(iconGlyph('no_such_token')).toBe('◆');
  });
});
