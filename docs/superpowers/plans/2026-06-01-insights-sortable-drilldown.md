# Insights Sortable Columns + Row Drill-in — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach).

**Goal:** Make the Insights dashboard tables sortable by column, and make every row drill in to "the data point in context."

**Architecture:** A generic DOM-based `makeSortable` over `.insights-table`. Hybrid drill-in via `data-drill` attributes + one delegated click handler: session rows → Activity view (scoped), single event/task rows → existing modals, cross-session aggregate rows → a new constituent-events modal backed by a new `GET /api/insights/events` endpoint (`constituentEvents` in `lib/analytics/events-by.ts`).

**Tech Stack:** Bun + bun:sqlite + TypeScript (server, analytics); vanilla ES-module JS (`ui/js/*`), CSS.

**Design doc:** `docs/superpowers/specs/2026-06-01-insights-sortable-drilldown-design.md`

---

## Conventions

- Run from the worktree root: `C:/Users/ehart/repos/agent-stalker/.worktrees/meta-analysis`.
- TS tests: `bun test <file>`; full suite `bun test`; types `bunx tsc --noEmit`.
- UI tasks have no unit harness in this project → they use **manual browser verification**. For those, run the demo server against the demo DB:
  `AGENT_STALKER_DB_PATH="$USERPROFILE/.claude/agent-stalker-demo.db" bun ui/server.ts --port 3199`
  then open `http://localhost:3199`. (The server module loads once at start — **restart it after editing `ui/server.ts`**; static `ui/js`/`ui/css` are served fresh on reload.)
- Commit one task at a time, staging specific files.

---

### Task 1: `constituentEvents` — resolve aggregate rows to their events

**Files:**
- Create: `lib/analytics/events-by.ts`
- Test: `lib/analytics/events-by.test.ts`

**Step 1: Write the failing test**

Create `lib/analytics/events-by.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall, seedToolFailure, seedEvent } from "./test-helpers";
import { constituentEvents } from "./events-by";

describe("constituentEvents", () => {
  const testDbPath = join(tmpdir(), `as-eventsby-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("by=file returns edit events for that file", () => {
    seedSession("s1");
    seedToolCall("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Write", { file_path: "/a.ts" });
    seedToolCall("s1", "Edit", { file_path: "/b.ts" });
    seedToolCall("s1", "Read", { file_path: "/a.ts" }); // not an edit
    const { events } = constituentEvents(getDb(), { by: "file", value: "/a.ts" });
    expect(events.length).toBe(2);
    expect(events.every((e) => e.tool_name === "Edit" || e.tool_name === "Write")).toBe(true);
  });

  it("by=tool with errorsOnly returns only failures of that tool", () => {
    seedSession("s1");
    seedToolCall("s1", "Bash", { command: "ok" });
    seedToolFailure("s1", "Bash", { command: "bad" });
    seedToolFailure("s1", "Edit", { file_path: "/x" });
    const { events } = constituentEvents(getDb(), { by: "tool", value: "Bash", errorsOnly: true });
    expect(events.length).toBe(1);
    expect(events[0].hook_event_name).toBe("PostToolUseFailure");
  });

  it("by=errorCluster joins semantic_error_assignments", () => {
    seedSession("s1");
    seedToolFailure("s1", "Bash", { command: "a" }); // event id 1
    seedToolFailure("s1", "Bash", { command: "b" }); // event id 2
    const db = getDb();
    db.run("INSERT INTO semantic_error_assignments (event_id, session_id, cluster_id) VALUES (1,'s1',7)");
    db.run("INSERT INTO semantic_error_assignments (event_id, session_id, cluster_id) VALUES (2,'s1',9)");
    const { events } = constituentEvents(db, { by: "errorCluster", value: "7" });
    expect(events.length).toBe(1);
    expect(events[0].id).toBe(1);
  });

  it("by=topic maps doc ids to events", () => {
    seedSession("s1");
    seedEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit", data: { prompt: "hi" } }); // id 1
    const db = getDb();
    db.run("INSERT INTO semantic_topic_assignments (doc_id, session_id, topic_id, prob) VALUES ('prompt-1','s1',3,0.9)");
    db.run("INSERT INTO semantic_topic_assignments (doc_id, session_id, topic_id, prob) VALUES ('task-9-s1','s1',3,0.5)"); // no event
    const { events } = constituentEvents(db, { by: "topic", value: "3" });
    expect(events.length).toBe(1);
    expect(events[0].id).toBe(1);
  });

  it("by=retry filters one session+tool to a target", () => {
    seedSession("s1");
    seedToolFailure("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Edit", { file_path: "/b.ts" });
    const { events } = constituentEvents(getDb(), { by: "retry", value: "/a.ts", tool: "Edit", session: "s1" });
    expect(events.length).toBe(2);
  });

  it("scopes by sessionIds and caps at 500", () => {
    seedSession("keep"); seedSession("drop");
    seedToolFailure("keep", "Bash", { command: "a" });
    seedToolFailure("drop", "Bash", { command: "b" });
    const { events } = constituentEvents(getDb(), { by: "tool", value: "Bash", errorsOnly: true, sessionIds: ["keep"] });
    expect(events.length).toBe(1);
    expect(events[0].session_id).toBe("keep");
  });

  it("throws on unknown by", () => {
    expect(() => constituentEvents(getDb(), { by: "nope" as any, value: "x" })).toThrow();
  });
});
```

**Step 2: Run to verify it fails**

Run: `bun test lib/analytics/events-by.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the implementation**

