# Meta-Analysis of Agentic Workflows — Design

**Date:** 2026-05-31
**Status:** Approved (design) — pending implementation plan
**Author:** brainstorming session

## Goal

Use the data agent-stalker already captures to surface **pockets of high
thrash, churn, errors, and token usage** across agentic workflows. Make those
pockets findable through the existing web dashboard, and add an **opt-in
semantic/AI layer** (frustration detection, topic modeling, error clustering,
agent pivot/retry detection, and LLM session triage) for the fuzzier insights.

## Context: what data exists today

Live DB at session start: 103 MB, 69 sessions, ~55k events, 1.7k agents, 288
tasks, 2.7k task_events, spanning 2026-03-09 → 2026-05-31.

**Structured signals already captured**
- Tool-use events: ~22.5k `PreToolUse`, ~22k `PostToolUse`, **430
  `PostToolUseFailure`** (errors).
- `task_events`: status-change history (thrash signal for tasks).
- `agents` rows with `transcript_path` (subagents only, today).
- `Edit`/`Write` events store full `tool_input` (so `file_path` is reliable).

**Natural-language text already captured**
- ~1.1k user prompts (`UserPromptSubmit.data.prompt`, untruncated).
- ~2.3k subagent "last assistant message" texts.
- Task subjects/descriptions, error payloads, truncated tool I/O.
- ≈3.4k NL documents total — workable for topic modeling.

**Known gap:** actual **token counts are not captured**. Hook payloads don't
include usage; only the transcript JSONL files do. Confirmed transcripts
contain real usage including cache:
```json
"usage":{"input_tokens":6,"cache_creation_input_tokens":42336,
         "cache_read_input_tokens":0,"output_tokens":199,...}
```

## Architecture (Approach A: derived-tables contract)

The **SQLite file is the contract.** TS writes raw capture + structured
metrics; Python reads raw and writes `semantic_*` tables; the dashboard reads
both and hides semantic panels when those tables are empty. No live
cross-language calls.

```
┌─────────────── core plugin (TS/Bun, always on) ───────────────┐
│  hooks/tracker.ts ─► lib/ingest.ts ─► SQLite (agent-stalker.db) │
│    + capture additions:                                        │
│      • store main-session transcript_path on sessions          │
│      • usage table from transcript parsing (Phase 2)           │
└────────────────────────────────────────────────────────────────┘
                              │ reads/writes
        ┌─────────────────────┴──────────────────────┐
        ▼                                             ▼
┌──────────────────────────┐          ┌──────────────────────────────┐
│ lib/analytics/ (TS)      │          │ analysis/ (Python, OPT-IN)    │
│  churn / errors / thrash │          │  batch job, reads same DB:    │
│  / pivot-loops / proxies │          │   sentiment → semantic_*      │
│  → analytics API         │          │   BERTopic / error-clusters   │
└───────────┬──────────────┘          │   pivot confirm / LLM triage  │
            │                          └───────────────┬──────────────┘
            ▼                                          │ writes derived tables
┌─────────────────────────────────────────────────────┴──────────────┐
│ ui/  "Insights" view — reads SQLite (structured always; semantic_*  │
│       only when present). "Enable semantic features" button checks  │
│       python+deps and triggers the batch.                           │
└─────────────────────────────────────────────────────────────────────┘
```

**Why A:** dashboard is always functional (semantic data is just present or
absent), the language boundary is a dead-simple DB contract, it works offline,
and it matches "opt-in, ships with plugin."

### Core capture additions (small, TS)
- Persist the **main session's** `transcript_path` on `sessions` (today only
  subagents keep it). Needed for token parsing and future message-level work.
- Add a test locking in that user prompts and `Stop` assistant messages stay
  **untruncated** (they currently flow through `handleGeneric` un-truncated).
- Everything else (errors, task_events, tool I/O) is already captured.

## Phasing

The work is a program, not a single build. Each phase ships and proves useful
on its own. Most "where's the pain" answers fall out of Phase 1 with zero
Python.

- **Phase 1** — Structured signals + Insights dashboard (TS only).
- **Phase 2** — Token research spike + `usage` table (TS).
- **Phase 3** — Semantic sidecar (Python, opt-in): frustration, topics, error
  clusters, pivot confirmation.
- **Phase 4** — LLM session triage (further opt-in, own toggle).

