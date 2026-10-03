/**
 * Keyboard accessibility (specs/027-hud-boon-ui T048 · FR-019 · contract §3).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * Every interactive M19 control is reachable and operable by keyboard: the boon
 * cards are native `<button>`s, the focus ring stays visible, and the manager does
 * not replace a button with a click-handled `<div>`. The Tab panel adds no
 * interactive control at all — it is a read-only reference — so it must not trap
 * focus either.
 */

import { describe, expect, it } from 'vitest';

import { readRepoFile, stripComments } from '../harness/ui-source';

const INDEX_HTML = readRepoFile('index.html');
const UI_MANAGER = readRepoFile('client/UIManager.ts');
const UI_MANAGER_CODE = stripComments(UI_MANAGER);

describe('T048 · interactive controls are native and focusable', () => {
  it('creates real `<button>` elements for every actionable control', () => {
    const tags = (UI_MANAGER_CODE.match(/document\.createElement\('([a-z0-9]+)'\)/g) ?? []).map((m) =>
      m.replace(/.*'([a-z0-9]+)'.*/, '$1'),
    );
    expect(tags).toContain('button');
    expect(tags.filter((tag) => tag === 'button').length).toBeGreaterThanOrEqual(3);
  });

  it('never wires a click onto a non-interactive element', () => {
    // A `<div onclick>` is unreachable by keyboard; the manager uses listeners on
    // real buttons only.
    expect(UI_MANAGER_CODE).not.toContain('.onclick =');
    expect(UI_MANAGER_CODE).not.toContain('.setAttribute(\'tabindex\', \'-1\')');
  });

  it('keeps a visible focus ring, and it covers the boon card', () => {
    expect(INDEX_HTML).toContain(':focus-visible');
    expect(INDEX_HTML).toMatch(/outline:\s*3px/);
    // The boon card carries `reward-button`, which the focus rule names.
    expect(INDEX_HTML).toContain('.reward-button:focus-visible');
    expect(UI_MANAGER_CODE).toContain('reward-button');
  });

  it('makes the boon card a button, not a styled div', () => {
    // The card is built on the same native button every reward uses.
    const render = UI_MANAGER_CODE.slice(UI_MANAGER_CODE.indexOf('private render('));
    const body = render.slice(0, render.indexOf('this.root.appendChild(grid)'));
    expect(body).toContain("document.createElement('button')");
    expect(body).toContain('reward-button');
    expect(body).toContain('boon-card');
  });
});

describe('T048 · the status panel is a reference overlay, not a focus trap', () => {
  it('adds no interactive control of its own', () => {
    const panel = UI_MANAGER_CODE.slice(
      UI_MANAGER_CODE.indexOf('private renderPanel('),
      UI_MANAGER_CODE.indexOf('private buildStatusRow('),
    );
    // Rows are plain divs; the only thing the panel does is display.
    expect(panel).not.toContain('createElement(\'button\')');
    expect(panel).not.toContain('addEventListener');
  });
});