Create `lib/analytics/events-by.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { extractFilePath, extractTarget } from "./extract";
import { sessionClause } from "./filter";

export interface ConstituentOpts {
  by: "file" | "tool" | "errorCluster" | "topic" | "retry";
  value: string;
  sessionIds?: string[];
  errorsOnly?: boolean;
  tool?: string;     // retry: the chain's tool
  session?: string;  // retry: the chain's single session
}

export interface EventRow {
  id: number; session_id: string; hook_event_name: string;
  tool_name: string | null; timestamp: number; data: string | null;
}

export interface ConstituentResult { events: EventRow[]; truncated: boolean; }

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX = 500;
const SELECT = "id, session_id, hook_event_name, tool_name, timestamp, data";

function isError(r: EventRow): boolean {
  if (r.hook_event_name === "PostToolUseFailure") return true;
  if (r.data) { try { return JSON.parse(r.data).error != null; } catch { return false; } }
  return false;
}

export function constituentEvents(db: Database, opts: ConstituentOpts): ConstituentResult {
  let rows: EventRow[] = [];

  if (opts.by === "file") {
    const { clause, params } = sessionClause(opts.sessionIds);
    const candidates = db.query(
      `SELECT ${SELECT} FROM events WHERE hook_event_name='PostToolUse' AND tool_name IS NOT NULL${clause} ORDER BY timestamp ASC`,
    ).all(...params) as EventRow[];
    rows = candidates.filter((r) => {
      if (!r.tool_name || !EDIT_TOOLS.has(r.tool_name) || !r.data) return false;
      try { return extractFilePath(r.tool_name, JSON.parse(r.data).tool_input) === opts.value; }
      catch { return false; }
    });
  } else if (opts.by === "tool") {
    const { clause, params } = sessionClause(opts.sessionIds);
    let all = db.query(
      `SELECT ${SELECT} FROM events WHERE tool_name = ?${clause} ORDER BY timestamp ASC`,
    ).all(opts.value, ...params) as EventRow[];
    rows = opts.errorsOnly ? all.filter(isError) : all;
  } else if (opts.by === "errorCluster") {
    const { clause, params } = sessionClause(opts.sessionIds, "e.session_id");
    rows = db.query(
      `SELECT e.id, e.session_id, e.hook_event_name, e.tool_name, e.timestamp, e.data
       FROM events e JOIN semantic_error_assignments a ON e.id = a.event_id
       WHERE a.cluster_id = ?${clause} ORDER BY e.timestamp ASC`,
    ).all(opts.value, ...params) as EventRow[];
  } else if (opts.by === "topic") {
    const { clause, params } = sessionClause(opts.sessionIds);
    const assigns = db.query(
      `SELECT doc_id FROM semantic_topic_assignments WHERE topic_id = ?${clause}`,
    ).all(opts.value, ...params) as { doc_id: string }[];
    const eventIds = assigns
      .map((a) => { const m = /^(?:prompt|assistant)-(\d+)$/.exec(a.doc_id); return m ? parseInt(m[1]) : null; })
      .filter((x): x is number => x != null);
    if (eventIds.length) {
      const ph = eventIds.map(() => "?").join(",");
      rows = db.query(
        `SELECT ${SELECT} FROM events WHERE id IN (${ph}) ORDER BY timestamp ASC`,
      ).all(...eventIds) as EventRow[];
    }
  } else if (opts.by === "retry") {
    const candidates = db.query(
      `SELECT ${SELECT} FROM events
       WHERE session_id = ? AND tool_name = ? AND hook_event_name IN ('PostToolUse','PostToolUseFailure')
       ORDER BY timestamp ASC`,
    ).all(opts.session ?? "", opts.tool ?? "") as EventRow[];
    rows = candidates.filter((r) => {
      if (!r.tool_name || !r.data) return false;
      try { return extractTarget(r.tool_name, JSON.parse(r.data).tool_input) === opts.value; }
      catch { return false; }
    });
  } else {
    throw new Error(`unknown by: ${opts.by}`);
  }

  return { events: rows.slice(0, MAX), truncated: rows.length > MAX };
}
```