## Phase 1 — Structured metrics (`lib/analytics/`, TS)

Computed via SQL over `events` / `task_events`. Primary unit = **session**;
also rolls up by **file**, **tool**, **agent**, later **topic**. All tunable
thresholds (windows, weights) live in one config block — no magic numbers.

**1. Errors**
- *Error event* = `hook_event_name = 'PostToolUseFailure'` **or** an event
  whose `data.error` is non-null. `is_interrupt` tracked separately
  (user-initiated, not a failure).
- *Error rate (session)* = error events ÷ total tool calls (PostToolUse count).
- Roll-ups by tool, by file (file_path from `tool_input`), by session. Rank by
  raw count and rate.

**2. Churn (file rework)**
- For `Edit`/`Write`/`MultiEdit`, extract `file_path` from `data.tool_input`
  (these use the `"full"` content rule).
- *Churn(file)* = edit-event count touching it; *session churn* = files edited
  ≥ N times in one session.
- *Re-edit gap* = time between successive edits of the same file; short median
  gap = back-and-forth rework. Rank files by edit count, sessions by re-edits.

**3. Thrash / pivot-loops** (structured first)
- *Error→retry chain*: a `PostToolUseFailure` for tool **T** on target **X**,
  followed within a window (default 2 min, same agent) by another call to **T**
  on **X**. Chain length = thrash depth.
- *Tool retry*: ≥3 near-consecutive calls of the same tool on the same target
  by one agent within the window.
- *Task bouncing*: from `task_events`, count `status_change`s per task and flag
  any that **re-enter a prior status** (e.g. `in_progress→blocked→in_progress`,
  `completed→reopened`).
- *Interleaved rework*: file A → other edits → file A again (ping-pong).
- A "pivot loop" = a window where error rate spikes **and** same-target retries
  cluster. Semantic confirmation layered on in Phase 3; structured version
  stands alone.
- **Target matching:** match on `file_path` for file tools and a normalized
  `command`/key for others; exact-equality first, fuzzy later.

**4. Token / effort proxy** (placeholder until Phase 2)
- Per session/agent: total events, tool-call count, summed bytes of stored
  `data`, distinct files touched, wall-clock duration (first→last event).
  Blended into an "effort" estimate.
- *Honest caveat:* stored content is already truncated per content-rules, and
  `Read`/`Grep` are metadata-stripped, so the byte proxy **undercounts
  unevenly**. It is a rank-ordering hint, not a measurement. Replaced by real
  tokens from Phase 2.

**5. Composite pain score** (sorts the hotspots leaderboard)
- Per session (and per file/topic): weighted blend of normalized **error rate +
  churn + thrash depth + effort/tokens**.
- Weights are **explicit and shown in the UI** so a high score is always
  explainable ("ranked high: 8 error→retry chains, 4× re-edited `server.ts`"),
  never a black box. Ship sensible defaults; do not auto-learn.

### Dashboard (extends existing `ui/`)
- New **Insights** view reads SQLite via new analytics API endpoints.
- Panels: pain leaderboard (sessions ranked, with the explainer breakdown),
  file-churn ranking, error breakdown (by tool/file/cluster), pivot-loop
  timeline.
- Semantic panels render only when `semantic_*` tables are populated.

## Phase 2 — Token research spike + `usage` table (TS)

Timeboxed spike. Output = a short decision note + a parser. Questions it
answers: capture the **main-session** `transcript_path`; map transcript
messages → our `events`/`sessions`; handle format drift; dedupe on re-runs.

Deliverable table:
```
usage(session_id, agent_id, message_uuid, role,
      input_tokens, cache_creation_input_tokens,
      cache_read_input_tokens, output_tokens, timestamp)
```
Populated incrementally by `message_uuid`. **Run timing:** on-demand plus
`SessionEnd` (no daemon). Once present, the structured layer swaps the
byte-proxy for real tokens in the pain score automatically.

## Phase 3 — Semantic sidecar (`analysis/`, Python, opt-in)

Self-contained Python package shipped with the plugin, CLI-driven
(`python -m analysis run --features …`), reads the same SQLite via stdlib
`sqlite3`, writes only `semantic_*` tables. **Full stack** dependencies
(BERTopic + sentence-transformers, which pulls torch) — heavy, which is exactly
why it is opt-in. A "lite" no-torch path (VADER + TF-IDF/KMeans) is a
documented future fallback, not built now. **Full recompute per feature** each
run (dataset is small); replace the table each run — incremental only if it
ever gets slow.

