import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  // '/' for local dev; the Pages deploy sets PAGES_BASE='/torah-app/' (project page). The DB worker reads
  // import.meta.env.BASE_URL to locate db/, so this drives both the app's asset URLs and the corpus URLs.
  base: process.env.PAGES_BASE || '/',
  plugins: [
    react(),
    // Installable PWA + offline. The service worker precaches the app shell (incl. the SQLite .wasm, the
    // OPFS workers, and the Hebrew font). The per-book corpus under db/ is NOT precached (it's multi-GB and
    // already lives in OPFS once downloaded); those requests pass straight through to the network.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon-180x180.png', 'pwa-64x64.png', 'pwa-192x192.png', 'pwa-512x512.png', 'maskable-icon-512x512.png'],
      manifest: {
        name: 'Torah — browser library',
        short_name: 'Torah',
        description: 'A Torah library that runs entirely in your browser — offline-capable.',
        theme_color: '#8a5a2b',
        background_color: '#faf8f4',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell AND the small boot catalog (db/db.sqlite.zst ~1 MB + its manifest) so the
        // catalog resolves OFFLINE even on a fresh/evicted OPFS (otherwise the boot fetch fails offline and the
        // catalog never loads). The large per-book slices (db/toc_*) stay fetched on demand into OPFS.
        globPatterns: ['**/*.{js,css,html,wasm,ttf,svg,ico,png,woff2}', 'db/db.sqlite.zst', 'db/manifest.json'],
        globIgnores: ['**/db/toc_*'],
        navigateFallbackDenylist: [/\/db\//],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // the SQLite .wasm is ~865 KB + the boot db ~1.5 MB; allow headroom
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  // sqlite-wasm ships its own .wasm + worker glue; let it resolve at runtime.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  // The corpus lives in public/db (multi-GB). Don't copy it on every app build — `npm run build:db` ships it.
  // emptyOutDir:false so an app build doesn't wipe the separately-deployed dist/db corpus; the build script
  // clears dist/assets itself. copyPublicDir:false so the multi-GB public/db isn't copied here (`build:db` does).
  build: { target: 'esnext', copyPublicDir: false, emptyOutDir: false },
});