**Step 4: Run to verify it passes**

Run: `bun test lib/analytics/events-by.test.ts`
Expected: PASS (7 tests).

**Step 5: Commit**

```bash
git add lib/analytics/events-by.ts lib/analytics/events-by.test.ts
git commit -m "feat(analytics): constituentEvents — resolve aggregate rows to their events"
```

---

### Task 2: `GET /api/insights/events` endpoint

**Files:**
- Modify: `ui/server.ts` (import + new route in `handleApi`)
- Test: `ui/server.test.ts`

**Step 1: Write the failing test**

Append to `ui/server.test.ts` (inside the existing top-level describe that has the temp-DB harness, or add a new describe mirroring the others — it needs `getDb`, `closeDb`, the temp-DB lifecycle, and `seedSession`/`seedToolFailure` from `../lib/analytics/test-helpers`):

```typescript
describe("constituent events endpoint", () => {
  const testDbPath = join(tmpdir(), `as-server-eventsby-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("GET /api/insights/events?by=tool&value=Bash&errorsOnly=1 returns failures", async () => {
    seedSession("s1");
    seedToolFailure("s1", "Bash", { command: "bad" });
    seedToolCall("s1", "Bash", { command: "ok" });
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/events?by=tool&value=Bash&errorsOnly=1"), "GET");
    const body = await res.json();
    expect(body.events.length).toBe(1);
    expect(body.events[0].hook_event_name).toBe("PostToolUseFailure");
    expect(body.truncated).toBe(false);
  });

  it("missing by → 400", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/events?value=x"), "GET");
    expect(res.status).toBe(400);
  });
});
```

Make sure the imports at the top of `ui/server.test.ts` include `seedSession, seedToolFailure, seedToolCall` from `../lib/analytics/test-helpers` (extend the existing import if needed).

**Step 2: Run to verify it fails**

Run: `bun test ui/server.test.ts`
Expected: FAIL — route missing (404, not 400/200).

**Step 3: Implement**

In `ui/server.ts`, add to the analytics imports near the top:

```typescript
import { constituentEvents } from "../lib/analytics/events-by";
```

In `handleApi`, after the `/api/insights/tokens` block and before the next route, add (note: `insightsSessionIds` is already computed above the insights routes):

```typescript
  if (path === "/api/insights/events") {
    const by = params.get("by");
    if (!by) return jsonResponse({ error: "by is required" }, 400);
    try {
      const result = constituentEvents(db, {
        by: by as any,
        value: params.get("value") ?? "",
        errorsOnly: params.get("errorsOnly") === "1",
        tool: params.get("tool") ?? undefined,
        session: params.get("retry_session") ?? undefined,
        sessionIds: insightsSessionIds,
      });
      return jsonResponse(result);
    } catch (e) {
      return jsonResponse({ error: String(e) }, 400);
    }
  }
