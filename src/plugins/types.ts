// The plugin contract now lives in the self-contained, copy-pasteable Plugin.type.ts (so external authors can
// reference/copy it without pulling in app internals). This module re-exports it for in-app code and adds the
// runtime definePlugin() helper (identity — it just types your object).
export * from './Plugin.type';
import type { Plugin } from './Plugin.type';

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
