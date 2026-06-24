/// <reference lib="webworker" />
//
// The per-page worker that owns SQLite-WASM + the OPFS SAH-pool VFS. Each tab spawns its own (no
// SharedWorker/leader). Exclusive OPFS handles can't be shared, so the pool is held only during a brief
// "lease" gated by the 'torah-db' Web Lock and released (pauseVfs) when the page goes inactive — so tabs
// take turns and an inactive/reloading tab holds nothing. See withLease/release below + LLM/037.
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

// A too-fast reload (or a second tab grabbing the pool) can leave the previous worker's OPFS
// SyncAccessHandles briefly open, so installing the SAH-pool VFS throws NoModificationAllowedError. Retry
// with backoff until the stale handles are released, instead of poisoning the worker on a quick refresh.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function installPoolWithRetry(sqlite3: any) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs({ name: 'torah-llm' });
    } catch (e) {
      const handleRace = /NoModificationAllowed|Access Handle|already (open|in use)/i.test(String((e as { message?: string })?.message ?? e));
      if (!handleRace || attempt >= 15) throw e;
      await new Promise((r) => setTimeout(r, Math.min(1000, 150 + attempt * 100)));
    }
  }
}

// SQLite-WASM loads eagerly (no OPFS handles yet). The SAH pool is installed lazily and only HELD while
// this tab owns a brief "lease" — the exclusive 'torah-db' Web Lock, with the pool UNPAUSED. Outside a
// lease the pool is paused, so its OPFS SyncAccessHandles are released and any other tab — or a reload of
// THIS (inactive) tab — can take ownership immediately. This replaces the old SharedWorker-broker + leader
// design, whose single worker kept the handles open on frozen/inactive pages and wedged the app on reload.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite3: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any = null;
const moduleReady = sqlite3InitModule().then((m) => {
  sqlite3 = m;
});

async function ensurePool() {
  await moduleReady;
  if (!pool) {
    pool = await installPoolWithRetry(sqlite3);
    await pool.reserveMinimumCapacity(8); // room for /db.sqlite + a merge slice + /catalog-tmp + journals
  }
  return pool;
}

// A malformed/corrupt cache (e.g. a pre-crash-safety reload mid-merge) can't be repaired in place — the
// fix is to wipe it and re-stream a fresh catalog (books re-download on demand).
const isCorrupt = (e: unknown) => /SQLITE_CORRUPT|malformed|not a database|disk image/i.test(String((e as { message?: string })?.message ?? e));

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
  // When we inflate, Content-Length is the COMPRESSED size, so received (inflated) would blow past it (>100%).
  // Drop total in that case so the UI shows MB downloaded instead of a bogus fraction.
  const total = inflate ? 0 : Number(res.headers.get('content-length') ?? 0);
  const reader = (inflate ? res.body!.pipeThrough(new DecompressionStream('gzip')) : res.body!).getReader();
  let received = 0;
  try {
    await pool.importDb(path, async () => {
      const { done, value } = await reader.read();
      if (done || !value) return undefined;
      received += value.length;
      onProgress?.({ received, total: total ? Math.max(total, received) : 0 });
      return value;
    });
  } catch (e) {
    // A failed/aborted stream leaves a truncated file behind; unlink it so a retry re-downloads cleanly
    // instead of attaching a partial db.
    if (pool.getFileNames().includes(path)) pool.unlink(path);
    throw e;
  }
}

// --- connection lease (the heart of the multi-tab model) --------------------------------------
// Every API call runs inside withLease(): it ensures we hold the 'torah-db' lock with the pool unpaused
// and the db open, runs, then (when no op is in flight) schedules a release after a short idle so
// back-to-back queries don't thrash pause/unpause. release() (called by the page on visibilitychange→
// hidden / pagehide / freeze) drops the lease immediately so an inactive tab holds no OPFS handles.
const LEASE_IDLE_MS = 600;
let booted = false; // first-boot work (download / migrate / reconcile) done this session
let leaseHeld = false; // lock held + pool unpaused + db open
let leaseDepth = 0; // in-flight operations — never release mid-op
let acquiring: Promise<void> | null = null;
let releaseLock: (() => void) | null = null; // resolves the Web Lock callback → frees the lock
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let releaseWanted = false; // page hidden → release as soon as nothing is in flight