```

**Step 4: Run to verify it passes**

Run: `bun test ui/server.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add ui/server.ts ui/server.test.ts
git commit -m "feat(server): GET /api/insights/events constituent-events endpoint"
```

---

### Task 3: Modal — navigable id list + `showEventListModal`

**Files:**
- Modify: `ui/js/modal.js`

**Step 1: Refactor `showEventModal` to accept an id list**

In `ui/js/modal.js`, replace the `showEventModal` function:

```javascript
export async function showEventModal(eventId, idList) {
  const data = await fetchJSON(`/api/events/${eventId}`);
  if (!data) return;
  modalEventIds = idList || state.events.map(e => String(e.id));
  modalCurrentIndex = modalEventIds.indexOf(String(eventId));
  renderEventModal(data);
  updateModalNav();
  openModal();
}
```

**Step 2: Add `showEventListModal`**

Add an import at the top of `ui/js/modal.js`:

```javascript
import { getEventSummary } from './activity.js';
```

> Note: `activity.js` already imports `showEventModal` from `modal.js`; this back-import is used only at runtime (inside handlers), so the ES-module cycle resolves cleanly — consistent with the existing `api.js`↔`activity.js` cycle.

Add at the end of `ui/js/modal.js`:

```javascript
export function showEventListModal(title, events, truncated) {
  document.getElementById('modalPrev').style.display = 'none';
  document.getElementById('modalNext').style.display = 'none';
  document.getElementById('modalCopy').style.display = 'none';
  modalCurrentEvent = null;
  document.getElementById('modalTitle').textContent = title;
  const body = document.getElementById('modalBody');

  if (!events || !events.length) {
    body.innerHTML = '<div style="padding:16px;color:var(--text-dim)">(no events)</div>';
    openModal();
    return;
  }
  const ids = events.map(e => String(e.id));
  const note = truncated ? '<div class="triage-hint">Showing the first 500 events.</div>' : '';
  const rows = events.map(e => `
    <tr data-event-id="${esc(e.id)}" class="is-drillable">
      <td class="mono">${esc(new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false }))}</td>
      <td>${esc(e.hook_event_name)}</td>
      <td>${esc(e.tool_name || '')}</td>
      <td>${esc((getEventSummary(e) || '').slice(0, 80))}</td>
    </tr>`).join('');
  body.innerHTML = `${note}<table class="insights-table"><thead><tr><th>Time</th><th>Type</th><th>Tool</th><th>Summary</th></tr></thead><tbody>${rows}</tbody></table>`;
  body.querySelectorAll('tr[data-event-id]').forEach(tr => {
    tr.addEventListener('click', () => showEventModal(tr.dataset.eventId, ids));
  });
  openModal();
}
```

**Step 3: Manual verification**

Run: `bun ui/server.ts --port 3199` is not needed yet (no caller). Instead verify the module parses:
Run: `bunx tsc --noEmit` (should stay exit 0) and `bun test` (should stay green — no behavior changed for existing callers since `idList` defaults to the old value).
Expected: tsc exit 0; full suite still passes.

**Step 4: Commit**

```bash
git add ui/js/modal.js
git commit -m "feat(ui): showEventListModal + navigable id list on showEventModal"
```

---

### Task 4: Sortable columns

**Files:**
- Modify: `ui/js/insights.js` (`makeSortable` + apply in `renderInsights`; add theads to the Errors sub-tables so they sort)
- Modify: `ui/css/insights.css` (sortable header affordance + indicators)

**Step 1: Add `makeSortable` and apply it**

In `ui/js/insights.js`, add this function (e.g. just above `function section(...)`):

```javascript
// Generic DOM sort: click a <th> to sort the table's rows by that column.
// Numeric-aware; skips empty / colspan headers. Sortable columns must precede
// any colspan header (true for all current tables — only Pain has a colspan,
// and its sortable columns Session/Score come before it).
function makeSortable(table) {
  if (!table.tHead || !table.tBodies[0]) return;
  const ths = [...table.tHead.rows[0].cells];
  ths.forEach((th, colIndex) => {
    if (!th.textContent.trim() || th.colSpan > 1) return;
    th.classList.add('sortable');
    th.addEventListener('click', () => {
      const tbody = table.tBodies[0];
      const asc = th.dataset.sortDir !== 'asc';
      ths.forEach(h => { h.removeAttribute('data-sort-dir'); h.classList.remove('sort-asc', 'sort-desc'); });
      th.dataset.sortDir = asc ? 'asc' : 'desc';
      th.classList.add(asc ? 'sort-asc' : 'sort-desc');
      const num = (s) => { const f = parseFloat(String(s).replace(/[, ]/g, '')); return isNaN(f) ? null : f; };
      [...tbody.rows].sort((ra, rb) => {
        const a = (ra.cells[colIndex]?.textContent || '').trim();
        const b = (rb.cells[colIndex]?.textContent || '').trim();
        const na = num(a), nb = num(b);
        const cmp = (na !== null && nb !== null) ? na - nb : a.localeCompare(b);
        return asc ? cmp : -cmp;
      }).forEach(r => tbody.appendChild(r));
    });
  });
}
```

In `renderInsights`, change the tail (currently `wireInsightsButtons(); applyInsightsSearch();`) to also apply sorting:

```javascript
  wireInsightsButtons();
  panel.querySelectorAll('.insights-table').forEach(makeSortable);
  applyInsightsSearch();
