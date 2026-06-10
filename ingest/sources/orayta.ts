// Orayta adapter — contributes Hebrew editions to canonical books from github.com/MosheWagner/
// Orayta-Books (free-licensed). Two kinds of input, both in Orayta's .txt format:
//   • base texts (Genesis, …): `$` title, `^` parsha, `~ … פרק-<gematria>` chapter, `! {gematria}` verse.
//   • commentaries (Rashi on the Torah): same markers, but each verse block holds several comments,
//     one per `<b>catchphrase</b>` (dibur hamatchil). We split on those to get chapter:verse:comment
//     refs that line up with Sefaria's Rashi (verified: identical comment counts per verse).

import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { SourceAdapter, IngestCtx } from './types.ts';
import { githubRawBase } from './pins.ts';

const SRC = 'orayta';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/orayta');
const RAW = `${githubRawBase(SRC)}/BooksSrc`; // pinned to the SHA in sources.lock.json
const INFO = 'Orayta library · MosheWagner/Orayta-Books · free/open license';

// Base texts → canonical book (= title).
const BOOKS = [
  { path: '001_mkra/01_torh/a01_Genesis.txt', toc: 'Genesis' },
  { path: '001_mkra/03_ctobim/a30_Song_of_Songs.txt', toc: 'Song of Songs' },
  { path: '001_mkra/03_ctobim/a34_Esther.txt', toc: 'Esther' },
];
// Commentaries → existing canonical commentary book (overlays Sefaria's edition of the same book).
const COMMENTARIES = [
  { path: '005_mprsi_mkra/03_rsi/1_torh/01_c_RASHI_BERESHIT_L1.txt', toc: 'Rashi on Genesis' },
  { path: '005_mprsi_mkra/03_rsi/1_torh/02_c_RASHI_SHEMOT_L1.txt', toc: 'Rashi on Exodus' },
  { path: '005_mprsi_mkra/03_rsi/1_torh/03_c_RASHI_VAYIKRA_L1.txt', toc: 'Rashi on Leviticus' },
  { path: '005_mprsi_mkra/03_rsi/1_torh/04_c_RASHI_BAMIDBAR_L1.txt', toc: 'Rashi on Numbers' },
  { path: '005_mprsi_mkra/03_rsi/1_torh/05_c_RASHI_DVARIM_L1.txt', toc: 'Rashi on Deuteronomy' },
];

async function fetchSubset() {
  let fetched = 0;
  for (const { path } of [...BOOKS, ...COMMENTARIES]) {
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

// Strip Orayta's cosmetic inline markup from a base verse (aliyah labels etc.).
const cleanBase = (s: string) =>
  s
    .replace(/<span[^>]*class="Aliyah"[^>]*>.*?<\/span>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Hebrew gematria → integer (incl. final letters), for Orayta's `{…}` chapter/verse labels.
// Needed for commentaries, whose verse markers skip verses with no comment (so we can't just count).
const GEM: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
  י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90,
  ק: 100, ר: 200, ש: 300, ת: 400, ך: 20, ם: 40, ן: 50, ף: 80, ץ: 90,
};
const gematria = (s: string) => [...s].reduce((n, ch) => n + (GEM[ch] ?? 0), 0);

// Clean one Rashi comment: drop the editor's <small> source-notes and {{…}} footnote anchors, strip
// remaining tags (keeping the bold catchphrase as leading text), tidy whitespace/punctuation.
function cleanComment(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<small>(?:(?!<\/?small>)[\s\S])*?<\/small>/g, '');
  } while (s !== prev);
  return s
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([:.,])/g, '$1')
    .trim();
}

// Parse an Orayta commentary file into chapter:verse:comment rows (comment split on <b> catchphrases).
function parseCommentary(txt: string): { ref: string; text: string }[] {
  const out: { ref: string; text: string }[] = [];
  let chapter = 0;
  let verse = 0;
  let buf: string[] = [];
  const flush = () => {
    if (chapter > 0 && verse > 0 && buf.length) {
      const pieces = buf.join(' ').split(/(?=<b>)/).map(cleanComment).filter(Boolean);
      pieces.forEach((text, i) => out.push({ ref: `${chapter}:${verse}:${i + 1}`, text }));
    }
    buf = [];
  };
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '$' || line[0] === '&' || line.startsWith('//')) continue;
    if (line[0] === '^') {
      flush();
    } else if (line[0] === '~') {
      flush();
      const m = line.match(/פרק[\s-]*([א-ת"']+)/);
      chapter = m ? gematria(m[1]) : chapter + 1;
      verse = 0;
    } else if (line[0] === '!') {
      flush();
      const m = line.match(/\{([^}]*)\}/);
      verse = m ? gematria(m[1]) : verse + 1;
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

function ingest(ctx: IngestCtx) {
  // Base texts.
  let baseVerses = 0;
  for (const { path, toc } of BOOKS) {
    const editionId = `${SRC}:${toc}:he:Orayta`;
    ctx.edition({ id: editionId, tocId: toc, source: SRC, lang: 'he', title: 'Orayta', info: INFO, orderIndex: 0 });

    const txt = readFileSync(resolve(DIR, path), 'utf8');
    let chapter = 0;
    let verse = 0;
    let buf: string[] = [];
    const flush = () => {
      if (chapter > 0 && verse > 0) {
        const text = cleanBase(buf.join(' '));
        if (text) {
          ctx.content({ editionId, tocId: toc, ref: `${chapter}:${verse}`, text });
          baseVerses++;
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
    ctx.meta({ tocId: toc, schema: { sectionNames: ['Chapter', 'Verse'], heSectionNames: ['פרק', 'פסוק'] } });
  }

  // Commentaries (Rashi on the Torah) — a 3rd edition overlaying the canonical "Rashi on …" books.
  let commentaryRows = 0;
  for (const { path, toc } of COMMENTARIES) {
    const editionId = `${SRC}:${toc}:he:Orayta`;
    ctx.edition({ id: editionId, tocId: toc, source: SRC, lang: 'he', title: 'Orayta', info: `Rashi · ${INFO}`, orderIndex: 5 });
    const rows = parseCommentary(readFileSync(resolve(DIR, path), 'utf8'));
    for (const { ref, text } of rows) {
      ctx.content({ editionId, tocId: toc, ref, text });
      commentaryRows++;
    }
    ctx.meta({
      tocId: toc,
      schema: { sectionNames: ['Chapter', 'Verse', 'Comment'], heSectionNames: ['פרק', 'פסוק', 'פירוש'] },
    });
  }

  console.log(
    `  orayta: ${BOOKS.length} base (${baseVerses} verses) + ${COMMENTARIES.length} commentary (${commentaryRows} comments)`
  );
}

export const orayta: SourceAdapter = { id: SRC, name: 'Orayta', fetchSubset, ingest };
