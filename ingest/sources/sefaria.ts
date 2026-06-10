// Sefaria source adapter.
//
// Builds the CANONICAL catalog (the Sefaria TOC is our spine: books keyed by title, categories
// by path — no source prefix) and contributes multiple EDITIONS per book: several languages /
// versions (Hebrew, English JPS 1917, a French translation, …). Other sources attach their own
// editions to these same canonical book ids. Also derives commentary→base links between books.

import { resolve, dirname } from 'node:path';
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  type Dirent,
} from 'node:fs';
import type { SourceAdapter, IngestCtx } from './types.ts';
import { pins } from './pins.ts';

const SRC = 'sefaria';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/sefaria');
const TOC_PATH = resolve(DIR, 'table_of_contents.json');
const SCHEMAS_DIR = resolve(DIR, 'schemas');
const JSON_DIR = resolve(DIR, 'json');

const BUCKET = pins.sefaria?.bucket ?? 'https://storage.googleapis.com/sefaria-export';
const TORAH = 'Tanakh/Torah';
const RASHI = 'Tanakh/Rishonim on Tanakh/Rashi/Torah';
const BOOKS = ['Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy'];

// An edition to fetch: GCS language folder + version filename, and how we label it.
type Ed = { dir: string; file: string; lang: string; title: string };

// Curated editions for the Torah base books — several languages/versions to show Sefaria's range.
const TORAH_EDITIONS: Ed[] = [
  { dir: 'Hebrew', file: 'merged.json', lang: 'he', title: 'Hebrew (Sefaria)' },
  { dir: 'English', file: 'merged.json', lang: 'en', title: 'English (Sefaria)' },
  { dir: 'English', file: 'The Holy Scriptures A New Translation JPS 1917.json', lang: 'en', title: 'JPS 1917' },
  {
    dir: 'English',
    file: 'Traduction française sous la direction du Grand-Rabbin Zadoc Kahn [fr].json',
    lang: 'fr',
    title: 'Français (Zadoc Kahn)',
  },
];
// Commentary (Rashi): just the merged Hebrew + English.
const MERGED_EDITIONS: Ed[] = [
  { dir: 'Hebrew', file: 'merged.json', lang: 'he', title: 'Hebrew (Sefaria)' },
  { dir: 'English', file: 'merged.json', lang: 'en', title: 'English (Sefaria)' },
];

type Spec = { title: string; gcsBase: string; editions: Ed[] };
const SPECS: Spec[] = [
  ...BOOKS.map((b) => ({ title: b, gcsBase: `${TORAH}/${b}`, editions: TORAH_EDITIONS })),
  ...BOOKS.map((b) => ({ title: `Rashi on ${b}`, gcsBase: `${RASHI}/Rashi on ${b}`, editions: MERGED_EDITIONS })),
];

const localJsonPath = (gcsBase: string, e: Ed) => resolve(JSON_DIR, gcsBase, e.dir, e.file);

async function fetchSubset() {
  const want: { rel: string; optional: boolean }[] = [{ rel: 'table_of_contents.json', optional: false }];
  for (const b of BOOKS) want.push({ rel: `schemas/${b}.json`, optional: false });
  for (const s of SPECS) for (const e of s.editions) {
    want.push({ rel: `json/${s.gcsBase}/${e.dir}/${e.file}`, optional: true });
  }

  let fetched = 0;
  let unavailable = 0;
  for (const { rel, optional } of want) {
    const dest = resolve(DIR, rel);
    if (existsSync(dest)) continue;
    const url = `${BUCKET}/${rel.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (optional) {
        unavailable++;
        continue;
      }
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    fetched++;
  }
  console.log(`  sefaria: fetched ${fetched} file(s)${unavailable ? `, ${unavailable} edition(s) unavailable` : ''}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadSchemas(): Map<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = new Map<string, any>();
  let names: string[] = [];
  try {
    names = readdirSync(SCHEMAS_DIR);
  } catch {
    return map;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const json = JSON.parse(readFileSync(resolve(SCHEMAS_DIR, name), 'utf8'));
      if (json?.title) map.set(String(json.title).toLowerCase(), json);
    } catch {
      /* skip */
    }
  }
  return map;
}

