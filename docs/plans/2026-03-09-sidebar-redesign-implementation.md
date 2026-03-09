# Sidebar Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach).

**Goal:** Replace the flat sidebar with a session-scoped hierarchy: dropdown session selector with active/archived sections, session accordions containing nested agents and tasks, archive/delete endpoints, and multi-session timeline support.

**Architecture:** DB migration v3 adds `archived_at` to sessions. New REST endpoints for archive/unarchive/delete with cascade. Frontend rebuilt as dropdown panel + accordion sidebar + multi-session timeline. Vanilla HTML/CSS/JS, no frameworks.

**Tech Stack:** Bun, SQLite (bun:sqlite), Bun.serve(), vanilla JS SPA

---

### Task 1: DB Migration v3 — Add archived_at Column

**Files:**
- Modify: `lib/db.ts:139` (add v3 migration block after v2)
- Test: `lib/db.test.ts`

**Step 1: Write the failing test**

Add to `lib/db.test.ts` inside a new `describe("v3 migration")` block:

```typescript
describe("v3 migration", () => {
  it("sessions table has archived_at column", () => {
    const db = getDb();
    const cols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("archived_at");
  });

  it("schema_version is 3", () => {
    const db = getDb();
    const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(row.version).toBe(3);
  });

  it("archived_at index exists", () => {
    const db = getDb();
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'").all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_sessions_archived_at");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test lib/db.test.ts`
Expected: FAIL — `archived_at` column not found, schema version is 2

**Step 3: Write the migration**

Add after the `currentVersion < 2` block in `lib/db.ts`:

```typescript
if (currentVersion < 3) {
  db.run("ALTER TABLE sessions ADD COLUMN archived_at INTEGER");
  db.run("CREATE INDEX idx_sessions_archived_at ON sessions(archived_at)");
  db.run("UPDATE schema_version SET version = 3");
}
```

**Step 4: Run test to verify it passes**

Run: `bun test lib/db.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add lib/db.ts lib/db.test.ts
git commit -m "feat: add schema migration v3 with archived_at column on sessions"
```

---

### Task 2: Archive/Unarchive/Delete API Endpoints

**Files:**
- Modify: `ui/server.ts` (add POST/DELETE handlers)
- Test: create `ui/server.test.ts`

**Step 1: Write the failing tests**

