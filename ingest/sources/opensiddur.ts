// Open Siddur adapter — Jewish liturgy from github.com/opensiddur/sourcetexts (Open Siddur Project).
// These are flat-text transcriptions of public-domain siddurim; we ingest the plain-text, clearly-PD
// ones as books under the canonical "Liturgy" category. (.fodt/.html siddurim and the fuller
// structured corpus behind Open Siddur's live eXist API are deferred — see LLM/014.)

import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { SourceAdapter, IngestCtx } from './types.ts';
import { githubRawBase } from './pins.ts';

const SRC = 'opensiddur';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/opensiddur');
const RAW = `${githubRawBase(SRC)}/whole-siddurim`; // pinned to the SHA in sources.lock.json
const LITURGY = 'Liturgy'; // canonical parent category (exists in the Sefaria TOC spine)

// Hebrew gematria → integer, for Rambam's [א]/[ב] section markers.
const GEM: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
  י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90,
  ק: 100, ר: 200, ש: 300, ת: 400, ך: 20, ם: 40, ן: 50, ף: 80, ץ: 90,
};
const gematria = (s: string) => [...s].reduce((n, c) => n + (GEM[c] ?? 0), 0);

type Row = { ref: string; text: string };

// Rambam's Seder ha-Tefilot: `[gematria]` section markers, blank-line-separated paragraphs.
function parseRambam(txt: string): Row[] {
  const out: Row[] = [];
  let section = 0;
  let para = 0;
  for (const block of txt.split(/\n\s*\n/)) {
    let t = block.replace(/^﻿/, '').trim();
    if (!t) continue;
    const m = t.match(/^\[([א-ת]+)\]\s*/);
    if (m) {
      section = gematria(m[1]);
      para = 0;
      t = t.slice(m[0].length).trim();
    }
    if (!t || section === 0) continue; // skip the title block before the first [א]
    para++;
    out.push({ ref: `${section}:${para}`, text: t.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

// Singer's Standard Prayer Book: `{file "Section"}` markers; `{rem …}`/`{…}` directives + `<…>`
// emphasis are dropped; `�` is a mis-encoded apostrophe.
const cleanSinger = (s: string) =>
  s
    .replace(/\{[^}]*\}/g, '')
    .replace(/[<>]/g, '')
    .replace(/�/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

function parseSinger(txt: string): Row[] {
  const out: Row[] = [];
  txt = txt.replace(/\{rem[\s\S]*?\}/g, ' '); // drop scan/editorial remarks
  const parts = txt.split(/\{file\s*"([^"]*)"\}/); // [pre, name1, body1, name2, body2, …]
  let section = 0;
  for (let i = 1; i < parts.length; i += 2) {
    const name = (parts[i] || '').trim();
    if (/^(Table of Contents|Title Page)$/i.test(name)) continue; // skip cover/nav
    section++;
    let para = 0;
    for (const block of (parts[i + 1] || '').split(/\n\s*\n/)) {
      const t = cleanSinger(block);
      if (!t) continue;
      para++;
      out.push({ ref: `${section}:${para}`, text: t });
    }
  }
  return out;
}

type Siddur = {
  path: string; // relative to whole-siddurim/
  title: string; // canonical book title (under "Liturgy")
  titleHe: string | null;
  lang: string;
  info: string; // provenance + public-domain basis
  parse: (txt: string) => Row[];
};

const SIDDURIM: Siddur[] = [
  {
    path: 'Seder-Tefillot-Rambam/Maimonides-Seder-ha-Tefilot-from-the-Mishneh-Torah-voweled-minimal-layout.txt',
    title: 'Seder ha-Tefillot (Rambam)',
    titleHe: 'סדר התפילה (רמב״ם)',
    lang: 'he',
    info: 'Seder ha-Tefilot from Mishneh Torah (Maimonides, 12th c.) · Open Siddur Project · Public Domain',
    parse: parseRambam,
  },
  {
    path: 'Authorised Daily Prayer Book-Singer/Standard-Prayer-Book-Singer-sans-HTML.txt',
    title: 'Standard Prayer Book (Singer)',
    titleHe: null,
    lang: 'en',
    info: 'The Standard Prayer Book, trans. Simeon Singer (Bloch, 1915) · Open Siddur Project · Public Domain (pre-1923)',
    parse: parseSinger,
  },
];

async function fetchSubset() {
  let fetched = 0;
  for (const { path } of SIDDURIM) {
    const dest = resolve(DIR, path);
    if (existsSync(dest)) continue;
    const url = `${RAW}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    fetched++;
  }
  console.log(`  opensiddur: fetched ${fetched} new file(s)`);
}

function ingest(ctx: IngestCtx) {
  let total = 0;
  SIDDURIM.forEach((s, i) => {
    // New canonical book under the existing "Liturgy" category.
    ctx.toc({
      id: s.title,
      parent_id: LITURGY,
      kind: 'book',
      title_en: s.title,
      title_he: s.titleHe,
      category_en: null,
      category_he: null,
      order_index: i,
    });
    const editionId = `${SRC}:${s.title}:${s.lang}:Open Siddur`;
    ctx.edition({ id: editionId, tocId: s.title, source: SRC, lang: s.lang, title: 'Open Siddur', info: s.info, orderIndex: 0 });

    const rows = s.parse(readFileSync(resolve(DIR, s.path), 'utf8'));
    for (const { ref, text } of rows) {
      if (!text) continue;
      ctx.content({ editionId, tocId: s.title, ref, text });
      total++;
    }
    ctx.meta({
      tocId: s.title,
      schema: {
        sectionNames: ['Section', 'Paragraph'],
        heSectionNames: s.lang === 'he' ? ['סימן', 'פסקה'] : null,
      },
    });
  });
  console.log(`  opensiddur: ${SIDDURIM.length} siddurim under Liturgy, ${total} rows`);
}

export const opensiddur: SourceAdapter = { id: SRC, name: 'Open Siddur', fetchSubset, ingest };
