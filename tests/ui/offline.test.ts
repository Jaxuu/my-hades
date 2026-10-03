/**
 * Offline availability (specs/027-hud-boon-ui T050 · FR-053 / SC-011).
 *
 * WHAT THIS SUITE GUARDS
 * ----------------------
 * Every UI asset is a BUILD-TIME static import, so the built game makes ZERO
 * network requests: no runtime `fetch`, no external URL, no CDN. This is the
 * contract `manifest.ts` records ("a Vite static import, so the asset is resolved
 * at BUILD time") — asserted rather than assumed, because a single `fetch` added
 * later would silently make the game require a network.
 *
 * The source half scans `client/**`; the manifest half proves every entry's
 * `source` is a local, Vite-resolved path rather than a remote URL. If a build
 * exists, the same ban is checked against the shipped bundle.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MANIFEST, MANIFEST_IDS } from '../../client/assets/manifest';
import { collectSources, readRepoFile, stripComments } from '../harness/ui-source';

const INDEX_HTML = readRepoFile('index.html');

/** The M19 ids that must be distributed locally (no icon id — U3). */
const M19_IDS = [
  'ui.frame.health',
  'ui.frame.dash',
  'ui.frame.boon-common',
  'ui.frame.boon-epic',
  'ui.frame.boon-legendary',
  'ui.panel.status',
  'ui.rule.bronze',
] as const;

/** Network primitives that would make the game require a connection. */
const NETWORK_TERMS = ['fetch(', 'XMLHttpRequest', 'navigator.sendBeacon', 'WebSocket(', 'EventSource('] as const;

describe('T050 · the client source makes no runtime network call (SC-011)', () => {
  it.each(NETWORK_TERMS)('never uses `%s`', (term) => {
    const offenders = collectSources('client')
      .filter((file) => stripComments(file.source).includes(term))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('references no external origin (http / https / protocol-relative)', () => {
    const offenders: string[] = [];
    for (const file of collectSources('client')) {
      const code = stripComments(file.source);
      if (/https?:\/\//.test(code) || /['"]\/\/[a-z0-9.-]+\./.test(code)) offenders.push(file.path);
    }
    expect(offenders).toEqual([]);
  });

  it('loads the stylesheet with no external resource', () => {
    expect(INDEX_HTML).not.toMatch(/<link[^>]+href=["']https?:\/\//i);
    expect(INDEX_HTML).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
  });
});

describe('T050 · every asset is a build-time static import', () => {
  it('resolves every manifest source to a local path', () => {
    expect(MANIFEST_IDS.length).toBeGreaterThan(0); // guard against a vacuous pass
    for (const id of MANIFEST_IDS) {
      const entry = MANIFEST[id];
      if (entry === undefined) throw new Error(`QA: missing manifest entry ${id}`);
      expect(entry.source).not.toContain('://');
      expect(entry.source.startsWith('//')).toBe(false);
    }
  });

  it('registers all seven M19 frames, so they ship with the bundle', () => {
    for (const id of M19_IDS) {
      expect(MANIFEST_IDS).toContain(id);
    }
  });

  it('ships no boon icon asset (the icon is a CSS glyph — U3)', () => {
    expect(MANIFEST_IDS.some((id) => id.startsWith('ui.icon.boon'))).toBe(false);
  });
});

describe('T050 · the built page, when present, is offline too', () => {
  it('references only local asset paths, never an external origin', () => {
    const dist = join(process.cwd(), 'dist');
    if (!existsSync(dist)) {
      // A source-only run (no build yet): the source-level proof above stands.
      return;
    }
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    // The built page inlines its styles and points at `/assets/...`; a remote
    // <link> / <script> would be the one way the shipped page could need a network.
    expect(html).not.toMatch(/<link[^>]+href=["']https?:\/\//i);
    expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
    // Guard against a vacuous pass: the built page really does load a script.
    expect(html).toMatch(/<script[^>]+src=["']\/assets\//i);
  });
});
