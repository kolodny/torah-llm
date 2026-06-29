# Writing a Torah plugin — the single source of truth

A plugin is **one `.js` file** loaded at runtime — the host imports it and registers its `export default`.
The exact same path is used for the app's own plugins and third-party ones, so there's one way to write them.

## The contract (3 pieces, all copy-pasteable)

1. **`src/plugins/Plugin.type.ts`** — every plugin type, fully self-contained (only depends on `react`'s
   types). Copy it into your project for full typing. It also declares `window.__torahRuntime` (the host SDK).
2. **`vite.plugin.config.ts`** — the build. Bundles your plugin to one IIFE and **externalizes**
   `react` / `react/jsx-runtime` / `@mantine/core` / `react-router` to the host's copies on
   `window.__torahRuntime`, so your plugin shares the host's *single* instance of each (hooks & JSX work) and
   stays tiny.
3. **`window.__torahRuntime`** — the host installs this before loading any plugin. Top level carries the shared
   libs (`react`, `jsxRuntime`, `mantine`, `reactRouter` — what the build externalizes); the host SDK lives under
   **`.sdk`**: `definePlugin`, `registerPlugin`, `components.{BookCheckTree}`, `util.{stripHtml}`,
   `hooks.{useSlot, usePages, useDecorationsTick}`. (Types for all of it are in `Plugin.type.ts → TorahRuntime`.)

## How a plugin is written

```tsx
import { useState } from 'react';                 // externalized → host React (one instance)
import { Stack, Button } from '@mantine/core';    // externalized → host Mantine
import type { PluginContext } from './Plugin.type';

const { definePlugin } = window.__torahRuntime.sdk;   // + .components.BookCheckTree, .util.stripHtml, .hooks.useSlot, … as needed

export default definePlugin({
  manifest: { id: 'hello', name: 'Hello', version: '1.0.0', apiVersion: '^1' /*, permissions, activationEvents */ },
  activate(ctx: PluginContext) {
    ctx.registerPage({ id: 'hello', title: 'Hello', icon: '👋', render: () => <Stack>…</Stack> });
    // or: ctx.viewer.addSidebar({...});  ctx.data.query(...);  ctx.ui.linkProps(book, ref);
  },
});
```

- **Import libs normally** (`react`, `@mantine/core`, `react-router`) — the build externalizes them.
- **Get the SDK off `window.__torahRuntime.sdk`** — `definePlugin`, plus `components.BookCheckTree`/`util.stripHtml`/`hooks.useSlot`/… as needed.
- **`export default definePlugin({…})`** — the host loads the bundle and registers its default export. (A self-registering bundle may also call `window.__torahRuntime.sdk.registerPlugin(...)` directly.)
- Everything a plugin can do is on the `ctx` passed to `activate` — see `PluginContext` in `Plugin.type.ts`. Highlights:
  - **`ctx.viewer.*`** — typed sugar for the viewer page's slots (`addSidebar`, `addVerseAction`, `addLinkAction`, `addDecoration`, `addEditor`, `addTextSelectAction`); equivalent to `ctx.contribute('viewer', <slot>, …)`.
  - **`ctx.ui.linkProps(book, ref)`** — `{ href, onClick }` to spread on an `<a>`/`<Anchor>` (in-app navigate + cmd-click works).
  - **`ctx.exposeApi(name, api)` / `ctx.getApi(name)`** — publish/consume a cross-plugin API by name (how a plugin extends another's page — see the Code page below).

## Build it

```sh
PLUGIN_ENTRY=index.tsx PLUGIN_ID=hello vite build --config vite.plugin.config.ts
# → dist/hello.js   (a ~1 KB self-registering IIFE)
```

## Load it (host side)

Drop `<id>.js` in `public/plugins/` and add its id to `public/plugins/index.json` (`["hello", …]`). At startup
the host calls `installPluginRuntime()` then `loadExternalPlugins(BASE_URL)`, which fetches that list and injects
each `<script>` in turn; the host then registers the bundle's default export. Registered pages appear in the
nav automatically (the registry is reactive). All the app's own plugins ship this way except **code-search**,
which stays bundled (it pulls in Monaco). `npm run build:plugins` builds them all into `public/plugins/`.

## Worked examples

The app's own plugins are the reference — all built this way (`npm run build:plugins` → `public/plugins/`):
- `plugins/pasuk-name/` — a simple **page** (`ctx.registerPage`) using `react-router` + Mantine.
- `plugins/songs/` — a **link action** + a viewer **sidebar** (`ctx.viewer.addLinkAction` / `addSidebar`).
- `plugins/gematria/` — a page + a verse action + a decoration, and **extends the Code page** via `ctx.getApi('code-search')` (the code-search plugin `exposeApi`s it).
- `plugins/torah-code/` — registers SQL functions + a result-cell renderer on the Code page.
- `plugins/reader-modes/` — contributes whole **reader editors** (lazy, `onBook:*` activation).

## Load it at runtime — the **Custom plugins** panel (no rebuild)

Third-party plugins don't need to be part of the build. Host your bundle anywhere it can be fetched as a
script, then in the app go to **Storage → Custom plugins** and paste the URL to its `.js`:

- The host injects it as a `<script>`, reads its `export default`, and registers it on the spot — if it
  declares a page, the nav tab appears immediately (the registry is reactive). No reload needed.
- The URL is saved in `localStorage` (`torah:user-plugins`) and **auto-loads on every startup**, *after* the
  first-party plugins — so your plugin can consume an API they expose (e.g. `ctx.getApi('code-search')`).
- **Remove** forgets the URL; the already-loaded instance stays until the next reload.
- Your bundle must be reachable from the app's origin. A cross-origin `<script>` runs fine, but the host
  reads the plugin off `window.__torahPlugin`, so build it the normal way (IIFE via `vite.plugin.config.ts`) —
  it assigns `export default` there automatically.

Programmatic equivalents are exported from `src/plugins/host.tsx`: `addUserPlugin(url)` /
`removeUserPlugin(url)` / `getUserPluginUrls()` / `loadUserPlugin(url)`.

## Trust note

These bundles run **in the host's origin** with full access (same-origin). That's fine for first-party / curated
plugins. Sandboxing untrusted third-party plugins (opaque-origin iframe + RPC, or a SES compartment for headless
ones) is a separate, larger piece — see the LLM log's plugin-platform notes.
