import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  getToc,
  getLocalBookIds,
  getEditions,
  getContent,
  getLinks,
  ensureBook,
  wipe,
  sqliteVersion,
} from './db/client';
import type { TocRow, Edition, ContentRow, LinkRef } from './db/types';
import './app.css';

const SEP = '';

function searchFor(book: string, ref: string | null): string {
  const p = new URLSearchParams();
  p.set('book', book);
  if (ref) p.set('ref', ref);
  return `?${p.toString()}`;
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
  const cmp = (a: TreeNode, b: TreeNode) =>
    (a.order_index ?? 0) - (b.order_index ?? 0) || a.id.localeCompare(b.id);
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

const refNum = (ref: string) => ref.split(':').map((x) => Number(x) || 0);
const depth = (ref: string) => ref.split(':').length;

export default function App() {
  const [params, setParams] = useSearchParams();
  const book = params.get('book');
  const ref = params.get('ref');
  const edKey = params.getAll('ed').join(SEP); // selected editions live in the URL

  const [toc, setToc] = useState<TocRow[] | null>(null);
  const [local, setLocal] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState('');
  const [editions, setEditions] = useState<Edition[]>([]);
  const [content, setContent] = useState<ContentRow[] | null>(null);
  const [links, setLinks] = useState<Record<string, LinkRef[]>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshLocal = useCallback(async () => setLocal(new Set(await getLocalBookIds())), []);

  useEffect(() => {
    (async () => {
      try {
        setVersion(await sqliteVersion());
        setToc(await getToc());
        await refreshLocal();
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [refreshLocal]);

  useEffect(() => {
    if (!book) {
      setContent(null);
      setEditions([]);
      setLinks({});
      return;
    }
    let cancelled = false;
    (async () => {
      setError(null);
      setContent(null);
      setEditions([]);
      setLinks({});
      setBusy(true);
      setProgress(null);
      try {
        await ensureBook(book, (p) => {
          if (p.total) setProgress(Math.round((p.received / p.total) * 100));
        });
        await refreshLocal();
        const [eds, rows, linkMap] = await Promise.all([
          getEditions(book),
          getContent(book),
          getLinks(book),
        ]);
        if (cancelled) return;
        setEditions(eds);
        setContent(rows);
        setLinks(linkMap);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book, refreshLocal]);

  // Selected editions (ordered) = the URL `ed` params, validated against the book; default to a
  // Hebrew edition + a translation if none are in the URL yet.
  const shown = useMemo(() => {
    const valid = (edKey ? edKey.split(SEP) : []).filter((id) => editions.some((e) => e.id === id));
    if (valid.length) return valid;
    // Default: an English translation on the left, a Hebrew edition on the right.
    const he = editions.find((e) => e.lang === 'he');
    const en = editions.find((e) => e.lang === 'en') ?? editions.find((e) => e.lang !== 'he');
    return [en?.id, he?.id].filter((x): x is string => !!x);
  }, [edKey, editions]);

  const setEd = useCallback(
    (ids: string[]) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.delete('ed');
          ids.forEach((id) => p.append('ed', id));
          return p;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  useEffect(() => {
    if (!ref || !content) return;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`.verse[data-ref="${ref}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1600);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [ref, content]);

  const tree = useMemo(() => (toc ? buildTree(toc) : []), [toc]);
  const selectedNode = useMemo(() => toc?.find((t) => t.id === book) ?? null, [toc, book]);

  const onWipe = useCallback(async () => {
    await wipe();
    location.reload();
  }, []);

  return (
    <div className="app">
      <header>
        <h1>
          Torah <span className="sub">· browser SQLite</span>
        </h1>
        <div className="meta">
          {version && <span data-testid="sqlite-version">SQLite {version}</span>}
          <button onClick={onWipe} className="wipe">
            Wipe local DB
          </button>
        </div>
      </header>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <div className="layout">
        <nav className="catalog" aria-label="Catalog">
          {!toc && <p className="muted">Loading catalog…</p>}
          {tree.map((node) => (
            <Tree key={node.id} node={node} local={local} selected={book} depth={0} />
          ))}
        </nav>

        <main className="viewer">
          {!selectedNode && <p className="muted">Select a book to download &amp; read.</p>}
          {selectedNode && (
            <>
              <h2>
                {selectedNode.title_en}
                {selectedNode.title_he && <span className="he"> · {selectedNode.title_he}</span>}
              </h2>
              {busy && (
                <p className="muted" data-testid="status">
                  {progress !== null ? `Downloading… ${progress}%` : 'Loading…'}
                </p>
              )}
              {editions.length > 0 && (
                <EditionBar editions={editions} shown={shown} onSetEd={setEd} />
              )}
              {content && (
                <Verses
                  rows={content}
                  editions={editions}
                  selected={shown}
                  links={links}
                  onCommentaryLoaded={refreshLocal}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function Tree({
  node,
  local,
  selected,
  depth,
}: {
  node: TreeNode;
  local: Set<string>;
  selected: string | null;
  depth: number;
}) {
  if (node.kind === 'category') {
    return (
      <div className="cat">
        <div className="cat-label" style={{ paddingLeft: depth * 14 }}>
          {node.category_en}
          {node.category_he && <span className="he"> {node.category_he}</span>}
        </div>
        {node.children.map((c) => (
          <Tree key={c.id} node={c} local={local} selected={selected} depth={depth + 1} />
        ))}
      </div>
    );
  }
  const isLocal = local.has(node.id);
  return (
    <Link
      to={{ search: searchFor(node.id, null) }}
      className={`book${selected === node.id ? ' active' : ''}`}
      style={{ paddingLeft: depth * 14 + 8 }}
      data-testid={`book-${node.id}`}
    >
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

function EditionBar({
  editions,
  shown,
  onSetEd,
}: {
  editions: Edition[];
  shown: string[];
  onSetEd: (ids: string[]) => void;
}) {
  const byId = useMemo(() => new Map(editions.map((e) => [e.id, e])), [editions]);
  const available = editions.filter((e) => !shown.includes(e.id));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) {
      onSetEd(arrayMove(shown, shown.indexOf(active.id as string), shown.indexOf(over.id as string)));
    }
  };

  return (
    <div className="edition-bar" role="group" aria-label="Editions">
      <span className="edition-bar-label">Editions (drag to reorder):</span>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shown} strategy={horizontalListSortingStrategy}>
          <div className="edition-chips">
            {shown.map((id) => {
              const e = byId.get(id);
              return e ? (
                <SortableChip
                  key={id}
                  edition={e}
                  onRemove={() => onSetEd(shown.filter((x) => x !== id))}
                />
              ) : null;
            })}
          </div>
        </SortableContext>
      </DndContext>
      {available.length > 0 && (
        <div className="edition-add">
          <span className="edition-bar-label">add:</span>
          {available.map((e) => (
            <button
              key={e.id}
              type="button"
              className="edition-chip add"
              onClick={() => onSetEd([...shown, e.id])}
              data-testid={`edition-${e.id}`}
              lang={e.lang}
            >
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: edition.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <span
      ref={setNodeRef}
      style={style}
      className={`edition-chip on${isDragging ? ' dragging' : ''}`}
      data-testid={`edition-${edition.id}`}
      lang={edition.lang}
    >
      <span className="chip-grip" {...attributes} {...listeners} aria-label="Drag to reorder">
        ⠿
      </span>
      {edition.title}
      <span className="edition-lang">{edition.lang}</span>
      <button type="button" className="chip-x" onClick={onRemove} aria-label="Remove edition">
        ×
      </button>
    </span>
  );
}

function Verses({
  rows,
  editions,
  selected,
  links,
  onCommentaryLoaded,
}: {
  rows: ContentRow[];
  editions: Edition[];
  selected: string[];
  links: Record<string, LinkRef[]>;
  onCommentaryLoaded: () => void;
}) {
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
    order.sort((a, b) => {
      const na = refNum(a);
      const nb = refNum(b);
      for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
      }
      return 0;
    });
    const grouped = new Map<string, string[]>();
    for (const r of order) {
      const ch = r.split(':')[0];
      (grouped.get(ch) ?? grouped.set(ch, []).get(ch)!).push(r);
    }
    return { byRef, grouped: [...grouped.entries()] };
  }, [rows]);

  return (
    <div className="verses">
      <p className="muted" data-testid="verse-count">
        {chapters.byRef.size} verses · {chapters.grouped.length} chapters
        {!selected.length && ' · add an edition above'}
      </p>
      {chapters.grouped.map(([ch, refs]) => (
        <section key={ch} className="chapter">
          <h3>Chapter {ch}</h3>
          {refs.map((r) => {
            const texts = chapters.byRef.get(r)!;
            const vlinks = links[r];
            const toCommentary = !!vlinks?.length && depth(vlinks[0].otherRef) > depth(r);
            return (
              <div className="verse" key={r} data-ref={r}>
                <span className="vref">{r}</span>
                <div className="vbody">
                  <div className="cols" style={{ ['--cols' as string]: selected.length || 1 }}>
                    {selected.map((id) => {
                      const he = langOf.get(id) === 'he';
                      return (
                        <p
                          key={id}
                          className={`col ${he ? 'he' : 'en'}`}
                          dir={he ? 'rtl' : 'ltr'}
                          dangerouslySetInnerHTML={{ __html: texts[id] ?? '' }}
                        />
                      );
                    })}
                  </div>
                  {vlinks?.length ? (
                    toCommentary ? (
                      <Commentary links={vlinks} refTag={r} onLoaded={onCommentaryLoaded} />
                    ) : (
                      <div className="baselinks">
                        {vlinks.map((l) => (
                          <Link
                            key={`${l.otherId}-${l.otherRef}`}
                            to={{ search: searchFor(l.otherId, l.otherRef) }}
                            className="comm-link"
                          >
                            ↗ {l.otherId} {l.otherRef}
                          </Link>
                        ))}
                      </div>
                    )
                  ) : null}
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

type CommentItem = { bookId: string; source: string; ref: string; he?: string; en?: string };

function Commentary({
  links,
  refTag,
  onLoaded,
}: {
  links: LinkRef[];
  refTag: string;
  onLoaded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<CommentItem[] | null>(null);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (items || loading) return;

    setLoading(true);
    try {
      const byBook = new Map<string, string[]>();
      for (const l of links) {
        const arr = byBook.get(l.otherId) ?? [];
        arr.push(l.otherRef);
        byBook.set(l.otherId, arr);
      }
      const out: CommentItem[] = [];
      for (const [bookId, refs] of byBook) {
        await ensureBook(bookId);
        const [eds, rows] = await Promise.all([getEditions(bookId), getContent(bookId)]);
        const heEd = eds.find((e) => e.lang === 'he')?.id;
        const enEd = eds.find((e) => e.lang === 'en')?.id;
        const wanted = new Set(refs);
        const byRef = new Map<string, { he?: string; en?: string }>();
        for (const row of rows) {
          if (!wanted.has(row.ref)) continue;
          const e = byRef.get(row.ref) ?? {};
          if (row.edition_id === heEd) e.he = row.text;
          else if (row.edition_id === enEd) e.en = row.text;
          byRef.set(row.ref, e);
        }
        const source = bookId.includes(' on ') ? bookId.split(' on ')[0] : bookId;
        for (const r of refs) {
          const e = byRef.get(r);
          if (e) out.push({ bookId, source, ref: r, ...e });
        }
      }
      out.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
      setItems(out);
      onLoaded();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="commentary">
      <button
        type="button"
        className="comm-toggle"
        onClick={toggle}
        aria-expanded={open}
        data-testid={`comm-${refTag}`}
      >
        {open ? '▾' : '▸'} {links.length} commentary
      </button>
      {open && (
        <div className="comm-body">
          {loading && !items && <span className="muted">Loading commentary…</span>}
          {items?.map((it, i) => (
            <div className="comm-item" key={`${it.bookId}-${it.ref}-${i}`}>
              <Link to={{ search: searchFor(it.bookId, it.ref) }} className="comm-link comm-src">
                {it.source} <span className="comm-ref">{it.ref}</span> ↗
              </Link>
              {it.he && <p className="he" dir="rtl" dangerouslySetInnerHTML={{ __html: it.he }} />}
              {it.en && <p className="en" dangerouslySetInnerHTML={{ __html: it.en }} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
