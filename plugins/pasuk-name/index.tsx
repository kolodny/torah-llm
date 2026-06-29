// "Pasuk for your name" — the widespread minhag at the end of Shemoneh Esrei (before Oseh Shalom): recite a
// pasuk that BEGINS with the first letter of your name and ENDS with its last letter. Pick the first and last
// Hebrew letters and this page finds matching pesukim in the downloaded Tanakh — using the read-only query() +
// the core letters() SQL function (first/last consonant of each verse). A self-contained page plugin: no
// DOM/reader integration, just letters in → results out.
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Select, Button, Group, Stack, Text, Anchor } from '@mantine/core';
import { definePlugin, type PluginContext } from '../../src/plugins/types';

const ALEPH_BET = 'אבגדהוזחטיכלמנסעפצקרשת'.split('');
// Pesukim end in final letter-forms; the picker shows base letters, so accept the final form too.
const FINAL: Record<string, string> = { כ: 'ך', מ: 'ם', נ: 'ן', פ: 'ף', צ: 'ץ' };

type Hit = { book: string; ref: string; preview: string };

function PasukNamePage({ ctx }: { ctx: PluginContext }) {
  // first/last live in the URL (?first=…&last=…) so a search is shareable and survives reload.
  const [params, setParams] = useSearchParams();
  const first = params.get('first');
  const last = params.get('last');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);

  const setLetter = (key: 'first' | 'last', val: string | null) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (val) p.set(key, val);
        else p.delete(key);
        return p;
      },
      { replace: true }
    );
    setHits(null);
  };

  const run = async () => {
    if (!first || !last) return;
    setBusy(true);
    try {
      const lastForms = [...new Set([last, FINAL[last] ?? last])];
      const ph = lastForms.map(() => '?').join(',');
      // First consonant of the verse == the first letter; last consonant ∈ the last letter's forms.
      // Restrict to the 24 canonical Tanakh books (the three pesukim divisions — not Targum/commentary)
      // via the toc join, which also gives order_index for canonical Tanakh ordering; one Hebrew
      // edition per verse (MIN). Order by book (Genesis→Chronicles), then numeric chapter:verse — NOT
      // the toc_id/ref strings, which would put Deuteronomy first and sort 10:1 before 2:1.
      const rows = (await ctx.data.query(
        `SELECT c.toc_id AS book, c.ref AS ref, substr(strip(min(c.text)), 1, 90) AS preview
           FROM content c
           JOIN editions e ON e.id = c.edition_id
           JOIN toc t ON t.id = c.toc_id
          WHERE e.lang = 'he'
            AND t.parent_id IN ('Tanakh / Torah', 'Tanakh / Prophets', 'Tanakh / Writings')
            AND substr(letters(c.text), 1, 1) = ?
            AND substr(letters(c.text), -1) IN (${ph})
          GROUP BY c.toc_id, c.ref
          ORDER BY MIN(t.order_index),
                   CAST(c.ref AS INTEGER),
                   CAST(substr(c.ref, instr(c.ref, ':') + 1) AS INTEGER)
          LIMIT 300`,
        [first, ...lastForms]
      )) as Hit[];
      setHits(rows);
    } finally {
      setBusy(false);
    }
  };

  // Auto-run once on mount if both letters arrived from the URL (shared link / reload restores results).
  const didAutoRun = useRef(false);
  useEffect(() => {
    if (!didAutoRun.current && first && last) {
      didAutoRun.current = true;
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Group the (already canonically-ordered) hits by book so each book + its count is scannable at a
  // glance — otherwise Tehillim sits ~halfway down a flat list (Ketuvim follows all of Neviim).
  const groups: { book: string; items: Hit[] }[] = [];
  for (const h of hits ?? []) {
    const g = groups[groups.length - 1];
    if (g && g.book === h.book) g.items.push(h);
    else groups.push({ book: h.book, items: [h] });
  }

  return (
    <div className="plugin-page">
      <h2>Pasuk for your name</h2>
      <Text size="sm" c="dimmed" mb="md">
        The custom at the end of Shemoneh Esrei: say a pasuk that <b>begins with the first letter of your name</b> and{' '}
        <b>ends with its last letter</b>. Pick the letters to find matching pesukim from your downloaded Tanakh.
      </Text>
      <Group align="flex-end">
        <Select
          label="First letter"
          placeholder="—"
          data={ALEPH_BET}
          value={first}
          onChange={(v) => setLetter('first', v)}
          w={110}
          searchable
          comboboxProps={{ dropdownPadding: 4 }}
          styles={{ input: { textAlign: 'center', fontSize: 18 } }}
        />
        <Select
          label="Last letter"
          placeholder="—"
          data={ALEPH_BET}
          value={last}
          onChange={(v) => setLetter('last', v)}
          w={110}
          searchable
          comboboxProps={{ dropdownPadding: 4 }}
          styles={{ input: { textAlign: 'center', fontSize: 18 } }}
        />
        <Button onClick={run} color="orange" loading={busy} disabled={!first || !last}>
          Find pesukim
        </Button>
      </Group>
      {hits && !busy && (
        <Text size="sm" c="dimmed" mt="md">
          {hits.length}{hits.length >= 300 ? '+' : ''} matching {hits.length === 1 ? 'pasuk' : 'pesukim'} across {groups.length} {groups.length === 1 ? 'book' : 'books'}
        </Text>
      )}
      {/* No inner scroll container — .plugin-page already scrolls; a nested ScrollArea here caused
          two competing scrollbars. Book headers stick to the top of the page scroll. */}
      <Stack gap="sm" mt="xs">
        {groups.map((g) => (
          <div key={g.book}>
            <Text fw={600} size="sm" className="comm-ref" style={{ position: 'sticky', top: 0, background: 'var(--mantine-color-body)', padding: '4px 0', zIndex: 1 }}>
              {g.book} · {g.items.length}
            </Text>
            <Stack gap={2}>
              {g.items.map((h) => (
                <Anchor
                  key={h.ref}
                  href={ctx.ui.href(h.book, h.ref)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    ctx.ui.navigate(h.book, h.ref);
                  }}
                  c="inherit"
                >
                  <span className="comm-ref">{h.ref}</span> <span dir="rtl" style={{ marginInlineStart: 8 }}>{h.preview}</span>
                </Anchor>
              ))}
            </Stack>
          </div>
        ))}
      </Stack>
      {hits && hits.length === 0 && !busy && (
        <Text c="dimmed" mt="md">No matching pesukim in your downloaded books — download Tanakh in the Storage tab.</Text>
      )}
    </div>
  );
}

export default definePlugin({
  manifest: {
    id: 'pasuk-name',
    name: 'Pasuk for your name',
    version: '1.0.0',
    apiVersion: '^1',
    permissions: ['data:read'],
    description: "Find a pasuk that begins with a name's first letter and ends with its last (end of Shemoneh Esrei).",
  },
  activate(ctx) {
    ctx.registerPage({ id: 'pasuk-name', title: 'Name Pasuk', icon: '✡', order: 40, render: () => <PasukNamePage ctx={ctx} /> });
  },
});
