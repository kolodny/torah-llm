// Split data/master.sqlite into the small files the browser loads on demand:
//   public/db/toc_<id>.sqlite : one per book — its editions + content + meta + links
//   public/db/db.sqlite       : the boot DB — the canonical TOC, pruned to books with content
//                               plus their ancestor categories. Each toc row carries a
//                               content_version (hash of the book's slice rows) for incremental
//                               re-merge (LLM/022).
//   public/db/manifest.json   : { schemaVersion, publishId } — fetched on every app start so the
//                               client can detect a new publish and refresh without a wipe.
//
// BOOT_ONLY=1 regenerates only db.sqlite + manifest.json (reusing the existing slices) — useful
// when only the versioning metadata changed, not the slice contents.

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { rmSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import { SCHEMA_SQL, BOOT_VERSION } from '../shared/schema.ts';
import { sliceFileName, TOC_DB } from '../shared/slice-path.ts';

const BOOT_ONLY = !!process.env.BOOT_ONLY;
const root = resolve(import.meta.dirname, '..');
const masterPath = resolve(root, 'data', 'master.sqlite');
const outDir = resolve(root, 'public', 'db');
const attach = (p: string) => `ATTACH DATABASE '${p.replace(/'/g, "''")}' AS master`;

if (!BOOT_ONLY) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const master = new Database(masterPath);
// content_version is new (LLM/022); tolerate a master built before it existed.
try {
  master.exec(`ALTER TABLE toc ADD COLUMN content_version TEXT`);
} catch {
  /* column already present (fresh master) */
}

const books = master
  .prepare(`SELECT DISTINCT toc_id AS id FROM editions ORDER BY toc_id`)
  .all() as { id: string }[];

// content_version: a deterministic hash over everything that lands in a book's slice (editions,
// content, meta, links touching it), in the natural-key order — independent of surrogate ids — so
// it changes iff the book's published data changes. Rows are streamed so memory stays bounded.
const qEditions = master
  .prepare(`SELECT id, source, lang, title, IFNULL(info,''), IFNULL(order_index,0)
              FROM editions WHERE toc_id = ? ORDER BY id`)
  .raw();
const qContent = master
  .prepare(`SELECT edition_id, ref, IFNULL(text,'') FROM content WHERE toc_id = ? ORDER BY edition_id, ref`)
  .raw();
const qMeta = master.prepare(`SELECT IFNULL(schema,'') FROM meta WHERE toc_id = ?`).raw();
const qLinks = master
  .prepare(`SELECT from_id, from_ref, to_id, to_ref, IFNULL(connection_type,'')
              FROM links WHERE from_id = ? OR to_id = ?
             ORDER BY from_id, from_ref, to_id, to_ref, connection_type`)
  .raw();

function contentVersion(id: string): string {
  const h = createHash('sha256');
  for (const row of qEditions.iterate(id)) h.update('e\x1f' + (row as unknown[]).join('\x1e'));
  for (const row of qContent.iterate(id)) h.update('c\x1f' + (row as unknown[]).join('\x1e'));
  for (const row of qMeta.iterate(id)) h.update('m\x1f' + (row as unknown[]).join('\x1e'));
  for (const row of qLinks.iterate(id, id)) h.update('l\x1f' + (row as unknown[]).join('\x1e'));
  return h.digest('hex').slice(0, 16);
}

console.log(`${BOOT_ONLY ? 'Versioning' : 'Slicing'} ${books.length} books…`);
const setMeta = master.prepare(`UPDATE toc SET file_size = ?, content_version = ? WHERE id = ?`);
const edCount = master.prepare(`SELECT COUNT(*) AS c FROM editions WHERE toc_id = ?`);
const versions: Array<[string, string]> = [];

for (const { id } of books) {
  const file = resolve(outDir, sliceFileName(id));
  let size = 0;
  if (!BOOT_ONLY) {
    const slice = new Database(file);
    slice.exec(SCHEMA_SQL);
    slice.exec(attach(masterPath));
    slice.prepare(`INSERT INTO editions SELECT * FROM master.editions WHERE toc_id = ?`).run(id);
    slice.prepare(`INSERT INTO content  SELECT * FROM master.content  WHERE toc_id = ?`).run(id);
    slice.prepare(`INSERT INTO meta     SELECT * FROM master.meta     WHERE toc_id = ?`).run(id);
    slice
      .prepare(`INSERT INTO links SELECT * FROM master.links WHERE from_id = ? OR to_id = ?`)
      .run(id, id);
    slice.exec(`DETACH DATABASE master`);
    slice.close();
    // Ship the slice gzipped (it's what the browser fetches); file_size records the compressed download size.
    const gzipped = gzipSync(readFileSync(file), { level: 9 });
    writeFileSync(`${file}.gz`, gzipped);
    rmSync(file, { force: true });
    size = gzipped.length;
  } else {
    try {
      size = statSync(`${file}.gz`).size;
    } catch {
      /* BOOT_ONLY with a missing slice — leave size 0 */
    }
  }
  const ver = contentVersion(id);
  versions.push([id, ver]);
  setMeta.run(size, ver, id);
  if (!BOOT_ONLY) {
    const eds = (edCount.get(id) as { c: number }).c;
    console.log(`  ${id}: ${eds} editions → ${(size / 1024).toFixed(0)} KB  [${ver}]`);
  }
}

// Boot TOC: keep content-bearing books plus all their ancestors (so the tree is connected).
const allToc = master.prepare(`SELECT id, parent_id FROM toc`).all() as {
  id: string;
  parent_id: string | null;
}[];
const parentOf = new Map(allToc.map((r) => [r.id, r.parent_id]));
const keep = new Set<string>();
for (const { id } of books) {
  let cur: string | null | undefined = id;
  while (cur && !keep.has(cur)) {
    keep.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
}

const tocDbPath = resolve(outDir, TOC_DB);
rmSync(tocDbPath, { force: true }); // rebuild fresh (no-op in full mode; replaces stale in BOOT_ONLY)
const tocDb = new Database(tocDbPath);
tocDb.exec(SCHEMA_SQL);
tocDb.exec(attach(masterPath));
const ids = [...keep];
const CHUNK = 400;
tocDb.transaction(() => {
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const placeholders = part.map(() => '?').join(',');
    tocDb.prepare(`INSERT INTO toc SELECT * FROM master.toc WHERE id IN (${placeholders})`).run(...part);
  }
})();
tocDb.exec(`DETACH DATABASE master`);
tocDb.exec(`PRAGMA user_version = ${BOOT_VERSION}`);
tocDb.close();
master.close();
// Ship the boot DB gzipped too (fetched on every cold start); db.sqlite.gz replaces db.sqlite.
const tocGz = gzipSync(readFileSync(tocDbPath), { level: 9 });
writeFileSync(`${tocDbPath}.gz`, tocGz);
rmSync(tocDbPath, { force: true });
const tocSize = tocGz.length;

// publishId changes iff any book's content_version changed → the client knows to refresh the
// catalog (and lazily re-merge the books that actually differ) without a wipe.
versions.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const publishId = createHash('sha256')
  .update(versions.map(([id, v]) => `${id}=${v}`).join('\n'))
  .digest('hex')
  .slice(0, 16);
writeFileSync(
  resolve(outDir, 'manifest.json'),
  JSON.stringify({ schemaVersion: BOOT_VERSION, publishId, books: books.length }, null, 2) + '\n'
);

console.log(`Boot TOC (${TOC_DB}): ${keep.size} nodes → ${(tocSize / 1024).toFixed(0)} KB`);
console.log(`manifest.json: schemaVersion=${BOOT_VERSION} publishId=${publishId} books=${books.length}`);
console.log(`\nDone → ${outDir}`);
