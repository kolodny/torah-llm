// ─────────────────────────────────────────────────────────────────────────────────────────────
//  Torah plugin contract — THE single source of truth for writing a plugin.
//
//  This file is fully SELF-CONTAINED (its only dependency is `react`'s types). Copy it into an
//  external plugin project to get full typing; nothing here imports app internals.
//
//  A plugin is one JS file built as an IIFE (see PLUGINS.md). At runtime it reads the host's
//  shared React / Mantine / react-router and the plugin API off `window.__torahRuntime` — so it uses
//  the host's SINGLE instance of each instead of bundling its own. A minimal plugin:
//
//    import { Text } from '@mantine/core';          // externalized to the host at build time
//    import type { PluginContext } from './Plugin.type';
//    const { definePlugin } = window.__torahRuntime.sdk;
//    export default definePlugin({
//      manifest: { id: 'hello', name: 'Hello', version: '1.0.0', apiVersion: '^1' },
//      activate(ctx: PluginContext) {
//        ctx.registerPage({ id: 'hello', title: 'Hello', render: () => <Text>hi</Text> });
//      },
//    });
// ─────────────────────────────────────────────────────────────────────────────────────────────
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

// ── primitives (inlined from the host's bus + db layer so this file stands alone) ──────────────
export type Disposable = { dispose(): void };

export type Actions = {
  /** Notify every listener of `event` in priority order. */
  emit(event: string, payload?: unknown): void;
  /** Listen for `event`; returns a Disposable. */
  on(event: string, fn: (payload: unknown) => void, priority?: number): Disposable;
};
export type Filters = {
  /** Run `value` through every transform registered for `name` (priority order). */
  apply<T>(name: string, value: T, ctx?: unknown): Promise<T>;
  /** Register a transform `(value, ctx) => nextValue`; returns a Disposable. */
  add<T>(name: string, fn: (value: T, ctx: unknown) => T | Promise<T>, priority?: number): Disposable;
};

export type TocRow = {
  id: string;
  parent_id: string | null;
  kind: 'category' | 'book';
  title_en: string | null;
  title_he: string | null;
  category_en: string | null;
  category_he: string | null;
  order_index: number | null;
  has_content: number; // 0 | 1
  edition_count: number;
  file_size: number | null;
  content_version?: string | null;
};
export type Edition = {
  id: string;
  toc_id: string;
  source: string;
  lang: string; // 'he' | 'en' | 'fr' | …
  title: string;
  info: string | null;
  order_index: number | null;
};
export type ContentRow = { edition_id: string; ref: string; text: string };
/** A link from the current book's ref to content in another (possibly not-yet-local) book. */
export type LinkRef = { otherId: string; otherRef: string; connectionType: string | null };

// ── reader + selection ─────────────────────────────────────────────────────────────────────────
/** The reader's current state, observable by plugins. */
export type ReaderContext = { book: string | null; ref: string | null; editions: Edition[]; selected: string[] };
/** A text selection in the reader (for onTextSelect contributions). */
export type TextSelection = { text: string; book: string | null; ref: string | null };

// ── data access (present iff 'data:read' granted) ───────────────────────────────────────────────
export type SqlFnSpec = { name: string; args: string[]; body: string; arity?: number };
export type PluginData = {
  getToc(): Promise<TocRow[]>;
  getEditions(tocId: string): Promise<Edition[]>;
  getContent(tocId: string): Promise<ContentRow[]>;
  getSegment(tocId: string, ref: string): Promise<ContentRow[]>;
  getSiblings(tocId: string, ref: string): Promise<ContentRow[]>;
  getLinks(tocId: string): Promise<Record<string, LinkRef[]>>;
  ensureBook(tocId: string): Promise<void>;
  /** Cheap check: is this book's content already downloaded locally? */
  hasLocalContent(tocId: string): Promise<boolean>;
  /** Arbitrary read-only (SELECT) SQL against the local DB. The custom evalJS() function is available. */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Table → column names (for schema-aware autocomplete). */
  schema(): Promise<Record<string, string[]>>;
  /** Register plugin SQL functions (names auto-namespaced by plugin id). Bodies are pure JS, run in the worker. */
  defineFunctions(specs: SqlFnSpec[]): Promise<void>;
};