```

**Step 2: Give the Errors sub-tables headers (so they're sortable)**

In `ui/js/insights.js`, replace `renderErrors`'s return value to include `<thead>`s:

```javascript
  return section('Errors',
    `<div class="insights-cols">
       <div><h4>By tool</h4><table class="insights-table"><thead><tr><th>Tool</th><th>Errors</th></tr></thead><tbody>${tool}</tbody></table></div>
       <div><h4>By session</h4><table class="insights-table"><thead><tr><th>Session</th><th>Errors</th><th>Rate</th></tr></thead><tbody>${sess}</tbody></table></div>
     </div>`);
```

**Step 3: Add the CSS affordance**

In `ui/css/insights.css`, append:

```css
.insights-table thead th.sortable { cursor: pointer; user-select: none; }
.insights-table thead th.sortable:hover { color: var(--text-secondary); }
.insights-table thead th.sort-asc::after { content: ' ▲'; color: var(--amber); }
.insights-table thead th.sort-desc::after { content: ' ▼'; color: var(--amber); }
```

**Step 4: Manual verification**

Run: `bun ui/server.ts --port 3199` (with the demo DB env) → open Insights, click "Score" on Pain leaderboard (sorts asc, then desc with ▲/▼), click "Edits" on File churn, "Errors" on the Errors sub-tables.
Expected: rows reorder; indicator shows on the active column; no console errors.

**Step 5: Commit**

```bash
git add ui/js/insights.js ui/css/insights.css
git commit -m "feat(ui): sortable Insights table columns"
```

---

### Task 5: Drill-in data attributes + task-bounces table + button guard

**Files:**
- Modify: `ui/js/insights.js` (add `data-drill-*` to rows; render task bounces; triage button `stopPropagation`)
- Modify: `ui/css/insights.css` (`is-drillable`)

**Step 1: Pain / Triage / Tokens / Pivots → `session` drill**

In `renderPain`, change the row's opening `<tr>` and the triage button:

```javascript
    return `
    <tr class="is-drillable" data-drill="session" data-session="${esc(p.session_id)}">
      <td class="mono">${esc((p.session_id || '').slice(0, 8))}</td>
      <td><span class="pain-score">${p.score.toFixed(3)}</span></td>
      <td><span class="pain-cell">${bar(n.errorRate, '--accent-red')} err</span></td>
      <td><span class="pain-cell">${bar(n.churn, '--accent-amber')} churn</span></td>
      <td><span class="pain-cell">${bar(n.thrash, '--accent-purple')} thrash</span></td>
      <td><span class="pain-cell">${bar(n.effort, '--accent-blue')} effort</span></td>
      <td><button class="insights-btn triage-btn" data-session="${esc(p.session_id)}">Flag for triage</button></td>
    </tr>`;