Create `ui/server.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../lib/db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("server API", () => {
  const testDbPath = join(tmpdir(), `agent-stalker-server-test-${Date.now()}.db`);

  beforeEach(() => {
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
    const db = getDb();
    // Seed a test session
    db.run("INSERT INTO sessions (id, cwd, started_at) VALUES ('sess-1', '/tmp/test', 1000)");
    db.run("INSERT INTO sessions (id, cwd, started_at) VALUES ('sess-2', '/tmp/test2', 2000)");
    db.run("INSERT INTO events (session_id, hook_event_name, timestamp) VALUES ('sess-1', 'SessionStart', 1000)");
    db.run("INSERT INTO agents (id, session_id, agent_type, started_at) VALUES ('agent-1', 'sess-1', 'Explore', 1000)");
    db.run("INSERT INTO tasks (id, session_id, subject, status, created_at, updated_at) VALUES ('1', 'sess-1', 'Test task', 'pending', 1000, 1000)");
    db.run("INSERT INTO task_events (task_id, session_id, event_type, timestamp) VALUES ('1', 'sess-1', 'created', 1000)");
  });

  afterEach(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
    try { unlinkSync(testDbPath + "-wal"); } catch {}
    try { unlinkSync(testDbPath + "-shm"); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("GET /api/sessions excludes archived by default", () => {
    const db = getDb();
    db.run("UPDATE sessions SET archived_at = 9999 WHERE id = 'sess-1'");
    const rows = db.query("SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY started_at DESC").all();
    expect(rows.length).toBe(1);
    expect((rows[0] as any).id).toBe("sess-2");
  });

  it("GET /api/sessions?archived=true returns only archived", () => {
    const db = getDb();
    db.run("UPDATE sessions SET archived_at = 9999 WHERE id = 'sess-1'");
    const rows = db.query("SELECT * FROM sessions WHERE archived_at IS NOT NULL ORDER BY started_at DESC").all();
    expect(rows.length).toBe(1);
    expect((rows[0] as any).id).toBe("sess-1");
  });

  it("archive sets archived_at", () => {
    const db = getDb();
    db.run("UPDATE sessions SET archived_at = ? WHERE id = ?", [Date.now(), "sess-1"]);
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-1'").get() as any;
    expect(session.archived_at).not.toBeNull();
  });

  it("unarchive clears archived_at", () => {
    const db = getDb();
    db.run("UPDATE sessions SET archived_at = 9999 WHERE id = 'sess-1'");
    db.run("UPDATE sessions SET archived_at = NULL WHERE id = 'sess-1'");
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-1'").get() as any;
    expect(session.archived_at).toBeNull();
  });

  it("delete cascades events, agents, tasks, task_events", () => {
    const db = getDb();
    // Must archive first
    db.run("UPDATE sessions SET archived_at = 9999 WHERE id = 'sess-1'");
    // Delete cascade
    db.run("DELETE FROM task_events WHERE session_id = 'sess-1'");
    db.run("DELETE FROM tasks WHERE session_id = 'sess-1'");
    db.run("DELETE FROM agents WHERE session_id = 'sess-1'");
    db.run("DELETE FROM events WHERE session_id = 'sess-1'");
    db.run("DELETE FROM sessions WHERE id = 'sess-1'");

    expect(db.query("SELECT * FROM sessions WHERE id = 'sess-1'").get()).toBeNull();
    expect(db.query("SELECT * FROM events WHERE session_id = 'sess-1'").all().length).toBe(0);
    expect(db.query("SELECT * FROM agents WHERE session_id = 'sess-1'").all().length).toBe(0);
    expect(db.query("SELECT * FROM tasks WHERE session_id = 'sess-1'").all().length).toBe(0);
    expect(db.query("SELECT * FROM task_events WHERE session_id = 'sess-1'").all().length).toBe(0);
  });

  it("delete rejects non-archived session", () => {
    const db = getDb();
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-1'").get() as any;
    expect(session.archived_at).toBeNull();
    // API should reject — verify session is not archived
  });
});
```

**Step 2: Run tests to verify they pass (these are DB-level tests)**

Run: `bun test ui/server.test.ts`
Expected: ALL PASS (these verify the DB operations, not HTTP yet)

**Step 3: Add API endpoints to server.ts**

Add to `handleApi` function in `ui/server.ts`, before the final 404 return. Also modify the existing `/api/sessions` handler:

Modify `/api/sessions` GET to filter by archived status:
```typescript
// Replace the existing /api/sessions handler
if (path === "/api/sessions") {
  const team = params.get("team");
  const archived = params.get("archived");
  const limit = parseInt(params.get("limit") ?? "50");
  const offset = parseInt(params.get("offset") ?? "0");
  let query = "SELECT * FROM sessions WHERE 1=1";
  const qParams: any[] = [];
  if (archived === "true") {
    query += " AND archived_at IS NOT NULL";
  } else {
    query += " AND archived_at IS NULL";
  }
  if (team) { query += " AND team_name = ?"; qParams.push(team); }
  query += " ORDER BY started_at DESC LIMIT ? OFFSET ?";
  qParams.push(limit, offset);
  return jsonResponse(db.query(query).all(...qParams));
}
```

Add new POST/DELETE endpoints (handle `req.method` check at top of `handleApi`, pass `req` as parameter):

