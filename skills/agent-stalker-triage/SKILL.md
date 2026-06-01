---
name: agent-stalker-triage
description: Analyze agent-stalker sessions that were flagged for triage in the dashboard. Use when the user runs /agent-stalker-triage, asks to triage flagged sessions, or wants a pain analysis of sessions flagged via the "Flag for triage" button in the agent-stalker Insights dashboard. Reads each flagged session's digest, scores its workflow pain, and writes the result back so the dashboard displays it — no API key required.
---

# Agent Stalker Triage

Triage the agent-stalker sessions a user flagged from the Insights dashboard.
The dashboard's "Flag for triage" button marks sessions; this skill does the
actual analysis **in the current Claude Code session** (no Anthropic API key,
no extra cost) and writes results back so the dashboard shows them.

The data interface is the `stalker` query CLI shipped with the plugin. Run it
with bun via the plugin root:

```
bun "${CLAUDE_PLUGIN_ROOT}/lib/query.ts" <command> [options]
```

## Workflow

1. **Read the queue.** Run:
   ```
   bun "${CLAUDE_PLUGIN_ROOT}/lib/query.ts" triage-queue
   ```
   This prints each flagged session as a `===== SESSION <id> =====` block
   followed by a compact digest (USER prompts, ERROR lines, ASSISTANT turns,
   TOOL calls). If it prints `(no sessions flagged for triage)`, tell the user
   there is nothing to triage and stop.

2. **Analyze each flagged session.** From its digest, judge the workflow pain
   and produce three things:
   - `pain_score`: an integer 1–5 (1 = smooth, 5 = very painful — lots of
     errors, retries, thrash, or the user clearly stuck/frustrated).
   - `summary`: one sentence describing what happened.
   - `root_cause`: a short phrase naming the main source of pain (e.g.
     "flaky test setup", "permission errors", "API contract mismatch"). Use
     "none" if the session was smooth.

3. **Write results back.** For each session, run:
   ```
   bun "${CLAUDE_PLUGIN_ROOT}/lib/query.ts" triage-save --session <id> --score <1-5> --summary "<one sentence>" --root-cause "<short phrase>"
   ```
   Quote the `--summary` and `--root-cause` values so multi-word text is passed
   as one argument. This marks the session `analyzed` and the dashboard's
   Triage panel will show the pain score, summary, and root cause.

4. **Report.** Give the user a brief ranked rundown of what you triaged
   (highest pain first) and note that the dashboard now reflects it.

## Notes

- Process every flagged session returned by `triage-queue`, one `triage-save`
  call each. Don't skip any silently — if a digest is empty, save a low score
  with summary "no digestible activity".
- This skill never calls an external API. All reasoning happens here in the
  current Claude Code session; only the structured result is written to the
  local SQLite DB via `triage-save`.
- `${CLAUDE_PLUGIN_ROOT}` resolves to the installed agent-stalker plugin
  directory. If it is unset in your shell, locate the plugin's `lib/query.ts`
  and call it with the same subcommands.
