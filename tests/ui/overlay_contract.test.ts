/**
 * Overlay semantics are unchanged (specs/027-hud-boon-ui T044 · US5 · FR-040…045).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * US5 re-skins the death / victory / camp overlays into the M19 visual language. The
 * SKIN may change freely; the SEMANTICS may not: `R` still settles a terminal run
 * into the camp, a talent click still spends darkness, the start button still opens
 * the next run, and a finished run still outranks every other overlay.
 *
 * WHY THIS IS A SOURCE SCAN
 * -------------------------
 * `client/UIManager.ts` is DOM-coupled and is not part of the DOM-less `npm run
 * typecheck` program. The interaction contract is pinned on the code that decides
 * it: the key handler, the callback wiring, and the branch order in `sync`.
 */

import { describe, expect, it } from 'vitest';

import { readRepoFile, stripComments } from '../harness/ui-source';

const UI_MANAGER = stripComments(readRepoFile('client/UIManager.ts'));
const INDEX_HTML = readRepoFile('index.html');

/** The body of a method, up to its closing brace. */
function methodBody(name: string): string {
  const start = UI_MANAGER.indexOf(name);
  expect(start).toBeGreaterThanOrEqual(0);
  return UI_MANAGER.slice(start, UI_MANAGER.indexOf('\n  }', start));
}

describe('T044 · `R` still settles a terminal run into the camp', () => {
  it('fires onEnterHub on the hub key and prevents the browser default', () => {
    const handler = methodBody('handleHubKey = (event');
    expect(handler).toContain('event.code !== HUB_KEY_CODE');
    expect(handler).toContain('event.preventDefault()');
    expect(handler).toContain('this.onEnterHub?.()');
  });

  it('binds the hub key to `R`', () => {
    expect(UI_MANAGER).toMatch(/HUB_KEY_CODE = 'KeyR'/);
  });

  it('serves BOTH terminal overlays through the same `R` path', () => {
    // One rendering path, two skins — so the two endings cannot diverge.
    const terminal = methodBody('private renderTerminal(');
    expect(terminal).toContain("kind === 'win' ? 'is-win' : 'is-death'");
    expect(terminal).toContain("window.addEventListener('keydown', this.handleHubKey)");
  });
});

describe('T044 · the camp and the terminal precedence are unchanged', () => {
  it('keeps the frozen overlay classes in both the stylesheet and the manager', () => {
    for (const hook of ['is-death', 'is-win', 'is-hub']) {
      expect(INDEX_HTML).toContain(`.${hook}`);
      expect(UI_MANAGER).toContain(hook);
    }
  });

  it('ranks a terminal run above the camp and the draft', () => {
    // `isRunFailed` is consulted before `isRunWon`, which is before `isInHub`.
    const sync = UI_MANAGER.slice(UI_MANAGER.indexOf('public sync('));
    const failedAt = sync.indexOf('isRunFailed(');
    const wonAt = sync.indexOf('isRunWon(');
    const hubAt = sync.indexOf('isInHub(');
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(wonAt).toBeGreaterThan(failedAt);
    expect(hubAt).toBeGreaterThan(wonAt);
  });

  it('still routes a talent click and the start button through their callbacks', () => {
    expect(UI_MANAGER).toContain('this.onPurchase?.(id)');
    expect(UI_MANAGER).toContain('this.onStartRun?.()');
    // The camp's ONE exit keeps its frozen class.
    expect(UI_MANAGER).toContain('start-button');
    expect(INDEX_HTML).toContain('.start-button');
  });
});