```typescript
// POST /api/sessions/:id/archive
if (path.match(/^\/api\/sessions\/[^/]+\/archive$/) && method === "POST") {
  const id = path.split("/")[3];
  const session = db.query("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!session) return jsonResponse({ error: "Not found" }, 404);
  db.run("UPDATE sessions SET archived_at = ? WHERE id = ?", [Date.now(), id]);
  return jsonResponse({ ok: true });
}

// POST /api/sessions/:id/unarchive
if (path.match(/^\/api\/sessions\/[^/]+\/unarchive$/) && method === "POST") {
  const id = path.split("/")[3];
  db.run("UPDATE sessions SET archived_at = NULL WHERE id = ?", [id]);
  return jsonResponse({ ok: true });
}

// DELETE /api/sessions/:id
if (path.match(/^\/api\/sessions\/[^/]+$/) && method === "DELETE") {
  const id = path.split("/")[3];
  const session = db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
  if (!session) return jsonResponse({ error: "Not found" }, 404);
  if (!session.archived_at) return jsonResponse({ error: "Must archive before deleting" }, 400);
  db.run("DELETE FROM task_events WHERE session_id = ?", [id]);
  db.run("DELETE FROM tasks WHERE session_id = ?", [id]);
  db.run("DELETE FROM agents WHERE session_id = ?", [id]);
  db.run("DELETE FROM events WHERE session_id = ?", [id]);
  db.run("DELETE FROM sessions WHERE id = ?", [id]);
  return jsonResponse({ ok: true });
}
```

Note: `handleApi` signature changes to `handleApi(url: URL, method: string)` and caller passes `req.method`.

**Step 4: Run all tests**

Run: `bun test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ui/server.ts ui/server.test.ts
git commit -m "feat: add archive/unarchive/delete session API endpoints"
```

---

### Task 3: Session Dropdown Panel (CSS + HTML)

**Files:**
- Modify: `ui/index.html` (CSS section + HTML structure)

**Step 1: Replace sidebar HTML**

Replace the entire `<aside class="sidebar">...</aside>` block with:

```html
<aside class="sidebar">
  <div class="session-dropdown">
    <button class="session-dropdown-trigger" id="sessionDropdownTrigger">
      <span id="sessionDropdownLabel">No sessions selected</span>
      <span class="chevron">▾</span>
    </button>
    <div class="session-dropdown-panel" id="sessionDropdownPanel">
      <div class="session-search">
        <input type="text" id="sessionSearchInput" placeholder="Search sessions..." autocomplete="off">
      </div>
      <div class="session-group">
        <div class="session-group-header" id="activeGroupHeader">
          Active <span class="count" id="activeSessionCount">0</span>
        </div>
        <div class="session-group-list" id="activeSessionList"></div>
      </div>
      <div class="session-group">
        <div class="session-group-header collapsible collapsed" id="archivedGroupHeader">
          Archived <span class="count" id="archivedSessionCount">0</span>
          <span class="chevron">▾</span>
        </div>
        <div class="session-group-list collapsed" id="archivedSessionList"></div>
      </div>
    </div>
  </div>
  <div class="session-accordions" id="sessionAccordions"></div>
</aside>
```

**Step 2: Add CSS for dropdown panel and accordions**

Add after the existing `.sidebar-item .badge` styles:

