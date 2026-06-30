#!/usr/bin/env bash
# Stop hook — keep the LLM/ work log current (the project convention in CLAUDE.md).
#
# Fires when Claude tries to finish while the working tree has changes OUTSIDE LLM/ but nothing UNDER LLM/ —
# i.e. work happened that may not have been logged. It blocks the stop once and feeds a reminder back to
# Claude. Loop-safe: it bows out when `stop_hook_active` is set (so it nudges at most once per stop cycle) and
# when LLM/ was already touched this round. If the change is trivial or already logged, Claude just stops again.
#
# Wired up in .claude/settings.json. No jq dependency; never errors out (a crashing Stop hook would wrongly
# block stopping), so every unexpected condition just exits 0.

input=$(cat)

# Already continued once because of this hook → let Claude stop (prevents an infinite block loop).
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$dir" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

changes=$(git status --porcelain 2>/dev/null)
[ -z "$changes" ] && exit 0                          # nothing changed → nothing to log

# If any change already touches LLM/, assume it's handled this round.
if printf '%s\n' "$changes" | grep -q 'LLM/'; then
  exit 0
fi

reason="Reminder (CLAUDE.md): the working tree has changes but nothing under LLM/. If this was a substantial workload, decision, or milestone, add an LLM/NNN.short-name.md entry and refresh LLM/0.index.md (Items row + Current state) before wrapping up. If the change is trivial or already logged, just finish."

# Block this one stop and hand the reminder to Claude (the reason is shown to the model).
printf '{"decision":"block","reason":"%s"}\n' "$reason"
exit 0
