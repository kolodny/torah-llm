import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  // '/' for local dev; the Pages deploy sets PAGES_BASE='/torah-app/' (project page). The DB worker reads
  // import.meta.env.BASE_URL to locate db/, so this drives both the app's asset URLs and the corpus URLs.
  base: process.env.PAGES_BASE || '/',
  plugins: [react()],
  // sqlite-wasm ships its own .wasm + worker glue; let it resolve at runtime.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  // The corpus lives in public/db (multi-GB). Don't copy it on every app build — `npm run build:db` ships it.
  // emptyOutDir:false so an app build doesn't wipe the separately-deployed dist/db corpus; the build script
  // clears dist/assets itself. copyPublicDir:false so the multi-GB public/db isn't copied here (`build:db` does).
  build: { target: 'esnext', copyPublicDir: false, emptyOutDir: false },
});
