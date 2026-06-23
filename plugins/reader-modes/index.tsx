// Reader modes — a RENDERER plugin: it contributes whole reading views via the editor registry, proving
// that plugins (not just the core) can own the rendering. Two editors:
//   • Tikkun (תיקון קוראים) — leining mode: a scroll column with nikud + te'amim stripped (like ktav STaM)
//     beside a vocalized "check" column. Toggles persist via ctx.config.
//   • Mikraot Gedolot (מקראות גדולות) — pick which linked sources (commentaries, targum, midrash, …) wrap
//     the text, then read a pasuk centered with your chosen sources fetched + laid around it.
// Self-fetches via ctx.data (data:read); dormant until a book opens (onBook:*).
import { useEffect, useMemo, useState } from 'react';
import { definePlugin, type BookView, type PluginContext, type ReaderContext, type EditorProps } from '../../src/plugins/types';

const RTL = /^(he|arc|yi)/;
// Strip tags AND decode HTML entities (e.g. &thinsp;) into real text via the DOM — so the columns show
// clean letters, not literal entity strings (we render text nodes, not innerHTML).
const toText = (html: string) => {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent ?? '';
};
// Hebrew combining marks: U+0591–U+05AF are te'amim (cantillation); U+05B0–U+05C7 add nikud + punctuation.
const TEAMIM = /[֑-֯]/g;
const ALL_POINTS = /[֑-ׇ]/g;

// Local ref ordering (chapter:verse[:comment], daf 2a/2b) — mirrors the core reader's sort.
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

const hebrewEdition = (view: BookView) =>
  view.editions.find((e) => view.reader.selected.includes(e.id) && RTL.test(e.lang)) ??
  view.editions.find((e) => RTL.test(e.lang));

// Group connection types into readable buckets (commentary first).
const typeLabel = (t: string) => {
  const k = (t || '').toLowerCase();
  if (k.includes('comment')) return 'Commentary';
  if (k.includes('targum')) return 'Targum';
  if (k.includes('midrash')) return 'Midrash';
  if (k.includes('quotation')) return 'Quotation';
  if (k.includes('related')) return 'Related';
  return t ? t[0].toUpperCase() + t.slice(1) : 'Reference';
};
const TYPE_RANK: Record<string, number> = { Commentary: 0, Targum: 1, Midrash: 2, Quotation: 3, Related: 4, Reference: 8 };
const typeRank = (label: string) => TYPE_RANK[label] ?? 6;

// The classic Mikraot Gedolot companions — preferred as the default selection when present (otherwise we
// fall back to the most-linked commentaries). The user can change the set via the ⚙ Sources selector.
const CANON = ['Targum Onkelos', 'Targum Jonathan', 'Rashi', 'Rashbam', 'Ibn Ezra', 'Ramban', 'Sforno', 'Or HaChaim', 'Kli Yakar', 'Chizkuni', "Da'at Zekenim", 'Bekhor Shor', 'Radak', 'Tur HaArokh'];
function defaultSources(sources: { id: string; type: string; count: number }[], book: string): string[] {
  const rankCanon = (id: string) => {
    const i = CANON.findIndex((c) => id.startsWith(`${c} `));
    return i < 0 ? 99 : i;
  };
  // Commentaries/targum ON the current book (e.g. "Rashi on Genesis", not "Rashi on Isaiah") — canonical
  // companions first, then by link count.
  const here = sources.filter((s) => book && s.id.includes(book) && /comment|targum/i.test(s.type));
  here.sort((a, b) => rankCanon(a.id) - rankCanon(b.id) || b.count - a.count);
  if (here.length) return here.slice(0, 8).map((s) => s.id);
  return sources.filter((s) => /comment/i.test(s.type)).sort((a, b) => b.count - a.count).slice(0, 6).map((s) => s.id);
}

