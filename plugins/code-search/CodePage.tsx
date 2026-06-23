// The Monaco SQL workbench component — lazy-loaded by index.tsx so Monaco isn't in the initial bundle.
import { useEffect, useMemo, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import type * as MonacoNs from 'monaco-editor';
// @ts-ignore
import * as monacoEsm from 'monaco-editor/esm/vs/editor/editor.api';
// @ts-ignore
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'; // SQL syntax only (avoids bundling every language)
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { Button, Group, Text, Code, ScrollArea, Table, Select, Anchor, Pagination } from '@mantine/core';
import type { PluginContext } from '../../src/plugins/types';
import { useSlot } from '../../src/plugins/host';
import { CODE_PAGE_ID, type CellRenderer, type CodeSample } from './api';
import { HEBREW_CHAR_NAMES } from '../../shared/hebrew-chars';
import { decodeLink, LINK_TAG } from '../../shared/code-link';
import { decodeRender, RENDER_TAG } from '../../shared/code-render';
import { stripHtml } from '../../shared/strip';

const monaco = monacoEsm as typeof MonacoNs;

// Use the bundled Monaco (no CDN) + only the base editor worker (SQL needs no language worker).
(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

// Schema for autocomplete; filled per session, read live by the (once-registered) completion provider.
let schemaCache: Record<string, string[]> = {};
let providerRegistered = false;
function registerSqlCompletion() {
  if (providerRegistered) return;
  providerRegistered = true;
  const K = monaco.languages.CompletionItemKind;
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: [' ', '.', '(', ','],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const suggestions: MonacoNs.languages.CompletionItem[] = [];
      for (const [table, cols] of Object.entries(schemaCache)) {
        suggestions.push({ label: table, kind: K.Struct, insertText: table, detail: 'table', range });
        for (const c of cols) suggestions.push({ label: `${table}.${c}`, kind: K.Field, insertText: c, detail: `${table} column`, range });
      }
      for (const kw of ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'LIMIT', 'DISTINCT', 'LIKE', 'AND', 'OR', 'AS', 'COUNT', 'substr'])
        suggestions.push({ label: kw, kind: K.Keyword, insertText: kw, range });
      const snippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      suggestions.push({ label: 'strip', kind: K.Function, insertText: 'strip(${1:text})', insertTextRules: snippet, detail: 'remove HTML tags', range });
      suggestions.push({ label: 'link', kind: K.Function, insertText: 'link(${1:book}, ${2:ref})', insertTextRules: snippet, detail: 'explicit viewer link (book, ref) — or just select toc_id + ref to auto-link', range });
      suggestions.push({ label: 'evalJS', kind: K.Function, insertText: "evalJS('${1:value.length > 80}', ${2:text})", insertTextRules: snippet, detail: 'run a JS expression (value, args, strip, H)', range });
      for (const name of HEBREW_CHAR_NAMES)
        suggestions.push({ label: `${name}()`, kind: K.Function, insertText: `${name}()`, detail: 'Hebrew character', range });
      return { suggestions };
    },
  });
}

