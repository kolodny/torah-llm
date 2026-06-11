// The "viewer" page — the reader. It declares viewer slots that plugins contribute to:
//   viewer:editor       — a reader mode (Grid/Flow built-in; Tikkun/MG from reader-modes)
//   viewer:sidebar      — a right-rail panel (search, notes)
//   viewer:onTextSelect — a contributor to the selected-text tooltip (gematria)
//   viewer:verseAction  — an item in a verse's ⋯ menu
//   viewer:linkAction   — an action on a cross-reference link
//   viewer:decoration   — handled in workbench/segment.tsx (gematria highlight, note pins)
// No autodownload: a book renders only if it's already local; otherwise the page prompts to download.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable, sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SegmentedControl, Tabs, Menu, ActionIcon, Button, Paper, Group, Loader } from '@mantine/core';
import { getToc, getLocalBookIds, getEditions, getContent, getSiblings, getLinks, getMeta, ensureBook } from '../db/client';
import type { TocRow, Edition, ContentRow, LinkRef } from '../db/types';
import { coreContext, useSlot, usePublishReader } from '../plugins/host';
import type { ReaderContext, BookView, EditorDef, Verse, VerseAction, LinkInfo, LinkAction, SidebarPanel, TextSelectAction, TextSelection } from '../plugins/types';
import { useWorkbench } from '../workbench/store';
import { SegmentText } from '../workbench/segment';

function searchFor(book: string, ref: string | null): string {
  const p = new URLSearchParams();
  p.set('page', 'viewer');
  p.set('book', book);
  if (ref) p.set('ref', ref);
  return `?${p.toString()}`;
}

function usePeek() {
  const { dispatch } = useWorkbench();
  const setPeek = useCallback((book: string, ref: string | null) => dispatch({ type: 'peek', book, ref }), [dispatch]);
  const clearPeek = useCallback(() => dispatch({ type: 'clearPeek' }), [dispatch]);
  return { setPeek, clearPeek };
}

const opensFull = (e: MouseEvent) => e.metaKey || e.ctrlKey;

function parseSefariaRef(dataRef: string): { book: string; ref: string } | null {
  const s = (dataRef || '').trim();
  const i = s.lastIndexOf(' ');
  if (i < 1) return null;
  const book = s.slice(0, i).trim();
  const ref = s.slice(i + 1).split(/[-–]/)[0].trim();
  return book && ref ? { book, ref } : null;
}

