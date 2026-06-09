// Split data/master.sqlite into the small files the browser loads on demand:
//   public/db/toc_<id>.sqlite : one per book — its editions + content + meta + links
//   public/db/db.sqlite       : the boot DB — the canonical TOC, pruned to books with content
//                               plus their ancestor categories.

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { rmSync, mkdirSync, statSync } from 'node:fs';

import { SCHEMA_SQL, BOOT_VERSION } from '../shared/schema.ts';
import { sliceFileName, TOC_DB } from '../shared/slice-path.ts';

const root = resolve(import.meta.dirname, '..');
const masterPath = resolve(root, 'data', 'master.sqlite');
const outDir = resolve(root, 'public', 'db');
const attach = (p: string) => `ATTACH DATABASE '${p.replace(/'/g, "''")}' AS master`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const master = new Database(masterPath);

const books = master
  .prepare(`SELECT DISTINCT toc_id AS id FROM editions ORDER BY toc_id`)
  .all() as { id: string }[];

console.log(`Slicing ${books.length} books…`);
const setSize = master.prepare(`UPDATE toc SET file_size = ? WHERE id = ?`);
const edCount = master.prepare(`SELECT COUNT(*) AS c FROM editions WHERE toc_id = ?`);

for (const { id } of books) {
  const file = resolve(outDir, sliceFileName(id));
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

  const size = statSync(file).size;
  setSize.run(size, id);
  const eds = (edCount.get(id) as { c: number }).c;
  console.log(`  ${id}: ${eds} editions → ${(size / 1024).toFixed(0)} KB`);
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
const tocSize = statSync(tocDbPath).size;
tocDb.close();
master.close();

console.log(`Boot TOC (${TOC_DB}): ${keep.size} nodes → ${(tocSize / 1024).toFixed(0)} KB`);
console.log(`\nDone → ${outDir}`);
