// Open Scriptures Hebrew Bible (WLC) adapter — contributes a Hebrew "WLC" edition to canonical
// books (by title). Parses OSIS XML from github.com/openscriptures/morphhb (WLC: Public Domain).

import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { SourceAdapter, IngestCtx } from './types.ts';

const SRC = 'oshb';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/oshb');
const RAW = 'https://raw.githubusercontent.com/openscriptures/morphhb/master/wlc';

const BOOKS = [
  { file: 'Gen.xml', title: 'Genesis' },
  { file: 'Jonah.xml', title: 'Jonah' },
  { file: 'Ruth.xml', title: 'Ruth' },
];

async function fetchSubset() {
  let fetched = 0;
  for (const { file } of BOOKS) {
    const dest = resolve(DIR, 'wlc', file);
    if (existsSync(dest)) continue;
    const res = await fetch(`${RAW}/${file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${file}`);
    mkdirSync(resolve(DIR, 'wlc'), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    fetched++;
  }
  console.log(`  oshb: fetched ${fetched} new file(s)`);
}

// Reconstruct a verse's Hebrew text from OSIS <w> words + <seg> punctuation ('/' separates
// morphology pieces; maqqef joins with no space; sof-pasuq ends the verse).
function verseText(inner: string): string {
  const tokens = /<w\b[^>]*>([\s\S]*?)<\/w>|<seg\b([^>]*)>([\s\S]*?)<\/seg>/g;
  let m: RegExpExecArray | null;
  let out = '';
  while ((m = tokens.exec(inner))) {
    if (m[1] !== undefined) {
      const word = m[1].replace(/\//g, '').trim();
      if (!word) continue;
      out += out && !out.endsWith('־') ? ` ${word}` : word;
    } else {
      const type = m[2] ?? '';
      if (type.includes('x-maqqef')) out += '־';
      else if (type.includes('sof-pasuq')) out += '׃';
    }
  }
  return out.trim();
}

function ingest(ctx: IngestCtx) {
  let total = 0;
  for (const { file, title } of BOOKS) {
    const editionId = `${SRC}:${title}:he:WLC`;
    ctx.edition({ id: editionId, tocId: title, source: SRC, lang: 'he', title: 'WLC', orderIndex: 0 });

    const xml = readFileSync(resolve(DIR, 'wlc', file), 'utf8');
    const verses = /<verse osisID="([^"]+)">([\s\S]*?)<\/verse>/g;
    let v: RegExpExecArray | null;
    while ((v = verses.exec(xml))) {
      const parts = v[1].split('.'); // ['Gen','1','1']
      if (parts.length < 3) continue;
      const text = verseText(v[2]);
      if (!text) continue;
      ctx.content({ editionId, tocId: title, ref: `${parts[1]}:${parts[2]}`, text });
      total++;
    }
    ctx.meta({ tocId: title, schema: { sectionNames: ['Chapter', 'Verse'], heSectionNames: ['פרק', 'פסוק'] } });
  }
  console.log(`  oshb: ${BOOKS.length} editions, ${total} verses`);
}

export const oshb: SourceAdapter = { id: SRC, name: 'Open Scriptures (WLC)', fetchSubset, ingest };
