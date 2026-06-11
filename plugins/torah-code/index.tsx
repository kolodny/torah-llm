// Torah codes (ELS): an ELS matrix renderer for the Code page + a torah_code_find() SQL function. Everything
// goes through the Code page's published API (codePageApi) — no core/page code knows about torah codes.
import { useEffect, useMemo, useState } from 'react';
import { Loader, Text } from '@mantine/core';
import { definePlugin, type PluginContext } from '../../src/plugins/types';
import { stripHtml } from '../../shared/strip';
import { codePageApi } from '../code-search/api';

// torah_code_find(text, word [, maxSkip] [, minSkip]) — find the smallest-skip ELS of <word> in skip range
// [minSkip, maxSkip]; returns a JSON handle
// {start, skip, len} to feed render('torah-code', book, handle), or NULL. (json_extract it for the numbers.)
const FIND_BODY = `
var letters = String(text).replace(/[^א-ת]/g, '');
var w = String(word).replace(/[^א-ת]/g, '');
if (w.length < 2) return null;
var max = Math.min(Math.max(1, Math.floor(Number(maxSkip) || 50)), 5000);
var min = Math.max(1, Math.floor(Number(minSkip) || 1));
var n = letters.length, m = w.length;
for (var s = min; s <= max; s++) {
  var limit = n - (m - 1) * s;
  for (var start = 0; start < limit; start++) {
    var ok = true;
    for (var k = 0; k < m; k++) { if (letters[start + k * s] !== w[k]) { ok = false; break; } }
    if (ok) return JSON.stringify({ start: start, skip: s, len: m });
  }
}
return null;`;

// Client-side twin of FIND_BODY, but returns the position too (the matrix needs start + skip to draw).
function findELS(letters: { ch: string }[], word: string, maxSkip: number, minSkip = 1): { start: number; skip: number } | null {
  const n = letters.length;
  const m = word.length;
  if (m < 1) return null;
  for (let s = Math.max(1, minSkip); s <= maxSkip; s++) {
    const limit = n - (m - 1) * s;
    for (let start = 0; start < limit; start++) {
      let ok = true;
      for (let k = 0; k < m; k++)
        if (letters[start + k * s].ch !== word[k]) {
          ok = false;
          break;
        }
      if (ok) return { start, skip: s };
    }
  }
  return null;
}