/** Persistent, plugin-scoped KV (present iff 'storage' granted). NOT cleared by a content wipe. */
export type PluginStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
};
/** Plugin-scoped settings. */
export type PluginConfig = {
  get<T = unknown>(key: string, fallback?: T): T | undefined;
  set(key: string, value: unknown): void;
  onDidChange(fn: (key: string) => void): Disposable;
};

export type Permission = 'data:read' | 'data:write' | 'storage' | 'network';

// ── contribution shapes (a page interprets the slots it reads) ──────────────────────────────────
export type Contribution = { id: string };
export type Verse = { book: string; ref: string; texts: Record<string, string>; editions: Edition[] };
export type VerseAction = Contribution & { label: string; icon?: ReactNode; when?(verse: Verse): boolean; run(verse: Verse): void };
export type LinkInfo = { from: { book: string; ref: string }; to: { book: string; ref: string }; connectionType: string | null };
export type LinkAction = Contribution & { label: string; icon?: ReactNode; when?(link: LinkInfo): boolean; run(link: LinkInfo): void };
/** A rendered text segment, handed to decoration providers (offsets index `text`, the tag-stripped html). */
export type Segment = { book: string; ref: string; editionId: string; lang: string; html: string; text: string; primary?: boolean };
export type Decoration =
  | { kind: 'mark'; from: number; to: number; className?: string; title?: string; onClick?(event: MouseEvent, seg: Segment): void }
  | { kind: 'lineWidget'; render(seg: Segment): ReactNode };
export type DecorationProvider = Contribution & { provide(seg: Segment): Decoration[] };
export type BookView = {
  reader: ReaderContext;
  editions: Edition[];
  content: ContentRow[] | null;
  links: Record<string, LinkRef[]>;
  sections: string[];
  bookTotals?: { sections: number; verses: number } | null;
  busy: boolean;
  setEditions(ids: string[]): void;
};
export type EditorProps = { view: BookView };
export type EditorDef = Contribution & { title: string; icon?: ReactNode; managesOwnScroll?: boolean; canRender(reader: ReaderContext): number; render(props: EditorProps): ReactNode };
/** A right-rail panel on the viewer (viewer:sidebar). Its render is a React component (use hooks freely). */
export type SidebarPanel = Contribution & { title: string; icon?: ReactNode; render(): ReactNode };
export type TextSelectAction = Contribution & { label(selection: TextSelection): ReactNode | null };

// ── pages + context + manifest ──────────────────────────────────────────────────────────────────
/** A top-level page (header nav). `render` is a React component; read your slots with useSlot(id, …). */
export type PageDef = { id: string; title: string; icon?: ReactNode; order?: number; render(): ReactNode };

/** Typed sugar over contribute('viewer', <slot>, …) for the built-in viewer page's slots. Each returns a
 *  Disposable (also auto-revoked on unload). Equivalent to calling contribute() with the matching slot name. */
export type ViewerApi = {
  /** A right-rail panel (slot 'sidebar'). */
  addSidebar(panel: SidebarPanel): Disposable;
  /** An item in a verse's ⋯ menu (slot 'verseAction'). */
  addVerseAction(action: VerseAction): Disposable;
  /** An action on a cross-reference link (slot 'linkAction'). */
  addLinkAction(action: LinkAction): Disposable;
  /** A decoration provider over rendered segments (slot 'decoration'). */
  addDecoration(provider: DecorationProvider): Disposable;
  /** A whole reading view (slot 'editor'). */
  addEditor(editor: EditorDef): Disposable;
  /** An action shown when text is selected (slot 'onTextSelect'). */
  addTextSelectAction(action: TextSelectAction): Disposable;
};

