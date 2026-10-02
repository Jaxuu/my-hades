/**
 * Text-readability tests (specs/024-real-art-assets US6, T040 — FR-019).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * The interface is Chinese (`选择祝福`, `营地 · CAMP`, `开始逃离`). A full CJK web font
 * is 8–10 MB — it would eat the entire 6 MB asset budget on its own — so D7 decides
 * NOT to bundle one and to rely on the system stack instead.
 *
 * That decision has one failure mode that only shows up on somebody else's machine:
 * a font stack with no CJK fallback renders every Chinese glyph as a tofu box (□).
 * It cannot be caught by a type check or by a render test, so it is caught here, by
 * reading the stylesheet.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const INDEX_HTML_RAW = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');

/**
 * The stylesheet with CSS comments removed.
 *
 * Comments are documentation, not declarations: a comment that explains "no web
 * font is declared here" must not itself look like one. Every assertion below
 * scans this, so it measures what the browser actually reads.
 */
const INDEX_HTML = INDEX_HTML_RAW.replace(/\/\*[\s\S]*?\*\//g, '');

/** The CJK-capable families the stack must name, per platform. */
const CJK_FAMILIES = ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC'] as const;

describe('the font stack survives a missing font asset (FR-019)', () => {
  it('bundles NO web font at all', () => {
    // No `@font-face` means no font FILE can be missing, which is the strongest
    // possible form of "the text does not depend on a font asset".
    expect(INDEX_HTML).not.toContain('@font-face');
  });

  it('never references a font file by extension', () => {
    for (const extension of ['.woff', '.woff2', '.ttf', '.otf', '.eot']) {
      expect(INDEX_HTML.toLowerCase()).not.toContain(extension);
    }
  });

  it.each(CJK_FAMILIES)('names the CJK fallback `%s`', (family) => {
    expect(INDEX_HTML).toContain(family);
  });

  it('always ends a stack with the generic family, so it can never fall through', () => {
    const stacks = INDEX_HTML.match(/--font-(?:body|mono):[^;]+;/g) ?? [];
    expect(stacks.length).toBe(2);
    for (const stack of stacks) {
      expect(stack).toMatch(/(sans-serif|monospace)\s*;/);
    }
  });

  it('keeps the Chinese copy the interface actually renders', () => {
    // The strings are the evidence that the stack is load-bearing: if these were
    // removed the CJK requirement would be vacuous.
    for (const text of ['移动', '攻击', '冲刺', '回营地']) {
      expect(INDEX_HTML).toContain(text);
    }
  });
});

describe('the canvas and the DOM agree on the palette', () => {
  it('declares the palette as custom properties rather than scattering literals', () => {
    for (const variable of ['--parchment', '--gold', '--blood', '--stone-dark']) {
      expect(INDEX_HTML).toContain(variable);
    }
  });

  it('uses the panel plate treatment on all three always-on HUD surfaces', () => {
    // A shared rule keeps the HUD, the key legend and the wallet visually one
    // family instead of three one-off boxes.
    const block = INDEX_HTML.match(/#hud,\s*#keys,\s*#gold\s*\{[^}]+\}/)?.[0] ?? '';
    expect(block).toContain('background-repeat: no-repeat');
    expect(block).toContain('image-rendering: pixelated');
  });
});