// render('torah-code', book, word [, maxSkip])            — find the smallest-skip ELS of <word> and draw it
// render('torah-code', book, start, skip [, length, width]) — draw an explicit ELS (numbers)
function TorahCodeMatrix({ args, ctx }: { args: unknown[]; ctx: PluginContext }) {
  const book = String(args[0] ?? '');
  const a1 = args[1];
  const a2 = args[2];
  const a3 = args[3];
  const a4 = args[4];
  // 2nd arg: a JSON handle from torah_code_find ({start,skip,len}), a Hebrew word to find, or the start index.
  const handleStr = typeof a1 === 'string' && a1.trim().startsWith('{') ? a1 : '';
  const word = typeof a1 === 'string' && !handleStr ? a1.replace(/[^א-ת]/g, '') : '';
  const [letters, setLetters] = useState<{ ch: string; ref: string }[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setLetters(null);
    setErr('');
    ctx.data
      .query(
        'SELECT c.ref AS ref, c.text AS text FROM content c JOIN editions e ON e.id = c.edition_id WHERE c.toc_id = ? AND e.lang = ? AND e.source = ? ORDER BY c.id',
        [book, 'he', 'sefaria']
      )
      .then((qrows) => {
        if (!alive) return;
        const out: { ch: string; ref: string }[] = [];
        for (const r of qrows as { ref: string; text: string }[])
          for (const ch of stripHtml(r.text).replace(/[^א-ת]/g, '')) out.push({ ch, ref: r.ref });
        setLetters(out);
      })
      .catch((e) => {
        if (alive) setErr(String(e));
      });
    return () => {
      alive = false;
    };
  }, [book, ctx]);

  // Resolve start/skip/length/width: word mode finds the smallest-skip ELS (memoized — the search is O(N·skip)).
  const spec = useMemo(() => {
    if (!letters) return null;
    if (handleStr) {
      // handle mode: a {start,skip,len} object from torah_code_find — draw it directly, no second search.
      let h: { start?: number; skip?: number; len?: number } | null = null;
      try { h = JSON.parse(handleStr); } catch { /* malformed handle */ }
      if (!h || h.start == null) return { notFound: true, reason: 'malformed handle', start: 0, skip: 1, length: 1, width: 1 };
      const skip = Math.max(1, Math.floor(Number(h.skip) || 1));
      return { start: Math.max(0, Math.floor(Number(h.start) || 0)), skip, length: Math.max(1, Math.floor(Number(h.len) || 1)), width: skip, notFound: false };
    }
    if (word) {
      const maxSkip = Math.min(Math.max(1, Math.floor(Number(a2) || 200)), 2000);
      const minSkip = Math.max(1, Math.floor(Number(a3) || 1));
      const hit = findELS(letters, word, maxSkip, minSkip);
      return hit ? { start: hit.start, skip: hit.skip, length: word.length, width: hit.skip, notFound: false } : { notFound: true, reason: `not found (skip ${minSkip}-${maxSkip})`, start: 0, skip: 1, length: 1, width: 1 };
    }
    if (a1 == null) return { notFound: true, reason: 'nothing to draw (NULL)', start: 0, skip: 1, length: 1, width: 1 };
    const start = Math.max(0, Math.floor(Number(a1) || 0)); // explicit mode: 2nd arg is the start index
    const skip = Math.max(1, Math.floor(Number(a2) || 1));
    const length = Math.max(1, Math.floor(Number(a3) || 8));
    const width = Math.max(1, Math.floor(Number(a4) || skip));
    return { start, skip, length, width, notFound: false };
  }, [letters, handleStr, word, a1, a2, a3, a4]);

  if (err) return <Text c="red" size="xs">{err}</Text>;
  if (!letters || !spec) return <Loader size="xs" />;
  if (!letters.length) return <Text c="dimmed" size="xs">No Hebrew text for “{book}”. Download it on the Storage tab.</Text>;
  if (spec.notFound) return <Text size="sm" c="dimmed" dir="auto">Torah code: {spec.reason} in {book}{word ? ` \u2014 ${word}` : ''}.</Text>;

  const { start, skip, length, width } = spec;
  const els = new Set<number>();
  const code: string[] = [];
  for (let k = 0; k < length; k++) {
    const i = start + k * skip;
    if (i < letters.length) {
      els.add(i);
      code.push(letters[i].ch);
    }
  }
  const lastIdx = start + (Math.max(1, code.length) - 1) * skip;
  const CONTEXT = 3; // rows of surrounding text to show before/after the ELS span, for context
  const firstRow = Math.max(0, Math.floor(start / width) - CONTEXT);
  const lastRow = Math.min(Math.floor((letters.length - 1) / width), Math.floor(lastIdx / width) + CONTEXT);
  // Keep rows readable: show at most MAX_COLS letters per row, windowed around the ELS column (which is
  // start % width — every ELS letter sits in it), so a large skip doesn't make a hundreds-wide matrix.
  const MAX_COLS = 41;
  const elsCol = start % width;
  const viewW = Math.min(width, MAX_COLS);
  const colStart = Math.max(0, Math.min(elsCol - Math.floor(viewW / 2), width - viewW));
  const grid: { label: string; cells: { i: number; ch: string; ref: string; hit: boolean }[] }[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const cells: { i: number; ch: string; ref: string; hit: boolean }[] = [];
    for (let col = colStart; col < colStart + viewW; col++) {
      const i = row * width + col;
      if (i >= letters.length) break;
      cells.push({ i, ch: letters[i].ch, ref: letters[i].ref, hit: els.has(i) });
    }
    if (cells.length) grid.push({ label: `${book} ${cells[0].ref}`, cells }); // label = book + verse the row starts in
  }

  return (
    <div className="torah-code">
      <Text size="sm" mb={4}>
        ELS{' '}
        <b dir="rtl" style={{ fontSize: 18 }}>{code.join('')}</b>{' '}
        <Text span c="dimmed" size="xs">· {book} · start {start} · skip {skip}</Text>
      </Text>
      <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <table className="torah-code-matrix">
          <tbody>
            {grid.map(({ label, cells }, ri) => (
              <tr key={ri}>
                <td className="rowlabel" title={label}>{label}</td>
                {cells.map((cell) => (
                  <td key={cell.i} className={cell.hit ? 'hit' : undefined}>
                    <a
                      href={`?page=viewer&book=${encodeURIComponent(book)}&ref=${encodeURIComponent(cell.ref)}`}
                      title={`${book} ${cell.ref}`}
                      onClick={(e) => {
                        // plain click navigates in-app; cmd/ctrl/shift/middle click keeps native open-in-new-tab
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        ctx.ui.navigate(book, cell.ref);
                      }}
                    >
                      {cell.ch}
                    </a>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default definePlugin({
  manifest: {
    id: 'torah-code',
    name: 'Torah Code',
    version: '1.0.0',
    apiVersion: '^1',
    permissions: ['data:read'],
    description: 'ELS (torah code) matrix renderer + torah_code_find() for the Code page.',
  },
  activate(ctx) {
    const code = codePageApi(ctx);
    code.registerFns([{ name: 'find', args: ['text', 'word', 'maxSkip', 'minSkip'], body: FIND_BODY }]);
    code.registerRenderer({ id: 'torah-code', render: (a: unknown[]) => <TorahCodeMatrix args={a} ctx={ctx} /> });
    code.registerSample({
      id: 'torah-code:find',
      label: 'Torah code — תורה (skip 50, spans Genesis 1:1–1:5)',
      sql: `-- The famous Genesis ELS: from the first letter ת, skipping 50 spells תורה across four verses (1:1, 1:2,
-- 1:4, 1:5). torah_code_find(text, word, maxSkip, minSkip) searches ONCE — minSkip 50 skips the trivial
-- closely-spaced hits — and returns a handle {start, skip, len}. Feed the handle to render('torah-code', book,
-- handle) to draw it (no second search), and json_extract it for the number. Click any letter to open its verse.
SELECT json_extract(f, '$.skip') AS skip,
       render('torah-code', 'Genesis', f) AS matrix
FROM (SELECT torah_code_find(group_concat(c.text, ''), 'תורה', 5000, 50) AS f FROM (
        SELECT c.text FROM content c JOIN editions e ON e.id = c.edition_id
        WHERE c.toc_id = 'Genesis' AND e.source = 'sefaria' AND e.lang = 'he' ORDER BY c.id) c);`,
    });
  },
});