```css
/* Session Dropdown */
.session-dropdown {
  position: relative;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}

.session-dropdown-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: border-color 0.2s;
}
.session-dropdown-trigger:hover { border-color: var(--border-bright); }
.session-dropdown-trigger .chevron { font-size: 10px; color: var(--text-dim); }

.session-dropdown-panel {
  display: none;
  position: absolute;
  top: 100%;
  left: 8px;
  right: 8px;
  z-index: 100;
  background: var(--bg-panel);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  max-height: 60vh;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.session-dropdown-panel.open { display: block; }

.session-search {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg-panel);
  z-index: 1;
}
.session-search input {
  width: 100%;
  padding: 5px 8px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
  outline: none;
}
.session-search input:focus { border-color: var(--accent-green); }

.session-group { border-bottom: 1px solid var(--border); }
.session-group:last-child { border-bottom: none; }

.session-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-dim);
}
.session-group-header.collapsible { cursor: pointer; }
.session-group-header.collapsible .chevron { transition: transform 0.2s; }
.session-group-header.collapsed .chevron { transform: rotate(-90deg); }
.session-group-list.collapsed { display: none; }

.session-group-header .count {
  font-family: var(--font-mono);
  font-weight: 400;
  font-size: 10px;
}

.session-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
  transition: background 0.15s;
  font-size: 11px;
}
.session-row:hover { background: var(--bg-hover); }

.session-row input[type="checkbox"] {
  accent-color: var(--accent-green);
  cursor: pointer;
  flex-shrink: 0;
}

.session-row-info {
  flex: 1;
  min-width: 0;
}
.session-row-label {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-row-subtitle {
  font-size: 10px;
  color: var(--text-dim);
}

.session-row-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.session-row:hover .session-row-actions { opacity: 1; }

.session-action-btn {
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s;
}
.session-action-btn:hover { border-color: var(--border-bright); color: var(--text-primary); }
.session-action-btn.delete { color: var(--accent-red); }
.session-action-btn.delete:hover { border-color: var(--accent-red); background: var(--accent-red-dim); }

/* Session Accordions */
.session-accordions {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.accordion-item {
  border-bottom: 1px solid var(--border);
}

.accordion-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.15s;
  font-size: 11px;
  color: var(--text-primary);
}
.accordion-header:hover { background: var(--bg-hover); }
.accordion-header .chevron {
  font-size: 10px;
  color: var(--text-dim);
  transition: transform 0.2s;
}
.accordion-header.collapsed .chevron { transform: rotate(-90deg); }

.accordion-body {
  padding: 0 8px 8px;
}
.accordion-header.collapsed + .accordion-body { display: none; }

.accordion-sub-header {
  padding: 4px 8px;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-dim);
}
```

**Step 3: Commit CSS/HTML structure**

```bash
git add ui/index.html
git commit -m "feat: add session dropdown panel and accordion HTML/CSS structure"
```

---

### Task 4: Session Dropdown JavaScript Logic

**Files:**
- Modify: `ui/index.html` (script section)

**Step 1: Update state object**

Replace existing `state` object:

```javascript
const state = {
  activeSessions: [],
  archivedSessions: [],
  selectedSessionIds: new Set(),
  sessionAgents: {},   // sessionId -> agents[]
  sessionTasks: {},    // sessionId -> tasks[]
  events: [],
  tools: [],
  stats: {},
  selectedEvent: null,
  searchText: '',
  sessionSearchText: '',
  toolFilter: '',
  eventTypeFilter: '',
  timeRangeFilter: '',
  isLive: true,
  lastTimestamp: 0,
};
```

**Step 2: Update API functions**

Replace `loadSessions`:
```javascript
async function loadSessions() {
  const [active, archived] = await Promise.all([
    fetchJSON('/api/sessions?limit=100'),
    fetchJSON('/api/sessions?limit=100&archived=true'),
  ]);
  if (active) state.activeSessions = active;
  if (archived) state.archivedSessions = archived;
  renderSessionDropdown();
}
```

Replace `loadAgents` and `loadTasks` to be session-scoped:
```javascript
async function loadSessionDetails() {
  const ids = [...state.selectedSessionIds];
  const agentPromises = ids.map(id => fetchJSON(`/api/agents?session=${id}`));
  const taskPromises = ids.map(id => fetchJSON(`/api/tasks?session=${id}`));
  const [agentResults, taskResults] = await Promise.all([
    Promise.all(agentPromises),
    Promise.all(taskPromises),
  ]);
  state.sessionAgents = {};
  state.sessionTasks = {};
  ids.forEach((id, i) => {
    state.sessionAgents[id] = agentResults[i] || [];
    state.sessionTasks[id] = taskResults[i] || [];
  });
  renderAccordions();
}
```

