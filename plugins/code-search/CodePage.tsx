// The Monaco SQL workbench component — lazy-loaded by index.tsx so Monaco isn't in the initial bundle.
import { useEffect, useMemo, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import type * as MonacoNs from 'monaco-editor';
// @ts-ignore
import * as monacoEsm from 'monaco-editor/esm/vs/editor/editor.api';
// @ts-ignore
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'; // SQL syntax only (avoids bundling every language)
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { Button, Group, Text, Code, ScrollArea, Table, Select, Anchor } from '@mantine/core';
import type { PluginContext } from '../../src/plugins/types';
import { useSlot } from '../../src/plugins/host';
import { CODE_PAGE_ID, type CellRenderer, type CodeSample } from './api';
import { HEBREW_CHAR_NAMES } from '../../shared/hebrew-chars';
import { decodeLink } from '../../shared/code-link';
import { decodeRender } from '../../shared/code-render';
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
    sql: `-- PAZER() returns the pazer mark; count it via length/replace. (Every Hebrew name works: ALEPH(), QAMATS(), …)
SELECT c.toc_id, c.ref,
       length(c.text) - length(replace(c.text, PAZER(), '')) AS pazer_count,
       substr(strip(c.text), 1, 50) AS preview
FROM content c JOIN editions e ON e.id = c.edition_id
WHERE c.toc_id = 'Genesis' AND e.source = 'sefaria' AND e.lang = 'he'
  AND length(c.text) - length(replace(c.text, PAZER(), '')) >= 2
ORDER BY pazer_count DESC
LIMIT 25;`,
  },
  {
    label: 'A word with two cantillation marks (Torah)',
    sql: `-- Words with two distinct DISJUNCTIVE te'amim — the famous double-cantillation cases: the Ten
-- Commandments' dual ta'am elyon/taḥton (Exodus 20, Deuteronomy 5) and the Reuben pisḳa (Genesis 35:22).
-- evalJS returns the first word that carries two distinct disjunctive accents — dropping the conjunctive
-- "servants" and counting zinor as zarqa, so servant+disjunctive / doubled / positional pairs don't count.
SELECT * FROM (
  SELECT c.toc_id, c.ref, evalJS('(function () {
    var CONJUNCTIVES = new Set([0x5A3, 0x5A4, 0x5A5, 0x5A6, 0x5A7, 0x5A8, 0x5A9, 0x5AA]);  // meshartim (servants)
    var words = value.replace(/&(?:[a-z0-9]+|#\\d+);/gi, " ")   // HTML spacing entities -> space
                     .split(/[\\s\\u05be\\u05c0]+/);            // split on space, maqaf, paseq
    return words.find(function (w) {
      var accents = new Set();
      for (var i = 0; i < w.length; i++) {
        var cp = w.charCodeAt(i);
        if (cp >= 0x591 && cp <= 0x5AE && !CONJUNCTIVES.has(cp)) accents.add(cp === 0x5AE ? 0x598 : cp);
      }
      return accents.size >= 2;
    }) || null;
  })()', strip(c.text)) AS word
  FROM content c JOIN editions e ON e.id = c.edition_id
  WHERE c.toc_id IN ('Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy') AND e.source = 'sefaria' AND e.lang = 'he'
)
WHERE word IS NOT NULL
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

function ResultsTable({ rows, ctx, renderers }: { rows: Record<string, unknown>[]; ctx: PluginContext; renderers: Map<string, CellRenderer> }) {
  const cols = Object.keys(rows[0]);
  const text = (v: unknown) => stripHtml(v).slice(0, 200);

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
      return r ? r.render(rnd.args) : <Text size="xs" c="dimmed">[no renderer for "{rnd.type}"]</Text>;
    }
    const explicit = decodeLink(v); // a cell built by the link() SQL function
    if (explicit) return linkTo(explicit.book, explicit.ref, explicit.label || explicit.ref || explicit.book);
    // Auto-link from the row's own columns — no function, no lookup: a `ref` cell links to its verse (book
    // read from toc_id/book in the SAME row); a `toc_id`/`book` cell opens that book.
    const book = row.toc_id ?? row.book;
    if (col === 'ref' && book != null && v != null) return linkTo(String(book), String(v), text(v));
    if ((col === 'toc_id' || col === 'book') && v != null) return linkTo(String(v), null, text(v));
    return <span dir="auto">{text(v)}</span>;
  };

  return (
    <ScrollArea mt="sm" mah={460} type="auto">
      <Table striped withTableBorder stickyHeader fz="xs">
        <Table.Thead>
          <Table.Tr>{cols.map((c) => <Table.Th key={c}>{c}</Table.Th>)}</Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.slice(0, 200).map((r, i) => (
            <Table.Tr key={i}>
              {cols.map((c) => (
                <Table.Td key={c} style={decodeRender(r[c]) ? undefined : { maxWidth: 380 }}>{renderCell(r, c)}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
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
