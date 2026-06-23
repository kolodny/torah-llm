// The plugin host (v3): a PAGE registry + a (pageId, slot) contribution registry, both reactive via
// useSyncExternalStore. Plugins register pages (clobbering an id from another plugin is an error) and
// contribute into page slots. UI/navigation route through a store-backed bridge installed before
// activation. Lifecycle is Disposable-based (HMR-safe); capabilities + lazy activation as in v2.

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
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

/** Fire an activation event; any dormant plugin that declared it activates now. */
export function fireActivation(event: string) {
  for (const [id, d] of discovered) {
    if (!activated.has(id) && d.events.includes(event)) activatePlugin(id);
  }
}

/** Discover every plugin under /plugins/, then activate the ones whose activation events have fired. */
export function loadPlugins() {
  const mods = import.meta.glob('/plugins/*/index.{ts,tsx}', { eager: true }) as Record<string, { default?: Plugin }>;
  for (const [path, mod] of Object.entries(mods)) {
    const plugin = mod.default;
    if (!plugin?.manifest?.id || typeof plugin.activate !== 'function') {
      console.warn(`[plugins] ${path}: no valid default export — skipped`);
      continue;
    }
    const { id, apiVersion } = plugin.manifest;
    if (discovered.has(id)) continue;
    if (!apiVersionOk(apiVersion)) {
      console.warn(`[plugins] "${id}" targets API ${apiVersion}; host is ${PLATFORM_API_VERSION} — skipped`);
      continue;
    }
    discovered.set(id, { plugin, events: plugin.manifest.activationEvents ?? ['onStartupFinished'] });
  }
  for (const [id, d] of discovered) {
    if (d.events.includes('onStartupFinished') || d.events.includes('*')) activatePlugin(id);
  }
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

  useMemo(() => loadPlugins(), []);
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
    resetBus();
    notify();
  });
}