function format(n: number, sectionName?: string): string {
  if (sectionName === 'Daf') {
    const offset = Math.floor((n - 2) / 2);
    return `${2 + offset}${n % 2 === 0 ? 'a' : 'b'}`;
  }
  return `${n + 1}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createRefPath(schema: any, path: string[]): string {
  if (!schema) return '';
  const { sectionNames, index_offsets_by_depth, nodes } = schema;
  const p = [...path];
  if (index_offsets_by_depth) {
    for (let i = 0; i < p.length; i++) {
      const offset = index_offsets_by_depth[i + 1];
      if (offset) p[i] = `${+p[i] + 1 + (offset[p[i - 1]] ?? 0)}`;
    }
    if (sectionNames) return p.join(':');
  }
  if (sectionNames) return p.map((num, i) => format(+num, sectionNames[i])).join(':');
  if (nodes) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node = nodes.find((nd: any) => p[0] === nd.title);
    if (!node) return '';
    const rest = createRefPath(node, p.slice(1));
    const comma = /^\d/.test(rest) ? '' : ',';
    return node.title ? `${node.title}${comma} ${rest}` : rest;
  }
  return '';
}

function* flatten(section: unknown, path: string[] = []): Generator<{ path: string[]; value: string }> {
  if (Array.isArray(section)) {
    for (let i = 0; i < section.length; i++) yield* flatten(section[i], [...path, String(i)]);
  } else if (section && typeof section === 'object') {
    for (const [k, v] of Object.entries(section)) yield* flatten(v, [...path, k]);
  } else if (typeof section === 'string') {
    yield { path, value: section };
  }
}

function sortLink(id1: string, ref1: string, id2: string, ref2: string): [string, string, string, string] {
  if (id1 < id2 || (id1 === id2 && ref1 <= ref2)) return [id1, ref1, id2, ref2];
  return [id2, ref2, id1, ref1];
}

// Provenance for an edition's hover tooltip, from the Sefaria version metadata.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function editionInfo(json: any): string | null {
  const parts: string[] = [];
  const vt = json?.versionTitle;
  if (vt && vt !== 'merged') parts.push(String(vt));
  else if (Array.isArray(json?.versions) && json.versions.length) {
    const n = json.versions.length;
    parts.push(`Merged from ${n} version${n === 1 ? '' : 's'}`);
  }
  if (json?.versionSource) parts.push(String(json.versionSource));
  const lic = json?.license;
  if (lic && !/^unknown$/i.test(String(lic))) parts.push(String(lic));
  return parts.length ? parts.join(' · ') : null;
}

function ingest(ctx: IngestCtx) {
  // Canonical TOC spine (ids are titles / category paths, no source prefix).
  const commentaryBase = new Map<string, string>(); // commentary title -> base title
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toc = JSON.parse(readFileSync(TOC_PATH, 'utf8')) as any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any, parentId: string | null) => {
    const title: string | undefined = node.title;
    const category: string | undefined = node.category;
    const id = title ?? (parentId ? `${parentId} / ${category}` : category);
    if (!id) return;
    ctx.toc({
      id,
      parent_id: parentId,
      kind: node.contents ? 'category' : 'book',
      title_en: title ?? null,
      title_he: node.heTitle ?? null,
      category_en: category ?? null,
      category_he: node.heCategory ?? null,
      order_index: node.order ?? null,
    });
    if (node.dependence === 'Commentary' && Array.isArray(node.base_text_titles) && node.base_text_titles[0]) {
      commentaryBase.set(id, node.base_text_titles[0]);
    }
    if (node.contents) for (const child of node.contents) walk(child, id);
  };
  for (const top of toc) walk(top, null);

  // Editions + content.
  const schemas = loadSchemas();
  const refsByBook = new Map<string, Set<string>>();
  let editionCount = 0;
  for (const spec of SPECS) {
    const schemaTop = schemas.get(spec.title.toLowerCase());
    let sectionNames: string[] | undefined = schemaTop?.schema?.sectionNames;
    let heSectionNames: string[] | undefined = schemaTop?.schema?.heSectionNames;
    const refs = refsByBook.get(spec.title) ?? new Set<string>();

    spec.editions.forEach((e, i) => {
      const path = localJsonPath(spec.gcsBase, e);
      if (!existsSync(path)) return;
      const json = JSON.parse(readFileSync(path, 'utf8'));
      const schema = schemaTop?.schema ?? { sectionNames: json.sectionNames };
      sectionNames ??= json.sectionNames;
      const editionId = `${SRC}:${spec.title}:${e.lang}:${e.title}`;
      ctx.edition({ id: editionId, tocId: spec.title, source: SRC, lang: e.lang, title: e.title, info: editionInfo(json), orderIndex: i });
      editionCount++;
      for (const { path: p, value } of flatten(json.text)) {
        if (!value.trim()) continue;
        const ref = createRefPath(schema, p);
        if (!ref) continue;
        ctx.content({ editionId, tocId: spec.title, ref, text: value });
        refs.add(ref);
      }
    });

    if (refs.size) {
      refsByBook.set(spec.title, refs);
      ctx.meta({ tocId: spec.title, schema: { sectionNames: sectionNames ?? null, heSectionNames: heSectionNames ?? null } });
    }
  }

  // Commentary → base links (comment ref a:b:c → base verse a:b), between canonical books.
  let links = 0;
  for (const [commentary, base] of commentaryBase) {
    const cRefs = refsByBook.get(commentary);
    const bRefs = refsByBook.get(base);
    if (!cRefs?.size || !bRefs?.size) continue;
    for (const ref of cRefs) {
      const parts = ref.split(':');
      if (parts.length < 2) continue;
      const baseRef = parts.slice(0, -1).join(':');
      if (!bRefs.has(baseRef)) continue;
      const [fid, fref, tid, tref] = sortLink(base, baseRef, commentary, ref);
      ctx.link({ fromId: fid, fromRef: fref, toId: tid, toRef: tref, connectionType: 'commentary' });
      links++;
    }
  }
  console.log(`  sefaria: ${editionCount} editions across ${refsByBook.size} books, ${links} links`);
}

export const sefaria: SourceAdapter = { id: SRC, name: 'Sefaria', fetchSubset, ingest };
