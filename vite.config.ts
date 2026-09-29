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
});
