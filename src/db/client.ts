// Main-thread interface to the SQLite worker.
//
// Each page owns its OWN dedicated db worker (no SharedWorker, no leader election). Tabs don't share a
// connection; instead the worker holds the OPFS SAH pool only during a brief "lease" coordinated by the
// 'torah-db' Web Lock, and RELEASES it (pauseVfs) when the page goes inactive. So at most one tab holds
// the handles at a time, and an inactive/reloading tab holds nothing — which is what fixes the reload
// lockup the old shared-worker design suffered (its handles lingered on frozen pages).

import { wrap, proxy } from 'comlink';
import type { Remote } from 'comlink';
import type { Api } from './worker';
import type { TocRow, Edition, ContentRow, LinkRef, Progress } from './types';

let api: Remote<Api> | null = null;

function start(): Remote<Api> {
  if (api) return api;
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  api = wrap<Api>(worker);

  // Drop the lease the moment the page stops being usable, so this tab isn't holding the OPFS handles
  // when it's backgrounded/frozen/reloaded. The next query re-acquires automatically. visibilitychange
  // (hidden) fires reliably while JS can still run; pagehide/freeze are belt-and-suspenders.
  const release = () => void api?.release().catch(() => {});
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') release();
    });
  addEventListener('pagehide', release);
  addEventListener('freeze', release); // Page Lifecycle API: about to be frozen

  return api;
}

async function withApi<T>(fn: (api: Remote<Api>) => Promise<T>): Promise<T> {
  return fn(start());
}

export async function sqliteVersion(): Promise<string> {
  return withApi((api) => api.version());
}

export async function getToc(): Promise<TocRow[]> {
  return withApi(async (api) => (await api.exec('SELECT * FROM toc')) as unknown as TocRow[]);
}

/** Canonical book ids whose content is already in the local DB. */
export async function getLocalBookIds(): Promise<string[]> {
  return withApi(async (api) =>
    ((await api.exec('SELECT DISTINCT toc_id AS id FROM content')) as unknown as { id: string }[]).map(
      (r) => r.id
    )
  );
}

export async function getEditions(tocId: string): Promise<Edition[]> {
  return withApi(
    async (api) =>
      (await api.exec(
        'SELECT id, toc_id, source, lang, title, info, order_index FROM editions WHERE toc_id = ? ORDER BY order_index, lang',
        [tocId]
      )) as unknown as Edition[]
  );
}

/** Cheap "is this book downloaded?" check — avoids pulling the whole book just to test for presence. */
export async function hasLocalContent(tocId: string): Promise<boolean> {
  return withApi(async (api) => {
    const r = (await api.exec('SELECT EXISTS(SELECT 1 FROM content WHERE toc_id = ?) AS e', [
      tocId,
    ])) as unknown as { e: number }[];
    return !!r[0]?.e;
  });
}

// --- section-level (paginated) loading --------------------------------------------------------
// A book is read one SECTION at a time (a chapter / daf — the ref part before the first ':'), so
// opening Genesis loads chapter 1, not all ~1,500 verses. The reader infinite-scrolls to fetch the
// previous/next section on demand. `like` patterns escape SQL wildcards (refs are numeric, but be safe).
const likeEsc = (s: string) => s.replace(/([\\%_])/g, '\\$1');

/** The (order-able) section ladder for a book: each section key + its verse count. Text-free, so cheap. */
export async function getBookSections(tocId: string): Promise<{ key: string; count: number }[]> {
  return withApi(
    async (api) =>
      (await api.exec(
        `SELECT CASE WHEN instr(ref, ':') > 0 THEN substr(ref, 1, instr(ref, ':') - 1) ELSE ref END AS key,
                COUNT(DISTINCT ref) AS count
           FROM content WHERE toc_id = ? GROUP BY key`,
        [tocId]
      )) as unknown as { key: string; count: number }[]
  );
}

/** One section's rows (every edition) — e.g. all of chapter 3. */
export async function getSectionContent(tocId: string, section: string): Promise<ContentRow[]> {
  return withApi(
    async (api) =>
      (await api.exec(
        "SELECT edition_id, ref, text FROM content WHERE toc_id = ? AND (ref = ? OR ref LIKE ? ESCAPE '\\') ORDER BY id",
        [tocId, section, `${likeEsc(section)}:%`]
      )) as unknown as ContentRow[]
  );
}

/** Links touching one section (either endpoint), keyed by the in-book ref — same shape as getLinks. */
export async function getSectionLinks(tocId: string, section: string): Promise<Record<string, LinkRef[]>> {
  return withApi(async (api) => {
    const like = `${likeEsc(section)}:%`;
    const rows = (await api.exec(
      `SELECT from_id, from_ref, to_id, to_ref, connection_type FROM links
         WHERE (from_id = ? AND (from_ref = ? OR from_ref LIKE ? ESCAPE '\\'))
            OR (to_id   = ? AND (to_ref   = ? OR to_ref   LIKE ? ESCAPE '\\'))`,
      [tocId, section, like, tocId, section, like]
    )) as unknown as {
      from_id: string;
      from_ref: string;
      to_id: string;
      to_ref: string;
      connection_type: string | null;
    }[];
    const map: Record<string, LinkRef[]> = {};
    for (const r of rows) {
      const isFrom = r.from_id === tocId;
      const thisRef = isFrom ? r.from_ref : r.to_ref;
      (map[thisRef] ??= []).push({
        otherId: isFrom ? r.to_id : r.from_id,
        otherRef: isFrom ? r.to_ref : r.from_ref,
        connectionType: r.connection_type,
      });
    }
    return map;
  });
}

