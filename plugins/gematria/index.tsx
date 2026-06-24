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
// Strip HTML tags AND decode entities (&thinsp;/&nbsp;/… → real whitespace) via the DOM, so previews show
// clean text (not literal "&thinsp;") and word-mode tokenization splits on entity-spacing too. Main-thread only.
const strip = (html: string) => {
  const el = document.createElement('div');
  el.innerHTML = html ?? '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
};
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
  // Reflect any highlight that's already active globally, so navigating away to view it and coming back
  // shows the "Clear highlight" button (the original bug was an orphaned highlight with no way to clear).
  // We must NOT clear on unmount: the whole point is the highlight persists in the viewer after you click a hit.
  const [highlighting, setHighlighting] = useState(highlightValue != null);
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
    // A search value of 0 matches every non-Hebrew (zero-value) token — treat it as "no search".
    if (!books.length || !Number.isFinite(n) || n <= 0) return;
    setBusy(true);
    const ph = books.map(() => '?').join(',');
    // Pick one Hebrew edition per verse (MIN edition_id) so a verse with several Hebrew editions
    // isn't returned/counted once per edition.
    const rows = (await ctx.data.query(
      `SELECT c.toc_id AS book, c.ref AS ref, MIN(c.text) AS text FROM content c JOIN editions e ON e.id = c.edition_id
        WHERE c.toc_id IN (${ph}) AND e.lang IN ('he', 'arc')
        GROUP BY c.toc_id, c.ref ORDER BY c.toc_id, MIN(c.id)`,
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
ORDER BY gematria DESC;`,
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
ORDER BY a.val DESC;`,
    });
    code.registerSample({
      id: 'gematria:rashi',
      label: 'Verse ↔ Rashi with equal gematria (any book)',
      sql: `-- A base verse and a Rashi comment (on that same book) that happen to share a gematria. Not Genesis-bound:
-- the join keys off the "Rashi on <book>" relationship, so it covers every book whose Rashi you've downloaded.
WITH rashi AS MATERIALIZED (
  SELECT replace(c.toc_id, 'Rashi on ', '') AS book, c.ref, gematria(c.text) AS val
  FROM content c JOIN editions e ON e.id = c.edition_id
  WHERE c.toc_id LIKE 'Rashi on %' AND e.lang = 'he'
),
verse AS MATERIALIZED (
  SELECT c.toc_id AS book, c.ref, gematria(c.text) AS val
  FROM content c JOIN editions e ON e.id = c.edition_id
  WHERE e.source = 'sefaria' AND e.lang = 'he'
    AND c.toc_id IN (SELECT DISTINCT book FROM rashi)
)
SELECT v.book, link(v.book, v.ref) AS verse, link('Rashi on ' || v.book, r.ref) AS rashi, v.val AS gematria
FROM verse v JOIN rashi r ON r.book = v.book AND r.val = v.val
WHERE v.val > 100
ORDER BY v.val DESC;`,
    });
    code.registerSample({
      id: 'gematria:verse-equals-word',
      label: 'Any verse whose gematria equals a single word',
      sql: `-- Every verse whose ENTIRE gematria equals that of one or more single Hebrew words — one row per verse, with
-- every matching word joined by ' / ' (e.g. Exodus 15:18 = 376 → עֵשָׂו / שָׁלוֹם / …). Verses that recur verbatim
-- collapse to one; words are de-duped by their consonants (te'amim vary). gematria() ignores nikud/te'amim/HTML.
-- Download the Torah books in Storage first. (Click a ref to open it; click any header to sort.)
WITH
  all_words AS MATERIALIZED (     -- every word in the Torah (words() splits, json_each unnests)
    SELECT word.value AS w
    FROM content c JOIN editions e ON e.id = c.edition_id
      JOIN json_each(words(c.text)) AS word
    WHERE c.toc_id IN ('Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy') AND e.source = 'sefaria' AND e.lang = 'he'
  ),
  matches AS MATERIALIZED (       -- each DISTINCT word (by consonants) and its gematria
    SELECT gematria(w) AS g, w AS word
    FROM all_words WHERE w <> '' AND gematria(w) > 0
    GROUP BY letters(w)
  ),
  verses AS MATERIALIZED (        -- one row per DISTINCT verse text (verses that recur verbatim, e.g. וַיְדַבֵּר…, collapse to one)
    SELECT c.toc_id, c.ref, gematria(c.text) AS g, substr(strip(c.text), 1, 45) AS verse
    FROM content c JOIN editions e ON e.id = c.edition_id
    WHERE c.toc_id IN ('Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy') AND e.source = 'sefaria' AND e.lang = 'he'
    GROUP BY c.text
  )
SELECT v.toc_id, v.ref, v.g AS gematria, count(*) AS word_count, group_concat(m.word, ' / ') AS equal_words, v.verse
FROM verses v JOIN matches m ON m.g = v.g
GROUP BY v.toc_id, v.ref
ORDER BY v.g DESC;`,
    });
    code.registerSample({
      id: 'gematria:triangular',
      label: 'Genesis 1:1 = 2701 = the 73rd triangular number',
      sql: `-- The Torah's opening verse sums to 2701 = 1+2+…+73 — exactly the 73rd "triangular number", a much-cited
-- numeric symmetry of בְּרֵאשִׁית. gematria() sums the Hebrew letters; evalJS solves n(n+1)/2 = g for n.
-- A subquery computes the gematria once, then we both show it and test it for triangularity.
SELECT toc_id, ref, gematria,
       evalJS('(function (x) { var n = Math.floor((Math.sqrt(8 * x + 1) - 1) / 2); return n * (n + 1) / 2 === x ? n : null; })(value)', gematria) AS triangular_index,
       verse
FROM (
  SELECT c.toc_id, c.ref, gematria(c.text) AS gematria, substr(strip(c.text), 1, 45) AS verse
  FROM content c JOIN editions e ON e.id = c.edition_id
  WHERE c.toc_id = 'Genesis' AND c.ref = '1:1' AND e.source = 'sefaria' AND e.lang = 'he'
);`,
    });
    code.registerSample({
      id: 'gematria:words-equal',
      label: 'Torah words sharing a famous gematria (376 = שלום = עשו)',
      sql: `-- Every Torah word whose letters sum to 376 — שָׁלוֹם, עֵשָׂו, and others (e.g. וַיַּשְׁכֵּם "and he rose early").
-- evalJS splits each verse into words (as a JSON array), json_each unnests them, and gematria() scores each.
-- Change 376 to 26 (יהוה), 13 (אהבה / אחד)…
-- words(text) splits a verse into a JSON array of words; json_each unnests them so gematria() scores each.
-- One row per DISTINCT word: GROUP BY the consonants-only form (te'amim/nikud vary by occurrence) and show a
-- sample location + how many times it occurs. (Drop the GROUP BY to instead list every occurrence.)
SELECT c.toc_id, c.ref, word.value AS word, count(*) AS occurrences
FROM content c
  JOIN editions e ON e.id = c.edition_id
  JOIN json_each(words(c.text)) AS word
WHERE c.toc_id IN ('Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy') AND e.source = 'sefaria' AND e.lang = 'he'
  AND gematria(word.value) = 376
GROUP BY letters(word.value)
ORDER BY occurrences DESC;`,
    });
  },
});
