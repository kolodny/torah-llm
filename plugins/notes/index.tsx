// Notes — a verse action to add a note, a viewer sidebar to browse them, and a 📝 pin decoration on
// verses that have notes. Uses persistent plugin-scoped storage.
import { useEffect, useState } from 'react';
import { Text, Stack, Anchor, Checkbox, Group, ActionIcon } from '@mantine/core';
import { definePlugin, type PluginContext, type ReaderContext, type Decoration, type Verse, type Segment } from '../../src/plugins/types';

type Note = { book: string; ref: string; body: string; at: number };
const keyOf = (n: Note) => `note:${n.book} ${n.ref} ${n.at}`;
const noteRefs = new Set<string>(); // `${book} ${ref}` that have a note
const noteByRef = new Map<string, string>(); // `${book} ${ref}` → first note body (for the pin tooltip)

async function loadNotes(ctx: PluginContext): Promise<{ key: string; note: Note }[]> {
  const keys = await ctx.storage.keys('note:');
  const all = await Promise.all(keys.map(async (key) => ({ key, note: await ctx.storage.get<Note>(key) })));
  return all.filter((x): x is { key: string; note: Note } => !!x.note).sort((a, b) => b.note.at - a.note.at);
}
async function refreshNotes(ctx: PluginContext) {
  const notes = await loadNotes(ctx);
  noteRefs.clear();
  noteByRef.clear();
  for (const { note } of notes) {
    const k = `${note.book} ${note.ref}`;
    noteRefs.add(k);
    if (!noteByRef.has(k)) noteByRef.set(k, note.body);
  }
  ctx.actions.emit('decorations.changed');
  return notes;
}

function useReader(ctx: PluginContext): ReaderContext {
  const [r, setR] = useState<ReaderContext>(ctx.reader.current);
  useEffect(() => {
    const d = ctx.reader.onDidChange(setR);
    return () => d.dispose();
  }, [ctx]);
  return r;
}

function NotesPanel({ ctx }: { ctx: PluginContext }) {
  const reader = useReader(ctx);
  const [notes, setNotes] = useState<{ key: string; note: Note }[]>([]);
  const [scopeAll, setScopeAll] = useState(false);
  useEffect(() => {
    const reload = () => loadNotes(ctx).then(setNotes);
    void reload();
    const sub = ctx.actions.on('decorations.changed', reload);
    return () => sub.dispose();
  }, [ctx]);
  const shown = scopeAll ? notes : notes.filter((n) => n.note.book === reader.book);
  return (
    <div className="plugin-notes" style={{ padding: 12 }}>
      <Checkbox size="xs" label="all books" checked={scopeAll} onChange={(e) => setScopeAll(e.currentTarget.checked)} mb="sm" />
      {!shown.length && <Text c="dimmed" size="sm">No notes{scopeAll ? '' : ' for this book'} yet — use a verse’s ⋯ menu → “Add note”.</Text>}
      <Stack gap="sm">
        {shown.map(({ key, note }) => (
          <div key={key}>
            <Group justify="space-between" wrap="nowrap">
              <Anchor
                size="sm"
                href={ctx.ui.href(note.book, note.ref)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  ctx.ui.navigate(note.book, note.ref);
                }}
              >
                {note.book} <span className="comm-ref">{note.ref}</span>
              </Anchor>
              <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Delete note" onClick={async () => { await ctx.storage.delete(key); await refreshNotes(ctx); }}>×</ActionIcon>
            </Group>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{note.body}</Text>
          </div>
        ))}
      </Stack>
    </div>
  );
}

export default definePlugin({
  manifest: { id: 'notes', name: 'Notes', version: '3.0.0', apiVersion: '^1', permissions: ['storage'], activationEvents: ['onBook:*'], description: 'Personal notes attached to verses.' },
  activate(ctx) {
    void refreshNotes(ctx);
    ctx.contribute('viewer', 'verseAction', {
      id: 'notes.add',
      label: 'Add note',
      icon: '📝',
      run: async (v: Verse) => {
        const body = window.prompt(`Note on ${v.book} ${v.ref}:`)?.trim();
        if (!body) return;
        const note: Note = { book: v.book, ref: v.ref, body, at: Date.now() };
        await ctx.storage.set(keyOf(note), note);
        await refreshNotes(ctx);
        ctx.ui.showToast('Note saved');
      },
    });
    ctx.contribute('viewer', 'sidebar', { id: 'notes', title: 'Notes', render: () => <NotesPanel ctx={ctx} /> });
    ctx.contribute('viewer', 'decoration', {
      id: 'notes.pins',
      provide: (seg: Segment): Decoration[] => {
        if (seg.primary === false) return []; // render the pin once per verse (on the first column), not per edition
        const k = `${seg.book} ${seg.ref}`;
        if (!noteRefs.has(k)) return [];
        return [{ kind: 'lineWidget', render: () => <button type="button" className="note-pin" onClick={() => ctx.ui.showToast(noteByRef.get(k) ?? 'Note')}>📝 note</button> }];
      },
    });
  },
});