// ---- Tikkun (leining) ------------------------------------------------------------------------
function TikkunReader({ view, ctx }: { view: BookView; ctx: PluginContext }) {
  const [showCheck, setShowCheck] = useState<boolean>(() => ctx.config.get<boolean>('tikkun.check', true) ?? true);
  const [teamim, setTeamim] = useState<boolean>(() => ctx.config.get<boolean>('tikkun.teamim', true) ?? true);
  const save = (key: string, v: boolean, setter: (b: boolean) => void) => {
    setter(v);
    ctx.config.set(key, v);
  };

  const heEd = useMemo(() => hebrewEdition(view), [view.editions, view.reader.selected]);
  // Precompute the three text forms once per verse (decode + strip), so toggling options is instant.
  const chapters = useMemo(() => {
    if (!heEd) return [] as [string, { ref: string; scroll: string; full: string; noTeam: string }[]][];
    const byCh = new Map<string, { ref: string; scroll: string; full: string; noTeam: string }[]>();
    for (const r of view.content ?? []) {
      if (r.edition_id !== heEd.id) continue;
      const full = toText(r.text);
      const ch = r.ref.split(':')[0];
      (byCh.get(ch) ?? byCh.set(ch, []).get(ch)!).push({
        ref: r.ref,
        scroll: full.replace(ALL_POINTS, ''), // consonants only — the scroll/STaM side
        full, // vocalized + cantillated — the check side
        noTeam: full.replace(TEAMIM, ''), // vocalized, cantillation removed
      });
    }
    for (const arr of byCh.values()) arr.sort((a, b) => cmpRef(a.ref, b.ref));
    return [...byCh.entries()].sort((a, b) => cmpRef(a[1][0]?.ref ?? a[0], b[1][0]?.ref ?? b[0]));
  }, [view.content, heEd]);

  if (!heEd) return <p className="muted">Tikkun needs a Hebrew edition — none is available for this book.</p>;
  return (
    <div className="tikkun">
      <div className="tikkun-bar">
        <strong>תיקון קוראים · Tikkun</strong>
        <label>
          <input type="checkbox" checked={showCheck} onChange={(e) => save('tikkun.check', e.target.checked, setShowCheck)} /> check column
        </label>
        <label>
          <input type="checkbox" checked={teamim} disabled={!showCheck} onChange={(e) => save('tikkun.teamim', e.target.checked, setTeamim)} /> cantillation
        </label>
      </div>
      {chapters.map(([ch, rows]) => (
        <section key={ch} className="chapter">
          <h3>{ch}</h3>
          {rows.map((r) => (
            <div className={`tikkun-verse${showCheck ? ' two' : ''}`} key={r.ref} data-ref={r.ref}>
              <span className="vref">{r.ref}</span>
              <p className="tikkun-scroll" dir="rtl">
                {r.scroll}
              </p>
              {showCheck && (
                <p className="tikkun-check" dir="rtl">
                  {teamim ? r.full : r.noTeam}
                </p>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// ---- Mikraot Gedolot --------------------------------------------------------------------------
// IMPORTANT: this editor must work off WHOLE-BOOK data, not the paginated render window. Since 036 the
// host passes view.content/view.links as only the currently-loaded section, so MG fetches its own verse
// ladder + link/source metadata via ctx.data (book-wide, text-free). It also renders a single focused
// pasuk, so it declares managesOwnScroll (the host then doesn't drive its infinite-scroll sentinels).
function MikraotGedolot({ view, ctx }: { view: BookView; ctx: PluginContext }) {
  const book = view.reader.book ?? '';
  const heEd = useMemo(() => hebrewEdition(view), [view.editions, view.reader.selected]);
  const enEd = useMemo(
    () => view.editions.find((e) => view.reader.selected.includes(e.id) && e.lang === 'en'),
    [view.editions, view.reader.selected]
  );

  // The whole-book verse ladder (text-free), so prev/next walks the entire book — not just the loaded window.
  const [verses, setVerses] = useState<string[]>([]);
  useEffect(() => {
    if (!book) return setVerses([]);
    let cancelled = false;
    ctx.data
      .query('SELECT DISTINCT ref FROM content WHERE toc_id = ?', [book])
      .then((rows) => !cancelled && setVerses((rows as { ref: string }[]).map((r) => r.ref).sort(cmpRef)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [book, ctx]);

  // Every distinct linked source across the WHOLE book (id, type, count) — aggregated server-side, text-free.
  const [sources, setSources] = useState<{ id: string; type: string; count: number }[]>([]);
  useEffect(() => {
    if (!book) return setSources([]);
    let cancelled = false;
    ctx.data
      .query(
        `SELECT other AS id, connection_type AS type, COUNT(*) AS count FROM (
           SELECT to_id AS other, connection_type FROM links WHERE from_id = ?
           UNION ALL
           SELECT from_id AS other, connection_type FROM links WHERE to_id = ?
         ) GROUP BY other, connection_type`,
        [book, book]
      )
      .then((rows) => {
        if (cancelled) return;
        const m = new Map<string, { type: string; count: number }>();
        for (const r of rows as { id: string; type: string | null; count: number }[]) {
          const t = r.type ?? 'reference';
          const e = m.get(r.id);
          if (e) {
            e.count += r.count;
            if (typeRank(typeLabel(t)) < typeRank(typeLabel(e.type))) e.type = t; // keep the source's best type
          } else {
            m.set(r.id, { type: t, count: r.count });
          }
        }
        setSources([...m.entries()].map(([id, v]) => ({ id, type: v.type, count: v.count })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [book, ctx]);

  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!view.reader.ref) return;
    const i = verses.indexOf(view.reader.ref);
    if (i >= 0) setIdx(i);
  }, [view.reader.ref, verses]);
  const ref = verses[Math.min(idx, verses.length - 1)] ?? '';

  // Base text of the focused pasuk — fetched directly (the verse may be outside the host's loaded window).
  const [base, setBase] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!book || !ref) return setBase({});
    let cancelled = false;
    ctx.data
      .getSegment(book, ref)
      .then((rows) => {
        if (cancelled) return;
        const m: Record<string, string> = {};
        for (const r of rows) m[r.edition_id] = r.text;
        setBase(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [book, ref, ctx]);

  // Selection is per-book (a Genesis layout shouldn't carry to Exodus); null = not yet chosen for this book.
  const [selected, setSelected] = useState<string[] | null>(() => ctx.config.get<string[]>(`mg.sources:${book}`) ?? null);
  useEffect(() => {
    setSelected(ctx.config.get<string[]>(`mg.sources:${book}`) ?? null);
  }, [book, ctx]);
  useEffect(() => {
    if (selected === null && sources.length) setSelected(defaultSources(sources, book));
  }, [sources, selected, book]);
  const chosen = selected ?? [];
  const toggle = (id: string) =>
    setSelected((prev) => {
      const base = prev ?? [];
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      ctx.config.set(`mg.sources:${book}`, next); // an explicit per-book choice (even empty) is remembered
      return next;
    });

  const [showSel, setShowSel] = useState(false);
  const [filter, setFilter] = useState('');

  // Linked refs for the focused verse, grouped by chosen source — fetched directly (not from the window).
  const [focusLinks, setFocusLinks] = useState<Map<string, string[]>>(new Map());
  useEffect(() => {
    if (!book || !ref) return setFocusLinks(new Map());
    let cancelled = false;
    ctx.data
      .query(
        `SELECT to_id AS id, to_ref AS oref FROM links WHERE from_id = ? AND from_ref = ?
         UNION ALL
         SELECT from_id AS id, from_ref AS oref FROM links WHERE to_id = ? AND to_ref = ?`,
        [book, ref, book, ref]
      )
      .then((rows) => {
        if (cancelled) return;
        const m = new Map<string, string[]>();
        for (const r of rows as { id: string; oref: string }[]) (m.get(r.id) ?? m.set(r.id, []).get(r.id)!).push(r.oref);
        for (const a of m.values()) a.sort(cmpRef);
        setFocusLinks(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [book, ref, ctx]);

  const groups = useMemo(() => [...focusLinks.entries()].filter(([id]) => chosen.includes(id)), [focusLinks, chosen]);

  // Load commentary text for the focused verse — ONLY from books already downloaded (no silent auto-download,
  // matching the app's no-autodownload policy). Selected-but-missing sources get an explicit Download button;
  // sources that error are surfaced (not silently dropped) with a retry.
  const [comms, setComms] = useState<{ id: string; text: string }[]>([]);
  const [needDl, setNeedDl] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [dlNonce, setDlNonce] = useState(0);
  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    setLoading(true);
    setComms([]);
    setNeedDl([]);
    setFailed([]);
    (async () => {
      const out: { id: string; text: string }[] = [];
      const missing: string[] = [];
      const errored: string[] = [];
      for (const [id, refs] of groups) {
        try {
          if (!(await ctx.data.hasLocalContent(id))) {
            missing.push(id);
            continue;
          }
          const parts: string[] = [];
          for (const r of refs) {
            const rows = await ctx.data.getSegment(id, r);
            const t = rows.map((x) => toText(x.text)).join(' ').trim();
            if (t) parts.push(t);
          }
          const text = parts.join(' ').trim();
          if (text) out.push({ id, text });
        } catch {
          errored.push(id);
        }
        if (cancelled) return;
      }
      if (!cancelled) {
        setComms(out);
        setNeedDl(missing);
        setFailed(errored);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ref, groups, ctx, dlNonce]);

  const [downloading, setDownloading] = useState<string | null>(null);
  const downloadSource = async (id: string) => {
    setDownloading(id);
    try {
      await ctx.data.ensureBook(id);
      setDlNonce((n) => n + 1); // re-run the load now that it's local
    } catch {
      setFailed((f) => (f.includes(id) ? f : [...f, id]));
    } finally {
      setDownloading(null);
    }
  };

  // The selector list: sources grouped by type, filterable, sorted commentary-first then by link count.
  const groupedSources = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const byType = new Map<string, { id: string; count: number }[]>();
    for (const s of sources) {
      if (f && !s.id.toLowerCase().includes(f)) continue;
      const label = typeLabel(s.type);
      (byType.get(label) ?? byType.set(label, []).get(label)!).push({ id: s.id, count: s.count });
    }
    for (const arr of byType.values()) arr.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    return [...byType.entries()].sort((a, b) => typeRank(a[0]) - typeRank(b[0]) || a[0].localeCompare(b[0]));
  }, [sources, filter]);

  if (!verses.length) return <p className="muted">Loading…</p>;
  const baseHe = heEd ? base[heEd.id] ?? '' : '';
  const baseEn = enEd ? base[enEd.id] ?? '' : '';
  return (
    <div className="mg">
      <div className="mg-bar">
        <strong>מקראות גדולות · Mikraot Gedolot</strong>
        <button type="button" className="mg-src-toggle" onClick={() => setShowSel((s) => !s)} aria-expanded={showSel}>
          ⚙ Sources ({chosen.length})
        </button>
        <span className="mg-nav">
          <button type="button" disabled={idx <= 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>
            ‹ prev
          </button>
          <span className="comm-ref">{ref}</span>
          <button type="button" disabled={idx >= verses.length - 1} onClick={() => setIdx((i) => Math.min(verses.length - 1, i + 1))}>
            next ›
          </button>
        </span>
      </div>

      {showSel && (
        <div className="mg-sources">
          <input
            className="plugin-search-input"
            placeholder={`Filter ${sources.length} linked sources…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="mg-sources-list">
            {groupedSources.map(([type, items]) => (
              <div key={type} className="mg-src-group">
                <div className="mg-src-group-head">
                  {type} <span className="muted">({items.length})</span>
                </div>
                {items.map((s) => (
                  <label key={s.id} className="mg-src-item">
                    <input type="checkbox" checked={chosen.includes(s.id)} onChange={() => toggle(s.id)} /> {s.id}{' '}
                    <span className="muted">· {s.count}</span>
                  </label>
                ))}
              </div>
            ))}
            {!groupedSources.length && <p className="muted">No linked sources{filter ? ' match your filter' : ''}.</p>}
          </div>
        </div>
      )}

      <div className="mg-base">
        {baseHe && (
          <p className="col he" dir="rtl">
            {toText(baseHe)}
          </p>
        )}
        {baseEn && <p className="col en">{toText(baseEn)}</p>}
      </div>

      <div className="mg-comms">
        {loading && <p className="muted">Loading your sources…</p>}
        {!loading && !chosen.length && <p className="muted">Open ⚙ Sources to choose the commentaries (and targum, midrash, …) that wrap the text.</p>}
        {comms.map((c, i) => (
          <div className="mg-comm" key={`${c.id}:${i}`}>
            <div className="mg-comm-src">{c.id}</div>
            <p className="col he" dir="rtl">
              {c.text}
            </p>
          </div>
        ))}
        {/* Selected sources that link this verse but aren't downloaded — explicit per-source download (no autodownload). */}
        {needDl.map((id) => (
          <div className="mg-comm mg-comm-needdl" key={`dl:${id}`}>
            <div className="mg-comm-src">{id}</div>
            <button type="button" className="mg-dl-btn" disabled={downloading === id} onClick={() => downloadSource(id)}>
              {downloading === id ? 'Downloading…' : '↓ Download to show'}
            </button>
          </div>
        ))}
        {failed.map((id) => (
          <div className="mg-comm mg-comm-failed" key={`err:${id}`}>
            <div className="mg-comm-src">{id}</div>
            <span className="muted">couldn’t load · </span>
            <button type="button" className="mg-dl-btn" onClick={() => downloadSource(id)}>retry</button>
          </div>
        ))}
        {!loading && chosen.length > 0 && !comms.length && !needDl.length && !failed.length && (
          <p className="muted">None of your selected sources comment on this verse.</p>
        )}
      </div>
    </div>
  );
}

export default definePlugin({
  manifest: {
    id: 'reader-modes',
    name: 'Reader Modes',
    version: '1.0.0',
    apiVersion: '^1',
    description: 'Leining (Tikkun) and Mikraot Gedolot reading views — custom renderers.',
    permissions: ['data:read'],
    activationEvents: ['onBook:*'], // reading modes only matter once a book is open
  },
  activate(ctx) {
    ctx.contribute('viewer', 'editor', {
      id: 'tikkun',
      title: 'Tikkun',
      icon: '📜',
      canRender: (reader: ReaderContext) => (reader.book && reader.editions.some((e) => RTL.test(e.lang)) ? 70 : 0),
      render: ({ view }: EditorProps) => <TikkunReader view={view} ctx={ctx} />,
    });
    ctx.contribute('viewer', 'editor', {
      id: 'mikraot-gedolot',
      title: 'Mikraot Gedolot',
      managesOwnScroll: true, // renders a single focused pasuk → host must not drive infinite-scroll sentinels
      icon: '📖',
      canRender: (reader: ReaderContext) => (reader.book ? 45 : 0),
      render: ({ view }: EditorProps) => <MikraotGedolot view={view} ctx={ctx} />,
    });
  },
});
