# Insights: Sortable Columns + Row Drill-in — Design

**Date:** 2026-06-01
**Status:** Approved (design) — pending implementation plan
**Branch:** feat/meta-analysis

## Goal

Make the Insights dashboard tables (a) sortable by column, and (b) drillable —
every row navigates to "the data point in context" so a user can go from an
aggregate ("this session is painful", "styles.css churned 54×", "this error
cluster recurs") to the underlying events/detail.

## Context: existing primitives to reuse

- **Event modal** — `showEventModal(eventId)` (`ui/js/modal.js`): detail view for
  one event, with prev/next over a navigable id list.
- **Task modal** — `showTaskModal(taskId, sessionId)`: task detail + status history.
- **Activity view** — the filtered event stream (`ui/js/activity.js`), driven by
  `state.selectedSessionIds` + tool/agent/event-type chip filters + `searchText`.
  Each event is itself clickable into the event modal. This is the app's natural
  "see it in context" surface. **Constraint:** Activity is session-scoped — it
  shows nothing unless sessions are selected.
- **Insights tables** are re-rendered from JS in `ui/js/insights.js`; styling is in
  `ui/css/insights.css`. The structured endpoints already accept `?session=` scope.
- `extractFilePath` / `extractTarget` (`lib/analytics/extract.ts`) and
  `sessionClause` (`lib/analytics/filter.ts`) are reusable.
- Corpus doc-id encoding (`analysis/.../corpus.py`): `prompt-<eventId>`,
  `assistant-<eventId>`, `task-<taskId>-<sessionId>`. `semantic_sentiment` and
  `semantic_error_assignments` carry `event_id`; `semantic_topic_assignments`
  carries `doc_id`; `semantic_pivot_signals` carries `session_id` only.

## Feature 1 — Sortable columns

A single generic helper `makeSortable(tableEl)` applied to every `.insights-table`
after render.

- Click a `<th>` → sort the `<tbody>` rows by that column; click again → flip
  direction; show a `▲`/`▼` indicator on the active column.
- **DOM-based**: reorder the rendered `<tr>` nodes (no per-table data plumbing).
- **Numeric detection**: `parseFloat(cell.textContent)` when the cell starts with a
  number (`0.727`, `54`, `25%`, `4/5`); otherwise locale string compare.
- **Skip** `<th>`s that are empty or `colspan` (the action column; the pain
  "Breakdown" group header). So Pain sorts by Session/Score, churn by Edits, etc.
- Sort holds while viewing; it resets on the next full re-render (selection change).
  Insights doesn't poll, so this is acceptable for v1.

## Feature 2 — Row drill-in (hybrid)

One delegated `click` handler on `#insightsPanel` reads `data-drill` + companion
attributes on the clicked `tr[data-drill]` and dispatches. Render functions add the
attributes (with **full** ids, since cells display 8-char slices) and an
`is-drillable` class (`cursor:pointer`, reuses the existing row-hover highlight).
Interactive controls inside a row (the Flag-for-triage button) call
`e.stopPropagation()` so they don't also drill.

### Row → destination map

| Row(s) | `data-drill` | Companion attrs | Destination |
|---|---|---|---|
| Pain leaderboard, Triage, Token usage, Errors-by-session, Agent pivots | `session` | `data-session` | Select that session, `setView('activity')` |
| Frustration / sentiment | `event` | `data-event` | `showEventModal(eventId)` |
| Task bounces | `task` | `data-task`, `data-session` | `showTaskModal(taskId, sessionId)` |
| Errors-by-tool, File churn, Error clusters, Topics, Retry chains | `events` | `data-by`, `data-value` (+ `data-session`,`data-tool` for retry) | Constituent-events modal |

## Feature 3 — Constituent-events modal + endpoint

For aggregate rows that span many sessions, open a modal listing the underlying
events, each click-through to the event modal.

### Backend — `GET /api/insights/events`

Query params: `by` (required), `value`, optional `session` (the current Insights
scope, comma-separated), plus `tool` for the retry case. Returns
`[{id, session_id, hook_event_name, tool_name, timestamp, data}]` ordered by
`timestamp ASC`, capped at 500 with a `truncated` flag.

Logic in a testable `lib/analytics/events-by.ts` → `constituentEvents(db, opts)`:

| `by` | Resolves to |
|---|---|
| `file` | `Edit/Write/MultiEdit/NotebookEdit` PostToolUse events whose `tool_input.file_path === value` (via `extractFilePath`) |
| `tool` | events where `tool_name === value`; if `opts.errorsOnly`, only failures (`PostToolUseFailure` or `data.error != null`) |
| `errorCluster` | `events` joined to `semantic_error_assignments` on `event_id` where `cluster_id = value` |
| `topic` | `semantic_topic_assignments.doc_id` for `topic_id = value` → parse `prompt-<id>`/`assistant-<id>` → those events (task docs skipped) |
| `retry` | events for `opts.session` + `opts.tool` where `extractTarget(tool, tool_input) === value` |

All dimensions apply the optional `session` scope via `sessionClause`. Unknown `by`
→ HTTP 400.

### Frontend — `showEventListModal(title, events)`

In `modal.js`, reusing the existing modal shell (hide prev/next/copy as
`showTaskModal` does). Renders a clickable list — `timestamp · type · tool ·
summary` (reuse `getEventSummary` from `activity.js`) — and clicking an item opens
that event's detail. `showEventModal` is refactored to
`showEventModal(eventId, idList = state.events.map(e => String(e.id)))`; the
constituent modal passes its own event ids so prev/next navigates within the
constituent set. Empty set → "(no events)". A truncation note is shown when the
endpoint capped the list.

The `events`-drill dispatch builds the URL from the row's `data-by`/`data-value`
(+ `data-session`/`data-tool`) and the current `sessionQS()` scope, fetches it, then
calls `showEventListModal`.

## Data flow

```
row click ─► #insightsPanel delegated handler ─► read data-drill
  session ─► state.selectedSessionIds = {id}; setView('activity')
  event   ─► showEventModal(id)
  task    ─► showTaskModal(id, session)
  events  ─► GET /api/insights/events?by=…&value=…&session=… ─► showEventListModal
                                   │
                          constituentEvents(db, opts)  (lib/analytics/events-by.ts)
```

## Error handling

- Endpoint tolerates missing/partial data (bad `data` JSON skipped); unknown `by`
  → 400; empty result → `[]` (modal shows "(no events)").
- Drill dispatch is defensive: a row missing its companion attr is a no-op.
- Selecting a session for the `session` drill replaces the current selection (single
  session focus) and switches to Activity.

## Testing

- **Unit** `lib/analytics/events-by.test.ts`: seed events (+ a couple
  `semantic_error_assignments` / `semantic_topic_assignments` rows) and assert
  `constituentEvents` returns the right set per `by`, respects `errorsOnly` and the
  `session` scope, and caps at 500.
- **Server** `ui/server.test.ts`: `/api/insights/events?by=tool&value=Bash&errorsOnly=1`
  returns expected rows; unknown `by` → 400.
- **UI** (sortable + drill dispatch): manual browser verification with screenshots —
  a column sort, a `session` drill (→ Activity scoped), an `event`/`task` modal, and
  a constituent-events modal with click-through.

## Out of scope (YAGNI)

- Persisting sort state across re-renders.
- New Activity filter dimensions (file/topic/cluster) — aggregates use the
  constituent modal instead.
- Multi-column / multi-key sorting.
- "Back to list" navigation from a constituent event detail (close to return).
