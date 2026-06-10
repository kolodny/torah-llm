// Single source of truth for the SQLite schema (raw SQL; no ORM).
//
// Multi-source "versions" model: a CANONICAL book (source-independent, keyed by title) can have
// many EDITIONS — one per (source, language, version). e.g. one "Genesis" with Sefaria Hebrew,
// JPS-1917 English, a French translation, the WLC, and Orayta's text as selectable editions.

// Bump when the CONTENT-cache schema changes (toc/editions/content/meta/links). The slicer stamps
// it into db.sqlite via `PRAGMA user_version`. On mismatch the worker migrates the cached content DB
// IN PLACE via CONTENT_MIGRATIONS — it never wipes/re-downloads the corpus to change schema. Every
// bump must add the matching migration step. See LLM/022.
export const BOOT_VERSION = 12;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS toc (
  id            TEXT PRIMARY KEY,    -- canonical, source-independent: a book's title or a category path
  parent_id     TEXT,                -- references toc.id (NULL for top-level categories)
  kind          TEXT NOT NULL,       -- 'category' | 'book'
  title_en      TEXT,
  title_he      TEXT,
  category_en   TEXT,
  category_he   TEXT,
  order_index   INTEGER,
  has_content   INTEGER NOT NULL DEFAULT 0,
  edition_count INTEGER NOT NULL DEFAULT 0,
  file_size     INTEGER,             -- byte size of this book's slice (set by the slicer)
  content_version TEXT               -- hash of this book's slice rows; drives incremental re-merge
);
CREATE INDEX IF NOT EXISTS toc_parent_idx ON toc(parent_id);

CREATE TABLE IF NOT EXISTS editions (
  id          TEXT PRIMARY KEY,      -- e.g. 'sefaria:Genesis:en:JPS 1917'
  toc_id      TEXT NOT NULL,         -- canonical book
  source      TEXT NOT NULL,         -- 'sefaria' | 'oshb' | 'orayta'
  lang        TEXT NOT NULL,         -- 'he' | 'en' | 'fr' | …
  title       TEXT NOT NULL,         -- short display name of this edition/version
  info        TEXT,                  -- provenance shown on hover (version title, source, license)
  order_index INTEGER
);
CREATE INDEX IF NOT EXISTS editions_toc_idx ON editions(toc_id);

CREATE TABLE IF NOT EXISTS content (
  id         INTEGER PRIMARY KEY,    -- globally unique (preserved into slices)
  edition_id TEXT NOT NULL,          -- references editions.id
  toc_id     TEXT NOT NULL,          -- canonical book (denormalized for slicing/queries)
  ref        TEXT NOT NULL,          -- e.g. '1:1'
  text       TEXT,
  UNIQUE(edition_id, ref)
);
CREATE INDEX IF NOT EXISTS content_toc_idx ON content(toc_id);

CREATE TABLE IF NOT EXISTS meta (
  toc_id  TEXT PRIMARY KEY,          -- canonical book
  schema  TEXT                       -- JSON: sectionNames/heSectionNames for display
);

CREATE TABLE IF NOT EXISTS links (
  id              INTEGER PRIMARY KEY,
  from_id         TEXT NOT NULL,     -- canonical book id
  from_ref        TEXT NOT NULL,
  to_id           TEXT NOT NULL,     -- canonical book id
  to_ref          TEXT NOT NULL,
  connection_type TEXT,
  UNIQUE(from_id, from_ref, to_id, to_ref)
);
CREATE INDEX IF NOT EXISTS links_from_idx ON links(from_id, from_ref);
CREATE INDEX IF NOT EXISTS links_to_idx   ON links(to_id, to_ref);
`;

// Local-only bookkeeping, created by the worker on the content DB (NOT shipped in slices/boot DB):
//   book_state  — the content_version actually merged locally for each book (drives staleness).
//   cache_meta  — small key/value; stores the local publishId (which catalog snapshot we hold).
export const LOCAL_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS book_state (
  toc_id          TEXT PRIMARY KEY,
  content_version TEXT
);
CREATE TABLE IF NOT EXISTS cache_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

// How a cached content DB is upgraded in place: CONTENT_MIGRATIONS[v] takes user_version v→v+1.
// The corpus is NEVER re-downloaded for a schema change — every BOOT_VERSION bump MUST add the next
// step here (additive ALTER / CREATE, or a table-rebuild for non-additive changes; SQLite can do any
// of these in place). The boot DB + downloaded books are kept; only books whose content_version
// actually changed re-download (see book_state). A missing step is a programmer error → boot throws
// rather than silently wiping a multi-GB cache.
export const CONTENT_MIGRATIONS: Record<number, string> = {
  11: `ALTER TABLE toc ADD COLUMN content_version TEXT`,
};
