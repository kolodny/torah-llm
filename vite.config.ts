import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [react()],
  // sqlite-wasm ships its own .wasm + worker glue; let it resolve at runtime.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  // The corpus lives in public/db (multi-GB). Don't copy it on every app build — `npm run build:db` ships it.
  // emptyOutDir:false so an app build doesn't wipe the separately-deployed dist/db corpus; the build script
  // clears dist/assets itself. copyPublicDir:false so the multi-GB public/db isn't copied here (`build:db` does).
  build: { target: 'esnext', copyPublicDir: false, emptyOutDir: false },
});