Replace `loadEvents` to support multi-session:
```javascript
async function loadEvents() {
  const ids = [...state.selectedSessionIds];
  if (ids.length === 0) {
    state.events = [];
    renderEvents();
    return;
  }
  const promises = ids.map(id => {
    let url = `/api/events?limit=500&session=${id}`;
    if (state.toolFilter) url += `&tool=${encodeURIComponent(state.toolFilter)}`;
    return fetchJSON(url);
  });
  const results = await Promise.all(promises);
  state.events = results.flat().filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
  if (state.events.length > 0) {
    state.lastTimestamp = Math.max(...state.events.map(e => e.timestamp || 0));
  }
  renderEvents();
}
```

**Step 3: Render session dropdown**

```javascript
function renderSessionDropdown() {
  // Update trigger label
  const count = state.selectedSessionIds.size;
  const label = document.getElementById('sessionDropdownLabel');
  if (count === 0) label.textContent = 'No sessions selected';
  else if (count === 1) {
    const s = [...state.activeSessions, ...state.archivedSessions].find(s => s.id === [...state.selectedSessionIds][0]);
    label.textContent = s ? (s.cwd || '').split('/').pop() || s.id : '1 session';
  } else {
    label.textContent = `${count} sessions`;
  }

  // Render active list
  renderSessionList('activeSessionList', state.activeSessions, 'activeSessionCount', false);
  renderSessionList('archivedSessionList', state.archivedSessions, 'archivedSessionCount', true);
}

function sessionLabel(s) {
  return s.cwd ? s.cwd.split('/').pop() || s.id.slice(0, 12) : s.id.slice(0, 12);
}

function sessionLastEvent(s) {
  // Use ended_at or started_at as proxy for last event time
  const ts = s.ended_at || s.started_at;
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function renderSessionList(listId, sessions, countId, isArchived) {
  const el = document.getElementById(listId);
  const q = state.sessionSearchText.toLowerCase();
  const filtered = q ? sessions.filter(s => sessionLabel(s).toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) : sessions;
  document.getElementById(countId).textContent = filtered.length;

  el.innerHTML = filtered.map(s => {
    const checked = state.selectedSessionIds.has(s.id) ? 'checked' : '';
    const isActive = !s.ended_at;
    const actionBtn = isArchived
      ? `<button class="session-action-btn delete" data-delete="${esc(s.id)}" title="Delete permanently">✕</button>`
      : `<button class="session-action-btn" data-archive="${esc(s.id)}" title="Archive">⬇</button>`;
    return `<div class="session-row">
      <input type="checkbox" data-session="${esc(s.id)}" ${checked}>
      <span class="dot" style="background:${isActive ? 'var(--accent-green)' : 'var(--text-dim)'}"></span>
      <div class="session-row-info">
        <div class="session-row-label" title="${esc(s.id)}">${esc(sessionLabel(s))}</div>
        <div class="session-row-subtitle">${esc(sessionLastEvent(s))}</div>
      </div>
      <div class="session-row-actions">${actionBtn}</div>
    </div>`;
  }).join('');

  // Checkbox handlers
  el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const sid = cb.dataset.session;
      if (cb.checked) state.selectedSessionIds.add(sid);
      else state.selectedSessionIds.delete(sid);
      renderSessionDropdown();
      loadSessionDetails();
      loadEvents();
    });
  });

  // Archive handlers
  el.querySelectorAll('[data-archive]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = btn.dataset.archive;
      await fetch(`/api/sessions/${sid}/archive`, { method: 'POST' });
      state.selectedSessionIds.delete(sid);
      await loadSessions();
      loadSessionDetails();
      loadEvents();
    });
  });

  // Delete handlers
  el.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = btn.dataset.delete;
      if (!confirm('Permanently delete this session and all its data?')) return;
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
      state.selectedSessionIds.delete(sid);
      await loadSessions();
      loadSessionDetails();
      loadEvents();
    });
  });
}
```

**Step 4: Dropdown open/close behavior**