// Curated starting points — all core SQLite + built-ins (strip/link/evalJS/PAZER()). Plugins contribute
// their own samples via the Code page API; they're merged into the dropdown below.
const SAMPLES: { label: string; sql: string }[] = [
  {
    label: 'Browse a book (verses auto-link)',
    sql: `-- Select toc_id + ref and the results table auto-links each verse to the viewer (click a ref or book).
SELECT c.toc_id, c.ref, substr(strip(c.text), 1, 60) AS preview
FROM content c JOIN editions e ON e.id = c.edition_id
WHERE c.toc_id = 'Genesis' AND e.source = 'sefaria' AND e.lang = 'he' AND c.ref LIKE '1:%'
LIMIT 25;`,
  },
  {
    label: 'Verses with two or more pazer cantillations',
    sql: `-- Pazer is a rare disjunctive accent. PAZER() returns its mark; count occurrences the SQLite way, with
-- length(text) - length(replace(text, mark, '')). (Every Hebrew name is a function: ALEPH(), QAMATS(), …)
SELECT c.toc_id, c.ref,
       length(c.text) - length(replace(c.text, PAZER(), '')) AS pazer_count,
       substr(strip(c.text), 1, 50) AS preview
FROM content c JOIN editions e ON e.id = c.edition_id
WHERE c.toc_id IN ('Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy') AND e.source = 'sefaria' AND e.lang = 'he'
  AND length(c.text) - length(replace(c.text, PAZER(), '')) >= 2
ORDER BY pazer_count DESC
LIMIT 25;`,
  },
  {
    label: 'A word with two cantillation marks (Torah)',
    sql: `-- The famous "double-cantillation" words: a single letter carrying two ta'am (accent) marks at once.
-- All ta'amim live in one Unicode block (U+0591–U+05AE), so the whole test is "two of them in a row".
-- This surfaces the Ten Commandments' dual ta'am elyon/taḥton (Exodus 20, Deuteronomy 5) plus the two
-- narrative oddities — the Reuben pisḳa (Genesis 35:22) and Noaḥ's naming (Genesis 5:29). SQLite has no
-- regex, so evalJS lends us JS's; we also pull out the marked word for display.
SELECT c.toc_id, c.ref,
       evalJS('value.split(/\\s+/).find(w => /[\\u0591-\\u05AE]{2}/.test(w))', strip(c.text)) AS word
FROM content c JOIN editions e ON e.id = c.edition_id
WHERE c.toc_id IN ('Genesis', 'Exodus', 'Deuteronomy') AND e.source = 'sefaria' AND e.lang = 'he'
  AND evalJS('/[\\u0591-\\u05AE]{2}/.test(value)', c.text)
ORDER BY c.toc_id, c.ref;`,
  },
  {
    label: 'The most-referenced verses (cross-reference graph)',
    sql: `-- The verses the tradition refers to most — ranked by how many cross-references (commentary, targum,
-- midrash, quotation…) touch them. Genesis 1:1 leads by far. Counts reflect the books you've DOWNLOADED.
-- The links table is stored undirected, so we count a verse on BOTH endpoints. Click a ref to open it.
WITH ep AS (
  SELECT from_id AS book, from_ref AS ref FROM links
  UNION ALL
  SELECT to_id, to_ref FROM links
)
SELECT book AS toc_id, ref, count(*) AS link_count
FROM ep
WHERE book IN ('Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy')
GROUP BY book, ref
ORDER BY link_count DESC
LIMIT 50;`,
  },
  {
    label: 'The Torah’s most-repeated verses (word-for-word)',
    sql: `-- Verses that recur identically. וַיְדַבֵּר יְהֹוָה אֶל מֹשֶׁה לֵּאמֹר appears ~69 times; in Numbers 7 each line of
-- the twelve princes' offering repeats 12× (one per tribe — why the Torah spells out all twelve identically is
-- a classic question of the meforshim). Grouping on the exact text — nikud + te'amim must match too.
SELECT count(*) AS times, substr(strip(min(c.text)), 1, 55) AS verse
FROM content c JOIN editions e ON e.id = c.edition_id
WHERE c.toc_id IN ('Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy') AND e.source = 'sefaria' AND e.lang = 'he'
GROUP BY strip(c.text)
HAVING times >= 3
ORDER BY times DESC
LIMIT 50;`,
  },
  {
    label: 'Genesis 1:1 — seven words and twenty-eight letters',
    sql: `-- Chazal note the Torah opens with SEVEN words and TWENTY-EIGHT letters (28 = כֹּחַ, "strength"). evalJS runs a
-- JS expression per row — \`value\` is the cell and strip() removes HTML — and JS regex makes both counts a
-- one-liner (SQLite has no regex): \\s+ splits words; [\\u05D0-\\u05EA] is the Hebrew-letter range (no vowels/te'amim).
SELECT evalJS('strip(value).trim().split(/\\s+/).length', c.text) AS words,
       evalJS('(strip(value).match(/[\\u05D0-\\u05EA]/g) || []).length', c.text) AS letters
FROM content c JOIN editions e ON e.id = c.edition_id
WHERE c.toc_id = 'Genesis' AND c.ref = '1:1' AND e.source = 'sefaria' AND e.lang = 'he';`,
  },
  {
    label: 'The longest chapters (by verse count)',
    sql: `-- Trivia: Numbers 7 (Naso — the twelve princes' offerings) is the longest chapter in the Torah at 89 verses.
-- ref is "chapter:verse", so take the part before the ':' as the chapter and count the distinct verses.
SELECT c.toc_id,
       CAST(substr(c.ref, 1, instr(c.ref, ':') - 1) AS INTEGER) AS chapter,
       count(DISTINCT c.ref) AS verses
FROM content c JOIN editions e ON e.id = c.edition_id
WHERE c.toc_id IN ('Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy') AND e.source = 'sefaria' AND e.lang = 'he' AND instr(c.ref, ':') > 0
GROUP BY c.toc_id, chapter
ORDER BY verses DESC
LIMIT 25;`,
  },
  {
    label: 'Largest downloaded books (by verse count)',
    sql: `-- Which downloaded books have the most segments?
SELECT toc_id, COUNT(DISTINCT ref) AS verses
FROM content
GROUP BY toc_id
ORDER BY verses DESC
LIMIT 25;`,
  },
];

