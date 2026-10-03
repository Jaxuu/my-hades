/**
 * Tab listener lifecycle (specs/027-hud-boon-ui T032 · FR-025).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * The Tab key is armed EXACTLY while the run is playing with no overlay, and
 * disarmed the instant a terminal / camp overlay takes over or the manager is
 * destroyed. A listener that outlived its surface would settle a live run (the hub
 * key) or trap the keyboard (a stale panel key) — neither shows up in a screenshot.
 *
 * WHY THIS IS A SOURCE SCAN
 * -------------------------
 * `client/UIManager.ts` is DOM-coupled and is not part of the DOM-less `npm run
 * typecheck` program (it is checked by `typecheck:client`). The lifecycle is
 * therefore pinned on the SHAPE of the code: where `attachPanelKey` is called, what
 * calls `detachPanelKey`, and that both are idempotent. That shape is exactly what
 * decides the runtime behaviour, and a re-skin cannot change it without changing
 * these lines.
 */

import { describe, expect, it } from 'vitest';

import { readRepoFile, stripComments } from '../harness/ui-source';

const UI_MANAGER = stripComments(readRepoFile('client/UIManager.ts'));

/** The body of a private/public method, up to its closing brace. */
function methodBody(name: string): string {
  const start = UI_MANAGER.indexOf(name);
  expect(start).toBeGreaterThanOrEqual(0);
  return UI_MANAGER.slice(start, UI_MANAGER.indexOf('\n  }', start));
}

describe('T032 · the Tab listener is armed only in-run (FR-025)', () => {
  it('arms the key AFTER every overlay branch has returned', () => {
    const sync = UI_MANAGER.slice(UI_MANAGER.indexOf('public sync('));
    const attachAt = sync.indexOf('this.attachPanelKey()');
    expect(attachAt).toBeGreaterThanOrEqual(0);
    // A terminal / camp / draft frame returns BEFORE reaching the attach call.
    expect(sync.indexOf('isRunFailed(')).toBeLessThan(attachAt);
    expect(sync.indexOf('isInHub(')).toBeLessThan(attachAt);
    expect(sync.indexOf('findRewardDraft(')).toBeLessThan(attachAt);
  });

  it('attaches exactly once (idempotent)', () => {
    const attach = methodBody('private attachPanelKey()');
    expect(attach).toContain('if (this.panelKeyAttached) return;');
    expect(attach).toContain("window.addEventListener('keydown', this.handlePanelKey)");
  });
});

describe('T032 · the listener is disarmed on every non-playing frame', () => {
  it('closePanel detaches the key', () => {
    const close = methodBody('private closePanel()');
    expect(close).toContain('this.detachPanelKey()');
  });

  it('detaches exactly once (idempotent)', () => {
    const detach = methodBody('private detachPanelKey()');
    expect(detach).toContain('if (!this.panelKeyAttached) return;');
    expect(detach).toContain("window.removeEventListener('keydown', this.handlePanelKey)");
  });

  it('is closed on a terminal frame, a camp frame, and destroy()', () => {
    const sync = UI_MANAGER.slice(UI_MANAGER.indexOf('public sync('));
    // The terminal branch and the camp branch both close the panel first.
    expect(sync.indexOf('this.closePanel()')).toBeGreaterThanOrEqual(0);
    const terminalBranch = sync.slice(sync.indexOf('isRunFailed('), sync.indexOf('isInHub('));
    expect(terminalBranch).toContain('this.closePanel()');
    const hubBranch = sync.slice(sync.indexOf('isInHub('));
    expect(hubBranch).toContain('this.closePanel()');
    // destroy() is a hard detach.
    expect(methodBody('public destroy()')).toContain('this.closePanel()');
  });
});
