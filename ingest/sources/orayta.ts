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
// Commentaries → existing canonical "X on <Book>" books (one Orayta edition each, with derived
// commentary→base links). Each Torah commentary is 5 files (01=Bereshit … 05=Dvarim).
const TORAH = ['Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy'];
const RASHI_HE = ['BERESHIT', 'SHEMOT', 'VAYIKRA', 'BAMIDBAR', 'DVARIM'];
const RAMBAN_HE = ['bereshit', 'shemot', 'vayikra', 'bamidbar', 'dvarim'];
const COMMENTARIES: { path: string; toc: string; base: string }[] = [
  ...TORAH.map((b, i) => ({ path: `005_mprsi_mkra/03_rsi/1_torh/0${i + 1}_c_RASHI_${RASHI_HE[i]}_L1.txt`, toc: `Rashi on ${b}`, base: b })),
  ...TORAH.map((b, i) => ({ path: `005_mprsi_mkra/04_rmbn/0${i + 1}_d_ramban_${RAMBAN_HE[i]}.txt`, toc: `Ramban on ${b}`, base: b })),
  ...TORAH.map((b, i) => ({ path: `005_mprsi_mkra/05_abn_uzra/0${i + 1}_g_EbenEzra.txt`, toc: `Ibn Ezra on ${b}`, base: b })),
  ...TORAH.map((b, i) => ({ path: `005_mprsi_mkra/06_sporno/0${i + 1}_j_sforno.txt`, toc: `Sforno on ${b}`, base: b })),
];

// Canonical link ordering (matches the Sefaria adapter, so identical commentary links dedupe).
function sortLink(a: string, ra: string, b: string, rb: string): [string, string, string, string] {
  return a < b || (a === b && ra <= rb) ? [a, ra, b, rb] : [b, rb, a, ra];
}

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
    s = s.replace(/<small>(?:(?!<\/?small>)[\s\S])*?<\/small>/gi, '');
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
      const pieces = buf.join(' ').split(/(?=<[bB]>)/).map(cleanComment).filter(Boolean);
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

  // Commentaries — one Orayta edition per canonical "X on <Book>" book, plus commentary→base links.
  let commentaryRows = 0;
  let links = 0;
  for (const { path, toc, base } of COMMENTARIES) {
    const commentator = toc.split(' on ')[0];
    const editionId = `${SRC}:${toc}:he:Orayta`;
    ctx.edition({ id: editionId, tocId: toc, source: SRC, lang: 'he', title: 'Orayta', info: `${commentator} · ${INFO}`, orderIndex: 5 });
    for (const { ref, text } of parseCommentary(readFileSync(resolve(DIR, path), 'utf8'))) {
      ctx.content({ editionId, tocId: toc, ref, text });
      commentaryRows++;
      const baseRef = ref.split(':').slice(0, -1).join(':'); // comment c:v:i → base verse c:v
      if (baseRef) {
        const [fId, fRef, tId, tRef] = sortLink(base, baseRef, toc, ref);
        ctx.link({ fromId: fId, fromRef: fRef, toId: tId, toRef: tRef, connectionType: 'commentary' });
        links++;
      }
    }
    ctx.meta({
      tocId: toc,
      schema: { sectionNames: ['Chapter', 'Verse', 'Comment'], heSectionNames: ['פרק', 'פסוק', 'פירוש'] },
    });
  }

  console.log(
    `  orayta: ${BOOKS.length} base (${baseVerses} verses) + ${COMMENTARIES.length} commentary (${commentaryRows} comments, ${links} links)`
  );
}

export const orayta: SourceAdapter = { id: SRC, name: 'Orayta', fetchSubset, ingest };