/** All content rows (every edition) for a book. */
export async function getContent(tocId: string): Promise<ContentRow[]> {
  return withApi(
    async (api) =>
      (await api.exec('SELECT edition_id, ref, text FROM content WHERE toc_id = ? ORDER BY id', [
        tocId,
      ])) as unknown as ContentRow[]
  );
}

/** Just one segment's rows (every edition) — for the inline link preview. */
export async function getSegment(tocId: string, ref: string): Promise<ContentRow[]> {
  return withApi(
    async (api) =>
      (await api.exec('SELECT edition_id, ref, text FROM content WHERE toc_id = ? AND ref = ? ORDER BY id', [
        tocId,
        ref,
      ])) as unknown as ContentRow[]
  );
}

/**
 * A ref's direct sibling segments (same parent + depth), every edition — lets the peek show a short
 * quote-only segment (common in Zohar/Midrash/Talmud) together with the following segments as context.
 */
export async function getSiblings(tocId: string, ref: string): Promise<ContentRow[]> {
  const parts = ref.split(':');
  const parent = parts.slice(0, -1).join(':');
  if (!parent) return getSegment(tocId, ref); // top-level ref → don't pull the whole book
  const rows = (await withApi((api) =>
    api.exec('SELECT edition_id, ref, text FROM content WHERE toc_id = ? AND ref LIKE ? ORDER BY id', [
      tocId,
      `${parent}:%`,
    ])
  )) as unknown as ContentRow[];
  return rows.filter((r) => r.ref.split(':').length === parts.length); // direct children only
}

export async function getLinks(tocId: string): Promise<Record<string, LinkRef[]>> {
  return withApi(async (api) => {
    const rows = (await api.exec(
      `SELECT from_id, from_ref, to_id, to_ref, connection_type
         FROM links WHERE from_id = ? OR to_id = ?`,
      [tocId, tocId]
    )) as unknown as {
      from_id: string;
      from_ref: string;
      to_id: string;
      to_ref: string;
      connection_type: string | null;
    }[];
    const map: Record<string, LinkRef[]> = {};
    for (const r of rows) {
      const isFrom = r.from_id === tocId;
      const thisRef = isFrom ? r.from_ref : r.to_ref;
      (map[thisRef] ??= []).push({
        otherId: isFrom ? r.to_id : r.from_id,
        otherRef: isFrom ? r.to_ref : r.from_ref,
        connectionType: r.connection_type,
      });
    }
    return map;
  });
}

/** A book's section names (e.g. ['Chapter','Verse'], ['Daf','Line'], ['Siman','Seif']) for labeling. */
export async function getMeta(tocId: string): Promise<{ sectionNames: string[]; heSectionNames: string[] }> {
  return withApi(async (api) => {
    const rows = (await api.exec('SELECT schema FROM meta WHERE toc_id = ?', [tocId])) as unknown as {
      schema: string;
    }[];
    try {
      const s = rows.length ? JSON.parse(rows[0].schema) : {};
      return { sectionNames: s.sectionNames ?? [], heSectionNames: s.heSectionNames ?? [] };
    } catch {
      return { sectionNames: [], heSectionNames: [] };
    }
  });
}

/**
 * Ensure a book's content is local AND current. The worker compares the merged content_version to
 * the catalog's and (re)merges the slice only when missing or stale (dedupes concurrent calls).
 */
const ensuring = new Map<string, Promise<void>>();
export function ensureBook(tocId: string, onProgress?: (p: Progress) => void): Promise<void> {
  let p = ensuring.get(tocId);
  if (!p) {
    p = withApi((api) => api.ensureBook(tocId, onProgress ? proxy(onProgress) : undefined)).catch(
      (e) => {
        ensuring.delete(tocId); // don't cache a failure — allow retry on the next navigation
        throw e;
      }
    );
    ensuring.set(tocId, p);
  }
  return p;
}

/** Raw read query against the local DB — for plugins (toc/editions/content/meta/links). */
export async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return withApi((api) => api.exec(sql, params)) as Promise<Record<string, unknown>[]>;
}

/** Table → column names, for schema-aware SQL autocomplete. */
export async function schema(): Promise<Record<string, string[]>> {
  return withApi((api) => api.schema());
}

/** Register plugin SQL functions (names already namespaced by the host). */
export async function defineFunctions(
  specs: { name: string; args: string[]; body: string; arity?: number }[]
): Promise<void> {
  await withApi((api) => api.defineFunctions(specs));
}

/** Remove one book's downloaded content (catalog row stays; re-downloadable). */
export async function clearBook(tocId: string) {
  ensuring.delete(tocId);
  await withApi((api) => api.clearBook(tocId));
}

/** Clear all local data — manual recovery (the "Wipe local DB" button). */
export async function wipe() {
  ensuring.clear();
  await withApi((api) => api.wipe());
}

// Dev-only debug handle so QA (and the console) can drive the DB layer directly.
if (import.meta.env.DEV) {
  (globalThis as Record<string, unknown>).__torahDb = {
    sql: (sql: string, params: unknown[] = []) => withApi((api) => api.exec(sql, params)),
    getToc,
    getEditions,
    getContent,
    getSegment,
    getLinks,
    getMeta,
    ensureBook,
    wipe,
  };
}
