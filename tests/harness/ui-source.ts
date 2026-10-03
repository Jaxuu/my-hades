/**
 * Source-scanning helpers for the M19 presentation-layer suites.
 * See specs/027-hud-boon-ui/design/quality-and-verification.md §3.
 *
 * This project has NO jsdom (the vitest environment is `node`), so the UI's
 * structural contracts are checked the way the existing `tests/ui/*` suites check
 * them: by reading the source and asserting on what it says. Three helpers keep
 * that honest across suites:
 *
 *  - {@link readRepoFile} reads a repository file by relative path;
 *  - {@link collectSources} walks a directory for `.ts` files, sorted by path;
 *  - {@link stripComments} removes comments so a docstring that MENTIONS a
 *    forbidden call ("this never calls `addComponent`") is not mistaken for the
 *    call itself. Every blacklist / whitelist assertion scans the stripped form.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The repository root — vitest runs from the project root. */
const REPO_ROOT = process.cwd();

/** Read a repository file by its path relative to the repo root. */
export function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** One source file: its repo-relative path and its raw text. */
export interface SourceFile {
  readonly path: string;
  readonly source: string;
}

/**
 * Every `.ts` file under `dirRel`, recursively, sorted by repo-relative path so a
 * failure report names files in a stable order.
 *
 * Paths are normalised to forward slashes: on Windows `relative()` returns
 * `client\GameLoop.ts`, and a suite that excludes a file by name would silently
 * fail to match it.
 */
export function collectSources(dirRel: string): readonly SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        const path = relative(REPO_ROOT, full).replace(/\\/g, '/');
        out.push({ path, source: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(join(REPO_ROOT, dirRel));
  // A plain code-unit comparator, NOT `localeCompare`: the latter depends on the
  // host locale, which would make any order-sensitive assertion environment-specific.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Strip `/* … *\/` block comments and `// …` line comments.
 *
 * The negative lookbehind-free form (`(^|[^:])//`) keeps a `https://` URL from
 * being read as the start of a comment, which is the one place a `//` appears in
 * real code rather than in a comment.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
