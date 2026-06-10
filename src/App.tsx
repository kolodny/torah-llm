import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
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
  getMeta,
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

// Sefaria's embedded cross-reference anchors carry the CANONICAL ref in `data-ref` — e.g.
// "Tosafot on Bava Kamma 22b:2", "Deuteronomy 6:4-9", "I Chronicles 1:7": a book title (may contain
// spaces/parens) + a trailing ref token. (The `href` is an internal slug like
// "/Tosafot_on_Bava_Kamma.22b.2.1" — do NOT parse that.) Split at the last space; a range → start verse.
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

// Numeric sort key for a ref, handling Talmud daf ("2a"/"2b") as well as chapter:verse[:comment].
const refNum = (ref: string) =>
  ref.split(':').map((x) => {
    const m = /^(\d+)([ab])?$/.exec(x);
    return m ? Number(m[1]) * 2 + (m[2] === 'b' ? 1 : 0) : Number(x) || 0;
  });
// Scripts rendered right-to-left (Hebrew, Aramaic, Yiddish, Judeo-Arabic).
const RTL_LANGS = new Set(['he', 'arc', 'yi', 'ar', 'jrb']);

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
  const [sections, setSections] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
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
      setSections([]);
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
          setProgress(
            p.total ? `${Math.round((p.received / p.total) * 100)}%` : `${(p.received / 1e6).toFixed(1)} MB`
          );
        });
        await refreshLocal();
        const [eds, rows, linkMap, meta] = await Promise.all([
          getEditions(book),
          getContent(book),
          getLinks(book),
          getMeta(book),
        ]);
        if (cancelled) return;
        setEditions(eds);
        setContent(rows);
        setLinks(linkMap);
        setSections(meta.sectionNames);
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
  // Ancestor category ids of the selected book — these stay expanded so the active book is visible.
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
            <Tree key={node.id} node={node} local={local} selected={book} depth={0} openPath={openPath} />
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
                  {progress !== null ? `Downloading… ${progress}` : 'Loading…'}
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
                  sections={sections}
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
  openPath,
}: {
  node: TreeNode;
  local: Set<string>;
  selected: string | null;
  depth: number;
  openPath: Set<string>;
}) {
  if (node.kind === 'category') {
    return <Category node={node} local={local} selected={selected} depth={depth} openPath={openPath} />;
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

// Collapsible category — collapsed by default; auto-opens the selected book's ancestor chain.
function Category({
  node,
  local,
  selected,
  depth,
  openPath,
}: {
  node: TreeNode;
  local: Set<string>;
  selected: string | null;
  depth: number;
  openPath: Set<string>;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  // openPath (ancestors of the active book) forces-open so the selected book is always visible;
  // a manual toggle only adds expansion elsewhere (it can't hide the active path).
  const open = openPath.has(node.id) || (override ?? false);
  return (
    <div className="cat">
      <button
        type="button"
        className="cat-label"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOverride(!open)}
        aria-expanded={open}
      >
        <span className="cat-arrow">{open ? '▾' : '▸'}</span> {node.category_en}
        {node.category_he && <span className="he"> {node.category_he}</span>}
        <span className="cat-count"> {node.children.length}</span>
      </button>
      {open &&
        node.children.map((c) => (
          <Tree key={c.id} node={c} local={local} selected={selected} depth={depth + 1} openPath={openPath} />
        ))}
    </div>
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
              title={editionTooltip(e)}
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

// Hover text for an edition chip: its provenance/info, with source·lang context.
function editionTooltip(e: Edition): string {
  const tail = `${e.source} · ${e.lang}`;
  return e.info ? `${e.info} (${tail})` : `${e.title} (${tail})`;
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
      title={editionTooltip(edition)}
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
  sections,
}: {
  rows: ContentRow[];
  editions: Edition[];
  selected: string[];
  links: Record<string, LinkRef[]>;
  sections: string[];
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

  // Make Sefaria's embedded refLink anchors (in the verse/footnote HTML) navigate via the router.
  const [, setSearchParams] = useSearchParams();
  const onRefClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const a = (e.target as HTMLElement).closest('a.refLink');
      if (!a) return;
      e.preventDefault(); // hrefs are Sefaria-internal slugs ("/Book.Daf"); never let them navigate
      const parsed = parseSefariaRef(a.getAttribute('data-ref') || '');
      if (!parsed) return;
      const search = searchFor(parsed.book, parsed.ref);
      if (e.metaKey || e.ctrlKey) window.open(search, '_blank');
      else setSearchParams(new URLSearchParams(search.slice(1)));
    },
    [setSearchParams]
  );

  return (
    <div className="verses" onClick={onRefClick}>
      <p className="muted" data-testid="verse-count">
        {chapters.byRef.size} verses · {chapters.grouped.length} chapters
        {!selected.length && ' · add an edition above'}
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
                <div className="vbody">
                  <div className="cols" style={{ ['--cols' as string]: selected.length || 1 }}>
                    {selected.map((id) => {
                      const he = RTL_LANGS.has(langOf.get(id) ?? '');
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
                  {vlinks?.length ? <VerseLinks links={vlinks} refTag={r} /> : null}
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

// Cross-references for a verse: a collapsed, type-grouped list of links (commentary, reference,
// targum, quotation, …) — each a navigable link, no inline text dump. (A verse can have hundreds.)
const LINK_TYPE_LABEL: Record<string, string> = {
  commentary: 'Commentary',
  targum: 'Targum',
  midrash: 'Midrash',
  quotation: 'Quotation',
  quotation_auto: 'Quotation',
  reference: 'Reference',
  related: 'Related',
  'related passage': 'Related',
  'mesorat hashas': 'Mesorat HaShas',
  'ein mishpat': 'Ein Mishpat',
  'ein mishpat / ner mitsvah': 'Ein Mishpat',
};
const linkTypeLabel = (t: string) =>
  LINK_TYPE_LABEL[t.toLowerCase()] ?? (t ? t[0].toUpperCase() + t.slice(1) : 'Reference');

function VerseLinks({ links, refTag }: { links: LinkRef[]; refTag: string }) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => {
    const m = new Map<string, LinkRef[]>();
    for (const l of links) {
      const t = linkTypeLabel(l.connectionType || 'reference'); // merge synonyms (quotation/quotation_auto, related/related passage…)
      (m.get(t) ?? m.set(t, []).get(t)!).push(l);
    }
    for (const arr of m.values())
      arr.sort(
        (a, b) =>
          a.otherId.localeCompare(b.otherId) ||
          a.otherRef.localeCompare(b.otherRef, undefined, { numeric: true })
      );
    // Study-relevant types first; the large generic "reference" bucket last.
    const rank: Record<string, number> = { Commentary: 0, Targum: 1, Midrash: 2, Quotation: 3, Related: 4, 'Mesorat HaShas': 5, Reference: 8 };
    return [...m.entries()].sort((a, b) => (rank[a[0]] ?? 6) - (rank[b[0]] ?? 6) || b[1].length - a[1].length);
  }, [links]);

  return (
    <div className="verse-links">
      <button
        type="button"
        className="links-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid={`links-${refTag}`}
      >
        {open ? '▾' : '▸'} {links.length} link{links.length === 1 ? '' : 's'}
        <span className="links-summary">
          {' · '}
          {groups.map(([t, arr]) => `${arr.length} ${t.toLowerCase()}`).join(' · ')}
        </span>
      </button>
      {open && (
        <div className="links-body">
          {groups.map(([type, arr]) => (
            <div className="link-group" key={type}>
              <div className="link-group-head">
                {type} <span className="muted">({arr.length})</span>
              </div>
              <ul className="link-list">
                {arr.map((l, i) => (
                  <li key={`${l.otherId}|${l.otherRef}|${i}`}>
                    <Link to={{ search: searchFor(l.otherId, l.otherRef) }} className="comm-link">
                      {l.otherId} <span className="comm-ref">{l.otherRef}</span> ↗
                    </Link>
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
