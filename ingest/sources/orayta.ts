// Orayta adapter — contributes a Hebrew "Orayta" edition to canonical books (by title).
// Parses Orayta's .txt format from github.com/MosheWagner/Orayta-Books (free-licensed).
// Markers: `$` title, `^` section/parsha, `~ … פרק-<n>` chapter, `! {gematria}` verse.

import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { SourceAdapter, IngestCtx } from './types.ts';

const SRC = 'orayta';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/orayta');
const RAW = 'https://raw.githubusercontent.com/MosheWagner/Orayta-Books/master/BooksSrc';

const BOOKS = [
  { path: '001_mkra/01_torh/a01_Genesis.txt', title: 'Genesis' },
  { path: '001_mkra/03_ctobim/a30_Song_of_Songs.txt', title: 'Song of Songs' },
  { path: '001_mkra/03_ctobim/a34_Esther.txt', title: 'Esther' },
];

async function fetchSubset() {
  let fetched = 0;
  for (const { path } of BOOKS) {
    const dest = resolve(DIR, path);
    if (existsSync(dest)) continue;
    const url = `${RAW}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    fetched++;
  }
  console.log(`  orayta: fetched ${fetched} new file(s)`);
}

// Strip Orayta's cosmetic inline markup (e.g. aliyah labels `<BR><span class="Aliyah">…</span>`).
const clean = (s: string) =>
  s
    .replace(/<span[^>]*class="Aliyah"[^>]*>.*?<\/span>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function ingest(ctx: IngestCtx) {
  let total = 0;
  for (const { path, title } of BOOKS) {
    const editionId = `${SRC}:${title}:he:Orayta`;
    ctx.edition({ id: editionId, tocId: title, source: SRC, lang: 'he', title: 'Orayta', orderIndex: 0 });

    const txt = readFileSync(resolve(DIR, path), 'utf8');
    let chapter = 0;
    let verse = 0;
    let buf: string[] = [];
    const flush = () => {
      if (chapter > 0 && verse > 0) {
        const text = clean(buf.join(' '));
        if (text) {
          ctx.content({ editionId, tocId: title, ref: `${chapter}:${verse}`, text });
          total++;
        }
      }
      buf = [];
    };
    for (const raw of txt.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const c = line[0];
      if (c === '$') continue;
      else if (c === '^') flush();
      else if (c === '~') {
        flush();
        chapter++;
        verse = 0;
      } else if (c === '!') {
        flush();
        verse++;
        const rest = line.replace(/^!\s*\{[^}]*\}\s*/, '').trim();
        if (rest) buf.push(rest);
      } else {
        buf.push(line);
      }
    }
    flush();

    ctx.meta({ tocId: title, schema: { sectionNames: ['Chapter', 'Verse'], heSectionNames: ['פרק', 'פסוק'] } });
  }
  console.log(`  orayta: ${BOOKS.length} editions, ${total} verses`);
}

export const orayta: SourceAdapter = { id: SRC, name: 'Orayta', fetchSubset, ingest };
