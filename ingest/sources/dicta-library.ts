// Dicta Library — OCR'd rabbinic texts from the Dicta Library (CC BY-SA 4.0; Dicta, Israel). Each
// book ships as a ZIP of per-page .txt files behind mutable files.dicta.org.il URLs (we snapshot
// them under data/). These are mostly obscure Acharonim NOT in Sefaria, so they become NEW canonical
// books under a "Dicta Library" category. Refs are siman:paragraph (from `סימן N` headings). The
// data carries no structured cross-references, so this source emits content only. Subset to start.

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { SourceAdapter, IngestCtx } from './types.ts';

const SRC = 'dicta-library';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/dicta-library');
const HOST = 'https://files.dicta.org.il/library-1-0';
const LIB = 'Dicta Library'; // top-level root (Sefaria-absent corpus) — declared in build-master HOUSE_CATEGORIES

const GEM: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
  י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90,
  ק: 100, ר: 200, ש: 300, ת: 400, ך: 20, ם: 40, ן: 50, ף: 80, ץ: 90,
};
const gematria = (s: string) => [...s.replace(/["'״׳]/g, '')].reduce((n, c) => n + (GEM[c] ?? 0), 0);

// Subset: books verified NEW (absent from Sefaria) + clearly Jewish + CC BY-SA 4.0 + human-reviewed.
const BOOKS = [
  { fileName: 'achiezer', title: 'Achiezer Even Haezer', he: 'אחיעזר חלק אבן העזר', by: 'Chaim Ozer Grodzinski (Vilna, 1922)' },
  { fileName: 'levushmordechaigittin', title: 'Levush Mordechai on Gittin', he: 'לבוש מרדכי', by: 'Moshe Mordechai Epstein (Jerusalem, 1948)' },
];

async function fetchSubset() {
  let fetched = 0;
  for (const { fileName } of BOOKS) {
    const dest = resolve(DIR, fileName);
    if (existsSync(dest)) continue;
    const res = await fetch(`${HOST}/${fileName}/${fileName}__text_files.zip`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${fileName}`);
    mkdirSync(DIR, { recursive: true });
    const zip = resolve(DIR, `${fileName}.zip`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    mkdirSync(dest, { recursive: true });
    execSync(`unzip -o -q "${zip}" -d "${dest}"`);
    rmSync(zip);
    fetched++;
  }
  console.log(`  dicta-library: fetched ${fetched} new book(s)`);
}

// Per-page .txt files named …-NNN.txt; concatenate in page order.
function pageFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.txt'))
    .map((f) => ({ f, n: Number((f.match(/-(\d+)\.txt$/) || [])[1] ?? 0) }))
    .sort((a, b) => a.n - b.n)
    .map((x) => x.f);
}

// `סימן N` headings open a section; `. `-prefixed lines are paragraphs → siman:paragraph refs.
function parseBook(dir: string): { ref: string; text: string }[] {
  const out: { ref: string; text: string }[] = [];
  let siman = 0;
  let para = 0;
  for (const rel of pageFiles(dir)) {
    for (const raw of readFileSync(resolve(dir, rel), 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const sm = line.match(/^סימן\s+([א-ת"'״׳]+)/);
      if (sm) {
        siman = gematria(sm[1]);
        para = 0;
        continue;
      }
      if (siman === 0) continue; // skip front matter before the first siman
      const text = line.replace(/^\.\s*/, '').trim();
      if (!text) continue;
      para++;
      out.push({ ref: `${siman}:${para}`, text });
    }
  }
  return out;
}

function ingest(ctx: IngestCtx) {
  // These books aren't in Sefaria, so "Dicta Library" is a top-level root — declared upfront in
  // build-master's HOUSE_CATEGORIES. Here we just hang the books off it.
  const parent = ctx.category([LIB]);
  let total = 0;
  for (const b of BOOKS) {
    ctx.toc({ id: b.title, parent_id: parent, kind: 'book', title_en: b.title, title_he: b.he, category_en: null, category_he: null, order_index: 0 });
    const editionId = `${SRC}:${b.title}:he:Dicta`;
    ctx.edition({ id: editionId, tocId: b.title, source: SRC, lang: 'he', title: 'Dicta (OCR)', info: `${b.by} · Dicta Library · CC BY-SA 4.0 · AI-OCR`, orderIndex: 0 });
    for (const { ref, text } of parseBook(resolve(DIR, b.fileName))) {
      ctx.content({ editionId, tocId: b.title, ref, text });
      total++;
    }
    ctx.meta({ tocId: b.title, schema: { sectionNames: ['Siman', 'Paragraph'], heSectionNames: ['סימן', 'פסקה'] } });
  }
  console.log(`  dicta-library: ${BOOKS.length} books, ${total} rows`);
}

export const dictaLibrary: SourceAdapter = { id: SRC, name: 'Dicta Library', fetchSubset, ingest };
