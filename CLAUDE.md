# torah-llm — guidance for Claude

## Keep the `LLM/` work log current — it's the project's memory

`LLM/0.index.md` is the always-current dashboard. **Read it first** to see where the project stands
(architecture, current state, conventions, the Jewish-origin-sources-only policy).

Every substantial workload, decision, or milestone gets its own **self-contained**
`LLM/NNN.short-name.md` entry (NNN = the next number after the highest entry already in `LLM/`). After
adding one, update `0.index.md`:

- add a row to the **Items** table, and
- refresh the **Current state** section.

Entry shape (see any recent item, e.g. `027` or `031`): `# NNN — Title`, a `**Date:**` line, then
`## Why` and `## What shipped`. Each entry should make sense on its own. `0.index.md` is the dashboard,
never a numbered content item.

Do this **as you work, not at the end** — the log is how the next session picks up the thread. If you
notice it's fallen behind, backfill the missing entries from git history + the code.
