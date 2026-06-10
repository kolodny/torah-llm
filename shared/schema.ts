// Single source of truth for the SQLite schema (raw SQL; no ORM).
//
// Multi-source "versions" model: a CANONICAL book (source-independent, keyed by title) can have
// many EDITIONS — one per (source, language, version). e.g. one "Genesis" with Sefaria Hebrew,
// JPS-1917 English, a French translation, the WLC, and Orayta's text as selectable editions.

// Bump when the boot-DB schema changes. The slicer stamps it into db.sqlite via
// `PRAGMA user_version`; the browser client re-downloads the boot DB if its stored version
// doesn't match, so an old cached DB in OPFS self-heals instead of erroring.
export const BOOT_VERSION = 11;

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
  file_size     INTEGER              -- byte size of this book's slice (set by the slicer)
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