```

In `renderTriage`, change the row's opening `<tr>`:

```javascript
    return `<tr class="is-drillable" data-drill="session" data-session="${esc(t.session_id)}">
      <td class="mono">${esc((t.session_id || '').slice(0, 8))}</td>
      <td>${badge}</td>
      <td>${analyzed && t.pain_score != null ? esc(String(t.pain_score)) + '/5' : '—'}</td>
      <td>${analyzed ? esc(t.summary || '') : ''}</td>
      <td>${analyzed ? esc(t.root_cause || '') : ''}</td>
    </tr>`;
```

In `renderTokens`, change the row:

```javascript
  const rows = tokens.slice(0, 20).map(t =>
    `<tr class="is-drillable" data-drill="session" data-session="${esc(t.session_id)}"><td class="mono">${esc((t.session_id || '').slice(0,8))}</td><td>${t.input_tokens}</td><td>${t.output_tokens}</td><td>${t.cache_read_input_tokens}</td></tr>`).join('');
```

In `renderPivots`, change the row:

```javascript
  const body = rows.slice(0, 15).map(p =>
    `<tr class="is-drillable" data-drill="session" data-session="${esc(p.session_id)}"><td class="mono">${esc((p.session_id||'').slice(0,8))}</td><td>${(p.confidence||0).toFixed(2)}</td><td>${esc(p.evidence||'')}</td></tr>`).join('');
```

**Step 2: File churn / Errors-by-tool / Errors-by-session → drill**

In `renderChurn`, change the row:

```javascript
  const rows = churn.slice(0, 20).map(c => `
    <tr class="is-drillable" data-drill="events" data-by="file" data-value="${esc(c.file_path)}" data-drill-title="${esc(c.file_path)}"><td class="mono">${esc(c.file_path)}</td><td>${c.edits}</td><td>${c.sessions}</td><td>${Math.round(c.medianGapMs/1000)}s</td></tr>`).join('');
```

In `renderErrors`, change the two row maps:

```javascript
  const tool = (errors.byTool || []).slice(0, 10).map(t => `<tr class="is-drillable" data-drill="events" data-by="tool" data-value="${esc(t.tool_name)}" data-errors-only="1" data-drill-title="${esc(t.tool_name)} errors"><td>${esc(t.tool_name)}</td><td>${t.errors}</td></tr>`).join('');
  const sess = (errors.bySession || []).slice(0, 10).map(s => `<tr class="is-drillable" data-drill="session" data-session="${esc(s.session_id)}"><td class="mono">${esc((s.session_id || '').slice(0,8))}</td><td>${s.errors}</td><td>${(s.errorRate*100).toFixed(1)}%</td></tr>`).join('');
```

**Step 3: Topics / Error clusters → drill**

In `renderTopics`, change the row:

```javascript
  const body = rows.slice(0, 20).map(t =>
    `<tr class="is-drillable" data-drill="events" data-by="topic" data-value="${esc(t.topic_id)}" data-drill-title="topic: ${esc(t.label)}"><td>${esc(t.label)}</td><td>${esc(t.keywords || '')}</td><td>${t.size}</td><td>${(t.pain_score||0).toFixed(2)}</td></tr>`).join('');
```

In `renderErrorClusters`, change the row:

```javascript
  const body = rows.slice(0, 20).map(c =>
    `<tr class="is-drillable" data-drill="events" data-by="errorCluster" data-value="${esc(c.cluster_id)}" data-drill-title="cluster: ${esc(c.label)}"><td>${esc(c.label)}</td><td>${c.size}</td><td>${c.session_spread}</td><td class="mono">${esc((c.exemplar||'').slice(0,60))}</td></tr>`).join('');
```

**Step 4: Frustration (event drill) + Thrash (retry events + task bounces)**

In `renderSentiment`, change the row:

```javascript
  const neg = rows.filter(r => r.label === 'negative').slice(0, 15).map(r =>
    `<tr class="is-drillable" data-drill="event" data-event="${esc(r.event_id)}"><td class="mono">${esc((r.session_id||'').slice(0,8))}</td><td>${r.score.toFixed(2)}</td><td>${esc(r.source_kind)}</td></tr>`).join('');
