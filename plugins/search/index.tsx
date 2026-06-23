// Search — a viewer sidebar that finds a phrase in the current book and jumps to a hit.
import { useEffect, useState, type FormEvent } from 'react';
import { TextInput, Text, Stack, Anchor } from '@mantine/core';
import { definePlugin, type PluginContext, type ReaderContext } from '../../src/plugins/types';

const strip = (html: string) => html.replace(/<[^>]+>/g, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
function snippet(html: string, q: string) {
  const text = strip(html);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, i - 30);
  const slice = (start ? '…' : '') + text.slice(start, i + q.length + 60) + '…';
  return escapeHtml(slice).replace(new RegExp(`(${escapeRe(q)})`, 'gi'), '<mark>$1</mark>');
}

function useReader(ctx: PluginContext): ReaderContext {
  const [r, setR] = useState<ReaderContext>(ctx.reader.current);
  useEffect(() => {
    const d = ctx.reader.onDidChange(setR);
    return () => d.dispose();
  }, [ctx]);
  return r;
}

function SearchPanel({ ctx }: { ctx: PluginContext }) {
  const reader = useReader(ctx);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<{ ref: string; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState(false);
  const [notDownloaded, setNotDownloaded] = useState(false);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (!reader.book || !term) return;
    setBusy(true);
    if (!(await ctx.data.hasLocalContent(reader.book))) {
      setRows([]);
      setNotDownloaded(true);
      setBusy(false);
      setRan(true);
      return;
    }
    setNotDownloaded(false);
    // Match against stripped (visible) text, dedupe by ref (a verse may exist in several editions),
    // and escape LIKE wildcards so %/_/\ in the term are literal.
    const like = `%${escapeLike(term)}%`;
    const res = (await ctx.data.query("SELECT ref, MIN(text) AS text FROM content WHERE toc_id = ? AND strip(text) LIKE ? ESCAPE '\\' GROUP BY ref ORDER BY MIN(id) LIMIT 300", [reader.book, like])) as { ref: string; text: string }[];
    setRows(res);
    setBusy(false);
    setRan(true);
  };

  return (
    <div className="plugin-search" style={{ padding: 12 }}>
      <form onSubmit={run}>
        <TextInput value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder={reader.book ? `Search in ${reader.book}…` : 'Open a book first'} disabled={!reader.book} />
      </form>
      {busy && <Text c="dimmed" size="sm" mt="xs">Searching…</Text>}
      {ran && !busy && notDownloaded && <Text c="dimmed" size="sm" mt="xs">{reader.book} isn't downloaded — open it to download, then search.</Text>}
      {ran && !busy && !notDownloaded && <Text c="dimmed" size="sm" mt="xs">{rows.length} match{rows.length === 1 ? '' : 'es'}</Text>}
      <Stack gap={4} mt="xs">
        {rows.map((r, i) => (
          <Anchor key={`${r.ref}:${i}`} c="inherit" onClick={() => reader.book && ctx.ui.navigate(reader.book, r.ref)}>
            <span className="comm-ref">{r.ref}</span> <span dangerouslySetInnerHTML={{ __html: snippet(r.text, q.trim()) }} />
          </Anchor>
        ))}
      </Stack>
    </div>
  );
}

export default definePlugin({
  manifest: { id: 'search', name: 'Search', version: '3.0.0', apiVersion: '^1', permissions: ['data:read'], activationEvents: ['onBook:*'], description: 'Find a phrase in the current book.' },
  activate(ctx) {
    ctx.contribute('viewer', 'sidebar', { id: 'search', title: 'Search', render: () => <SearchPanel ctx={ctx} /> });
  },
});
