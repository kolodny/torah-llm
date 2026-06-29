// The plugin host (v3): a PAGE registry + a (pageId, slot) contribution registry, both reactive via
// useSyncExternalStore. Plugins register pages (clobbering an id from another plugin is an error) and
// contribute into page slots. UI/navigation route through a store-backed bridge installed before
// activation. Lifecycle is Disposable-based (HMR-safe); capabilities + lazy activation as in v2.

import { useEffect, useMemo, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import {
  getToc,
  getEditions,
  getContent,
  getSegment,
  getSiblings,
  getLinks,
  ensureBook,
  hasLocalContent,
  query as dbQuery,
  schema as dbSchema,
  defineFunctions as dbDefineFunctions,
} from '../db/client';
import { actions, filters, resetBus, type Disposable } from './bus';
import type { Contribution, PageDef, Plugin, PluginContext, PluginData, PluginManifest, PluginStorage, ReaderContext } from './types';
import { useWorkbench } from '../workbench/store';

export const PLATFORM_API_VERSION = '1.0.0';

// --- reactive registry (pages + page slots) ---------------------------------------------------
const regSubs = new Set<() => void>();
const notify = () => {
  for (const cb of regSubs) cb();
};
const subscribeReg = (cb: () => void) => {
  regSubs.add(cb);
  return () => regSubs.delete(cb);
};

let pages: PageDef[] = [];
const pageOwners = new Map<string, string>(); // pageId → owning plugin id (clobber detection)

function registerPage(owner: string, page: PageDef): Disposable {
  const existingOwner = pageOwners.get(page.id);
  if (existingOwner && existingOwner !== owner) {
    console.error(`[plugins] page id "${page.id}" is already registered by "${existingOwner}" — "${owner}" cannot clobber it`);
    return { dispose() {} };
  }
  pageOwners.set(page.id, owner);
  pages = [...pages.filter((p) => p.id !== page.id), page].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
  notify();
  return {
    dispose() {
      pages = pages.filter((p) => p !== page);
      if (pageOwners.get(page.id) === owner) pageOwners.delete(page.id);
      notify();
    },
  };
}

// Slots: contributions keyed by `${pageId}\x1f${slot}`. Each key holds a stable array between changes.
let slots: Record<string, Contribution[]> = {};
const EMPTY: Contribution[] = [];
const slotKey = (pageId: string, slot: string) => `${pageId}\x1f${slot}`;

function addSlot(pageId: string, slot: string, c: Contribution): Disposable {
  const key = slotKey(pageId, slot);
  slots = { ...slots, [key]: [...(slots[key] ?? []).filter((x) => x.id !== c.id), c] }; // replace same id
  notify();
  return {
    dispose() {
      slots = { ...slots, [key]: (slots[key] ?? []).filter((x) => x !== c) };
      notify();
    },
  };
}

export function usePages(): PageDef[] {
  return useSyncExternalStore(
    subscribeReg,
    () => pages,
    () => pages
  );
}

/** Live contributions for a page's slot; re-renders the caller when they change. */
export function useSlot<T extends Contribution>(pageId: string, slot: string): T[] {
  const key = slotKey(pageId, slot);
  const get = () => (slots[key] ?? EMPTY) as T[];
  return useSyncExternalStore(subscribeReg, get, get);
}

// --- decoration invalidation (a provider signals 'decorations.changed'; segments re-decorate) ----
let decoTick = 0;
const decoTickSubs = new Set<() => void>();
function bumpDecorations() {
  decoTick += 1;
  for (const cb of decoTickSubs) cb();
}
actions.on('decorations.changed', bumpDecorations);
export function useDecorationsTick(): number {
  return useSyncExternalStore(
    (cb) => {
      decoTickSubs.add(cb);
      return () => decoTickSubs.delete(cb);
    },
    () => decoTick
  );
}

// --- reader context + store-backed bridge -----------------------------------------------------
let currentReader: ReaderContext = { book: null, ref: null, editions: [], selected: [] };
const readerSubs = new Set<(c: ReaderContext) => void>();
let lastDecoKey = '';
let lastActivatedBook: string | null = null;
function setReader(ctx: ReaderContext) {
  currentReader = ctx;
  actions.emit('reader.changed', ctx);
  for (const fn of readerSubs) fn(ctx);
  if (ctx.book && ctx.book !== lastActivatedBook) {
    lastActivatedBook = ctx.book;
    fireActivation(`onBook:${ctx.book}`);
    fireActivation('onBook:*');
  }
  const key = `${ctx.book}${ctx.selected.join(',')}`;
  if (key !== lastDecoKey) {
    lastDecoKey = key;
    bumpDecorations();
  }
}

type Bridge = {
  openPage(id: string): void;
  navigate(book: string, ref?: string | null): void;
  peek(book: string, ref: string | null): void;
  toast(message: string): void;
};
const bridge: Bridge = { openPage() {}, navigate() {}, peek() {}, toast: (m) => console.log('[toast]', m) };

// --- capability-scoped data / storage / config ------------------------------------------------
function readOnlyQuery(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  // Skip leading whitespace + SQL comments, then require a read-only leading keyword.
  const head = sql.replace(/^(?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '');
  if (!/^(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(head)) {
    return Promise.reject(new Error(`query() is read-only (SELECT/WITH/PRAGMA/EXPLAIN only) — refused: ${head.slice(0, 50)}`));
  }
  // Reject multi-statement SQL (e.g. `SELECT 1; DELETE FROM content`). Blank out comments + string/quoted-
  // identifier literals FIRST so a `;` inside a comment or a string literal isn't mistaken for a second
  // statement, then refuse if a `;` remains anywhere but the very end.
  const body = sql
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/'(?:[^']|'')*'/g, "''") // string literals
    .replace(/"(?:[^"]|"")*"/g, '""') // quoted identifiers
    .trim()
    .replace(/;\s*$/, '');
  if (body.includes(';')) {
    return Promise.reject(new Error(`query() allows a single statement only — refused: ${head.slice(0, 50)}`));
  }
  return dbQuery(sql, params);
}
// Namespace a plugin SQL-function name by plugin id: defineFunctions({name:'find'}) from torah-code →
// torah_code_find. A plugin's namesake function (name omitted, or equal to its id) stays bare, e.g. gematria.
function nsName(pluginId: string, name: string): string {
  const p = pluginId.replace(/[^a-z0-9]+/gi, '_');
  if (!name || name === p) return p;
  return name.startsWith(p + '_') ? name : `${p}_${name}`;
}
const fullData: PluginData = { getToc, getEditions, getContent, getSegment, getSiblings, getLinks, ensureBook, hasLocalContent, query: readOnlyQuery, schema: dbSchema, defineFunctions: dbDefineFunctions };
function denied<T extends object>(cap: string, methods: string[]): T {
  const o: Record<string, () => never> = {};
  for (const m of methods)
    o[m] = () => {
      throw new Error(`[plugin] permission "${cap}" not granted`);
    };
  return o as T;
}
function storageFor(pluginId: string): PluginStorage {
  const prefix = `torah:plugin:${pluginId}:`;
  const k = (key: string) => prefix + key;
  return {
    async get(key) {
      const v = localStorage.getItem(k(key));
      return v == null ? undefined : JSON.parse(v);
    },
    async set(key, value) {
      localStorage.setItem(k(key), JSON.stringify(value));
    },
    async delete(key) {
      localStorage.removeItem(k(key));
    },
    async keys(p = '') {
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const full = localStorage.key(i)!;
        if (full.startsWith(prefix + p)) out.push(full.slice(prefix.length));
      }
      return out;
    },
  };
}

