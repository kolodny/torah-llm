// Sefaria source adapter — FULL corpus.
//
// Walks Sefaria's table_of_contents.json (our canonical spine: books keyed by title, categories by
// path) and, for EVERY book, contributes its merged Hebrew + merged English editions. Refs are
// computed from each text's sectionNames, which covers Chapter:Verse, Talmud Daf:Line, Mishnah, and
// multi-level commentaries. Books whose text has no flat sectionNames (exotic nested schemas) yield
// no parseable refs and are skipped. Commentary→base links are derived from the TOC's
// base_text_titles; broader cross-corpus links come from the links CSV (see sefaria-links.ts).

import { resolve, dirname } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import type { SourceAdapter, IngestCtx, TocInsert } from './types.ts';
import { pins } from './pins.ts';

const SRC = 'sefaria';
const root = resolve(import.meta.dirname, '../../');
const DIR = resolve(root, 'data/sefaria');
const TOC_PATH = resolve(DIR, 'table_of_contents.json');
const JSON_DIR = resolve(DIR, 'json');
const BUCKET = pins.sefaria?.bucket ?? 'https://storage.googleapis.com/sefaria-export';
const MAX_BOOKS = Number(process.env.SEFARIA_MAX || Infinity); // cap for validation runs

const LANGS = [
  { dir: 'Hebrew', file: 'merged.json', lang: 'he', title: 'Hebrew (Sefaria)' },
  { dir: 'English', file: 'merged.json', lang: 'en', title: 'English (Sefaria)' },
];
// Curated extra editions kept beyond merged He+En, for the books that had them.
const TORAH = ['Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy'];
const EXTRAS: Record<string, { dir: string; file: string; lang: string; title: string }[]> = Object.fromEntries(
  TORAH.map((b) => [
    b,
    [
      { dir: 'English', file: 'The Holy Scriptures A New Translation JPS 1917.json', lang: 'en', title: 'JPS 1917' },
      { dir: 'English', file: 'Traduction française sous la direction du Grand-Rabbin Zadoc Kahn [fr].json', lang: 'fr', title: 'Français (Zadoc Kahn)' },
    ],
  ])
);
const editionsFor = (title: string) => [...LANGS, ...(EXTRAS[title] ?? [])];

type Book = { title: string; heTitle: string | null; gcsBase: string; base: string | null; parentId: string | null };

// Walk the TOC: emit every node via onNode, return every book with its GCS path + commentary base.
function walkToc(onNode?: (row: TocInsert) => void): Book[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toc = JSON.parse(readFileSync(TOC_PATH, 'utf8')) as any[];
  const books: Book[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visit = (node: any, catPath: string[], parentId: string | null) => {
    const title: string | undefined = node.title;
    const category: string | undefined = node.category;
    const id = title ?? (parentId ? `${parentId} / ${category}` : category);
    if (!id) return;
    onNode?.({
      id,
      parent_id: parentId,
      kind: node.contents ? 'category' : 'book',
      title_en: title ?? null,
      title_he: node.heTitle ?? null,
      category_en: category ?? null,
      category_he: node.heCategory ?? null,
      order_index: node.order ?? null,
    });
    if (node.contents) {
      const childPath = category ? [...catPath, category] : catPath;
      for (const child of node.contents) visit(child, childPath, id);
    } else if (title) {
      books.push({
        title,
        heTitle: node.heTitle ?? null,
        gcsBase: [...catPath, title].join('/'),
        base:
          node.dependence === 'Commentary' && Array.isArray(node.base_text_titles)
            ? node.base_text_titles[0] ?? null
            : null,
        parentId,
      });
    }
  };
  for (const top of toc) visit(top, [], null);
  return books;
}

const localPath = (gcsBase: string, dir: string, file: string) => resolve(JSON_DIR, gcsBase, dir, file);

async function pool<T>(items: T[], n: number, worker: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await worker(items[i++]);
    })
  );
}

async function fetchSubset() {
  if (!existsSync(TOC_PATH)) {
    const res = await fetch(`${BUCKET}/table_of_contents.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for table_of_contents.json`);
    mkdirSync(DIR, { recursive: true });
    writeFileSync(TOC_PATH, Buffer.from(await res.arrayBuffer()));
  }
  const books = walkToc().slice(0, MAX_BOOKS);
  const targets: { url: string; dest: string }[] = [];
  for (const b of books)
    for (const e of editionsFor(b.title)) {
      const dest = localPath(b.gcsBase, e.dir, e.file);
      if (existsSync(dest)) continue;
      const rel = `json/${b.gcsBase}/${e.dir}/${e.file}`;
      targets.push({ url: `${BUCKET}/${rel.split('/').map(encodeURIComponent).join('/')}`, dest });
    }
  let done = 0;
  let ok = 0;
  await pool(targets, 24, async ({ url, dest }) => {
    try {
      const res = await fetch(url);
      if (res.ok) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        ok++;
      }
    } catch {
      /* transient network error — skip; rerun is resumable (skip-existing) */
    }
    if (++done % 1000 === 0) console.log(`    sefaria fetch: ${done}/${targets.length} (${ok} ok)…`);
  });
  console.log(`  sefaria: fetched ${ok} merged file(s) for ${books.length} books`);
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