export type PluginContext = {
  readonly manifest: PluginManifest;
  /** Disposables pushed here are revoked when the plugin unloads. */
  readonly subscriptions: Disposable[];
  registerPage(page: PageDef): Disposable;
  /** Contribute into any page's slot. The built-in viewer's slots have typed sugar on `ctx.viewer.*`. */
  contribute<T extends Contribution>(pageId: string, slot: string, contribution: T): Disposable;
  /** Typed helpers for the built-in viewer page (sugar over contribute('viewer', …)). */
  viewer: ViewerApi;
  /** Publish a value other plugins read via getApi(name) — e.g. a page's extension API. Revoked on unload. */
  exposeApi<T>(name: string, api: T): Disposable;
  /** Read an API another plugin published with exposeApi(name); undefined if none is registered. */
  getApi<T = unknown>(name: string): T | undefined;
  reader: { readonly current: ReaderContext; onDidChange(fn: (ctx: ReaderContext) => void): Disposable };
  ui: {
    openPage(id: string): void;
    navigate(book: string, ref?: string | null): void;
    peek(book: string, ref: string | null): void;
    showToast(message: string): void;
    /** In-app URL for a verse/book (`?page=viewer&book=…&ref=…`) — put on an <a href> for cmd-click. */
    href(book: string, ref?: string | null): string;
    /** `{ href, onClick }` for a verse/book link — spread onto an <a>/<Anchor>. Left-click navigates in-app;
     *  cmd/ctrl/shift/middle-click fall through to the browser (real new-tab). DRYs the link boilerplate. */
    linkProps(book: string, ref?: string | null): { href: string; onClick(e: ReactMouseEvent): void };
  };
  data: PluginData;
  storage: PluginStorage;
  config: PluginConfig;
  actions: Actions;
  filters: Filters;
};

/** Static, inspectable metadata (read without running the plugin). */
export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  description?: string;
  /** When to call activate(). Default ['onStartupFinished']. e.g. 'onBook:*', 'onPage:viewer'. */
  activationEvents?: string[];
  /** Capabilities the plugin needs; calling an API it didn't request throws. */
  permissions?: Permission[];
};

export type Plugin = {
  manifest: PluginManifest;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void;
};

// ── the runtime a plugin binds to at load (window.__torahRuntime) ────────────────────────────────
// The build externalizes `react`/`@mantine/core`/`react-router` to the host's copies (the top-level fields
// here), and the plugin reads the host SDK off `.sdk`. definePlugin is an identity helper (types your object);
// registerPlugin hands a plugin to the host (a self-registering bundle can call it directly).
export type TorahSdk = {
  definePlugin(plugin: Plugin): Plugin;
  registerPlugin(plugin: Plugin): void;
  /** React components the host provides. */
  components: {
    BookCheckTree(props: { toc: TocRow[]; checked: Set<string>; onChange: (next: Set<string>) => void; renderBookExtra?: (bookId: string, row: TocRow) => ReactNode }): ReactNode;
  };
  /** Pure utilities. */
  util: {
    /** Strip presentation HTML (tags, footnotes, parsha markers) and decode entities → plain text. */
    stripHtml(v: unknown): string;
  };
  /** Hooks for reading the host's reactive registries inside a page/component render. */
  hooks: {
    useSlot<T extends Contribution>(pageId: string, slot: string): T[];
    usePages(): PageDef[];
    useDecorationsTick(): number;
  };
};

export type TorahRuntime = {
  react: typeof import('react');
  jsxRuntime: unknown;
  mantine: typeof import('@mantine/core');
  reactRouter: typeof import('react-router');
  sdk: TorahSdk;
};

declare global {
  interface Window {
    __torahRuntime: TorahRuntime;
  }
}
