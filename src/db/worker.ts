/// <reference lib="webworker" />
//
// The dedicated worker that owns SQLite-WASM + the OPFS SAH-pool VFS. It is spawned by the
// *leader tab* (a window context, where `Worker` exists — a SharedWorker can't spawn it) and
// shared by every tab via per-tab MessagePorts brokered through the SharedWorker. So one
// connection backs all tabs: no exclusive-handle conflicts, and downloaded books are shared.
//
// Updates are forward-compatible WITHOUT ever re-downloading the corpus (see LLM/022):
//   /db.sqlite    — the content cache: catalog (toc) + accumulated editions/content/meta/links.
//                   A schema bump migrates this file IN PLACE (CONTENT_MIGRATIONS); it is never
//                   wiped to change schema.
//   manifest.json — { schemaVersion, publishId }, fetched each start so a new publish refreshes the
//                   catalog and lazily re-merges only the books whose content_version changed.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { expose } from 'comlink';
import type { Progress } from './types';
import { BOOT_VERSION, LOCAL_TABLES_SQL, CONTENT_MIGRATIONS } from '../../shared/schema';
import { TOC_DB, sliceUrlPath } from '../../shared/slice-path';
import { HEBREW_CHAR_STRINGS } from '../../shared/hebrew-chars';
import { encodeLink } from '../../shared/code-link';
import { encodeRender } from '../../shared/code-render';
import { stripHtml as stripTags } from '../../shared/strip';

(self as unknown as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = {
  warn: (...args: unknown[]) => {
    if (!String(args[0]).includes('Ignoring inability to install OPFS')) console.warn(...args);
  },
};

const BOOT_PATH = '/db.sqlite';
const CATALOG_TMP = '/catalog-tmp.sqlite';
const dbBase = `${import.meta.env.BASE_URL}db/`;
const bootUrl = `${dbBase}${TOC_DB}`;
const manifestUrl = `${dbBase}manifest.json`;

type Manifest = { schemaVersion: number; publishId: string; books?: number };

const init = (async () => {
  const sqlite3 = await sqlite3InitModule(); // print/printErr default to console.log/error
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'torah-llm' });
  // Need room for: /db.sqlite + a slice (merge) + /catalog-tmp + SQLite journals.
  await pool.reserveMinimumCapacity(8);
  return { sqlite3, pool };
})();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