```

Replace `renderThrash` entirely (adds the retry drill, and renders the previously-unused `taskBounces` as a second sub-table with a `task` drill):

```javascript
function renderThrash(thrash) {
  if (!thrash) return section('Thrash / pivot-loops', '<p class="empty">No data yet.</p>');
  const chains = (thrash.retryChains || []).slice(0, 15).map(c =>
    `<tr class="is-drillable" data-drill="events" data-by="retry" data-value="${esc(c.target)}" data-tool="${esc(c.tool_name)}" data-retry-session="${esc(c.session_id)}" data-drill-title="retry: ${esc(c.tool_name)}"><td class="mono">${esc((c.session_id||'').slice(0,8))}</td><td>${esc(c.tool_name)}</td><td class="mono">${esc(String(c.target).slice(0,40))}</td><td>${c.chainLength}</td></tr>`).join('');
  const bounces = (thrash.taskBounces || []).slice(0, 15).map(b =>
    `<tr class="is-drillable" data-drill="task" data-task="${esc(b.task_id)}" data-session="${esc(b.session_id)}"><td class="mono">${esc(b.task_id)}</td><td class="mono">${esc((b.session_id||'').slice(0,8))}</td><td>${b.bounces}</td></tr>`).join('');
  const bouncesTable = bounces
    ? `<div><h4>Task bounces</h4><table class="insights-table"><thead><tr><th>Task</th><th>Session</th><th>Bounces</th></tr></thead><tbody>${bounces}</tbody></table></div>`
    : '';
  const chainsTable = `<div><h4>Retry chains</h4><table class="insights-table"><thead><tr><th>Session</th><th>Tool</th><th>Target</th><th>Retry depth</th></tr></thead><tbody>${chains}</tbody></table></div>`;
  return section('Thrash / pivot-loops', `<div class="insights-cols">${chainsTable}${bouncesTable}</div>`);
}
```

**Step 5: Triage button must not also drill**

In `wireInsightsButtons`, add `e.stopPropagation()` as the first line of the `.triage-btn` click handler:

```javascript
  document.querySelectorAll('.triage-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const session = btn.dataset.session;
      btn.textContent = 'Flagging…';
      const res = await fetch(API + '/api/insights/semantic/triage?session=' + encodeURIComponent(session), { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        btn.textContent = 'Flagged ✓';
        btn.disabled = true;
      } else {
        btn.textContent = body.message || 'failed';
      }
    });
  });
