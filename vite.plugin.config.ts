// ─────────────────────────────────────────────────────────────────────────────────────────────
//  Build config for a Torah plugin — COPY/PASTE this into your plugin project alongside Plugin.type.ts.
//
//  It bundles your plugin into ONE self-registering IIFE `.js` file. React / Mantine / react-router are
//  marked EXTERNAL and mapped to the host's copies on `window.__torahRuntime`, so your plugin shares the
//  host's single instance of each (no duplicate React → hooks/JSX work) and stays tiny. The host SDK
//  (definePlugin, registerPlugin, useSlot, BookCheckTree, …) is read straight off `window.__torahRuntime`
//  at runtime, so it isn't bundled either.
//
//  Build:   vite build --config vite.plugin.config.ts
//  Output:  dist/<PLUGIN_ID>.js   (drop it on the host; it self-registers when loaded)
//
//  Env (optional): PLUGIN_ENTRY (default ./index.tsx), PLUGIN_ID (default "plugin"), PLUGIN_OUTDIR (default dist).
// ─────────────────────────────────────────────────────────────────────────────────────────────
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const RT = 'window.__torahRuntime';
// specifier → the global expression rollup rewrites `import … from '<specifier>'` to.
const externals: Record<string, string> = {
  react: `${RT}.react`,
  'react/jsx-runtime': `${RT}.jsxRuntime`,
  'react/jsx-dev-runtime': `${RT}.jsxRuntime`,
  'react-dom': `${RT}.reactDom`,
  '@mantine/core': `${RT}.mantine`,
  'react-router': `${RT}.reactRouter`,
};

const entry = resolve(process.cwd(), process.env.PLUGIN_ENTRY ?? 'index.tsx');
const id = process.env.PLUGIN_ID ?? 'plugin';

export default defineConfig({
  // A plugin bundle has no static assets of its own — and crucially this stops Vite from copying the app's
  // publicDir (which holds the ~886 MB public/db corpus) into the plugin outDir on every build.
  publicDir: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: process.env.PLUGIN_OUTDIR ?? 'dist',
    emptyOutDir: false,
    target: 'es2020',
    minify: true,
    lib: { entry, name: '__torahPlugin', formats: ['iife'], fileName: () => `${id}.js` },
    rollupOptions: {
      external: Object.keys(externals),
      output: { globals: externals, extend: true, inlineDynamicImports: true },
    },
  },
});
