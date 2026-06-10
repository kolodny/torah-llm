// Dicta Talmud Bavli (with nikud) — vocalized Vilna Talmud from
// github.com/Dicta-Israel-Center-for-Text-Analysis/Talmud-Bavli-with-Nikud (CC BY-SA; Dicta, Israel).
// FULL Shas: every tractate auto-discovered from the repo tree. Each is one ktiv-haser .txt with
// `*** דף N ***` markers ('.'=amud a, ':'=b) → Daf:Line refs matching Sefaria's Talmud addressing.
// No cross-references in the data, so content only.

import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import type { SourceAdapter, IngestCtx } from './types.ts';
import { githubRawBase, pins } from './pins.ts';

const SRC = 'dicta-talmud';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/dicta-talmud');
const RAW = githubRawBase(SRC); // pinned to the SHA in sources.lock.json
const INFO = 'Babylonian Talmud vocalized by Dicta — the Israel Center for Text Analysis · CC BY-SA';

// Repo dir → canonical Sefaria title where the repo's transliteration differs (verified vs the TOC).
const OVERRIDE: Record<string, string> = {
  Avoda_Zara: 'Avodah Zarah',
  Hullin: 'Chullin',
  Karetot: 'Keritot',
  Menahot: 'Menachot',
  Sota: 'Sotah',
  Temura: 'Temurah',
  Zevahim: 'Zevachim',
};
const titleOf = (dir: string) => OVERRIDE[dir] ?? dir.replace(/_/g, ' ');

const GEM: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
  י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90,
  ק: 100, ר: 200, ש: 300, ת: 400, ך: 20, ם: 40, ן: 50, ף: 80, ץ: 90,
};
const gematria = (s: string) => [...s].reduce((n, c) => n + (GEM[c] ?? 0), 0);
const stripNikud = (s: string) => s.replace(/[֑-ׇ]/g, '');
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
    if (!daf || isMarkerOnly(t)) continue;
    line++;
    out.push({ ref: `${daf}:${line}`, text: t });
  }
  return out;
}

async function pool<T>(items: T[], n: number, worker: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await worker(items[i++]); }));
}

async function fetchSubset() {
  const repo = pins[SRC]?.repo;
  const ref = pins[SRC]?.ref;
  const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`, {
    headers: { 'User-Agent': 'torah-llm/0.1' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} listing Talmud tree`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tree = (await res.json()) as { tree: { path: string }[] };
  const paths = tree.tree
    .map((t) => t.path)
    .filter((p) => p.endsWith('combinedfullhaser.txt') && p.split('/')[0] !== 'Meila'); // drop the Meila/Meilah dup
  let fetched = 0;
  await pool(paths, 12, async (p) => {
    const dest = resolve(DIR, p);
    if (existsSync(dest)) return;
    const r = await fetch(`${RAW}/${p.split('/').map(encodeURIComponent).join('/')}`);
    if (!r.ok) return;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    fetched++;
  });
  console.log(`  dicta-talmud: fetched ${fetched} tractate file(s)`);
}

function ingest(ctx: IngestCtx) {
  if (!existsSync(DIR)) return;
  const files = (readdirSync(DIR, { recursive: true }) as string[]).filter((f) => String(f).endsWith('combinedfullhaser.txt'));
  let n = 0;
  let total = 0;
  for (const rel of files) {
    const dir = String(rel).split('/')[0];
    if (dir === 'Meila') continue;
    const title = titleOf(dir);
    const editionId = `${SRC}:${title}:he:Dicta`;
    ctx.edition({ id: editionId, tocId: title, source: SRC, lang: 'he', title: 'Dicta (nikud)', info: INFO, orderIndex: 0 });
    for (const { ref, text } of parseTractate(readFileSync(resolve(DIR, String(rel)), 'utf8'))) {
      ctx.content({ editionId, tocId: title, ref, text });
      total++;
    }
    ctx.meta({ tocId: title, schema: { sectionNames: ['Daf', 'Line'], heSectionNames: ['דף', 'שורה'] } });
    n++;
  }
  console.log(`  dicta-talmud: ${n} tractates, ${total} rows`);
}

export const dictaTalmud: SourceAdapter = { id: SRC, name: 'Dicta Talmud (nikud)', fetchSubset, ingest };