// --- small query helpers (the connection is a single shared `db`) -----------------------------
function rows(sql: string, bind: unknown[] = []): unknown[][] {
  const out: unknown[][] = [];
  db.exec({ sql, bind: bind.length ? bind : undefined, rowMode: 'array', resultRows: out });
  return out;
}
function scalar(sql: string, bind: unknown[] = []): unknown {
  const r = rows(sql, bind);
  return r.length ? r[0][0] : undefined;
}
function pragmaInt(name: string): number {
  const r = rows(`PRAGMA ${name}`);
  return r.length ? Number(r[0][0]) : 0;
}
function setPublishId(id: string) {
  db.exec({ sql: `INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('publishId', ?)`, bind: [id] });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function streamInto(pool: any, path: string, url: string, onProgress?: (p: Progress) => void) {
  if (pool.getFileNames().includes(path)) pool.unlink(path); // replace any partial leftover
  // Prefer a gzipped artifact (smaller download, inflated in-stream); fall back to the plain file so a corpus
  // not yet re-sliced with gzip still loads. A missing file makes the dev/static server fall back to
  // index.html (200, text/html) — treat that as "not present" (and, for the plain file, a clear retryable error).
  const isHtml = (r: Response) => (r.headers.get('content-type') ?? '').includes('text/html');
  let res = await fetch(`${url}.gz`);
  const gz = res.ok && !isHtml(res);
  if (!gz) res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (isHtml(res))
    throw new Error(`Database not available yet at ${url} (server returned a web page). If a data rebuild is in progress, retry in a moment.`);
  // If the host already set Content-Encoding: gzip, the browser inflated the body for us; otherwise inflate here.
  const inflate = gz && (res.headers.get('content-encoding') ?? '').toLowerCase() !== 'gzip';
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = (inflate ? res.body!.pipeThrough(new DecompressionStream('gzip')) : res.body!).getReader();
  let received = 0;
  await pool.importDb(path, async () => {
    const { done, value } = await reader.read();
    if (done || !value) return undefined;
    received += value.length;
    onProgress?.({ received, total });
    return value;
  });
}

// Ensure storage is present, current, and open. Retryable: a failed boot (offline / transient
// fetch error) re-arms so the next call tries again instead of poisoning the worker permanently.
let bootP: Promise<void> | null = null;
function boot(): Promise<void> {
  if (!bootP)
    bootP = doBoot().catch((e) => {
      bootP = null;
      throw e;
    });
  return bootP;
}

async function doBoot() {
  const { pool, sqlite3 } = await init;

  // 1. Content cache: open it and bring the schema current by migrating IN PLACE (never re-download).
  //    `fresh` = the boot DB was just downloaded, so it already matches the published manifest.
  let fresh = false;
  if (!pool.getFileNames().includes(BOOT_PATH)) {
    await streamInto(pool, BOOT_PATH, bootUrl);
    db = new pool.OpfsSAHPoolDb(BOOT_PATH);
    fresh = true;
  } else {
    db = new pool.OpfsSAHPoolDb(BOOT_PATH);
    migrateContent();
  }
  db.exec(LOCAL_TABLES_SQL); // local-only bookkeeping (not shipped in slices)
  registerFunctions(); // evalJS() etc. — re-registered each open (functions are per-connection)
  // Safety net: cancel a user query that runs past EXEC_TIMEOUT_MS so a pathological query (e.g. a cartesian
  // self-join) can't wedge the single worker — which would also stall the viewer's own reads. The handler
  // fires every ~10k VM steps; it only aborts while a user query is in flight (queryDeadline > 0).
  try {
    sqlite3.capi.sqlite3_progress_handler(db.pointer, 10000, () => (queryDeadline && Date.now() > queryDeadline ? 1 : 0), 0);
  } catch (e) {
    console.warn('[db] progress handler unavailable; user queries are not time-limited', e);
  }

  // 2. Reconcile against the published manifest (catalog refresh + prune; stale books re-merge lazily).
  await reconcile(pool, fresh);
}

// Upgrade an already-cached content DB in place, one step at a time. Each step is additive/cache-safe
// SQL (or a table rebuild) — the corpus is never re-downloaded to change schema. A missing step means
// the migration ladder is incomplete (a bug): fail loudly rather than wipe a multi-GB cache.
function migrateContent() {
  let v = pragmaInt('user_version');
  while (v < BOOT_VERSION) {
    const step = CONTENT_MIGRATIONS[v];
    if (step === undefined)
      throw new Error(
        `No content migration from v${v} to v${v + 1}. The cache cannot be upgraded in place; ` +
          `add CONTENT_MIGRATIONS[${v}] (or use "Wipe local DB" to recover).`
      );
    db.exec('BEGIN');
    try {
      db.exec(step);
      db.exec(`PRAGMA user_version = ${v + 1}`); // transactional with the step
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    v += 1;
  }
}

// Refresh the catalog from the published manifest WITHOUT wiping content. Books removed upstream are
// pruned; books whose content_version changed are left for ensureBook to re-merge on next access.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reconcile(pool: any, fresh: boolean) {
  let manifest: Manifest | undefined;
  try {
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    if (res.ok) manifest = (await res.json()) as Manifest;
  } catch {
    return; // offline → keep using the cached catalog
  }
  if (!manifest?.publishId) return;
  // Fresh boot DB already IS this manifest's snapshot — just record which publish we hold.
  if (fresh) {
    setPublishId(manifest.publishId);
    return;
  }
  if (scalar(`SELECT value FROM cache_meta WHERE key = 'publishId'`) === manifest.publishId) return;

  await streamInto(pool, CATALOG_TMP, bootUrl); // toc-only boot DB (small)
  db.exec(`ATTACH DATABASE '${CATALOG_TMP}' AS cat`);
  try {
    db.exec('BEGIN');
    // Refresh the catalog spine (new content_versions, titles, sizes) and prune removed books.
    db.exec(`DELETE FROM toc WHERE id NOT IN (SELECT id FROM cat.toc)`);
    db.exec(`INSERT OR REPLACE INTO toc SELECT * FROM cat.toc`);
    db.exec(`DELETE FROM content    WHERE toc_id  NOT IN (SELECT id FROM toc)`);
    db.exec(`DELETE FROM editions   WHERE toc_id  NOT IN (SELECT id FROM toc)`);
    db.exec(`DELETE FROM meta       WHERE toc_id  NOT IN (SELECT id FROM toc)`);
    db.exec(`DELETE FROM links      WHERE from_id NOT IN (SELECT id FROM toc)
                                       OR to_id   NOT IN (SELECT id FROM toc)`);
    db.exec(`DELETE FROM book_state WHERE toc_id  NOT IN (SELECT id FROM toc)`);
    // First versioned boot: book_state is empty but content may already be cached from before this
    // feature existed. Trust the existing cache as current so we don't re-download everything once.
    if (Number(scalar(`SELECT COUNT(*) FROM book_state`)) === 0) {
      db.exec(`INSERT OR REPLACE INTO book_state (toc_id, content_version)
                 SELECT DISTINCT c.toc_id, t.content_version
                   FROM content c JOIN toc t ON t.id = c.toc_id`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec(`DETACH DATABASE cat`);
    pool.unlink(CATALOG_TMP);
  }
  setPublishId(manifest.publishId);
}

// Replace a book's published rows with a slice's contents, atomically (idempotent). content/links
// drop their surrogate ids (autoincrement locally) so re-merging a republished slice can't collide
// with another book's global ids; editions keep their stable TEXT id.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mergeSlice(pool: any, tocId: string, url: string, path: string, onProgress?: (p: Progress) => void) {
  if (!pool.getFileNames().includes(path)) await streamInto(pool, path, url, onProgress);
  db.exec(`ATTACH DATABASE '${path.replace(/'/g, "''")}' AS merge`); // escape ' (ids like "Ba'al HaTurim")
  try {
    db.exec('BEGIN');
    db.exec({ sql: `DELETE FROM editions WHERE toc_id = ?`, bind: [tocId] });
    db.exec({ sql: `DELETE FROM content  WHERE toc_id = ?`, bind: [tocId] });
    db.exec({ sql: `DELETE FROM meta     WHERE toc_id = ?`, bind: [tocId] });
    db.exec({ sql: `DELETE FROM links    WHERE from_id = ? OR to_id = ?`, bind: [tocId, tocId] });
    db.exec(`INSERT INTO editions (id,toc_id,source,lang,title,info,order_index)
             SELECT id,toc_id,source,lang,title,info,order_index FROM merge.editions`);
    db.exec(`INSERT INTO content (edition_id,toc_id,ref,text)
             SELECT edition_id,toc_id,ref,text FROM merge.content`);
    db.exec(`INSERT INTO meta (toc_id,schema) SELECT toc_id,schema FROM merge.meta`);
    db.exec(`INSERT OR IGNORE INTO links (from_id,from_ref,to_id,to_ref,connection_type)
             SELECT from_id,from_ref,to_id,to_ref,connection_type FROM merge.links`);
    db.exec({
      sql: `INSERT OR REPLACE INTO book_state (toc_id, content_version)
              SELECT id, content_version FROM toc WHERE id = ?`,
      bind: [tocId],
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec(`DETACH DATABASE merge`);
  }
  pool.unlink(path);
}

// --- custom SQL functions (so the Code page can use JS expressions inside SQLite) ----------------
type EvalFn = (...a: unknown[]) => unknown;
const evalCache = new Map<string, EvalFn>();

// Coerce a JS value into something SQLite accepts as a function result.
const coerceSql = (r: unknown): number | string | null =>
  r == null ? null : typeof r === 'boolean' ? (r ? 1 : 0) : typeof r === 'bigint' ? Number(r) : typeof r === 'number' || typeof r === 'string' ? r : String(r);

// Plugin-registered SQL functions (the host namespaces names by plugin id, e.g. torah_code_find). Stored so
// they survive a connection re-open (re-registered in registerFunctions). Bodies compile via new Function —
// pure + synchronous, since they run inside query execution and can't call back to the main thread.
type SqlFnSpec = { name: string; args: string[]; body: string; arity?: number };
const pluginFnSpecs: SqlFnSpec[] = [];
function registerPluginFn(spec: SqlFnSpec) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...spec.args, spec.body) as (...a: unknown[]) => unknown;
  db.createFunction(spec.name, (_pCx: unknown, ...a: unknown[]) => coerceSql(fn(...a)), { arity: spec.arity ?? -1, deterministic: true });
}

// User queries (api.exec) are time-limited via the progress handler so one runaway query can't wedge the worker.
const EXEC_TIMEOUT_MS = 10000;
let queryDeadline = 0; // ms epoch; > 0 only while a user query runs — the progress handler aborts once past it

// Register the generic SQL helpers: strip(text) (remove HTML), the Hebrew char names as 0-arity functions
// (PAZER(), ALEPH(), …), link(...) / render(...) markers for the Code page, and evalJS(expr, ...vals) — a JS
// expression with `value` = first value, `args` = all values, plus strip()/H in scope. (Plugins register
// additional functions via defineFunctions.)
function registerFunctions() {
  // strip(text): remove HTML tags — e.g. substr(strip(c.text), 1, 40) gives a clean preview.
  db.createFunction('strip', (_pCx: unknown, v: unknown) => stripTags(v), { arity: 1, deterministic: true });
  db.createFunction(
    'evalJS',
    (_pCx: unknown, expr: string, ...vals: unknown[]) => {
      let fn = evalCache.get(expr);
      if (!fn) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          fn = new Function('args', 'value', 'strip', 'H', `return (${expr});`) as EvalFn;
        } catch {
          return null;
        }
        evalCache.set(expr, fn);
      }
      try {
        return coerceSql(fn(vals, vals[0], stripTags, HEBREW_CHAR_STRINGS));
      } catch {
        return null;
      }
    },
    { arity: -1, deterministic: true }
  );
  // Hebrew character names as 0-arity functions: PAZER() -> '֡', ALEPH() -> 'א', … so a query can write
  // replace(text, PAZER(), '') instead of char(1441).
  for (const [name, ch] of Object.entries(HEBREW_CHAR_STRINGS))
    db.createFunction(name, (_pCx: unknown) => ch, { arity: 0, deterministic: true });
  // link(book, ref [, label]): tag a cell as an explicit viewer link (the Code page renders it clickable).
  // Usually unneeded — selecting toc_id + ref auto-links the verse — but handy for a link in a computed or
  // aliased column. label defaults to the ref; HTML in it is stripped.
  db.createFunction(
    'link',
    (_pCx: unknown, ...a: unknown[]) => {
      const book = a[0] == null ? '' : String(a[0]);
      const ref = a[1] == null ? null : String(a[1]);
      const label = a.length >= 3 ? stripTags(a[2]) : ref ?? book;
      return encodeLink({ book, ref, label });
    },
    { arity: -1, deterministic: true }
  );
  // render(rendererId, ...args): tag a cell for a plugin-supplied renderer (the cellRenderer slot on the
  // code-search page). e.g. render('torah-code', book, start, skip) draws an ELS matrix.
  db.createFunction(
    'render',
    (_pCx: unknown, ...a: unknown[]) =>
      encodeRender({ type: a[0] == null ? '' : String(a[0]), args: a.slice(1).map((x) => (typeof x === 'bigint' ? Number(x) : x)) }),
    { arity: -1, deterministic: true }
  );
  // Re-register plugin-defined functions (added after boot via defineFunctions, but must survive a re-open).
  for (const s of pluginFnSpecs)
    try {
      registerPluginFn(s);
    } catch (e) {
      console.warn('[db] plugin fn failed:', s.name, e);
    }
}