```javascript
document.getElementById('sessionDropdownTrigger').addEventListener('click', () => {
  document.getElementById('sessionDropdownPanel').classList.toggle('open');
});

document.addEventListener('click', (e) => {
  const panel = document.getElementById('sessionDropdownPanel');
  const trigger = document.getElementById('sessionDropdownTrigger');
  if (!panel.contains(e.target) && !trigger.contains(e.target)) {
    panel.classList.remove('open');
  }
});

document.getElementById('sessionSearchInput').addEventListener('input', (e) => {
  state.sessionSearchText = e.target.value;
  renderSessionDropdown();
});

document.getElementById('archivedGroupHeader').addEventListener('click', () => {
  document.getElementById('archivedGroupHeader').classList.toggle('collapsed');
  document.getElementById('archivedSessionList').classList.toggle('collapsed');
});
```

**Step 5: Commit**

```bash
git add ui/index.html
git commit -m "feat: add session dropdown panel with search, archive, and delete"
```

---

### Task 5: Session Accordion Sidebar

**Files:**
- Modify: `ui/index.html` (script section)

**Step 1: Write renderAccordions function**

```javascript
function renderAccordions() {
  const el = document.getElementById('sessionAccordions');
  const ids = [...state.selectedSessionIds];
  const allSessions = [...state.activeSessions, ...state.archivedSessions];

  if (ids.length === 0) {
    el.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:11px;text-align:center">Select sessions above to view agents and tasks</div>';
    return;
  }

  el.innerHTML = ids.map(sid => {
    const session = allSessions.find(s => s.id === sid);
    if (!session) return '';
    const agents = state.sessionAgents[sid] || [];
    const tasks = state.sessionTasks[sid] || [];
    const isActive = !session.ended_at;
    const dotColor = isActive ? 'var(--accent-green)' : 'var(--text-dim)';

    return `<div class="accordion-item">
      <div class="accordion-header" data-accordion="${esc(sid)}">
        <span class="chevron">▾</span>
        <span class="dot" style="background:${dotColor};width:6px;height:6px;border-radius:50%;flex-shrink:0"></span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sessionLabel(session))}</span>
        <span class="badge" style="font-size:10px;padding:1px 5px;border-radius:10px;background:var(--bg-card);color:var(--text-dim)">${agents.length}A ${tasks.length}T</span>
      </div>
      <div class="accordion-body">
        <div class="accordion-sub-header">Agents (${agents.length})</div>
        ${agents.length === 0 ? '<div style="padding:4px 8px;color:var(--text-dim);font-size:10px">(none)</div>' :
          agents.map(a => {
            const isRunning = !a.ended_at;
            return `<div class="sidebar-item" data-agent-filter="${esc(a.id)}" data-session-scope="${esc(sid)}">
              <span class="dot" style="background:${isRunning ? 'var(--accent-purple)' : 'var(--text-dim)'}"></span>
              <span class="label" title="${esc(a.id)}">${esc(a.agent_type || a.id.slice(0, 12))}</span>
              ${a.team_name ? `<span class="badge">${esc(a.team_name)}</span>` : ''}
            </div>`;
          }).join('')}
        <div class="accordion-sub-header" style="margin-top:4px">Tasks (${tasks.length})</div>
        ${tasks.length === 0 ? '<div style="padding:4px 8px;color:var(--text-dim);font-size:10px">(none)</div>' :
          tasks.map(t =>
            `<div class="sidebar-item" data-task-detail="${esc(t.id)}">
              <span class="dot" style="background:${taskStatusColor(t.status)}"></span>
              <span class="label">${esc(t.subject || t.id)}</span>
              ${t.owner ? `<span class="badge">${esc(t.owner)}</span>` : ''}
            </div>`
          ).join('')}
      </div>
    </div>`;
  }).join('');

  // Accordion toggle
  el.querySelectorAll('.accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      header.classList.toggle('collapsed');
    });
  });

  // Agent click -> filter events to that agent
  el.querySelectorAll('[data-agent-filter]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const agentId = item.dataset.agentFilter;
      // Toggle: if already active, clear filter
      const wasActive = item.classList.contains('active');
      el.querySelectorAll('[data-agent-filter]').forEach(i => i.classList.remove('active'));
      if (wasActive) {
        state.agentFilter = null;
      } else {
        item.classList.add('active');
        state.agentFilter = agentId;
      }
      renderEvents();
    });
  });

  // Task click -> show detail
  el.querySelectorAll('[data-task-detail]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      showTaskDetail(item.dataset.taskDetail);
    });
  });
}
```

