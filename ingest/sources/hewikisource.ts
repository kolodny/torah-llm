// Hebrew Wikisource — the "Biur" (ביאור), Wikisource's own modern-Hebrew Tanakh commentary
// (CC BY-SA 4.0). It's verse-segmented and NOT in Sefaria, so it's the one genuinely-new slice of
// he.wikisource (the rest is duplicative). Biur is a COMMENTARY, so we ingest it as its own book
// "Biur on <Book>" (verse refs) linked to the base verses — NOT as a sparse "edition" of the base
// text (which rendered as a mostly-blank, misaligned column). It shows up as a commentary connection.
// Fetched via the MediaWiki API (current revision — mutable; a small whitelisted subset of pages).

import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { SourceAdapter, IngestCtx } from './types.ts';

const SRC = 'hewikisource';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/hewikisource');
const API = 'https://he.wikisource.org/w/api.php';
const UA = 'torah-llm/0.1 (research; per-page subset)';
const INFO = 'Biur — Hebrew Wikisource modern commentary · CC BY-SA 4.0';

// Biur is a modern Hebrew commentary on Tanakh — it fits inside Sefaria's spine, so we graft a "Biur"
// folder onto Sefaria's existing "Modern Commentary on Tanakh" branch (ctx.category requires that parent
// to already exist, i.e. Sefaria ingested first). No new top-level category needed.
const BIUR_PATH = ['Tanakh', 'Modern Commentary on Tanakh', 'Biur'];

// Whitelisted Biur pages → canonical English book. One page per chapter.
const PAGES: { title: string; toc: string }[] = [
  { title: 'ביאור:בראשית א', toc: 'Genesis' },
  { title: 'ביאור:בראשית ב', toc: 'Genesis' },
  { title: 'ביאור:בראשית ג', toc: 'Genesis' },
  { title: 'ביאור:תהלים א', toc: 'Psalms' },
  { title: 'ביאור:תהלים כג', toc: 'Psalms' },
  { title: 'ביאור:דברים ו', toc: 'Deuteronomy' },
];

const GEM: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
  י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90,
  ק: 100, ר: 200, ש: 300, ת: 400, ך: 20, ם: 40, ן: 50, ף: 80, ץ: 90,
};
const gematria = (s: string) => [...s.replace(/["'״׳]/g, '')].reduce((n, c) => n + (GEM[c] ?? 0), 0);

const local = (title: string) => resolve(DIR, `${title.replace(/[: ]/g, '_')}.wikitext`);

const inl = (s: string) =>
  s
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/<\/?br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();

// Reduce a verse's Biur wikitext to readable text: {{ב|word|gloss}} → "word (gloss)", drop other
// templates / קטע markers / wikilinks / tags.
function cleanBiur(s: string): string {
  s = s.replace(/\{[פסש]\}/g, ''); // petucha/setuma/shirah markers
  s = s.replace(/\{\{ב\|([^|{}]*)\|([^{}]*?)\}\}/g, (_m, w, g) => {
    const word = inl(w);
    const gloss = inl(g);
    return gloss ? `${word} (${gloss})` : word;
  });
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\{\{[^{}]*\}\}/g, '');
  } while (s !== prev);
  s = s
    .replace(/<קטע[^>]*>/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/<\/?br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/'''?/g, '')
    .replace(/[{}]/g, '');
  return s.replace(/\s+/g, ' ').replace(/\s+([:.,;])/g, '$1').trim();
}

// Each verse begins with {{ביאור:אות-פסוק|book|chapter|verse}}; its text runs to the next anchor.
function parseBiur(wt: string): { ref: string; text: string }[] {
  const re = /\{\{ביאור:אות-פסוק\|[^|]*\|([^|]*)\|([^}|]*)\}\}/g;
  const anchors: { ch: string; v: string; end: number; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(wt))) anchors.push({ ch: m[1].trim(), v: m[2].trim(), start: m.index, end: re.lastIndex });
  const out: { ref: string; text: string }[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const text = cleanBiur(wt.slice(a.end, i + 1 < anchors.length ? anchors[i + 1].start : undefined));
    if (text) out.push({ ref: `${gematria(a.ch)}:${gematria(a.v)}`, text });
  }
  return out;
}

async function fetchSubset() {
  let fetched = 0;
  for (const { title } of PAGES) {
    const dest = local(title);
    if (existsSync(dest)) continue;
    const url = `${API}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&titles=${encodeURIComponent(title)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${title}`);
    const data = (await res.json()) as { query: { pages: Record<string, { revisions?: { slots: { main: { '*': string } } }[] }> } };
    const page = Object.values(data.query.pages)[0];
    const wt = page?.revisions?.[0]?.slots?.main?.['*'];
    if (!wt) throw new Error(`no wikitext for ${title}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, wt, 'utf8');
    fetched++;
  }
  console.log(`  hewikisource: fetched ${fetched} new page(s)`);
}

function ingest(ctx: IngestCtx) {
  const byBook = new Map<string, string[]>(); // toc → page titles
  for (const { title, toc } of PAGES) (byBook.get(toc) ?? byBook.set(toc, []).get(toc)!).push(title);

  // Graft the "Biur" folder onto Sefaria's Modern Commentary on Tanakh; each book hangs directly off it.
  const parent = ctx.category(BIUR_PATH, { he: 'ביאור' });

  let total = 0;
  for (const [toc, titles] of byBook) {
    const book = `Biur on ${toc}`; // its own commentary book, linked to the base verses
    // Hebrew base-book name straight from the Wikisource page title ("ביאור:בראשית א" → "בראשית"), so the
    // viewer's Hebrew label reads "ביאור על בראשית" rather than mixing scripts.
    const heBook = titles[0].replace(/^ביאור:/, '').replace(/\s+\S+$/, '').trim();
    ctx.toc({ id: book, parent_id: parent, kind: 'book', title_en: book, title_he: `ביאור על ${heBook}`, category_en: null, category_he: null, order_index: null });
    const editionId = `${SRC}:${book}:he:Biur`;
    ctx.edition({ id: editionId, tocId: book, source: SRC, lang: 'he', title: 'Biur (Wikisource)', info: INFO, orderIndex: 0 });
    for (const title of titles) {
      for (const { ref, text } of parseBiur(readFileSync(local(title), 'utf8'))) {
        ctx.content({ editionId, tocId: book, ref, text });
        ctx.link({ fromId: book, fromRef: ref, toId: toc, toRef: ref, connectionType: 'commentary' });
        total++;
      }
    }
    ctx.meta({ tocId: book, schema: { sectionNames: ['Chapter', 'Verse'], heSectionNames: ['פרק', 'פסוק'] } });
  }
  console.log(`  hewikisource: Biur on ${byBook.size} book(s), ${total} verses`);
}

export const hewikisource: SourceAdapter = { id: SRC, name: 'Hebrew Wikisource (Biur)', fetchSubset, ingest };
