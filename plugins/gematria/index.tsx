// Gematria — numeric value of Hebrew text. On the new page platform it contributes:
//   • viewer:onTextSelect — a tooltip showing the gematria of any selected Hebrew text
//   • viewer:verseAction  — a verse's total value (⋯ menu)
//   • viewer:decoration   — highlight every word matching a searched value
//   • a "Gematria" page    — pick any books (nested tree) and search them by value (words or whole verses)
//   • the Code page's SQL gematria(text) function + gematria sample queries
import { useEffect, useState, type FormEvent } from 'react';
import { TextInput, SegmentedControl, Button, Group, Stack, Text, Anchor, ScrollArea, Badge } from '@mantine/core';
import { definePlugin, type PluginContext, type Decoration, type Verse, type Segment, type TextSelection } from '../../src/plugins/types';
import type { TocRow } from '../../src/db/types';
import { BookCheckTree } from '../../src/components/BookTree';
import { codePageApi } from '../code-search/api';

const VALUE: Record<string, number> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9,
  י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90,
  ק: 100, ר: 200, ש: 300, ת: 400, ך: 20, ם: 40, ן: 50, ף: 80, ץ: 90,
};
const gematria = (s: string) => [...s.replace(/[^א-ת]/g, '')].reduce((n, c) => n + (VALUE[c] ?? 0), 0);
const RTL = /^(he|arc|yi)/;
const strip = (html: string) => html.replace(/<[^>]+>/g, '');
// The same gematria math as a pure body string, so the Code page's SQL gematria(text) matches this tooltip's.
const GEMATRIA_BODY = `var GV=${JSON.stringify(VALUE)}; var t=String(text), n=0; for (var i=0;i<t.length;i++) n+=GV[t[i]]||0; return n;`;
let highlightValue: number | null = null;

function GematriaSearchPage({ ctx }: { ctx: PluginContext }) {
  const [toc, setToc] = useState<TocRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [value, setValue] = useState('');
  const [mode, setMode] = useState('word');
  const [hits, setHits] = useState<{ book: string; ref: string; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState(false);
  const [highlighting, setHighlighting] = useState(false);
  const [localBooks, setLocalBooks] = useState<Set<string>>(new Set());

  useEffect(() => {
    ctx.data.getToc().then(setToc).catch(() => {});
    // only downloaded books have content to search — flag them in the tree.
    ctx.data.query('SELECT DISTINCT toc_id AS id FROM content').then((r) => setLocalBooks(new Set(r.map((x) => x.id as string)))).catch(() => {});
  }, [ctx]);

  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = parseInt(value, 10);
    const books = [...selected];
    if (!books.length || !Number.isFinite(n)) return;
    setBusy(true);
    const ph = books.map(() => '?').join(',');
    const rows = (await ctx.data.query(
      `SELECT c.toc_id AS book, c.ref AS ref, c.text AS text FROM content c JOIN editions e ON e.id = c.edition_id
        WHERE c.toc_id IN (${ph}) AND e.lang IN ('he', 'arc') ORDER BY c.toc_id, c.id`,
      books
    )) as { book: string; ref: string; text: string }[];
    const out: { book: string; ref: string; text: string }[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const plain = strip(r.text);
      if (mode === 'verse') {
        if (gematria(plain) === n) out.push({ book: r.book, ref: r.ref, text: plain.slice(0, 70) });
      } else {
        for (const w of plain.split(/[\s־]+/)) {
          const clean = w.replace(/[^א-ת]/g, '');
          const key = `${r.book}|${r.ref}|${clean}`;
          if (clean && gematria(clean) === n && !seen.has(key)) {
            seen.add(key);
            out.push({ book: r.book, ref: r.ref, text: clean });
          }
        }
      }
      if (out.length >= 500) break;
    }
    setHits(out);
    setBusy(false);
    setRan(true);
    if (mode === 'word') {
      highlightValue = n;
      setHighlighting(true);
      ctx.actions.emit('decorations.changed');
    }
  };

  const count = selected.size;
  return (
    <div className="plugin-page">
      <h2>Gematria search</h2>
      <form onSubmit={run}>
        <Group align="flex-end">
          <TextInput type="number" label="Value" placeholder="e.g. 26" value={value} onChange={(e) => setValue(e.currentTarget.value)} w={150} />
          <SegmentedControl value={mode} onChange={setMode} data={[{ value: 'word', label: 'Words' }, { value: 'verse', label: 'Whole verses' }]} />
          <Button type="submit" color="orange" disabled={!count} loading={busy}>
            Search{count ? ` (${count} book${count === 1 ? '' : 's'})` : ''}
          </Button>
          {highlighting && (
            <Button variant="subtle" color="gray" onClick={() => { highlightValue = null; setHighlighting(false); ctx.actions.emit('decorations.changed'); }}>
              Clear highlight
            </Button>
          )}
        </Group>
      </form>

      <Text size="sm" c="dimmed" mt="md" mb={4}>Search which books:</Text>
      <ScrollArea h={220} type="auto" style={{ maxWidth: 460, border: '1px solid var(--line)', borderRadius: 8, padding: 6 }}>
        {!toc ? (
          <Text c="dimmed" size="sm">Loading catalog…</Text>
        ) : (
          <BookCheckTree
            toc={toc}
            checked={selected}
            onChange={setSelected}
            renderBookExtra={(id) => (localBooks.has(id) ? <Badge size="xs" color="green" variant="light">local</Badge> : null)}
          />
        )}
      </ScrollArea>

      {ran && !busy && (
        <Text c="dimmed" size="sm" mt="md">{hits.length} {mode === 'word' ? 'word' : 'verse'} match{hits.length === 1 ? '' : 'es'}{hits.length >= 500 ? '+' : ''}</Text>
      )}
      <Stack gap={4} mt="xs">
        {hits.map((h, i) => (
          <Anchor key={`${h.book}:${h.ref}:${i}`} onClick={() => ctx.ui.navigate(h.book, h.ref)} c="inherit">
            <span className="comm-ref">{h.book} {h.ref}</span> <span dir="rtl" className="plugin-gem-hit">{h.text}</span>
          </Anchor>
        ))}
      </Stack>
    </div>
  );
}

