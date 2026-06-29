// The "storage" page — manage which books are downloaded. The checkbox tree mirrors the download state
// (downloaded books checked, partly-downloaded categories indeterminate); editing it queues a diff that the
// Download / Clear buttons apply. This is where downloading happens — the viewer never auto-downloads.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Group, Button, Text, ScrollArea, Progress, Badge, Stack } from '@mantine/core';
import { getToc, getLocalBookIds, ensureBook, clearBook } from '../db/client';
import type { TocRow } from '../db/types';
import { BookCheckTree, fmtBytes } from '../components/BookTree';
import CustomPlugins from '../components/CustomPlugins';

export default function StoragePage() {
  const [toc, setToc] = useState<TocRow[] | null>(null);
  const [local, setLocal] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<{ done: number; total: number; label: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Refresh the "what's actually local" set. `syncChecked` also resets the desired-state checkboxes to match
  // (used on first load); a run in flight passes false so it preserves any checkbox edits the user made while
  // the download/clear was running instead of clobbering them with a stale snapshot.
  const refreshLocal = useCallback(async (syncChecked = false) => {
    const ids = new Set(await getLocalBookIds());
    setLocal(ids);
    if (syncChecked) setChecked(new Set(ids));
  }, []);
  useEffect(() => {
    void (async () => {
      setToc(await getToc());
      await refreshLocal(true);
    })();
  }, [refreshLocal]);

  const byId = useMemo(() => new Map((toc ?? []).map((t) => [t.id, t] as const)), [toc]);
  // checked = the desired download state; diff it against what's actually local.
  const toDownload = useMemo(() => [...checked].filter((id) => !local.has(id)), [checked, local]);
  const toClear = useMemo(() => [...local].filter((id) => !checked.has(id)), [checked, local]);
  const downloadBytes = useMemo(() => toDownload.reduce((s, id) => s + (byId.get(id)?.file_size ?? 0), 0), [toDownload, byId]);

  const run = useCallback(
    async (ids: string[], op: (id: string) => Promise<void>, verb: string) => {
      setBusy({ done: 0, total: ids.length, label: verb });
      setRunError(null);
      const failed: { id: string; err: string }[] = [];
      for (let i = 0; i < ids.length; i++) {
        setBusy({ done: i + 1, total: ids.length, label: `${verb} ${byId.get(ids[i])?.title_en ?? ids[i]}` });
        try {
          await op(ids[i]);
        } catch (e) {
          console.error(`[storage] ${verb} ${ids[i]} failed:`, e);
          failed.push({ id: ids[i], err: e instanceof Error ? e.message : String(e) });
        }
      }
      await refreshLocal();
      setBusy(null);
      if (failed.length) {
        const names = failed.map((f) => byId.get(f.id)?.title_en ?? f.id);
        setRunError(`${failed.length} of ${ids.length} failed (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}): ${failed[0].err}`);
      }
    },
    [byId, refreshLocal]
  );

  const localCount = useMemo(() => (toc ?? []).filter((t) => t.kind === 'book' && local.has(t.id)).length, [toc, local]);

  return (
    <div className="storage-page">
      <Stack gap="xs" className="storage-bar">
        <Group justify="space-between">
          <Text fw={700} size="lg">Storage</Text>
          <Text size="sm" c="dimmed">{localCount.toLocaleString()} books downloaded</Text>
        </Group>
        <Group>
          <Button color="orange" disabled={!toDownload.length || !!busy} onClick={() => run(toDownload, (id) => ensureBook(id), 'Downloading')}>
            Download ({toDownload.length}{downloadBytes ? ` · ${fmtBytes(downloadBytes)}` : ''})
          </Button>
          <Button variant="default" disabled={!toClear.length || !!busy} onClick={() => run(toClear, (id) => clearBook(id), 'Clearing')}>
            Clear ({toClear.length})
          </Button>
          {(toDownload.length > 0 || toClear.length > 0) && (
            <Button variant="subtle" color="gray" disabled={!!busy} onClick={() => setChecked(new Set(local))}>
              Reset
            </Button>
          )}
        </Group>
        {busy && (
          <div>
            <Text size="sm">{busy.label}… ({busy.done}/{busy.total})</Text>
            <Progress value={busy.total ? (busy.done / busy.total) * 100 : 0} color="orange" mt={4} />
          </div>
        )}
        {runError && <Text size="sm" c="red">{runError}</Text>}
      </Stack>

      <ScrollArea className="storage-tree">
        {!toc ? (
          <Text c="dimmed">Loading catalog…</Text>
        ) : (
          <BookCheckTree
            toc={toc}
            checked={checked}
            onChange={setChecked}
            renderBookExtra={(id, row) =>
              local.has(id) ? (
                <Badge size="xs" color="green" variant="light">local</Badge>
              ) : (
                <Text size="xs" c="dimmed">{fmtBytes(row.file_size ?? null)}</Text>
              )
            }
          />
        )}
      </ScrollArea>

      <CustomPlugins />
    </div>
  );
}
