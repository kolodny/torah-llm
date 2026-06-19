// Build data/master.sqlite by running every source adapter. Each adapter contributes canonical
// toc nodes, editions, content, meta, and links via the IngestCtx. This file owns the DB and the
// prepared inserts; post-processing (edition counts, has_content, orphan-node safety net) is
// source-agnostic.

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';

import { SCHEMA_SQL } from '../shared/schema.ts';
import { adapters } from './sources/index.ts';
import type { IngestCtx } from './sources/types.ts';

const root = resolve(import.meta.dirname, '..');
const dataDir = resolve(root, 'data');
const dbPath = resolve(dataDir, 'master.sqlite');

mkdirSync(dataDir, { recursive: true });
rmSync(dbPath, { force: true });

const db = new Database(dbPath);
db.pragma('journal_mode = MEMORY');
db.pragma('synchronous = OFF');
db.exec(SCHEMA_SQL);

const insertToc = db.prepare(
  `INSERT OR IGNORE INTO toc (id, parent_id, kind, title_en, title_he, category_en, category_he, order_index)
   VALUES (@id, @parent_id, @kind, @title_en, @title_he, @category_en, @category_he, @order_index)`
);
const insertEdition = db.prepare(
  `INSERT OR IGNORE INTO editions (id, toc_id, source, lang, title, info, order_index)
   VALUES (@id, @tocId, @source, @lang, @title, @info, @orderIndex)`
);
const insertContent = db.prepare(
  `INSERT OR IGNORE INTO content (edition_id, toc_id, ref, text) VALUES (?, ?, ?, ?)`
);
const insertMeta = db.prepare(`INSERT OR IGNORE INTO meta (toc_id, schema) VALUES (?, ?)`);
const insertLink = db.prepare(
  `INSERT OR IGNORE INTO links (from_id, from_ref, to_id, to_ref, connection_type) VALUES (?, ?, ?, ?, ?)`
);

const tocExists = db.prepare(`SELECT 1 FROM toc WHERE id = ?`).pluck();

const ctx: IngestCtx = {
  toc: (r) => insertToc.run(r),
  // Graft a work's grouping onto an existing branch (see IngestCtx.category for the contract).
  category: (path, opts = {}) => {
    if (!path.length) throw new Error('ctx.category() requires a non-empty path');
    const id = path.join(' / ');
    if (tocExists.get(id)) return id; // already in the spine (Sefaria, a house root, or an earlier call)
    if (path.length === 1)
      throw new Error(
        `Refusing to create top-level category "${id}" ad-hoc. Declare it once in HOUSE_CATEGORIES ` +
          `(build-master.ts) — we trust Sefaria's top categories implicitly; ours must be explicit.`
      );
    const parent = path.slice(0, -1).join(' / ');
    if (!tocExists.get(parent))
      throw new Error(
        `Cannot place "${id}": parent "${parent}" does not exist. Ensure Sefaria is ingested first ` +
          `(it owns that branch), or fix the path.`
      );
    insertToc.run({ id, parent_id: parent, kind: 'category', title_en: null, title_he: null, category_en: path[path.length - 1], category_he: opts.he ?? null, order_index: opts.order ?? null });
    return id;
  },
  edition: (r) => insertEdition.run(r),
  content: (r) => insertContent.run(r.editionId, r.tocId, r.ref, r.text),
  meta: (r) => insertMeta.run(r.tocId, JSON.stringify(r.schema)),
  link: (r) => insertLink.run(r.fromId, r.fromRef, r.toId, r.toRef, r.connectionType),
};

// Our own top-level categories — the ONLY non-Sefaria roots, all declared here in one place so the
// catalog's top level stays auditable. Everything else must nest under an existing branch via
// ctx.category(), which refuses to invent new roots. Seeded upfront, before any adapter runs.
const HOUSE_CATEGORIES: { id: string; he: string | null; order: number }[] = [
  { id: 'Dicta Library', he: 'ספריית דיקטא', order: 900 },
];
for (const c of HOUSE_CATEGORIES)
  insertToc.run({ id: c.id, parent_id: null, kind: 'category', title_en: null, title_he: null, category_en: c.id, category_he: c.he, order_index: c.order });

// Sefaria must run first: it lays down the canonical category spine that every other source grafts onto
// (Tanakh / Rishonim on Tanakh / …). ctx.category() enforces "parent exists" downstream, but assert the
// order here for a clear failure rather than a confusing missing-parent error.
if (adapters[0]?.id !== 'sefaria')
  throw new Error('Sefaria must be the first adapter so its category spine exists before other works are placed under it.');

for (const adapter of adapters) {
  console.log(`Ingesting ${adapter.name}…`);
  db.transaction(() => adapter.ingest(ctx))();
}

// Edition alignment is handled in the READER, not here: a selected edition whose segmentation
// diverges from the canonical (e.g. Dicta segments a Talmud daf coarsely vs Sefaria's fine segments)
// renders as a standalone panel rather than a misaligned parallel column. Nothing is dropped — every
// edition is kept; the reader decides grid-column vs. standalone per selection (see src/App.tsx).

// Drop links whose endpoints have no content (generalizes "both endpoints in the master DB" across
// all sources — adapters may derive links liberally; this keeps only the ones that resolve).
// A (toc_id, ref) index makes the millions of endpoint lookups in the prune fast.
db.exec(`CREATE INDEX IF NOT EXISTS content_toc_ref ON content(toc_id, ref)`);
db.exec(`
  DELETE FROM links
  WHERE NOT EXISTS (SELECT 1 FROM content c WHERE c.toc_id = links.from_id AND c.ref = links.from_ref)
     OR NOT EXISTS (SELECT 1 FROM content c WHERE c.toc_id = links.to_id   AND c.ref = links.to_ref)
`);

// Every book MUST be placed. A book with editions but no toc node would orphan at the catalog root —
// we no longer paper over that with a synthesized stub; we fail the build so the gap can't ship silently.
// Fix by attaching the edition to an existing Sefaria tocId, or by calling ctx.category(...) to graft it.
const orphans = db
  .prepare(`SELECT DISTINCT e.toc_id FROM editions e LEFT JOIN toc t ON t.id = e.toc_id WHERE t.id IS NULL ORDER BY e.toc_id`)
  .all() as { toc_id: string }[];
if (orphans.length)
  throw new Error(
    `${orphans.length} book(s) have editions but no TOC node (would orphan at the catalog root):\n` +
      orphans.map((o) => `  • ${o.toc_id}`).join('\n') +
      `\nPlace each one: attach its edition to an existing Sefaria tocId, or call ctx.category(path) and set the book's parent_id.`
  );

// Flag content-bearing books and count their editions.
db.exec(`
  UPDATE toc SET
    edition_count = (SELECT COUNT(*) FROM editions WHERE editions.toc_id = toc.id),
    has_content   = (SELECT COUNT(*) FROM editions WHERE editions.toc_id = toc.id) > 0
`);

const totals = db
  .prepare(
    `SELECT (SELECT COUNT(*) FROM toc) AS toc,
            (SELECT COUNT(*) FROM editions) AS editions,
            (SELECT COUNT(*) FROM content) AS content,
            (SELECT COUNT(*) FROM links) AS links`
  )
  .get() as { toc: number; editions: number; content: number; links: number };

db.close();
console.log(`\nDone → ${dbPath}`);
console.log(`  toc=${totals.toc}  editions=${totals.editions}  content=${totals.content}  links=${totals.links}`);