const api = {
  async version() {
    const { sqlite3 } = await init;
    return sqlite3.version.libVersion;
  },

  /** Run SQL; returns rows as objects (empty for non-SELECT). */
  async exec(sql: string, params: unknown[] = []) {
    await boot();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resultRows: any[] = [];
    queryDeadline = Date.now() + EXEC_TIMEOUT_MS;
    try {
      db.exec({ sql, bind: params.length ? params : undefined, rowMode: 'object', resultRows });
    } catch (e) {
      if (/interrupt/i.test(String((e as { message?: string })?.message ?? e)))
        throw new Error(`Query cancelled after ${EXEC_TIMEOUT_MS / 1000}s. Add a LIMIT, or MATERIALIZE a CTE you join to itself.`);
      throw e;
    } finally {
      queryDeadline = 0;
    }
    return resultRows;
  },

  /** Register plugin-supplied SQL functions (names already namespaced by the host). Bodies are pure JS. */
  async defineFunctions(specs: SqlFnSpec[]) {
    await boot();
    for (const s of specs) {
      const i = pluginFnSpecs.findIndex((x) => x.name === s.name);
      if (i >= 0) pluginFnSpecs[i] = s;
      else pluginFnSpecs.push(s);
      try {
        registerPluginFn(s);
      } catch (e) {
        console.warn('[db] plugin fn failed:', s.name, e);
      }
    }
  },

  /** Ensure a book's content is local AND current: (re)merge its slice when missing or stale. */
  async ensureBook(tocId: string, onProgress?: (p: Progress) => void) {
    const { pool } = await init;
    await boot();
    const want = scalar(`SELECT content_version FROM toc WHERE id = ?`, [tocId]);
    const have = scalar(`SELECT content_version FROM book_state WHERE toc_id = ?`, [tocId]);
    if (have != null && (want == null || have === want)) return; // present and current
    if (want == null && Number(scalar(`SELECT COUNT(*) FROM content WHERE toc_id = ?`, [tocId])) > 0)
      return; // no version info (offline/old catalog) but content is present → use it
    const file = sliceUrlPath(tocId);
    await mergeSlice(pool, tocId, `${dbBase}${file}`, `/${file}`, onProgress);
  },

  /** Remove one book's downloaded content (the catalog row stays). It can be re-downloaded later. */
  async clearBook(tocId: string) {
    await boot();
    db.exec('BEGIN');
    try {
      db.exec({ sql: `DELETE FROM editions   WHERE toc_id = ?`, bind: [tocId] });
      db.exec({ sql: `DELETE FROM content    WHERE toc_id = ?`, bind: [tocId] });
      db.exec({ sql: `DELETE FROM meta       WHERE toc_id = ?`, bind: [tocId] });
      db.exec({ sql: `DELETE FROM links      WHERE from_id = ? OR to_id = ?`, bind: [tocId, tocId] });
      db.exec({ sql: `DELETE FROM book_state WHERE toc_id = ?`, bind: [tocId] });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },

  /** Table → column names, for the Code page's schema-aware autocomplete. */
  async schema(): Promise<Record<string, string[]>> {
    await boot();
    const tables = (rows(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`) as unknown[][]).map((r) => String(r[0]));
    const out: Record<string, string[]> = {};
    for (const t of tables) out[t] = (rows(`PRAGMA table_info("${t.replace(/"/g, '""')}")`) as unknown[][]).map((r) => String(r[1]));
    return out;
  },

  /** Clear all local data — a manual recovery action (the button), never an automatic version wipe. */
  async wipe() {
    const { pool } = await init;
    if (db) {
      db.close();
      db = undefined;
    }
    bootP = null;
    await pool.wipeFiles();
  },
};

// The leader tab forwards one MessagePort per connecting tab; expose the API on each.
self.onmessage = (event: MessageEvent) => {
  if (event.data?.type === 'connect' && event.data.port) {
    const port = event.data.port as MessagePort;
    expose(api, port);
    port.start();
  }
};

export type Api = typeof api;
