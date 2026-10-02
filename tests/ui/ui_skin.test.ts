/**
 * UI skin contract tests (specs/024-real-art-assets US6, T035).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * `client/UIManager.ts` builds the interface by creating elements and toggling
 * classes; `index.html` styles them. The contract between the two
 * (contracts/ui-asset-slots.md 承诺 1/2) is that the SKIN may change freely but the
 * CLASS HOOKS may not: they are the selectors both the manager and the tests use.
 *
 * A re-skin that renamed `is-death` into something prettier would still look right
 * in a browser and would silently break every selector that keys on it — including
 * the manager's own `contains()` check. So the hooks are pinned here by literal.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const INDEX_HTML = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');
const UI_MANAGER = readFileSync(resolve(REPO_ROOT, 'client/UIManager.ts'), 'utf8');

/** The hooks the contract freezes (ui-asset-slots.md §1 + §3 承诺 2). */
const FROZEN_CLASSES = [
  'is-visible',
  'is-death',
  'is-win',
  'is-hub',
  'reward-button',
  'talent-button',
  'start-button',
  'hub-currency',
  'hub-talents',
  'death-hint',
] as const;

/** The ids the manager looks up by `getElementById`. */
const FROZEN_IDS = ['app', 'ui-layer', 'hud', 'gold', 'keys'] as const;

describe('the markup keeps every frozen hook (承诺 2)', () => {
  it.each(FROZEN_CLASSES)('styles and keeps `%s`', (className) => {
    // Present in the stylesheet...
    expect(INDEX_HTML).toContain(`.${className}`);
    // ...and still emitted by the manager that owns the logic.
    expect(UI_MANAGER).toContain(className);
  });

  it.each(FROZEN_IDS)('keeps the `#%s` element', (id) => {
    expect(INDEX_HTML).toContain(`id="${id}"`);
  });

  it('adds the M16 skin hooks WITHOUT removing any frozen one', () => {
    for (const added of ['ui-card', 'ui-hint', 'ui-currency', 'ui-list', 'ui-button-primary', 'ui-heading']) {
      expect(UI_MANAGER).toContain(added);
      expect(INDEX_HTML).toContain(`.${added}`);
    }
  });
});

describe('buttons stay native and focusable (承诺 3)', () => {
  it('never replaces a button with a non-focusable element', () => {
    // The manager creates real `<button>` elements for every actionable control.
    const created = UI_MANAGER.match(/document\.createElement\('([a-z0-9]+)'\)/g) ?? [];
    const tags = created.map((m) => m.replace(/.*'([a-z0-9]+)'.*/, '$1'));
    expect(tags).toContain('button');
    // And no actionable control is built out of a div/span.
    const buttonCount = tags.filter((t) => t === 'button').length;
    expect(buttonCount).toBeGreaterThanOrEqual(3);
  });

  it('keeps a visible focus ring in the stylesheet', () => {
    expect(INDEX_HTML).toContain(':focus-visible');
    expect(INDEX_HTML).toMatch(/outline:\s*3px/);
  });
});

describe('the interface does not enter the PixiJS scene graph (承诺 6)', () => {
  it('declares the UI as DOM elements only', () => {
    // A regression guard for the ONE structural temptation of this milestone: a
    // canvas-drawn HUD would have to add a resident node and break F1–F6.
    expect(UI_MANAGER).not.toContain('pixi.js');
    expect(UI_MANAGER).not.toContain('Container');
    expect(UI_MANAGER).not.toContain('Graphics');
  });
});

describe('the art slots are wired as CSS custom properties (FR-018)', () => {
  it('declares every slot variable with a `none` default', () => {
    for (const variable of [
      '--ui-panel-hud',
      '--ui-panel-reward',
      '--ui-panel-camp',
      '--ui-frame-reward-card',
      '--ui-frame-talent-card',
      '--ui-button-primary',
      '--ui-overlay-death',
      '--ui-overlay-win',
      '--ui-bar-hud',
    ]) {
      expect(INDEX_HTML).toContain(variable);
    }
    // Every declaration defaults to `none`, so the plain CSS underneath is the
    // real degradation path rather than a comment.
    const defaults = INDEX_HTML.match(/--ui-[a-z-]+:\s*none;/g) ?? [];
    expect(defaults.length).toBeGreaterThanOrEqual(11);
  });

  it('renders the panels with pixel-art settings rather than a blurry upscale', () => {
    expect(INDEX_HTML).toContain('image-rendering: pixelated');
  });
});
