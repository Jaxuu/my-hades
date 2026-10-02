import { defineConfig } from 'vite';

// Static single-page entry: the root `index.html` mounts `client/main.ts`.
// The simulation core (`src/`) stays a pure dependency of the render layer —
// Vite only ever bundles the client entry, never `src/` on its own.
export default defineConfig({
  server: {
    // Fixed dev port so the manual-verification URL is stable and scriptable.
    port: 5173,
    // Do NOT hard-fail if 5173 is taken: fall back to the next free port rather
    // than killing the dev loop.
    strictPort: false,
  },
  build: {
    // Emit EVERY asset as its own file (M16). Vite's default 4 kB inline limit
    // would base64 the four small atlases and the eleven UI plates straight into
    // the JS/CSS chunk — which is functionally equivalent (still local, still
    // zero requests) but hides them from `dist/`, defeats per-file caching, and
    // makes "the manifest references a real file" impossible to inspect. Assets
    // are meant to be files; `assetsInlineLimit: 0` keeps them that way.
    assetsInlineLimit: 0,
  },
});
