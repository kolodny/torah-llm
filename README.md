# torah-llm

A platform for Torah content that runs **entirely in the browser**. The full Sefaria text
catalog is split into small per-book SQLite files; the app boots from a tiny table-of-contents
DB and downloads each book's chunk **on demand** into persistent browser storage (SQLite-WASM
over the OPFS SAH-pool VFS) — instead of shipping one giant database.

## How it works

```
GCS (gs://sefaria-export)  ──fetch──▶  ./sefaria  ──build──▶  db/master.sqlite
                                                       │
                                                       └──slice──▶  public/db/
                                                                      ├─ db.sqlite          (boot: TOC only)
                                                                      └─ toc_<title>.sqlite (one per book)

browser: load db.sqlite ─▶ browse catalog ─▶ click a book ─▶ fetch its slice ─▶
         ATTACH + INSERT OR IGNORE into the local DB ─▶ read it back with SQL
```

- **Stable string keys.** A book's TOC id is its English title (`Genesis`); categories use a
  path (`Tanakh / Torah`). Adding a new book never renumbers existing ids, so slice filenames
  and any saved references stay valid across catalog updates.

## Develop

```bash
npm install
npm run data     # fetch Torah subset from GCS → build master → slice  (≈ a few seconds)
npm run dev      # http://localhost:5173
```

`npm run data` is `fetch:subset` → `build:master` → `slice`. To refresh the source files,
`npm run fetch:subset -- --force`.

## Scope

Ships the **Torah** (Genesis–Deuteronomy) with **Rashi** commentary, Hebrew + English. Each verse
shows a commentary toggle; expanding it downloads that commentary's slice on demand and renders
the linked comments. Links are derived structurally from commentary↔base-text refs (a comment
`a:b:c` maps to base verse `a:b`) — no link CSVs — and only links whose endpoints are both in the
stripped master DB are kept. Expanding the corpus = fetching more titles in
`scripts/fetch-subset.ts`; Sefaria cross-reference links are a future addition.

See [`LLM/`](./LLM) for the indexed work log (decisions, data-source notes, milestones).