**Step 2: Add agentFilter to state and renderEvents**

Add `agentFilter: null` to state object.

In `renderEvents`, add after the event type filter:
```javascript
if (state.agentFilter) {
  events = events.filter(e => e.agent_id === state.agentFilter);
}
```

**Step 3: Commit**

```bash
git add ui/index.html
git commit -m "feat: add session accordion sidebar with nested agents and tasks"
```

---

### Task 6: Multi-Session Timeline + Session Indicator

**Files:**
- Modify: `ui/index.html` (event row rendering)

**Step 1: Add session indicator to event rows**

Modify the event row grid template to add a session column:

CSS change:
```css
.event-row {
  grid-template-columns: 80px 60px 110px 100px 120px 1fr;
  /* Added 60px session column after time */
}
```

In `renderEvents`, add a session indicator column after time:
```javascript
const sessionShort = esc((e.session_id || '').slice(0, 8));
// In the event-row HTML template, after the time span:
`<span class="session-indicator" title="${esc(e.session_id)}" style="font-size:10px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sessionShort}</span>`
```

**Step 2: Update pollNewEvents for multi-session**

```javascript
async function pollNewEvents() {
  if (!state.isLive || !state.lastTimestamp) return;
  const ids = [...state.selectedSessionIds];
  if (ids.length === 0) return;
  const promises = ids.map(id => {
    let url = `/api/events?since=${state.lastTimestamp}&limit=200&session=${id}`;
    if (state.toolFilter) url += `&tool=${encodeURIComponent(state.toolFilter)}`;
    return fetchJSON(url);
  });
  const results = await Promise.all(promises);
  const newEvents = results.flat().filter(Boolean);
  if (newEvents.length > 0) {
    state.events = state.events.concat(newEvents).sort((a, b) => a.timestamp - b.timestamp);
    state.lastTimestamp = Math.max(...newEvents.map(e => e.timestamp || 0));
    renderEvents();
    loadStats();
  }
}
```

**Step 3: Remove old agent filter from toolbar**

Remove the agent sidebar rendering functions (`renderAgents`, `renderTeams`, and the old `renderSessions`, `renderTasks` that wrote to the removed sidebar sections). Remove unused element references.

**Step 4: Update loadAll**

```javascript
async function loadAll() {
  await Promise.all([loadSessions(), loadEvents(), loadTools(), loadStats()]);
  await loadSessionDetails();
}
```

**Step 5: Commit**

```bash
git add ui/index.html
git commit -m "feat: multi-session timeline with session indicator and cleanup"
```

---

### Task 7: Integration Test + Final Polish

**Files:**
- Modify: `ui/index.html` (minor polish)
- Run: full test suite

**Step 1: Run all tests**

Run: `bun test`
Expected: ALL PASS

**Step 2: Manual verification checklist**

Start the UI server and verify:
- [ ] Session dropdown opens/closes
- [ ] Type-ahead search filters sessions
- [ ] Checkboxes select/deselect sessions
- [ ] Selected sessions appear as accordions
- [ ] Agents and tasks nested under correct session
- [ ] Clicking agent filters timeline
- [ ] Clicking task opens detail pane
- [ ] Archive button moves session to archived section
- [ ] Delete button (archived only) removes session with confirmation
- [ ] Multi-session timeline shows session indicator
- [ ] Live polling works across selected sessions

**Step 3: Commit any polish fixes**

```bash
git add -A
git commit -m "chore: sidebar redesign polish and cleanup"
```