Provenance: `semantic_meta(feature, version, model, last_run_at, corpus_size)`
drives "computed Nh ago / stale" badges and a Recompute button.

### Derived tables (Python writes, TS reads)
| Table | Holds |
|---|---|
| `semantic_meta` | per-feature provenance (version, model, last_run_at, corpus_size) |
| `semantic_sentiment` | per-doc score+label (prompts, assistant msgs) → frustration |
| `semantic_topics` / `semantic_topic_assignments` | BERTopic topics + per-doc topic + prob |
| `semantic_error_clusters` / `semantic_error_assignments` | error-message clusters + labels |
| `semantic_pivot_signals` | semantic confirmation of structured pivot windows |
| `semantic_session_triage` | LLM triage output (Phase 4) |

### Shared corpus extractor
Pulls + cleans docs from `events`, each tagged with session/agent/timestamp:
user prompts (`UserPromptSubmit.data.prompt`), assistant messages
(`Stop`/`SubagentStop.last_assistant_message`), task subjects/descriptions,
error payloads.

### Features
1. **Frustration detection** — sentiment over prompts (+ assistant msgs) →
   per-doc + per-session affect; the session aggregate feeds the pain score.
2. **Topic clustering** — BERTopic over the combined corpus → topics, then
   **correlated with pain** so the UI ranks "topics that hurt most," not just
   topics.
3. **Error clustering** — sentence-transformer embeddings + HDBSCAN over error
   messages → labeled clusters (recurring failure modes), ranked by
   frequency × session-spread.
4. **Agent pivot confirmation** — takes the *structured* pivot windows from
   Phase 1, pulls agent messages in each window, classifies "reporting error /
   trying multiple approaches" → confidence + evidence, **upgrading** the
   structured signal rather than replacing it.

### Enable-button flow
"Enable semantic features" → server runs `python -m analysis check`; if deps
missing, show install instructions; if present, kick off the batch as a
background job, poll status, then reveal the semantic panels. `semantic_meta`
drives stale/recompute. Dashboard degrades gracefully — panels don't render
when their table is empty.

## Phase 4 — LLM session triage (further opt-in, own toggle)

For an eligible/selected session, build a compact digest from events, call the
Claude API → `{pain_score, summary, root_cause}` into
`semantic_session_triage`. Gated separately: needs `ANTHROPIC_API_KEY`, costs
tokens per run; the UI shows a cost estimate before running. Uses the latest
Claude models per project convention.

## Testing strategy

- **Phase 1 (TS):** unit-test each metric against a seeded fixture DB with
  known thrash/churn/error patterns; assert ranks and the pain-score breakdown.
  Test file_path extraction across tool shapes and the retry-window edge cases.
- **Phase 2 (TS):** parser tested against a captured transcript fixture; assert
  token sums and idempotent re-runs (dedupe by `message_uuid`).
- **Phase 3 (Python):** test the corpus extractor and table writers against a
  fixture SQLite; smoke-test each feature produces well-formed `semantic_*`
  rows. Heavy model downloads stay out of CI (mark/skip).
- **Dashboard:** test that semantic panels hide when tables are empty and
  render when present; analytics endpoints return expected shapes.

## Error handling

- Analytics endpoints tolerate missing/partial data (active sessions, null
  fields) and never 500 on absent `semantic_*` tables.
- The semantic batch fails per-feature, not all-or-nothing; `semantic_meta`
  records last success per feature.
- Transcript parser tolerates format drift (unknown fields ignored, missing
  usage skipped, logged).
- "Enable" button surfaces a clear message when Python/deps are absent rather
  than failing silently.

## Distribution

Ship the `analysis/` package and a `requirements.txt` with the plugin. The TS
dashboard and structured metrics work with no Python installed; semantic
features are strictly opt-in via the dashboard button.

## Open items deferred (YAGNI)

- "Lite" no-torch semantic path — documented fallback, not built.
- Incremental semantic recompute — only if full recompute gets slow.
- Auto-learned pain-score weights — explicit defaults instead.
- Fuzzy target matching for retry chains — exact-equality first.
