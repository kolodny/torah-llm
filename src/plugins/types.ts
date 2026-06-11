// The plugin contract (v3) — a PAGE platform. The app is a set of top-level pages (header nav); each
// page declares named SLOTS and decides how to place them. A plugin either registers its own page or
// contributes into some (pageId, slot). Core pages: "viewer" + "storage". One namespaced PluginContext
// is handed to activate(ctx); lifecycle is Disposable-based; capabilities + lazy activation as before.

import type { ReactNode } from 'react';
import type { TocRow, Edition, ContentRow, LinkRef } from '../db/types';
import type { Actions, Filters, Disposable } from './bus';

export type { Disposable } from './bus';

/** The reader's current state, observable by plugins. */
export type ReaderContext = {
  book: string | null;
  ref: string | null;
  editions: Edition[];
  selected: string[];
};

/** A text selection in the reader (for onTextSelect contributions). */
export type TextSelection = { text: string; book: string | null; ref: string | null };

/** Read access to the corpus — the same queries the core uses (present iff 'data:read' granted). */
export type SqlFnSpec = { name: string; args: string[]; body: string; arity?: number };

export type PluginData = {
  getToc(): Promise<TocRow[]>;
  getEditions(tocId: string): Promise<Edition[]>;
  getContent(tocId: string): Promise<ContentRow[]>;
  getSegment(tocId: string, ref: string): Promise<ContentRow[]>;
  getSiblings(tocId: string, ref: string): Promise<ContentRow[]>;
  getLinks(tocId: string): Promise<Record<string, LinkRef[]>>;
  ensureBook(tocId: string): Promise<void>;
  /** Arbitrary read-only (SELECT) SQL against the local DB. The custom evalJS() function is available. */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Table → column names (for schema-aware autocomplete). */
  schema(): Promise<Record<string, string[]>>;
  /** Register plugin SQL functions (names auto-namespaced by plugin id, e.g. torah_code_find). Bodies are pure JS, run in the worker. */
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

// --- contribution shapes (a page interprets the slots it reads) -------------------------------
// Every contribution has an id (used for de-dupe + disposal). A page knows the shape of its slots.
export type Contribution = { id: string };

/** A verse/segment, passed to verse actions. */
export type Verse = { book: string; ref: string; texts: Record<string, string>; editions: Edition[] };
/** An action in a verse's "⋯" menu (viewer:verseAction). */
export type VerseAction = Contribution & { label: string; icon?: ReactNode; when?(verse: Verse): boolean; run(verse: Verse): void };

/** A cross-reference link, passed to link actions. */
export type LinkInfo = { from: { book: string; ref: string }; to: { book: string; ref: string }; connectionType: string | null };
/** An action attached to a link (viewer:linkAction). */
export type LinkAction = Contribution & { label: string; icon?: ReactNode; when?(link: LinkInfo): boolean; run(link: LinkInfo): void };

/** A rendered text segment, handed to decoration providers (offsets index `text`, the tag-stripped html). */
export type Segment = { book: string; ref: string; editionId: string; lang: string; html: string; text: string };
export type Decoration =
  | { kind: 'mark'; from: number; to: number; className?: string; title?: string; onClick?(event: MouseEvent, seg: Segment): void }
  | { kind: 'lineWidget'; render(seg: Segment): ReactNode };
/** Contributes decorations for a segment (viewer:decoration). */
export type DecorationProvider = Contribution & { provide(seg: Segment): Decoration[] };

/** Everything a book editor needs (the core fetches it once and passes it). */
export type BookView = {
  reader: ReaderContext;
  editions: Edition[];
  content: ContentRow[] | null;
  links: Record<string, LinkRef[]>;
  sections: string[];
  busy: boolean;
  setEditions(ids: string[]): void;
};
export type EditorProps = { view: BookView };
/** A main-view reader mode (viewer:editor). Highest canRender() is the default; the user can switch. */
export type EditorDef = Contribution & { title: string; icon?: ReactNode; canRender(reader: ReaderContext): number; render(props: EditorProps): ReactNode };

/** A right-rail panel on the viewer (viewer:sidebar). Its render is a React component (use hooks freely). */
export type SidebarPanel = Contribution & { title: string; icon?: ReactNode; render(): ReactNode };

/** A contribution to the selected-text tooltip (viewer:onTextSelect) — return null to show nothing. */
export type TextSelectAction = Contribution & { label(selection: TextSelection): ReactNode | null };

// --- pages ------------------------------------------------------------------------------------
/** A top-level page (header nav). `render` is a React component; read your slots with useSlot(id, …). */
export type PageDef = { id: string; title: string; icon?: ReactNode; order?: number; render(): ReactNode };

// --- the plugin context -----------------------------------------------------------------------
export type PluginContext = {
  readonly manifest: PluginManifest;
  /** Disposables pushed here are revoked when the plugin unloads (register/contribute/on/add do so). */
  readonly subscriptions: Disposable[];

  /** Register a top-level page. Clobbering an existing page id throws. */
  registerPage(page: PageDef): Disposable;
  /** Contribute into a page's named slot. The page decides how/where its slots render. */
  contribute<T extends Contribution>(pageId: string, slot: string, contribution: T): Disposable;

  reader: {
    readonly current: ReaderContext;
    onDidChange(fn: (ctx: ReaderContext) => void): Disposable;
  };
  ui: {
    openPage(id: string): void;
    navigate(book: string, ref?: string | null): void;
    peek(book: string, ref: string | null): void;
    showToast(message: string): void;
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

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
