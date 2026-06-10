# torah-llm

A multi-source Torah library that runs **entirely in the browser**. A tiny table-of-contents
DB boots instantly; each book's text is split into a small SQLite slice and fetched **on demand**
into persistent browser storage (SQLite-WASM over the OPFS SAH-pool VFS), shared across tabs —
instead of shipping one giant database.

Each book is one **canonical** entry (keyed by title) with many **editions** — source × language ×
version — shown side by side and reorderable. Sources are pinned in
[`sources.lock.json`](./sources.lock.json) and ingested by adapters in `ingest/sources/`
(Sefaria, OpenScriptures WLC, Orayta).

## Develop

```bash
npm install
npm run data    # fetch pinned source subset → build master → slice into public/db/
npm run dev     # http://localhost:5173
```

`npm run data` = `fetch:subset → build:master → slice`. Fetched corpora and built DBs live in
`./data` + `./public/db` (gitignored — clones stay small; `sources.lock.json` records which source
versions to build from). Sources are cached in `./data`; delete a folder there to re-fetch it.

## Project state

**[`LLM/0.index.md`](./LLM/0.index.md) is the living dashboard** — current state, what works, what's
next — backed by the indexed work log in [`LLM/`](./LLM) (decisions, data sources, milestones).
Anyone (or any LLM) picking this up should start there; this README is only the quickstart.
