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

const ctx: IngestCtx = {
  toc: (r) => insertToc.run(r),
  edition: (r) => insertEdition.run(r),
  content: (r) => insertContent.run(r.editionId, r.tocId, r.ref, r.text),
  meta: (r) => insertMeta.run(r.tocId, JSON.stringify(r.schema)),
  link: (r) => insertLink.run(r.fromId, r.fromRef, r.toId, r.toRef, r.connectionType),
};

for (const adapter of adapters) {
  console.log(`Ingesting ${adapter.name}…`);
  db.transaction(() => adapter.ingest(ctx))();
}

// Safety net: a minimal canonical node for any edition whose book isn't in the catalog spine.
db.exec(`
  INSERT OR IGNORE INTO toc (id, kind, title_en)
  SELECT DISTINCT e.toc_id, 'book', e.toc_id
  FROM editions e LEFT JOIN toc t ON t.id = e.toc_id
  WHERE t.id IS NULL
`);

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