// (Re)open the db connection on the (unpaused) pool. The VFS functions + progress handler are
// per-connection, so they're (re)installed on every open.
function openConnection() {
  db = new pool.OpfsSAHPoolDb(BOOT_PATH);
  // Crash-safety on the SAH-pool VFS: NORMAL syncs the rollback journal before db pages, so a reload
  // mid-write rolls back cleanly instead of leaving a malformed image (see LLM/033), without FULL's cost.
  db.exec('PRAGMA journal_mode = TRUNCATE');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(LOCAL_TABLES_SQL); // local-only bookkeeping (not shipped in slices)
  registerFunctions(); // evalJS() etc.
  // Cancel a user query that runs past EXEC_TIMEOUT_MS (fires every ~10k VM steps; only while a query is in flight).
  try {
    sqlite3.capi.sqlite3_progress_handler(db.pointer, 10000, () => (queryDeadline && Date.now() > queryDeadline ? 1 : 0), 0);
  } catch (e) {
    console.warn('[db] progress handler unavailable; user queries are not time-limited', e);
  }
}

// Open the connection and, the FIRST time this session, bring the cache current (migrate in place +
// reconcile against the manifest). Self-heals a corrupt cache by wiping + re-streaming the catalog.
async function bootSequence() {
  if (booted) {
    openConnection(); // re-acquire after a pause: just reopen, no re-reconcile
    return;
  }
  const fresh = !pool.getFileNames().includes(BOOT_PATH);
  try {
    if (fresh) await streamInto(pool, BOOT_PATH, bootUrl);
    openConnection();
    if (!fresh) migrateContent();
    await reconcile(pool, fresh);
  } catch (e) {
    // Only an EXISTING cached db is repaired by wipe + re-stream. A freshly downloaded catalog that's already
    // corrupt would just re-download the same bad file (and wiping a cache on a transient bad fetch is wrong),
    // so surface it as a retryable error instead.
    if (!isCorrupt(e)) throw e;
    if (fresh) throw new Error(`Downloaded catalog is corrupt — retry. (${(e as { message?: string })?.message ?? e})`);
    console.warn('[db] content cache is corrupt — wiping and re-initializing fresh', e);
    try {
      db?.close();
    } catch {
      /* unusable */
    }
    await pool.wipeFiles();
    await streamInto(pool, BOOT_PATH, bootUrl);
    openConnection();
    await reconcile(pool, true);
  }
  booted = true;
}

function clearIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleRelease() {
  clearIdle();
  if (releaseWanted) return releaseLease();
  idleTimer = setTimeout(() => {
    if (leaseDepth === 0) releaseLease();
  }, LEASE_IDLE_MS);
}

// Drop the lease: close the db, pause the pool (releasing its OPFS handles), and free the Web Lock.
function releaseLease() {
  if (!leaseHeld || leaseDepth > 0) return;
  clearIdle();
  try {
    db?.close();
  } catch {
    /* unusable */
  }
  db = undefined;
  try {
    pool?.pauseVfs(); // synchronous; releases the SyncAccessHandles
  } catch (e) {
    console.warn('[db] pauseVfs failed', e);
  }
  leaseHeld = false;
  releaseWanted = false;
  const free = releaseLock;
  releaseLock = null;
  free?.(); // resolve the lock callback → the next waiter (this or another tab) can acquire
}

// Acquire the lock and hold it (the request callback stays pending until releaseLock() is called).
function startLease(): Promise<void> {
  return new Promise<void>((acquired, failed) => {
    navigator.locks
      .request('torah-db', { mode: 'exclusive' }, () =>
        new Promise<void>((free) => {
          (async () => {
            await ensurePool();
            if (pool.isPaused()) await pool.unpauseVfs();
            await bootSequence();
            leaseHeld = true;
            releaseLock = free;
            acquired();
          })().catch((e) => {
            free(); // setup failed under the lock — release it so we don't wedge other tabs
            failed(e);
          });
        })
      )
      .catch(failed); // the lock request itself failed (not the held callback)
  });
}

async function withLease<T>(fn: () => Promise<T> | T): Promise<T> {
  if (!leaseHeld) {
    if (!acquiring) acquiring = startLease().finally(() => (acquiring = null));
    await acquiring;
  }
  leaseDepth++;
  clearIdle();
  try {
    return await fn();
  } finally {
    leaseDepth--;
    if (leaseDepth === 0) scheduleIdleRelease();
  }
}

