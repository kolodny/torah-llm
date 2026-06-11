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
var n = letters.length, m = w.length;
if (m < 2 || n < m) return null;
// Anchor the scan on the word's RAREST letter (fewest start candidates), and bail if any letter is absent —
// so a not-found word over a whole book stays fast. Skip can't exceed (n-1)/(m-1) — beyond that no ELS fits.
var freq = {};
for (var i = 0; i < n; i++) freq[letters[i]] = (freq[letters[i]] || 0) + 1;
var aj = 0, aMin = Infinity;
for (var j = 0; j < m; j++) { var f = freq[w[j]] || 0; if (f === 0) return null; if (f < aMin) { aMin = f; aj = j; } }
var anchor = w[aj], anchorPos = [];
for (var i = 0; i < n; i++) if (letters[i] === anchor) anchorPos.push(i);
var max = Math.min(Math.max(1, Math.floor(Number(maxSkip) || 50)), Math.floor((n - 1) / (m - 1)));
var min = Math.max(1, Math.floor(Number(minSkip) || 1));
for (var s = min; s <= max; s++) {
  for (var pi = 0; pi < anchorPos.length; pi++) {
    var start = anchorPos[pi] - aj * s;
    if (start < 0) continue;
    if (start + (m - 1) * s >= n) break; // positions ascending -> start only grows past here
    var ok = true;
    for (var k = 0; k < m; k++) { if (k !== aj && letters[start + k * s] !== w[k]) { ok = false; break; } }
    if (ok) return JSON.stringify({ start: start, skip: s, len: m });
  }
}
return null;`;

// Client-side twin of FIND_BODY, but returns the position too (the matrix needs start + skip to draw).
function findELS(letters: { ch: string }[], word: string, maxSkip: number, minSkip = 1): { start: number; skip: number } | null {
  const n = letters.length;
  const m = word.length;
  if (m < 2 || n < m) return null;
  // Anchor on the word's rarest letter (fewest candidates); bail if any letter is absent. (Same as FIND_BODY.)
  const freq: Record<string, number> = {};
  for (let i = 0; i < n; i++) freq[letters[i].ch] = (freq[letters[i].ch] || 0) + 1;
  let aj = 0;
  let aMin = Infinity;
  for (let j = 0; j < m; j++) {
    const f = freq[word[j]] || 0;
    if (f === 0) return null;
    if (f < aMin) { aMin = f; aj = j; }
  }
  const anchor = word[aj];
  const anchorPos: number[] = [];
  for (let i = 0; i < n; i++) if (letters[i].ch === anchor) anchorPos.push(i);
  const max = Math.min(maxSkip, Math.floor((n - 1) / (m - 1)));
  for (let s = Math.max(1, minSkip); s <= max; s++) {
    for (let pi = 0; pi < anchorPos.length; pi++) {
      const start = anchorPos[pi] - aj * s;
      if (start < 0) continue;
      if (start + (m - 1) * s >= n) break;
      let ok = true;
      for (let k = 0; k < m; k++) if (k !== aj && letters[start + k * s].ch !== word[k]) { ok = false; break; }
      if (ok) return { start, skip: s };
    }
  }
  return null;
}

// render('torah-code', books, word [, maxSkip] [, minSkip])  — find the smallest-skip ELS of <word> and draw it
// render('torah-code', books, handle)                         — draw a {start,skip,len} handle from torah_code_find
// render('torah-code', books, start, skip [, length, width])  — draw an explicit ELS (numbers)
// `books` is one toc id OR a comma-separated list treated as ONE continuous letter stream (e.g.
// 'Genesis,Exodus,…'), so an ELS can run across books; each cell links to the verse + book its letter is in.
function TorahCodeMatrix({ args, ctx }: { args: unknown[]; ctx: PluginContext }) {
  const corpus = String(args[0] ?? '');
  const books = corpus.split(',').map((s) => s.trim()).filter(Boolean);
  const a1 = args[1];
  const a2 = args[2];
  const a3 = args[3];
  const a4 = args[4];
  const handleStr = typeof a1 === 'string' && a1.trim().startsWith('{') ? a1 : '';
  const word = typeof a1 === 'string' && !handleStr ? a1.replace(/[^א-ת]/g, '') : '';
  const [letters, setLetters] = useState<{ ch: string; book: string; ref: string }[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setLetters(null);
    setErr('');
    Promise.all(
      books.map((b) =>
        ctx.data.query(
          'SELECT c.ref AS ref, c.text AS text FROM content c JOIN editions e ON e.id = c.edition_id WHERE c.toc_id = ? AND e.lang = ? AND e.source = ? ORDER BY c.id',
          [b, 'he', 'sefaria']
        )
      )
    )
      .then((perBook) => {
        if (!alive) return;
        // concatenate the books in order → one continuous letter stream, so an ELS skip can cross book lines.
        const out: { ch: string; book: string; ref: string }[] = [];
        books.forEach((b, bi) => {
          for (const r of perBook[bi] as { ref: string; text: string }[])
            for (const ch of stripHtml(r.text).replace(/[^א-ת]/g, '')) out.push({ ch, book: b, ref: r.ref });
        });
        setLetters(out);
      })
      .catch((e) => {
        if (alive) setErr(String(e));
      });
    return () => {
      alive = false;
    };
  }, [corpus, ctx]);

  const spec = useMemo(() => {
    if (!letters) return null;
    if (handleStr) {
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
    const start = Math.max(0, Math.floor(Number(a1) || 0));
    const skip = Math.max(1, Math.floor(Number(a2) || 1));
    const length = Math.max(1, Math.floor(Number(a3) || 8));
    const width = Math.max(1, Math.floor(Number(a4) || skip));
    return { start, skip, length, width, notFound: false };
  }, [letters, handleStr, word, a1, a2, a3, a4]);

  const corpusLabel = books.length > 1 ? `${books[0]}…${books[books.length - 1]}` : books[0] ?? corpus;
  if (err) return <Text c="red" size="xs">{err}</Text>;
  if (!letters || !spec) return <Loader size="xs" />;
  if (!letters.length) return <Text c="dimmed" size="xs">No Hebrew text for “{corpusLabel}”. Download the book(s) on the Storage tab.</Text>;
  if (spec.notFound) return <Text size="sm" c="dimmed" dir="auto">Torah code: {spec.reason} in {corpusLabel}{word ? ` — ${word}` : ''}.</Text>;

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
  // Keep rows readable: show at most MAX_COLS letters per row, windowed around the ELS column.
  const MAX_COLS = 41;
  const elsCol = start % width;
  const viewW = Math.min(width, MAX_COLS);
  const colStart = Math.max(0, Math.min(elsCol - Math.floor(viewW / 2), width - viewW));
  const grid: { label: string; cells: { i: number; ch: string; book: string; ref: string; hit: boolean }[] }[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const cells: { i: number; ch: string; book: string; ref: string; hit: boolean }[] = [];
    for (let col = colStart; col < colStart + viewW; col++) {
      const i = row * width + col;
      if (i >= letters.length) break;
      cells.push({ i, ch: letters[i].ch, book: letters[i].book, ref: letters[i].ref, hit: els.has(i) });
    }
    if (cells.length) grid.push({ label: `${cells[0].book} ${cells[0].ref}`, cells }); // book + verse the row starts in
  }

  return (
    <div className="torah-code">
      <Text size="sm" mb={4}>
        ELS{' '}
        <b dir="rtl" style={{ fontSize: 18 }}>{code.join('')}</b>{' '}
        <Text span c="dimmed" size="xs">· {corpusLabel} · start {start} · skip {skip}</Text>
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
                      href={`?page=viewer&book=${encodeURIComponent(cell.book)}&ref=${encodeURIComponent(cell.ref)}`}
                      title={`${cell.book} ${cell.ref}`}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        ctx.ui.navigate(cell.book, cell.ref);
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
    code.registerSample({
      id: 'torah-code:cross',
      label: 'Torah code — תורה across the Genesis–Exodus seam',
      sql: `-- Books are read as ONE continuous letter stream, so an ELS skip flows across book lines. Here תורה is
-- spelled every 39 letters from the end of Genesis (50:25, 50:26) into the start of Exodus (1:1, 1:2). Each row
-- is labelled with its own book + verse; click a letter to open it. (Needs Genesis + Exodus downloaded.)
SELECT render('torah-code', 'Genesis,Exodus,Leviticus,Numbers,Deuteronomy', 78309, 39, 4) AS torah_genesis_to_exodus;`,
    });
  },
});
