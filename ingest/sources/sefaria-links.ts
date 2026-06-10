// Sefaria links — the cross-reference graph from Sefaria's links CSV export (~657MB, 18 shards).
// Emits canonical (book,ref) ↔ (book,ref) links across the WHOLE corpus (commentary, Talmud↔Tanakh,
// Midrash, dictionary references, …). The CSV gives each side's book title directly (the "Text 1" /
// "Text 2" columns), so ref = citation with the title stripped; ranges collapse to their start verse.
// build-master prunes any link whose endpoints have no content, so we can emit liberally.

import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { SourceAdapter, IngestCtx } from './types.ts';

const SRC = 'sefaria-links';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/sefaria-links');
const BUCKET = 'https://storage.googleapis.com/sefaria-export';
const SHARDS = 18;

async function fetchSubset() {
  mkdirSync(DIR, { recursive: true });
  let fetched = 0;
  await Promise.all(
    Array.from({ length: SHARDS }, async (_, n) => {
      const dest = resolve(DIR, `links${n}.csv`);
      if (existsSync(dest)) return;
      const res = await fetch(`${BUCKET}/links/links${n}.csv`);
      if (!res.ok) return;
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      fetched++;
    })
  );
  console.log(`  sefaria-links: fetched ${fetched} shard(s)`);
}

// Minimal CSV line parser: handles "quoted, fields" and "" escapes (titles contain commas).
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// "Genesis 1:1-2:3" with title "Genesis" → "1:1" (strip the title prefix, collapse a range to its start).
function refOf(citation: string, title: string): string {
  if (!citation.startsWith(title)) return '';
  const r = citation.slice(title.length).trim();
  return r.split('-')[0].trim();
}

function sortLink(a: string, ra: string, b: string, rb: string): [string, string, string, string] {
  return a < b || (a === b && ra <= rb) ? [a, ra, b, rb] : [b, rb, a, ra];
}

function ingest(ctx: IngestCtx) {
  let emitted = 0;
  for (let n = 0; n < SHARDS; n++) {
    const path = resolve(DIR, `links${n}.csv`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line || line.startsWith('Citation 1,')) continue; // skip blanks + header
      const f = parseCsvLine(line);
      const [c1, c2, conn, t1, t2] = f; // Citation1, Citation2, ConnType, Text1, Text2, …
      if (!t1 || !t2 || !c1 || !c2 || t1 === t2) continue;
      const r1 = refOf(c1, t1);
      const r2 = refOf(c2, t2);
      if (!r1 || !r2) continue;
      const [fId, fRef, tId, tRef] = sortLink(t1, r1, t2, r2);
      ctx.link({ fromId: fId, fromRef: fRef, toId: tId, toRef: tRef, connectionType: conn || 'reference' });
      emitted++;
    }
  }
  console.log(`  sefaria-links: emitted ${emitted} links (build-master prunes to resolvable)`);
}

export const sefariaLinks: SourceAdapter = { id: SRC, name: 'Sefaria links', fetchSubset, ingest };