type TreeNode = TocRow & { children: TreeNode[] };
function buildTree(rows: TocRow[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  rows.forEach((r) => byId.set(r.id, { ...r, children: [] }));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const cmp = (a: TreeNode, b: TreeNode) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id.localeCompare(b.id);
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort(cmp);
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

const fmtBytes = (n: number | null) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

const refNum = (ref: string) =>
  ref.split(':').map((x) => {
    const m = /^(\d+)([ab])?$/.exec(x);
    return m ? Number(m[1]) * 2 + (m[2] === 'b' ? 1 : 0) : Number(x) || 0;
  });
const cmpRef = (a: string, b: string) => {
  const na = refNum(a);
  const nb = refNum(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
const RTL_LANGS = new Set(['he', 'arc', 'yi', 'ar', 'jrb']);

// === the page ================================================================================
export default function ViewerPage() {
  const { state, dispatch } = useWorkbench();
  const { book, ref } = state;

  const [toc, setToc] = useState<TocRow[] | null>(null);
  const [local, setLocal] = useState<Set<string>>(new Set());
  const [editions, setEditions] = useState<Edition[]>([]);
  const [content, setContent] = useState<ContentRow[] | null>(null);
  const [links, setLinks] = useState<Record<string, LinkRef[]>>({});
  const [sections, setSections] = useState<string[]>([]);
  const [notLocal, setNotLocal] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshLocal = useCallback(async () => setLocal(new Set(await getLocalBookIds())), []);
  useEffect(() => {
    (async () => {
      try {
        setToc(await getToc());
        await refreshLocal();
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [refreshLocal]);

  const loadBookData = useCallback(async (b: string) => {
    const [eds, rows, linkMap, meta] = await Promise.all([getEditions(b), getContent(b), getLinks(b), getMeta(b)]);
    setEditions(eds);
    setContent(rows);
    setLinks(linkMap);
    setSections(meta.sectionNames);
  }, []);

  useEffect(() => {
    if (!book) {
      setContent(null);
      setEditions([]);
      setLinks({});
      setSections([]);
      setNotLocal(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setError(null);
      setContent(null);
      setEditions([]);
      setLinks({});
      setSections([]);
      setNotLocal(false);
      try {
        const rows = await getContent(book); // local check — NO autodownload
        if (cancelled) return;
        if (!rows.length) {
          setNotLocal(true);
          return;
        }
        await loadBookData(book);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book, loadBookData]);

  const download = useCallback(async () => {
    if (!book) return;
    setDownloading('…');
    try {
      await ensureBook(book, (p) => setDownloading(p.total ? `${Math.round((p.received / p.total) * 100)}%` : `${(p.received / 1e6).toFixed(1)} MB`));
      await loadBookData(book);
      await refreshLocal();
      setNotLocal(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(null);
    }
  }, [book, loadBookData, refreshLocal]);

  const shown = useMemo(() => {
    const valid = state.selectedEditionIds.filter((id) => editions.some((e) => e.id === id));
    if (valid.length) return valid;
    const he = editions.find((e) => e.lang === 'he');
    const en = editions.find((e) => e.lang === 'en') ?? editions.find((e) => e.lang !== 'he');
    return [en?.id, he?.id].filter((x): x is string => !!x);
  }, [state.selectedEditionIds, editions]);
  const setEd = useCallback((ids: string[]) => dispatch({ type: 'setEditions', ids }), [dispatch]);

  // scroll-to + flash the focused ref
  useEffect(() => {
    if (!ref || !content) return;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`.verse[data-ref="${window.CSS.escape(ref)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('flash');
        void el.offsetWidth; // force reflow so the animation restarts if we re-navigate to the same verse
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 3000);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [ref, content]);

  const tree = useMemo(() => (toc ? buildTree(toc) : []), [toc]);
  const selectedNode = useMemo(() => toc?.find((t) => t.id === book) ?? null, [toc, book]);
  const openPath = useMemo(() => {
    const s = new Set<string>();
    if (!toc || !book) return s;
    const byId = new Map(toc.map((t) => [t.id, t] as const));
    let cur = byId.get(book)?.parent_id ?? null;
    while (cur) {
      s.add(cur);
      cur = byId.get(cur)?.parent_id ?? null;
    }
    return s;
  }, [toc, book]);

  const readerCtx = useMemo<ReaderContext>(() => ({ book, ref, editions, selected: shown }), [book, ref, editions, shown]);
  usePublishReader(readerCtx);
  const view = useMemo<BookView>(
    () => ({ reader: readerCtx, editions, content, links, sections, busy: !!downloading, setEditions: setEd }),
    [readerCtx, editions, content, links, sections, downloading, setEd]
  );

  const viewerRef = useRef<HTMLElement>(null);

  return (
    <div className="viewer-page">
      <nav className="catalog" aria-label="Catalog">
        {!toc && <p className="muted">Loading catalog…</p>}
        {tree.map((node) => (
          <Tree key={node.id} node={node} local={local} selected={book} depth={0} openPath={openPath} />
        ))}
      </nav>

      <main className="viewer" ref={viewerRef}>
        {error && <div className="error" role="alert">{error}</div>}
        {!selectedNode && <p className="muted">Select a book from the catalog. Manage downloads in the Storage tab.</p>}
        {selectedNode && (
          <>
            <h2>
              {selectedNode.title_en}
              {selectedNode.title_he && <span className="he"> · {selectedNode.title_he}</span>}
            </h2>
            {notLocal ? (
              <Paper withBorder p="lg" radius="md" mt="md" maw={520}>
                <p className="muted" style={{ marginTop: 0 }}>
                  <strong>{selectedNode.title_en}</strong> isn’t downloaded yet ({fmtBytes(selectedNode.file_size) || 'small'}).
                </p>
                <Group>
                  <Button onClick={download} loading={!!downloading} color="orange">
                    {downloading ? `Downloading ${downloading}` : 'Download this book'}
                  </Button>
                  <Button variant="default" onClick={() => dispatch({ type: 'setPage', id: 'storage' })}>
                    Manage in Storage
                  </Button>
                </Group>
              </Paper>
            ) : content ? (
              <EditorHost view={view} />
            ) : (
              <p className="muted" data-testid="status">
                <Loader size="xs" /> Loading…
              </p>
            )}
          </>
        )}
        <TextSelectTooltip containerRef={viewerRef} />
      </main>

      <ViewerSidebar peek={state.peek} reader={readerCtx} />
    </div>
  );
}

// === editor host (viewer:editor slot) =========================================================
function EditorHost({ view }: { view: BookView }) {
  const editors = useSlot<EditorDef>('viewer', 'editor');
  const { state, dispatch } = useWorkbench();
  const candidates = editors
    .map((e) => ({ e, score: e.canRender(view.reader) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) return <p className="muted">No reader available for this book.</p>;
  const chosen = candidates.find((c) => c.e.id === state.editorId)?.e ?? candidates[0].e;
  return (
    <>
      {candidates.length > 1 && (
        <SegmentedControl
          size="xs"
          mb="sm"
          value={chosen.id}
          onChange={(v) => dispatch({ type: 'setEditor', id: v })}
          data={candidates.map(({ e }) => ({ value: e.id, label: e.title }))}
        />
      )}
      {chosen.render({ view })}
    </>
  );
}

// === right rail: peek + sidebar panels (viewer:sidebar) =======================================
function ViewerSidebar({ peek, reader }: { peek: { book: string; ref: string | null } | null; reader: ReaderContext }) {
  const panels = useSlot<SidebarPanel>('viewer', 'sidebar');
  const [active, setActive] = useState<string | null>(null);
  void reader;
  const hasPeek = !!peek;
  const tabs = [...(hasPeek ? [{ id: '__peek', title: 'Preview' }] : []), ...panels.map((p) => ({ id: p.id, title: p.title }))];
  if (!tabs.length) return null;
  const current = tabs.some((t) => t.id === active) ? active! : hasPeek ? '__peek' : tabs[0].id;
  const panel = panels.find((p) => p.id === current);
  return (
    <aside className="viewer-side">
      <Tabs value={current} onChange={setActive} variant="outline">
        <Tabs.List>
          {tabs.map((t) => (
            <Tabs.Tab key={t.id} value={t.id}>{t.title}</Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>
      <div className="viewer-side-body">
        {current === '__peek' && peek ? <PeekPanel book={peek.book} refTag={peek.ref} /> : panel ? panel.render() : null}
      </div>
    </aside>
  );
}

// === selected-text tooltip (viewer:onTextSelect) ==============================================
function TextSelectTooltip({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const acts = useSlot<TextSelectAction>('viewer', 'onTextSelect');
  const { state } = useWorkbench();
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const onUp = () => {
      const s = window.getSelection();
      const text = s?.toString().trim() ?? '';
      const el = containerRef.current;
      if (!text || !s || s.rangeCount === 0 || !el) return setSel(null);
      const range = s.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return setSel(null);
      const r = range.getBoundingClientRect();
      setSel({ text, x: r.left + r.width / 2, y: r.top });
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, [containerRef]);

  if (!sel || !acts.length) return null;
  const selection: TextSelection = { text: sel.text, book: state.book, ref: state.ref };
  const items = acts.map((a) => ({ id: a.id, node: a.label(selection) })).filter((x) => x.node != null);
  if (!items.length) return null;
  return createPortal(
    <Paper
      className="select-tooltip"
      shadow="md"
      withBorder
      p="xs"
      style={{ position: 'fixed', left: sel.x, top: sel.y - 10, transform: 'translate(-50%, -100%)', zIndex: 400 }}
    >
      {items.map((i) => (
        <div key={i.id} className="select-tooltip-item">{i.node}</div>
      ))}
    </Paper>,
    document.body
  );
}

// === catalog tree =============================================================================
function Tree({ node, local, selected, depth, openPath }: { node: TreeNode; local: Set<string>; selected: string | null; depth: number; openPath: Set<string> }) {
  if (node.kind === 'category') return <Category node={node} local={local} selected={selected} depth={depth} openPath={openPath} />;
  const isLocal = local.has(node.id);
  return (
    <Link to={{ search: searchFor(node.id, null) }} className={`book${selected === node.id ? ' active' : ''}`} style={{ paddingLeft: depth * 14 + 8 }} data-testid={`book-${node.id}`}>
      <span className="book-title">
        {node.title_en}
        {node.title_he && <span className="he"> {node.title_he}</span>}
      </span>
      <span className="book-meta">
        {isLocal ? '✓ local' : `↓ ${fmtBytes(node.file_size)}`}
        {node.edition_count > 1 ? ` · ${node.edition_count} ed.` : ''}
      </span>
    </Link>
  );
}

function Category({ node, local, selected, depth, openPath }: { node: TreeNode; local: Set<string>; selected: string | null; depth: number; openPath: Set<string> }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = openPath.has(node.id) || (override ?? false);
  return (
    <div className="cat">
      <button type="button" className="cat-label" style={{ paddingLeft: depth * 14 }} onClick={() => setOverride(!open)} aria-expanded={open}>
        <span className="cat-arrow">{open ? '▾' : '▸'}</span> {node.category_en}
        {node.category_he && <span className="he"> {node.category_he}</span>}
        <span className="cat-count"> {node.children.length}</span>
      </button>
      {open && node.children.map((c) => <Tree key={c.id} node={c} local={local} selected={selected} depth={depth + 1} openPath={openPath} />)}
    </div>
  );
}

// === edition bar ==============================================================================
function editionTooltip(e: Edition): string {
  const tail = `${e.source} · ${e.lang}`;
  return e.info ? `${e.info} (${tail})` : `${e.title} (${tail})`;
}
function EditionBar({ editions, shown, onSetEd }: { editions: Edition[]; shown: string[]; onSetEd: (ids: string[]) => void }) {
  const byId = useMemo(() => new Map(editions.map((e) => [e.id, e])), [editions]);
  const available = editions.filter((e) => !shown.includes(e.id));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) onSetEd(arrayMove(shown, shown.indexOf(active.id as string), shown.indexOf(over.id as string)));
  };
  return (
    <div className="edition-bar" role="group" aria-label="Editions">
      <span className="edition-bar-label">Editions (drag to reorder):</span>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shown} strategy={horizontalListSortingStrategy}>
          <div className="edition-chips">
            {shown.map((id) => {
              const e = byId.get(id);
              return e ? <SortableChip key={id} edition={e} onRemove={() => onSetEd(shown.filter((x) => x !== id))} /> : null;
            })}
          </div>
        </SortableContext>
      </DndContext>
      {available.length > 0 && (
        <div className="edition-add">
          <span className="edition-bar-label">add:</span>
          {available.map((e) => (
            <button key={e.id} type="button" className="edition-chip add" onClick={() => onSetEd([...shown, e.id])} data-testid={`edition-${e.id}`} title={editionTooltip(e)} lang={e.lang}>
              + {e.title}
              <span className="edition-lang">{e.lang}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function SortableChip({ edition, onRemove }: { edition: Edition; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: edition.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  return (
    <span ref={setNodeRef} style={style} className={`edition-chip on${isDragging ? ' dragging' : ''}`} data-testid={`edition-${edition.id}`} title={editionTooltip(edition)} lang={edition.lang}>
      <span className="chip-grip" {...attributes} {...listeners} aria-label="Drag to reorder">⠿</span>
      {edition.title}
      <span className="edition-lang">{edition.lang}</span>
      <button type="button" className="chip-x" onClick={onRemove} aria-label="Remove edition">×</button>
    </span>
  );
}

// === verses ===================================================================================
function Verses({ rows, editions, selected, links, sections }: { rows: ContentRow[]; editions: Edition[]; selected: string[]; links: Record<string, LinkRef[]>; sections: string[] }) {
  const book = editions[0]?.toc_id ?? '';
  const langOf = useMemo(() => {
    const m = new Map<string, string>();
    editions.forEach((e) => m.set(e.id, e.lang));
    return m;
  }, [editions]);
  const chapters = useMemo(() => {
    const byRef = new Map<string, Record<string, string>>();
    const order: string[] = [];
    for (const r of rows) {
      let e = byRef.get(r.ref);
      if (!e) {
        e = {};
        byRef.set(r.ref, e);
        order.push(r.ref);
      }
      e[r.edition_id] = r.text;
    }
    order.sort(cmpRef);
    const grouped = new Map<string, string[]>();
    for (const r of order) {
      const ch = r.split(':')[0];
      (grouped.get(ch) ?? grouped.set(ch, []).get(ch)!).push(r);
    }
    return { byRef, grouped: [...grouped.entries()] };
  }, [rows]);

  const { setPeek } = usePeek();
  const onRefClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const a = (e.target as HTMLElement).closest('a.refLink');
      if (!a) return;
      e.preventDefault();
      const parsed = parseSefariaRef(a.getAttribute('data-ref') || '');
      if (!parsed) return;
      if (opensFull(e)) window.open(searchFor(parsed.book, parsed.ref), '_blank');
      else setPeek(parsed.book, parsed.ref);
    },
    [setPeek]
  );

  const { gridIds, standaloneIds } = useMemo(() => {
    const counts = new Map<string, Map<string, number>>();
    const total = new Map<string, number>();
    const sel = new Set(selected);
    for (const r of rows) {
      if (!sel.has(r.edition_id)) continue;
      const m = counts.get(r.edition_id) ?? counts.set(r.edition_id, new Map()).get(r.edition_id)!;
      const p = r.ref.split(':').slice(0, -1).join(':');
      m.set(p, (m.get(p) ?? 0) + 1);
      total.set(r.edition_id, (total.get(r.edition_id) ?? 0) + 1);
    }
    const srcOf = new Map(editions.map((e) => [e.id, e.source] as const));
    const canon = selected
      .filter((id) => total.has(id))
      .sort((a, b) => (srcOf.get(b) === 'sefaria' ? 1 : 0) - (srcOf.get(a) === 'sefaria' ? 1 : 0) || (total.get(b) ?? 0) - (total.get(a) ?? 0))[0];
    if (!canon) return { gridIds: selected, standaloneIds: [] as string[] };
    const cc = counts.get(canon)!;
    const gridIds: string[] = [];
    const standaloneIds: string[] = [];
    for (const id of selected) {
      const m = counts.get(id);
      if (id === canon || !m) {
        gridIds.push(id);
        continue;
      }
      let shared = 0;
      let agree = 0;
      for (const [p, c] of m) if (cc.has(p)) { shared++; if (cc.get(p) === c) agree++; }
      if (shared >= 3 && agree / shared < 0.5) standaloneIds.push(id);
      else gridIds.push(id);
    }
    return { gridIds, standaloneIds };
  }, [rows, selected, editions]);

  return (
    <div className="verses" onClick={onRefClick}>
      <p className="muted" data-testid="verse-count">
        {chapters.byRef.size} verses · {chapters.grouped.length} chapters
        {!selected.length && ' · add an edition above'}
        {standaloneIds.length > 0 && ` · ${standaloneIds.length} shown separately (different segmentation)`}
      </p>
      {chapters.grouped.map(([ch, refs]) => (
        <section key={ch} className="chapter">
          <h3>{sections[0] ?? 'Chapter'} {ch}</h3>
          {refs.map((r) => {
            const texts = chapters.byRef.get(r)!;
            const vlinks = links[r];
            return (
              <div className="verse" key={r} data-ref={r}>
                <span className="vref">{r}</span>
                <VerseMenu verse={{ book, ref: r, texts, editions }} />
                <div className="vbody">
                  <div className="cols" style={{ ['--cols' as string]: gridIds.length || 1 }}>
                    {gridIds.map((id) => {
                      const he = RTL_LANGS.has(langOf.get(id) ?? '');
                      return <SegmentText key={id} book={book} segRef={r} editionId={id} lang={langOf.get(id) ?? ''} html={texts[id] ?? ''} className={`col ${he ? 'he' : 'en'}`} dir={he ? 'rtl' : 'ltr'} />;
                    })}
                  </div>
                  {vlinks?.length ? <VerseLinks links={vlinks} refTag={r} book={book} /> : null}
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {standaloneIds.map((id) => {
        const e = editions.find((ed) => ed.id === id);
        return e ? <StandaloneEdition key={id} edition={e} rows={rows.filter((r) => r.edition_id === id)} /> : null;
      })}
    </div>
  );
}

function StandaloneEdition({ edition, rows }: { edition: Edition; rows: ContentRow[] }) {
  const grouped = useMemo(() => {
    const byRef = new Map<string, string>();
    const order: string[] = [];
    for (const r of rows) {
      if (!byRef.has(r.ref)) order.push(r.ref);
      byRef.set(r.ref, r.text);
    }
    order.sort(cmpRef);
    const g = new Map<string, string[]>();
    for (const r of order) {
      const ch = r.split(':')[0];
      (g.get(ch) ?? g.set(ch, []).get(ch)!).push(r);
    }
    return { byRef, grouped: [...g.entries()] };
  }, [rows]);
  const rtl = RTL_LANGS.has(edition.lang);
  return (
    <section className="standalone">
      <div className="standalone-head">
        {edition.title} <span className="edition-lang">{edition.lang}</span>
        <span className="muted"> · shown separately (its own segmentation)</span>
      </div>
      {grouped.grouped.map(([ch, refs]) => (
        <div className="chapter" key={ch}>
          <h3>{ch}</h3>
          {refs.map((r) => (
            <div className="verse" key={r} data-ref={r}>
              <span className="vref">{r}</span>
              <SegmentText book={edition.toc_id} segRef={r} editionId={edition.id} lang={edition.lang} html={grouped.byRef.get(r) ?? ''} className={`col ${rtl ? 'he' : 'en'}`} dir={rtl ? 'rtl' : 'ltr'} />
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

const LINK_TYPE_LABEL: Record<string, string> = {
  commentary: 'Commentary', targum: 'Targum', midrash: 'Midrash', quotation: 'Quotation', quotation_auto: 'Quotation',
  reference: 'Reference', related: 'Related', 'related passage': 'Related', 'mesorat hashas': 'Mesorat HaShas',
  'ein mishpat': 'Ein Mishpat', 'ein mishpat / ner mitsvah': 'Ein Mishpat',
};
const linkTypeLabel = (t: string) => LINK_TYPE_LABEL[t.toLowerCase()] ?? (t ? t[0].toUpperCase() + t.slice(1) : 'Reference');

function VerseLinks({ links, refTag, book }: { links: LinkRef[]; refTag: string; book: string }) {
  const [open, setOpen] = useState(false);
  const { setPeek } = usePeek();
  const groups = useMemo(() => {
    const m = new Map<string, LinkRef[]>();
    for (const l of links) {
      const t = linkTypeLabel(l.connectionType || 'reference');
      (m.get(t) ?? m.set(t, []).get(t)!).push(l);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.otherId.localeCompare(b.otherId) || a.otherRef.localeCompare(b.otherRef, undefined, { numeric: true }));
    const rank: Record<string, number> = { Commentary: 0, Targum: 1, Midrash: 2, Quotation: 3, Related: 4, 'Mesorat HaShas': 5, Reference: 8 };
    return [...m.entries()].sort((a, b) => (rank[a[0]] ?? 6) - (rank[b[0]] ?? 6) || b[1].length - a[1].length);
  }, [links]);
  return (
    <div className="verse-links">
      <button type="button" className="links-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid={`links-${refTag}`}>
        {open ? '▾' : '▸'} {links.length} link{links.length === 1 ? '' : 's'}
        <span className="links-summary">{' · '}{groups.map(([t, arr]) => `${arr.length} ${t.toLowerCase()}`).join(' · ')}</span>
      </button>
      {open && (
        <div className="links-body">
          {groups.map(([type, arr]) => (
            <div className="link-group" key={type}>
              <div className="link-group-head">{type} <span className="muted">({arr.length})</span></div>
              <ul className="link-list">
                {arr.map((l, i) => (
                  <li key={`${l.otherId}|${l.otherRef}|${i}`}>
                    <Link
                      to={{ search: searchFor(l.otherId, l.otherRef) }}
                      className="comm-link"
                      onClick={(e) => {
                        if (opensFull(e)) return;
                        e.preventDefault();
                        setPeek(l.otherId, l.otherRef);
                      }}
                    >
                      {l.otherId} <span className="comm-ref">{l.otherRef}</span>
                    </Link>
                    <LinkActions link={{ from: { book, ref: refTag }, to: { book: l.otherId, ref: l.otherRef }, connectionType: l.connectionType }} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// === verse ⋯ menu (viewer:verseAction) + link actions (viewer:linkAction) =====================
function VerseMenu({ verse }: { verse: Verse }) {
  const acts = useSlot<VerseAction>('viewer', 'verseAction').filter((a) => !a.when || a.when(verse));
  if (!acts.length) return null;
  return (
    <span className="verse-menu">
      <Menu position="bottom-end" withinPortal shadow="md" width={180}>
        <Menu.Target>
          <ActionIcon className="verse-menu-btn" variant="subtle" color="gray" size="sm" aria-label="Verse actions">⋯</ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {acts.map((a) => (
            <Menu.Item key={a.id} leftSection={a.icon} onClick={() => a.run(verse)}>{a.label}</Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </span>
  );
}
function LinkActions({ link }: { link: LinkInfo }) {
  const acts = useSlot<LinkAction>('viewer', 'linkAction').filter((a) => !a.when || a.when(link));
  if (!acts.length) return null;
  return (
    <>
      {acts.map((a) => (
        <button key={a.id} type="button" className="link-action" onClick={() => a.run(link)}>{a.label}</button>
      ))}
    </>
  );
}

// === peek (inline link preview) ===============================================================
function PeekPanel({ book, refTag }: { book: string; refTag: string | null }) {
  const { setPeek, clearPeek } = usePeek();
  const [st, setSt] = useState<{ loading: boolean; error?: string; local: boolean; editions: Edition[]; segments: { ref: string; texts: Record<string, string> }[] }>({ loading: true, local: true, editions: [], segments: [] });

  const load = useCallback(async () => {
    if (!refTag) return setSt({ loading: false, local: true, editions: [], segments: [] });
    setSt({ loading: true, local: true, editions: [], segments: [] });
    const rows0 = await getContent(book);
    if (!rows0.length) return setSt({ loading: false, local: false, editions: [], segments: [] }); // not downloaded
    const [eds, rows] = await Promise.all([getEditions(book), getSiblings(book, refTag)]);
    const byRef = new Map<string, Record<string, string>>();
    for (const r of rows) (byRef.get(r.ref) ?? byRef.set(r.ref, {}).get(r.ref)!)[r.edition_id] = r.text;
    const segments = [...byRef.entries()].map(([ref, texts]) => ({ ref, texts })).sort((a, b) => cmpRef(a.ref, b.ref));
    setSt({ loading: false, local: true, editions: eds, segments });
  }, [book, refTag]);

  useEffect(() => {
    let cancelled = false;
    load().catch((e) => !cancelled && setSt({ loading: false, local: true, error: String(e), editions: [], segments: [] }));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onRefClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const a = (e.target as HTMLElement).closest('a.refLink');
      if (!a) return;
      e.preventDefault();
      const parsed = parseSefariaRef(a.getAttribute('data-ref') || '');
      if (!parsed) return;
      if (opensFull(e)) window.open(searchFor(parsed.book, parsed.ref), '_blank');
      else setPeek(parsed.book, parsed.ref);
    },
    [setPeek]
  );

  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (st.loading) return;
    bodyRef.current?.querySelector<HTMLElement>('.peek-linked')?.scrollIntoView({ block: 'center' });
  }, [st.loading, st.segments]);

  const shownEds = st.editions.filter((e) => st.segments.some((s) => s.texts[e.id]));
  const multi = st.segments.length > 1;
  return (
    <div className="peek" aria-label="Linked text preview">
      <div className="peek-head">
        <div className="peek-title">
          {book}
          {refTag && <span className="comm-ref"> {refTag}</span>}
        </div>
        <div className="peek-actions">
          <Link to={{ search: searchFor(book, refTag) }} className="comm-link" onClick={() => clearPeek()} title="Open full text">open ↗</Link>
          <button type="button" className="peek-close" onClick={clearPeek} aria-label="Close preview">✕</button>
        </div>
      </div>
      <div className="peek-body" onClick={onRefClick} ref={bodyRef}>
        {st.loading && <p className="muted">Loading…</p>}
        {st.error && <p className="error">{st.error}</p>}
        {!st.loading && !st.local && (
          <Paper withBorder p="md" radius="sm">
            <p className="muted" style={{ marginTop: 0 }}>“{book}” isn’t downloaded.</p>
            <Button size="xs" color="orange" onClick={() => ensureBook(book).then(load)}>Download to preview</Button>
          </Paper>
        )}
        {!st.loading && st.local && !st.error && shownEds.length === 0 && <p className="muted">No text for this reference.</p>}
        {st.segments.map((seg) => (
          <div className={`peek-seg${seg.ref === refTag ? ' peek-linked' : ''}`} key={seg.ref}>
            {multi && <div className="peek-segref">{seg.ref}</div>}
            {shownEds.map((e) =>
              seg.texts[e.id] ? (
                <SegmentText key={e.id} book={book} segRef={seg.ref} editionId={e.id} lang={e.lang} html={seg.texts[e.id]} className={`col ${RTL_LANGS.has(e.lang) ? 'he' : 'en'}`} dir={RTL_LANGS.has(e.lang) ? 'rtl' : 'ltr'} />
              ) : null
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// === continuous (Flow) reader =================================================================
function ContinuousReader({ view }: { view: BookView }) {
  const { content, editions, reader } = view;
  const primary = reader.selected[0];
  const ed = editions.find((e) => e.id === primary);
  const rtl = ed ? RTL_LANGS.has(ed.lang) : false;
  const chapters = useMemo(() => {
    const byCh = new Map<string, { ref: string; text: string }[]>();
    for (const r of content ?? []) {
      if (r.edition_id !== primary) continue;
      const ch = r.ref.split(':')[0];
      (byCh.get(ch) ?? byCh.set(ch, []).get(ch)!).push({ ref: r.ref, text: r.text });
    }
    for (const arr of byCh.values()) arr.sort((a, b) => cmpRef(a.ref, b.ref));
    return [...byCh.entries()].sort((a, b) => cmpRef(a[1][0]?.ref ?? a[0], b[1][0]?.ref ?? b[0]));
  }, [content, primary]);
  if (!primary) return <p className="muted">Select an edition to read.</p>;
  return (
    <div className="continuous">
      {chapters.map(([ch, verses]) => (
        <section key={ch} className="chapter">
          <h3>{ch}</h3>
          <p className={`col ${rtl ? 'he' : 'en'} flow`} dir={rtl ? 'rtl' : 'ltr'}>
            {verses.map((v) => (
              <span key={v.ref} className="flow-verse">
                <sup className="flow-num">{v.ref.split(':').slice(1).join(':') || v.ref}</sup>{' '}
                <span dangerouslySetInnerHTML={{ __html: v.text }} />{' '}
              </span>
            ))}
          </p>
        </section>
      ))}
    </div>
  );
}

// Register the core's built-in reader editors (Grid + Flow) through the same slot API plugins use.
coreContext.contribute('viewer', 'editor', {
  id: 'verses',
  title: 'Grid',
  icon: '▦',
  canRender: (r: ReaderContext) => (r.book ? 100 : 0),
  render: ({ view }: { view: BookView }) => (
    <>
      {view.editions.length > 0 && <EditionBar editions={view.editions} shown={view.reader.selected} onSetEd={view.setEditions} />}
      {view.content && <Verses rows={view.content} editions={view.editions} selected={view.reader.selected} links={view.links} sections={view.sections} />}
    </>
  ),
} as EditorDef);
coreContext.contribute('viewer', 'editor', {
  id: 'continuous',
  title: 'Flow',
  icon: '☰',
  canRender: (r: ReaderContext) => (r.book ? 50 : 0),
  render: ({ view }: { view: BookView }) => <ContinuousReader view={view} />,
} as EditorDef);