export default definePlugin({
  manifest: {
    id: 'gematria',
    name: 'Gematria',
    version: '3.0.0',
    apiVersion: '^1',
    permissions: ['data:read'],
    description: 'Gematria of selected text, per verse, highlight, and a search page.',
  },
  activate(ctx) {
    ctx.contribute('viewer', 'onTextSelect', {
      id: 'gematria',
      label: (sel: TextSelection) => {
        const g = gematria(sel.text);
        return g ? `Gematria ${g.toLocaleString()}` : null;
      },
    });
    ctx.contribute('viewer', 'verseAction', {
      id: 'gematria',
      label: 'Gematria',
      icon: 'א',
      when: (v: Verse) => v.editions.some((e) => RTL.test(e.lang)),
      run: (v: Verse) => {
        const he = v.editions.find((e) => RTL.test(e.lang) && v.texts[e.id]);
        ctx.ui.showToast(`${v.book} ${v.ref} — gematria ${gematria(he ? strip(v.texts[he.id]) : '').toLocaleString()}`);
      },
    });
    ctx.contribute('viewer', 'decoration', {
      id: 'gematria.highlight',
      provide: (seg: Segment) => {
        if (highlightValue == null || !RTL.test(seg.lang)) return [];
        const out: Decoration[] = [];
        const re = /[^\s־]+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(seg.text))) {
          if (gematria(m[0]) === highlightValue) out.push({ kind: 'mark', from: m.index, to: m.index + m[0].length, className: 'gematria-hit', title: `gematria ${highlightValue}` });
        }
        return out;
      },
    });
    ctx.registerPage({ id: 'gematria-search', title: 'Gematria', icon: 'א', order: 10, render: () => <GematriaSearchPage ctx={ctx} /> });

    // Extend the Code page through its published API: the SQL gematria(text) function + sample queries.
    const code = codePageApi(ctx);
    code.registerFns([{ name: 'gematria', args: ['text'], body: GEMATRIA_BODY }]);
    code.registerSample({
      id: 'gematria:verse',
      label: 'Verse gematria (Genesis 1)',
      sql: `-- gematria(text) comes from the Gematria plugin (HTML is ignored). Select toc_id + ref to auto-link.
SELECT c.toc_id, c.ref, gematria(c.text) AS gematria, substr(strip(c.text), 1, 40) AS preview
FROM content c JOIN editions e ON e.id = c.edition_id
WHERE c.toc_id = 'Genesis' AND e.source = 'sefaria' AND e.lang = 'he' AND c.ref LIKE '1:%'
ORDER BY gematria DESC
LIMIT 25;`,
    });
    code.registerSample({
      id: 'gematria:pairs',
      label: 'Two verses with equal gematria (Genesis)',
      sql: `-- Pairs of Genesis verses sharing a gematria. MATERIALIZED computes gematria once per verse, not per pair.
WITH g AS MATERIALIZED (
  SELECT c.ref, gematria(c.text) AS val
  FROM content c JOIN editions e ON e.id = c.edition_id
  WHERE c.toc_id = 'Genesis' AND e.source = 'sefaria' AND e.lang = 'he'
)
SELECT link('Genesis', a.ref) AS verse_a, link('Genesis', b.ref) AS verse_b, a.val AS gematria
FROM g a JOIN g b ON a.val = b.val AND a.ref < b.ref
ORDER BY a.val DESC
LIMIT 50;`,
    });
    code.registerSample({
      id: 'gematria:prime',
      label: 'Verses whose gematria is prime (Genesis 1)',
      sql: `-- gematria() + evalJS() for a primality test (value = the gematria number passed in).
SELECT c.toc_id, c.ref, gematria(c.text) AS gematria, substr(strip(c.text), 1, 40) AS preview
FROM content c JOIN editions e ON e.id = c.edition_id
WHERE c.toc_id = 'Genesis' AND e.source = 'sefaria' AND e.lang = 'he' AND c.ref LIKE '1:%'
  AND evalJS('(n => { if (n < 2) return false; for (let i = 2; i*i <= n; i++) if (n % i === 0) return false; return true; })(value)', gematria(c.text))
ORDER BY gematria DESC
LIMIT 25;`,
    });
  },
});