// Yield (tocId, ref, value) for a text. Simple texts → one book (`title`). Sefaria "complex texts"
// store `text` as an OBJECT keyed by node title; we split them into node-qualified sub-books that
// match Sefaria's addressing AND the links' titles: the default node ('') keeps the base title with
// flat numeric refs ("1:1:41" — exactly how links cite it); named nodes become "<title>, <node>"
// sub-books (e.g. "Abarbanel on Torah, Genesis"), each with its own numeric refs. Numbers 1-indexed.
// (Daf-addressed complex nodes would need the full index schema for "2a/2b"; numeric covers the
// Tanakh commentaries that make up the bulk of complex texts.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function* segments(title: string, json: any): Generator<{ tocId: string; ref: string; value: string }> {
  const complex = !!json.text && typeof json.text === 'object' && !Array.isArray(json.text);
  if (!complex) {
    const schema = { sectionNames: json.sectionNames };
    for (const { path, value } of flatten(json.text)) {
      if (value.trim()) {
        const ref = createRefPath(schema, path);
        if (ref) yield { tocId: title, ref, value };
      }
    }
    return;
  }
  for (const { path, value } of flatten(json.text)) {
    if (!value.trim()) continue;
    let i = 0;
    while (i < path.length && !/^\d+$/.test(path[i])) i++;
    const nodes = path.slice(0, i).filter((t) => t !== ''); // node-title keys (drop the default '')
    const ref = path
      .slice(i)
      .map((n) => String(+n + 1))
      .join(':');
    if (ref) yield { tocId: [title, ...nodes].join(', '), ref, value };
  }
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
  const books = walkToc((row) => ctx.toc(row)); // emit the full canonical spine
  const knownTitles = new Set(books.map((b) => b.title));
  const commentaryBase = new Map<string, string>(); // (sub)book id → its base book id
  for (const b of books) if (b.base) commentaryBase.set(b.title, b.base);

  const refsByBook = new Map<string, Set<string>>();
  let editionCount = 0;
  for (const b of books.slice(0, MAX_BOOKS)) {
    // Usually one canonical book (b.title); complex texts add node-qualified sub-books.
    const sub = new Map<string, { refs: Set<string>; sectionNames?: string[]; heSectionNames?: string[] }>();
    editionsFor(b.title).forEach((e, i) => {
      const file = localPath(b.gcsBase, e.dir, e.file);
      if (!existsSync(file)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let json: any;
      try {
        json = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return;
      }
      const byToc = new Map<string, { ref: string; value: string }[]>();
      for (const { tocId, ref, value } of segments(b.title, json))
        (byToc.get(tocId) ?? byToc.set(tocId, []).get(tocId)!).push({ ref, value });
      for (const [tocId, rows] of byToc) {
        const editionId = `${SRC}:${tocId}:${e.lang}:${e.title}`;
        ctx.edition({ id: editionId, tocId, source: SRC, lang: e.lang, title: e.title, info: editionInfo(json), orderIndex: i });
        editionCount++;
        const s = sub.get(tocId) ?? sub.set(tocId, { refs: new Set() }).get(tocId)!;
        for (const { ref, value } of rows) {
          ctx.content({ editionId, tocId, ref, text: value });
          s.refs.add(ref);
        }
        if (tocId === b.title) {
          s.sectionNames ??= json.sectionNames;
          s.heSectionNames ??= json.heSectionNames;
        }
      }
    });
    for (const [tocId, s] of sub) {
      if (!s.refs.size) continue;
      refsByBook.set(tocId, s.refs);
      if (tocId !== b.title) {
        // node-qualified sub-book (not in the TOC spine) — place it beside its parent book.
        ctx.toc({ id: tocId, parent_id: b.parentId, kind: 'book', title_en: tocId, title_he: null, category_en: null, category_he: null, order_index: null });
        const node = tocId.split(', ').pop()!; // base book = the last node segment, when it names a real book
        if (knownTitles.has(node)) commentaryBase.set(tocId, node);
      }
      ctx.meta({ tocId, schema: { sectionNames: s.sectionNames ?? null, heSectionNames: s.heSectionNames ?? null } });
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
  console.log(`  sefaria: ${editionCount} editions across ${refsByBook.size} books, ${links} commentary links`);
}

export const sefaria: SourceAdapter = { id: SRC, name: 'Sefaria', fetchSubset, ingest };
