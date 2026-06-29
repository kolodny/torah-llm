// Derive data/publish-master.sqlite — the filtered view of the full master that gets published to the
// public site (which must fit under GitHub Pages' 1 GB limit). torah-llm stays the full source of truth;
// this is just the subset we ship. The normal slicer then runs against it:
//   tsx ingest/build-publish-master.ts && MASTER=data/publish-master.sqlite tsx ingest/slice-db.ts
//
// Tune what ships via the three constants below.

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { rmSync, statSync } from 'node:fs';
import { SCHEMA_SQL } from '../shared/schema.ts';

// What the public build includes.
const SOURCES = ['sefaria']; // only Sefaria for now (other adapters add <1% but extra scope)
const LANGS = ['he', 'en', 'arc']; // main Hebrew + English (+ Aramaic targumim); drops e.g. French
// Previously dropped Halakhah + Second Temple to fit gzip under GitHub Pages' 1 GB limit; with zstd-19 slices
// (LLM/053) the whole corpus fits (~800 MB), so we now ship everything.
const EXCLUDE_TOP_CATEGORIES = new Set<string>();

const root = resolve(import.meta.dirname, '..');
const srcPath = resolve(root, 'data', 'master.sqlite');
const dstPath = resolve(root, 'data', 'publish-master.sqlite');
const inList = (a: string[]) => a.map(() => '?').join(',');

rmSync(dstPath, { force: true });
const db = new Database(dstPath);
db.pragma('journal_mode = MEMORY');
db.pragma('synchronous = OFF');
db.exec(SCHEMA_SQL);
db.exec(`ATTACH DATABASE '${srcPath.replace(/'/g, "''")}' AS m`);

// Map every toc node to its top-level category id (walk parents to the root).
const parent = new Map<string, string | null>(
  (db.prepare('SELECT id, parent_id FROM m.toc').all() as { id: string; parent_id: string | null }[]).map((r) => [r.id, r.parent_id])
);
const topOf = (id: string): string => {
  let cur = id;
  for (let p = parent.get(cur); p; p = parent.get(cur)) cur = p;
  return cur;
};

// Kept books: have a (source, lang) edition and aren't under an excluded top category.
const kept = new Set<string>();
for (const { toc_id } of db
  .prepare(`SELECT DISTINCT toc_id FROM m.editions WHERE source IN (${inList(SOURCES)}) AND lang IN (${inList(LANGS)})`)
  .all(...SOURCES, ...LANGS) as { toc_id: string }[])
  if (!EXCLUDE_TOP_CATEGORIES.has(topOf(toc_id))) kept.add(toc_id);

// toc to keep = kept books + all their ancestors (so the tree stays connected).
const keptToc = new Set<string>();
for (const id of kept) {
  let cur: string | null | undefined = id;
  while (cur && !keptToc.has(cur)) {
    keptToc.add(cur);
    cur = parent.get(cur);
  }
}

// Stage the kept-id sets as temp tables so the bulk copies are simple joins.
db.exec('CREATE TEMP TABLE keep_book(id TEXT PRIMARY KEY)');
db.exec('CREATE TEMP TABLE keep_toc(id TEXT PRIMARY KEY)');
const fill = (tbl: string, ids: Set<string>) => {
  const ins = db.prepare(`INSERT INTO ${tbl}(id) VALUES (?)`);
  db.transaction(() => ids.forEach((id) => ins.run(id)))();
};
fill('keep_book', kept);
fill('keep_toc', keptToc);

db.transaction(() => {
  db.prepare(`INSERT INTO toc SELECT t.* FROM m.toc t JOIN keep_toc k ON k.id = t.id`).run();
  db.prepare(
    `INSERT INTO editions SELECT e.* FROM m.editions e JOIN keep_book k ON k.id = e.toc_id
      WHERE e.source IN (${inList(SOURCES)}) AND e.lang IN (${inList(LANGS)})`
  ).run(...SOURCES, ...LANGS);
  db.prepare(
    `INSERT INTO content SELECT c.* FROM m.content c JOIN keep_book k ON k.id = c.toc_id
       JOIN m.editions e ON e.id = c.edition_id
      WHERE e.source IN (${inList(SOURCES)}) AND e.lang IN (${inList(LANGS)})`
  ).run(...SOURCES, ...LANGS);
  db.prepare(`INSERT INTO meta SELECT mt.* FROM m.meta mt JOIN keep_book k ON k.id = mt.toc_id`).run();
  // Links only where BOTH endpoints survive — no dangling commentary connections.
  db.prepare(
    `INSERT INTO links SELECT l.* FROM m.links l
       JOIN keep_book f ON f.id = l.from_id
       JOIN keep_book t ON t.id = l.to_id`
  ).run();
})();

const n = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
const totals = { toc: n('toc'), editions: n('editions'), content: n('content'), links: n('links') };
db.exec('DETACH DATABASE m');
db.close();

console.log(`Published view → ${dstPath}`);
console.log(`  sources=${SOURCES.join(',')}  langs=${LANGS.join(',')}  excluded=[${[...EXCLUDE_TOP_CATEGORIES].join(', ')}]`);
console.log(`  kept books=${kept.size}  toc=${totals.toc}  editions=${totals.editions}  content=${totals.content.toLocaleString()}  links=${totals.links.toLocaleString()}`);
console.log(`  master.sqlite size: ${(statSync(dstPath).size / 1024 / 1024).toFixed(0)} MB`);
