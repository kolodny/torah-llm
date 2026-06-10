// Dicta Talmud Bavli (with nikud) — vocalized Vilna Talmud from
// github.com/Dicta-Israel-Center-for-Text-Analysis/Talmud-Bavli-with-Nikud (CC BY-SA; Dicta, Israel).
// Each tractate is one .txt with `*** דף N. ***` daf markers ('.'=amud a, ':'=amud b); each paragraph
// becomes a Daf:Line ref following Sefaria's Talmud addressing (e.g. Berakhot 2a:1). The data carries
// NO cross-references, so this source emits content only. Starter subset: Berakhot, Megillah.

import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { SourceAdapter, IngestCtx } from './types.ts';
import { githubRawBase } from './pins.ts';

const SRC = 'dicta-talmud';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/dicta-talmud');
const RAW = githubRawBase(SRC); // pinned to the SHA in sources.lock.json
const INFO = 'Babylonian Talmud vocalized by Dicta — the Israel Center for Text Analysis · CC BY-SA';

// Subset: canonical English title (= Sefaria node + repo dir) → Hebrew filename stem.
const TRACTATES: { title: string; he: string }[] = [
  { title: 'Berakhot', he: 'ברכות' },
  { title: 'Megillah', he: 'מגילה' },
];

const GEM: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
  י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90,
  ק: 100, ר: 200, ש: 300, ת: 400, ך: 20, ם: 40, ן: 50, ף: 80, ץ: 90,
};
const gematria = (s: string) => [...s].reduce((n, c) => n + (GEM[c] ?? 0), 0);

const stripNikud = (s: string) => s.replace(/[֑-ׇ]/g, '');
// A standalone Mishnah/Gemara marker line (structural; the passage follows) — skip it.
const isMarkerOnly = (s: string) => /^(מתני|מתניתין|גמ|גמרא)['׳]?$/.test(stripNikud(s).trim());

function parseTractate(txt: string): { ref: string; text: string }[] {
  const out: { ref: string; text: string }[] = [];
  let daf = '';
  let line = 0;
  for (const raw of txt.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    const m = t.match(/\*\*\*\s*דף\s+([^*]+?)\s*\*\*\*/);
    if (m) {
      const inner = m[1].trim();
      const amud = inner.slice(-1) === ':' ? 'b' : 'a';
      daf = `${gematria(inner.replace(/[.:]/g, ''))}${amud}`;
      line = 0;
      continue;
    }
    if (!daf || isMarkerOnly(t)) continue; // before the first daf, or a standalone מתני'/גמ' marker
    line++;
    out.push({ ref: `${daf}:${line}`, text: t });
  }
  return out;
}

async function fetchSubset() {
  let fetched = 0;
  for (const { title, he } of TRACTATES) {
    const rel = `${title}/${he}.combinedfullhaser.txt`;
    const dest = resolve(DIR, rel);
    if (existsSync(dest)) continue;
    const url = `${RAW}/${rel.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    fetched++;
  }
  console.log(`  dicta-talmud: fetched ${fetched} new file(s)`);
}

function ingest(ctx: IngestCtx) {
  let total = 0;
  for (const { title, he } of TRACTATES) {
    const editionId = `${SRC}:${title}:he:Dicta`;
    ctx.edition({ id: editionId, tocId: title, source: SRC, lang: 'he', title: 'Dicta (nikud)', info: INFO, orderIndex: 0 });
    const rel = `${title}/${he}.combinedfullhaser.txt`;
    for (const { ref, text } of parseTractate(readFileSync(resolve(DIR, rel), 'utf8'))) {
      ctx.content({ editionId, tocId: title, ref, text });
      total++;
    }
    ctx.meta({ tocId: title, schema: { sectionNames: ['Daf', 'Line'], heSectionNames: ['דף', 'שורה'] } });
  }
  console.log(`  dicta-talmud: ${TRACTATES.length} tractates, ${total} rows`);
}

export const dictaTalmud: SourceAdapter = { id: SRC, name: 'Dicta Talmud (nikud)', fetchSubset, ingest };