```

**Step 6: `is-drillable` CSS**

In `ui/css/insights.css`, append:

```css
.insights-table tbody tr.is-drillable { cursor: pointer; }
```

**Step 7: Manual verification (visual only — dispatch wired in Task 6)**

Run the server, open Insights. Confirm: rows show a pointer cursor on hover; the new "Task bounces" sub-table renders next to "Retry chains"; `bunx tsc --noEmit` still exit 0; no console errors. (Clicks won't navigate yet — that's Task 6.)

**Step 8: Commit**

```bash
git add ui/js/insights.js ui/css/insights.css
git commit -m "feat(ui): drill-in data attributes, task-bounces table, button guard"
```

---

### Task 6: Delegated drill dispatch

**Files:**
- Modify: `ui/js/main.js`

**Step 1: Add imports**

In `ui/js/main.js`, extend the existing imports:

```javascript
import { closeModal, copyCurrentEvent, modalPrev, modalNext, showEventModal, showTaskModal, showEventListModal } from './modal.js';
import {
  loadSessions, loadSessionDetails, loadEvents, loadTools, loadStats, pollNewEvents, fetchJSON,
} from './api.js';
```

(Adjust the existing `./modal.js` and `./api.js` import lines to add `showEventModal, showTaskModal, showEventListModal` and `fetchJSON` respectively.)

**Step 2: Add the delegated handler**

In `ui/js/main.js`, after the view-toggle setup (after the `viewInsightsBtn` listener), add:

```javascript
// Drill-in: delegated click on Insights rows → context destination
document.getElementById('insightsPanel').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-drill]');
  if (!tr) return;
  const d = tr.dataset;
  if (d.drill === 'session') {
    if (!d.session) return;
    state.selectedSessionIds = new Set([d.session]);
    state.agentFilters.clear();
    state.toolChipFilters.clear();
    state.eventTypeFilters.clear();
    state.eventsFullyLoaded = false;
    renderSessionDropdown();
    loadSessionDetails();
    loadEvents();
    loadStats();
    setView('activity');
  } else if (d.drill === 'event') {
    if (d.event) showEventModal(d.event);
  } else if (d.drill === 'task') {
    if (d.task) showTaskModal(d.task, d.session);
  } else if (d.drill === 'events') {
    const p = new URLSearchParams({ by: d.by, value: d.value || '' });
    if (d.tool) p.set('tool', d.tool);
    if (d.retrySession) p.set('retry_session', d.retrySession);
    if (d.errorsOnly) p.set('errorsOnly', '1');
    const scope = [...state.selectedSessionIds];
    if (scope.length) p.set('session', scope.join(','));
    const res = await fetchJSON('/api/insights/events?' + p.toString());
    showEventListModal(d.drillTitle || 'Events', res?.events || [], res?.truncated);
  }
});
```

`renderSessionDropdown` is already imported in `main.js`; `setView` and `state` are already in scope.

**Step 3: Manual verification (the real end-to-end check)**

Run the server (demo DB), open Insights:
- Click a **Pain leaderboard** row → jumps to **Activity**, scoped to that session, showing its event stream; the header label updates.
- Click a **Frustration** row → event modal opens on that prompt/message.
- Click a **File churn** row → constituent-events modal lists that file's edits; clicking an item opens the event detail with working prev/next.
- Click an **Errors → by tool** row → modal lists that tool's failures.
- Click a **Retry chains** row → modal lists the retry events for that target.
- Click a **Task bounces** row → task modal with status history.
- Click the **Flag for triage** button → flags (does NOT drill).
Expected: each behaves as above; no console errors.

**Step 4: Commit**

```bash
git add ui/js/main.js
git commit -m "feat(ui): delegated drill-in dispatch for Insights rows"
```

---

### Task 7: Full verification + docs

**Files:**
- Modify: `README.md` (one line under the Insights section noting sortable columns + click-to-drill)

**Step 1: Run the full TS suite + types**

Run: `bun test` and `bunx tsc --noEmit`
Expected: all green; tsc exit 0.

**Step 2: Cross-browser sanity (manual)**

With the server running, re-verify the Task 6 drill list and a sort on each table type, including under an active session-scope (select a session, confirm drills still work and the constituent modal respects scope).

**Step 3: Doc line**

In `README.md`, under the Insights/meta-analysis section, add a sentence: "Every Insights table is sortable (click a column header) and every row drills in — sessions open in the Activity view, single prompts/tasks open a detail modal, and aggregate rows (a file, tool, error cluster, topic, or retry chain) open a list of their underlying events."

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: note Insights sortable columns + row drill-in"
```

---

## Self-review notes (addressed during authoring)

- **Spec coverage:** sortable (Task 4), drill map session/event/task (Tasks 5–6), constituent modal + endpoint + `constituentEvents` (Tasks 1–3, 6), task-bounces rows so the `task` drill has a surface (Task 5). All design rows covered.
- **Naming consistency:** `constituentEvents`/`ConstituentOpts`/`ConstituentResult`, `showEventListModal`, `showEventModal(eventId, idList)`, `makeSortable`, and the `data-drill`/`data-by`/`data-value`/`data-tool`/`data-retry-session`/`data-errors-only`/`data-drill-title` attributes map exactly to the dispatch reads (`dataset.drill`/`by`/`value`/`tool`/`retrySession`/`errorsOnly`/`drillTitle`).
- **Cycle note:** `modal.js`↔`activity.js` import is runtime-only (consistent with existing `api.js`↔`activity.js`).
- **Sort/colspan constraint:** sortable columns precede the only colspan header (Pain "Breakdown"), so DOM `colIndex` aligns thead→tbody; documented in `makeSortable`.
- **Scope interplay:** the constituent endpoint reuses `insightsSessionIds` (the `?session=` scope) so the drill list matches the scoped aggregate; the dispatch forwards the current selection.