// --- cross-plugin API registry (ctx.exposeApi / ctx.getApi) -----------------------------------
// A flat name → value map. A plugin publishes a value (e.g. a page's extension-API factory) under a name;
// any other plugin reads it by that name. Decouples consumers from the provider's module (no host involvement
// beyond this map). An entry is removed when its publishing plugin unloads.
let apiRegistry: Record<string, unknown> = {};

// In-app URL for a verse/book — shared by ui.href and ui.linkProps.
const viewerHref = (book: string, ref?: string | null) =>
  `?page=viewer&book=${encodeURIComponent(book)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;

// --- per-plugin context -----------------------------------------------------------------------
function contextFor(manifest: PluginManifest): PluginContext {
  const subscriptions: Disposable[] = [];
  const track = <T extends Disposable>(d: T): T => {
    subscriptions.push(d);
    return d;
  };
  const perms = new Set<string>(manifest.permissions ?? []);
  const grant = (p: string) => manifest.id === 'core' || perms.has(p);
  const data: PluginData = grant('data:read')
    ? { ...fullData, defineFunctions: (specs) => dbDefineFunctions(specs.map((s) => ({ ...s, name: nsName(manifest.id, s.name) }))) }
    : denied<PluginData>('data:read', ['getToc', 'getEditions', 'getContent', 'getSegment', 'getSiblings', 'getLinks', 'ensureBook', 'hasLocalContent', 'query', 'schema', 'defineFunctions']);
  const storage: PluginStorage = grant('storage')
    ? storageFor(manifest.id)
    : denied<PluginStorage>('storage', ['get', 'set', 'delete', 'keys']);
  const cfgPrefix = `torah:config:${manifest.id}:`;
  return {
    manifest,
    subscriptions,
    registerPage: (page) => track(registerPage(manifest.id, page)),
    contribute: (pageId, slot, contribution) => track(addSlot(pageId, slot, contribution)),
    viewer: {
      addSidebar: (panel) => track(addSlot('viewer', 'sidebar', panel)),
      addVerseAction: (action) => track(addSlot('viewer', 'verseAction', action)),
      addLinkAction: (action) => track(addSlot('viewer', 'linkAction', action)),
      addDecoration: (provider) => track(addSlot('viewer', 'decoration', provider)),
      addEditor: (editor) => track(addSlot('viewer', 'editor', editor)),
      addTextSelectAction: (action) => track(addSlot('viewer', 'onTextSelect', action)),
    },
    exposeApi: (name, api) => {
      apiRegistry = { ...apiRegistry, [name]: api };
      return track({
        dispose() {
          if (apiRegistry[name] === api) {
            const { [name]: _drop, ...rest } = apiRegistry;
            apiRegistry = rest;
          }
        },
      });
    },
    getApi: <T,>(name: string) => apiRegistry[name] as T | undefined,
    reader: {
      get current() {
        return currentReader;
      },
      onDidChange: (fn) => {
        readerSubs.add(fn);
        // Deliver the current context once to a late subscriber (added after the reader already has a book), so
        // it isn't stuck until the next change. Future setReader() calls still fire fn with their new value.
        try {
          fn(currentReader);
        } catch (e) {
          console.error(`[plugins] "${manifest.id}" reader.onDidChange initial call threw:`, e);
        }
        return track({ dispose: () => void readerSubs.delete(fn) });
      },
    },
    ui: {
      openPage: (id) => bridge.openPage(id),
      navigate: (book, ref) => bridge.navigate(book, ref),
      peek: (book, ref) => bridge.peek(book, ref),
      showToast: (m) => bridge.toast(m),
      href: (book, ref) => viewerHref(book, ref),
      linkProps: (book, ref) => ({
        href: viewerHref(book, ref),
        onClick: (e: ReactMouseEvent) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a new tab
          e.preventDefault();
          bridge.navigate(book, ref);
        },
      }),
    },
    data,
    storage,
    config: {
      get: (key, fallback) => {
        const v = localStorage.getItem(cfgPrefix + key);
        return v == null ? fallback : JSON.parse(v);
      },
      set: (key, value) => {
        localStorage.setItem(cfgPrefix + key, JSON.stringify(value));
        actions.emit('config.changed', { plugin: manifest.id, key });
      },
      onDidChange: (fn) =>
        track(
          actions.on('config.changed', (p) => {
            const e = p as { plugin: string; key: string };
            if (e.plugin === manifest.id) fn(e.key);
          })
        ),
    },
    actions: { emit: (e, p) => actions.emit(e, p), on: (e, fn, p) => track(actions.on(e, fn, p)) },
    filters: { apply: (n, v, c) => filters.apply(n, v, c), add: (n, fn, p) => track(filters.add(n, fn, p)) },
  };
}

/** A context the app core uses to register built-in pages + contributions through the same API plugins use. */
export const coreContext: PluginContext = contextFor({ id: 'core', name: 'Core', version: PLATFORM_API_VERSION, apiVersion: PLATFORM_API_VERSION });

// --- discovery + lifecycle --------------------------------------------------------------------
const majorOf = (semver: string) => semver.match(/\d+/)?.[0] ?? '';
const apiVersionOk = (range: string) => majorOf(range) === majorOf(PLATFORM_API_VERSION);

type Discovered = { plugin: Plugin; events: string[] };
const discovered = new Map<string, Discovered>();
const activated = new Map<string, PluginContext>();
// Activation events that have already fired this session. External bundles load ASYNC (serial <script>
// injection), so a plugin can be discovered AFTER its event fired (e.g. onBook:* fires when a book opens
// from a cold deep-link, before the bundle arrives). We record fired events so late-discovered plugins
// still activate instead of waiting for a re-fire that may never come.
const firedEvents = new Set<string>();

function activatePlugin(id: string) {
  if (activated.has(id)) return;
  const d = discovered.get(id);
  if (!d) return;
  const ctx = contextFor(d.plugin.manifest);
  activated.set(id, ctx);
  // On a failed activate() (sync throw or async rejection), dispose everything it already registered so a
  // half-activated plugin leaves no orphaned pages/slots/listeners behind.
  const cleanup = (e: unknown) => {
    console.error(`[plugins] "${id}" failed to activate:`, e);
    for (const sub of ctx.subscriptions) sub.dispose();
    activated.delete(id);
  };
  try {
    Promise.resolve(d.plugin.activate(ctx)).catch(cleanup);
    actions.emit('plugin.activated', { id });
    console.log(`[plugins] activated "${id}"`);
  } catch (e) {
    cleanup(e);
  }
}

/** Fire an activation event; any dormant plugin that declared it activates now. The event is remembered so
 *  a plugin discovered later (async bundle) that declared it activates immediately on discovery. */
export function fireActivation(event: string) {
  firedEvents.add(event);
  for (const [id, d] of discovered) {
    if (!activated.has(id) && d.events.includes(event)) activatePlugin(id);
  }
}

// Validate + record a plugin in the registry. Shared by both load paths so a built-in (bundled) and an
// external (runtime JS) plugin go through the exact same discovery — the single source of truth.
function discover(plugin: Plugin | undefined, source: string): string | null {
  if (!plugin?.manifest?.id || typeof plugin.activate !== 'function') {
    console.warn(`[plugins] ${source}: no valid plugin (need { manifest.id, activate }) — skipped`);
    return null;
  }
  const { id, apiVersion } = plugin.manifest;
  if (discovered.has(id)) return null;
  if (!apiVersionOk(apiVersion)) {
    console.warn(`[plugins] "${id}" targets API ${apiVersion}; host is ${PLATFORM_API_VERSION} — skipped`);
    return null;
  }
  discovered.set(id, { plugin, events: plugin.manifest.activationEvents ?? ['onStartupFinished'] });
  return id;
}

const startupReady = (events: string[]) => events.includes('onStartupFinished') || events.includes('*');
// Should a just-discovered plugin activate right now? — yes if it's startup-ready, or if any event it
// declared has already fired this session (it loaded too late to catch the live fireActivation()).
const shouldActivateOnDiscovery = (events: string[]) => startupReady(events) || events.some((e) => firedEvents.has(e));

/** Register a plugin object (a plugin bundle's `export default definePlugin({…})`) — or a self-registering
 *  bundle can call this directly. Same discovery + lazy-activation as the bundled path. Exposed on
 *  window.__torahRuntime as registerPlugin. */
export function registerExternalPlugin(plugin: Plugin) {
  const id = discover(plugin, `external:${plugin?.manifest?.id ?? '?'}`);
  if (id && shouldActivateOnDiscovery(discovered.get(id)!.events)) activatePlugin(id);
}

/** Load runtime plugin bundles listed in public/plugins/index.json by injecting each <script> (IIFE) in turn;
 *  the bundle's default export (`window.__torahPlugin.default`) is then registered. Same path a third-party
 *  plugin uses. Loaded serially because each IIFE writes the shared __torahPlugin global. */
export async function loadExternalPlugins(base: string) {
  let ids: string[] = [];
  try {
    const res = await fetch(`${base}plugins/index.json`, { cache: 'no-cache' });
    if (res.ok) ids = (await res.json()) as string[];
  } catch {
    /* no external plugins published — fine */
  }
  // The IIFE assigns its `export default` to window.__torahPlugin — for a default-only bundle rollup makes
  // that the plugin object itself; if a bundle ever has named exports it'd be { default: … }. Accept both.
  const w = window as unknown as { __torahPlugin?: Plugin | { default?: Plugin } };
  for (const id of ids) {
    await new Promise<void>((resolve) => {
      w.__torahPlugin = undefined;
      const s = document.createElement('script');
      s.src = `${base}plugins/${id}.js`;
      s.onload = () => {
        const ns = w.__torahPlugin as (Plugin & { default?: Plugin }) | undefined;
        const plugin = ns?.default ?? ns;
        if (plugin?.manifest) registerExternalPlugin(plugin);
        else console.error(`[plugins] external plugin "${id}" has no default export`);
        resolve();
      };
      s.onerror = () => {
        console.error(`[plugins] failed to load external plugin "${id}"`);
        resolve();
      };
      document.head.appendChild(s);
    });
  }
}

/** Discover every BUILT-IN plugin under /plugins/ (bundled via glob). External plugins load separately via
 *  loadExternalPlugins(). Both end at the same discover()/activatePlugin(). */
export function loadPlugins() {
  // code-search stays bundled (it pulls in Monaco, which doesn't make a clean standalone IIFE). Every OTHER
  // plugin is built to public/plugins/<id>.js and loaded by loadExternalPlugins() — the same path third-party
  // plugins use. Both end at the same discover()/activatePlugin().
  const mods = import.meta.glob('/plugins/code-search/index.{ts,tsx}', { eager: true }) as Record<string, { default?: Plugin }>;
  for (const [path, mod] of Object.entries(mods)) discover(mod.default, path);
  for (const [id, d] of discovered) if (startupReady(d.events)) activatePlugin(id);
}

export function unloadAll() {
  for (const ctx of activated.values()) {
    try {
      for (const d of ctx.subscriptions) d.dispose();
    } catch (e) {
      console.error(`[plugins] error disposing "${ctx.manifest.id}":`, e);
    }
  }
  activated.clear();
  discovered.clear();
}

// --- React layer ------------------------------------------------------------------------------
/** Installs the store-backed bridge, activates plugins, pushes reader context, fires onPage events. */
export function PluginProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useWorkbench();
  bridge.openPage = (id) => dispatch({ type: 'setPage', id });
  bridge.navigate = (b, r) => dispatch({ type: 'navigate', book: b, ref: r ?? null });
  bridge.peek = (b, r) => dispatch({ type: 'peek', book: b, ref: r });
  bridge.toast = (m) => dispatch({ type: 'toast', message: m });

  useMemo(() => {
    loadPlugins(); // built-in (bundled) plugins
    void loadExternalPlugins(import.meta.env.BASE_URL); // runtime .js bundles (same path third-party plugins use)
  }, []);
  useEffect(() => fireActivation(`onPage:${state.page}`), [state.page]);

  return <>{children}</>;
}

/** A page/component calls this to publish the current reader context to plugins (book/ref/editions). */
export function usePublishReader(reader: ReaderContext) {
  useEffect(() => setReader(reader), [reader]);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unloadAll();
    pages = [];
    pageOwners.clear();
    slots = {};
    apiRegistry = {};
    firedEvents.clear();
    resetBus();
    notify();
  });
}