// Self-heal a corrupt cache discovered mid-query, while we already hold the lease.
async function wipeAndRebootInLease() {
  try {
    db?.close();
  } catch {
    /* unusable */
  }
  db = undefined;
  booted = false;
  await pool.wipeFiles();
  await bootSequence();
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
  // A publish that ships a newer content-schema than this app understands would feed us a
  // catalog/slices we can't handle → corruption. Keep using the current cached catalog and wait
  // for the app itself to update on reload.
  if (manifest.schemaVersion != null && manifest.schemaVersion > BOOT_VERSION) {
    console.warn(`published content schema v${manifest.schemaVersion} is newer than this app (BOOT_VERSION v${BOOT_VERSION}) — skipping catalog refresh; reload to update the app`);
    return;
  }
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
  // words(text): split a verse into a JSON array of words — strips HTML, then splits on whitespace, maqaf
  // (U+05BE) and paseq (U+05C0). Pair with json_each() to score/filter each word without per-row JS, e.g.
  //   SELECT w.value FROM content c, json_each(words(c.text)) w WHERE gematria(w.value) = 376
  db.createFunction(
    'words',
    (_pCx: unknown, v: unknown) => JSON.stringify(stripTags(v).split(/[\s־׀]+/).filter(Boolean)),
    { arity: 1, deterministic: true }
  );
  // letters(text): keep only the Hebrew letters (א–ת, incl. final forms; U+05D0–U+05EA) — strips HTML, vowels
  // (nikud), cantillation (te'amim) and punctuation. Use as a consonantal key (GROUP BY letters(word)) or count
  // letters with length(letters(text)).
  db.createFunction(
    'letters',
    (_pCx: unknown, v: unknown) => (stripTags(v).match(/[א-ת]/g) || []).join(''),
    { arity: 1, deterministic: true }
  );
  // chapter(ref): the leading number of a "chapter:verse" ref as an integer (e.g. chapter('7:89') = 7), or
  // NULL if the ref has no numeric chapter — handy for grouping/sorting by chapter without substr/instr.
  db.createFunction(
    'chapter',
    (_pCx: unknown, v: unknown) => { const m = String(v ?? '').match(/^(\d+):/); return m ? Number(m[1]) : null; },
    { arity: 1, deterministic: true }
  );
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
    await moduleReady;
    return sqlite3.version.libVersion;
  },

  /** Release the connection now (no-op if idle). Called by the page when it goes hidden/frozen so an
   *  inactive tab holds no OPFS handles — making a reload, or another tab, acquire instantly. */
  release() {
    releaseWanted = true;
    if (leaseDepth === 0) releaseLease();
  },

  /** Run SQL; returns rows as objects (empty for non-SELECT). */
  async exec(sql: string, params: unknown[] = []) {
    const run = () => {
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
    };
    return withLease(async () => {
      try {
        return run();
      } catch (e) {
        if (!isCorrupt(e)) throw e;
        console.warn('[db] query hit a corrupt cache — wiping, re-initializing, and retrying once', e);
        await wipeAndRebootInLease();
        return run();
      }
    });
  },

  /** Register plugin-supplied SQL functions (names already namespaced by the host). Bodies are pure JS. */
  async defineFunctions(specs: SqlFnSpec[]) {
    return withLease(() => {
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
    });
  },

  /** Ensure a book's content is local AND current: (re)merge its slice when missing or stale. */
  async ensureBook(tocId: string, onProgress?: (p: Progress) => void) {
    return withLease(async () => {
      const want = scalar(`SELECT content_version FROM toc WHERE id = ?`, [tocId]);
      const have = scalar(`SELECT content_version FROM book_state WHERE toc_id = ?`, [tocId]);
      if (have != null && (want == null || have === want)) return; // present and current
      if (want == null && Number(scalar(`SELECT COUNT(*) FROM content WHERE toc_id = ?`, [tocId])) > 0)
        return; // no version info (offline/old catalog) but content is present → use it
      const file = sliceUrlPath(tocId);
      // Don't wrap this in corruption-recovery: a transiently bad slice would otherwise wipe ALL downloaded
      // books. A genuinely corrupt main cache surfaces on the next boot/query, which self-heal (see exec).
      await mergeSlice(pool, tocId, `${dbBase}${file}`, `/${file}`, onProgress);
    });
  },

  /** Remove one book's downloaded content (the catalog row stays). It can be re-downloaded later. */
  async clearBook(tocId: string) {
    return withLease(() => {
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
    });
  },

  /** Table → column names, for the Code page's schema-aware autocomplete. */
  async schema(): Promise<Record<string, string[]>> {
    return withLease(() => {
      const tables = (rows(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`) as unknown[][]).map((r) => String(r[0]));
      const out: Record<string, string[]> = {};
      for (const t of tables) out[t] = (rows(`PRAGMA table_info("${t.replace(/"/g, '""')}")`) as unknown[][]).map((r) => String(r[1]));
      return out;
    });
  },

  /** Clear all local data — a manual recovery action (the button), never an automatic version wipe. */
  async wipe() {
    return withLease(async () => {
      try {
        db?.close();
      } catch {
        /* unusable */
      }
      db = undefined;
      booted = false;
      await pool.wipeFiles();
      await bootSequence(); // re-open a fresh, empty store so subsequent calls work
    });
  },
};

// One dedicated worker per page (no SharedWorker broker): expose the API directly over the default
// worker endpoint. The page coordinates SAH-pool ownership purely through the 'torah-db' Web Lock.
expose(api);

export type Api = typeof api;
