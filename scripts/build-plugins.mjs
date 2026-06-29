// Build every external plugin under plugins/* into a self-registering IIFE in public/plugins/<id>.js using the
// shared, copy-pasteable vite.plugin.config.ts, then write public/plugins/index.json (the list the host loads).
// code-search is SKIPPED — it bundles Monaco, which doesn't make a clean standalone IIFE, so it stays a
// built-in (loaded via the glob in host.tsx). Run: npm run build:plugins
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const pluginsDir = resolve(root, 'plugins');
const outDir = resolve(root, 'public', 'plugins');
const BUNDLED = new Set(['code-search']); // stays a built-in (Monaco)

mkdirSync(outDir, { recursive: true });

const plugins = [];
for (const id of readdirSync(pluginsDir)) {
  if (BUNDLED.has(id)) continue;
  const entry = ['index.tsx', 'index.ts'].map((f) => resolve(pluginsDir, id, f)).find(existsSync);
  if (entry) plugins.push({ id, entry });
}

for (const { id, entry } of plugins) {
  console.log(`\nbuilding plugin "${id}" …`);
  execFileSync('npx', ['vite', 'build', '--config', 'vite.plugin.config.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PLUGIN_ENTRY: entry, PLUGIN_ID: id, PLUGIN_OUTDIR: outDir },
  });
}

writeFileSync(resolve(outDir, 'index.json'), JSON.stringify(plugins.map((p) => p.id)) + '\n');
console.log(`\n✓ built ${plugins.length} external plugin(s): ${plugins.map((p) => p.id).join(', ')}  (code-search stays bundled)`);