const PAGE_SIZE = 25;
function ResultsTable({ rows, ctx, renderers }: { rows: Record<string, unknown>[]; ctx: PluginContext; renderers: Map<string, CellRenderer> }) {
  const cols = Object.keys(rows[0]);
  const text = (v: unknown) => stripHtml(v).slice(0, 200);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [rows]); // a fresh query → back to page 1
  const pageCount = Math.ceil(rows.length / PAGE_SIZE);
  const start = (Math.min(page, pageCount) - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  // A clickable link into the viewer. The href is real (URL shows in the status bar; cmd/ctrl/shift/middle
  // click opens a new tab); a plain left-click navigates in-app instead.
  const linkTo = (book: string, ref: string | null, label: string) => {
    const href = `?page=viewer&book=${encodeURIComponent(book)}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`;
    return (
      <Anchor
        href={href}
        dir="auto"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          ctx.ui.navigate(book, ref);
        }}
      >
        {label.slice(0, 120)}
      </Anchor>
    );
  };

  const renderCell = (row: Record<string, unknown>, col: string) => {
    const v = row[col];
    const rnd = decodeRender(v); // a cell built by the render() SQL function → a plugin cellRenderer
    if (rnd) {
      const r = renderers.get(rnd.type);
      if (!r) return <Text size="xs" c="dimmed">[no renderer for "{rnd.type}"]</Text>;
      // A throwing renderer must blank only this cell, not the whole table.
      try {
        return r.render(rnd.args);
      } catch (e) {
        return <Text size="xs" c="red">[renderer "{rnd.type}" error: {String(e)}]</Text>;
      }
    }
    const explicit = decodeLink(v); // a cell built by the link() SQL function
    if (explicit) return linkTo(explicit.book, explicit.ref, explicit.label || explicit.ref || explicit.book);
    // Auto-link from the row's own columns — no function, no lookup: a `ref` cell links to its verse (book
    // read from toc_id/book in the SAME row); a `toc_id`/`book` cell opens that book. Skip values that are
    // really encoded link/render markers — those aren't plain book ids and would make a broken link.
    const plainStr = (x: unknown): x is string => typeof x === 'string' && !x.startsWith(LINK_TAG) && !x.startsWith(RENDER_TAG);
    const book = row.toc_id ?? row.book;
    if (col === 'ref' && plainStr(book) && plainStr(v)) return linkTo(book, v, text(v));
    if ((col === 'toc_id' || col === 'book') && plainStr(v)) return linkTo(v, null, text(v));
    return <span dir="auto">{text(v)}</span>;
  };

  return (
    <>
      {pageCount > 1 && (
        <Group justify="space-between" mt="sm" mb={4}>
          <Text size="xs" c="dimmed">
            rows {start + 1}–{start + pageRows.length} of {rows.length}
          </Text>
          <Pagination size="xs" total={pageCount} value={Math.min(page, pageCount)} onChange={setPage} withEdges />
        </Group>
      )}
      <ScrollArea mt={pageCount > 1 ? 0 : 'sm'} mah={600} type="auto">
        <Table striped withTableBorder stickyHeader fz="xs">
          <Table.Thead>
            <Table.Tr>{cols.map((c) => <Table.Th key={c}>{c}</Table.Th>)}</Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {pageRows.map((r, i) => (
              <Table.Tr key={start + i}>
                {cols.map((c) => (
                  <Table.Td key={c} style={decodeRender(r[c]) ? undefined : { maxWidth: 380 }}>{renderCell(r, c)}</Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </>
  );
}

export default function CodePage({ ctx }: { ctx: PluginContext }) {
  const [sql, setSql] = useState(SAMPLES[0].sql);
  const [sample, setSample] = useState('0');
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [ms, setMs] = useState(0);
  const cellRenderers = useSlot<CellRenderer>(CODE_PAGE_ID, 'cellRenderer');
  const renderers = useMemo(() => new Map(cellRenderers.map((r) => [r.id, r] as const)), [cellRenderers]);
  const pluginSamples = useSlot<CodeSample>(CODE_PAGE_ID, 'sample');
  const allSamples = useMemo(() => [...SAMPLES, ...pluginSamples], [pluginSamples]);

  useEffect(() => {
    ctx.data.schema().then((s) => { schemaCache = s; }).catch(() => {});
  }, [ctx]);

  const run = async () => {
    setBusy(true);
    setErr('');
    const t = performance.now();
    try {
      const r = await ctx.data.query(sql);
      setRows(r);
      setMs(Math.round(performance.now() - t));
    } catch (e) {
      setErr(String(e));
      setRows(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plugin-page" style={{ maxWidth: 'none' }}>
      <h2>Code · SQLite</h2>
      <Text size="sm" c="dimmed" mb="xs">
        Query your downloaded books directly (read-only). Autocomplete knows the schema. Built-ins: <Code>strip(text)</Code> (removes HTML); Hebrew chars as functions (<Code>PAZER()</Code>, <Code>ALEPH()</Code>, …); select <Code>toc_id</Code> + <Code>ref</Code> to auto-link verses (or <Code>link(book, ref [, label])</Code>); <Code>evalJS(expr, ...vals)</Code> runs JS (<Code>value</Code>, <Code>args</Code>, <Code>strip()</Code>, <Code>H</Code> in scope). Plugins add functions, renderers, and samples.
      </Text>
      <Select
        label="Sample queries"
        size="xs"
        mb="sm"
        maw={460}
        allowDeselect={false}
        data={allSamples.map((s, i) => ({ value: String(i), label: s.label }))}
        value={sample}
        onChange={(v) => {
          if (v == null) return;
          setSample(v);
          setSql(allSamples[Number(v)].sql);
          setRows(null);
          setErr('');
        }}
      />
      <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
        <Editor height={260} language="sql" theme="vs" value={sql} onChange={(v) => setSql(v ?? '')} onMount={registerSqlCompletion} options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, wordWrap: 'on' }} />
      </div>
      <Group mt="sm">
        <Button color="orange" onClick={run} loading={busy}>Run</Button>
        {rows && !err && <Text size="sm" c="dimmed">{rows.length} row{rows.length === 1 ? '' : 's'} · {ms} ms</Text>}
      </Group>
      {err && <Text c="red" mt="sm" style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{err}</Text>}
      {rows && rows.length > 0 && <ResultsTable rows={rows} ctx={ctx} renderers={renderers} />}
      {rows && rows.length === 0 && !err && <Text c="dimmed" mt="sm">No rows. (Download books in the Storage tab if a table is empty.)</Text>}
    </div>
  );
}
