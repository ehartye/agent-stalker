# Task Lifecycle Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach).

**Goal:** Track full task lifecycle (create, assign, status change, block/unblock, complete) by parsing PostToolUse events for TaskCreate/TaskUpdate tools.

**Architecture:** Add schema migration v2 that expands the `tasks` table with status/owner/blocks/blocked_by columns and adds a `task_events` history table. Enhance `handleToolUse` in ingest.ts to detect TaskCreate/TaskUpdate tool names and maintain both tables. Update query, API, and web UI to expose the richer task data.

**Tech Stack:** Bun, SQLite (bun:sqlite), bun:test, vanilla HTML/CSS/JS

---

### Task 1: Schema Migration v2 — Expand tasks table + add task_events

**Files:**
- Modify: `lib/db.ts:24-93` (add migration v2 block)
- Modify: `lib/db.test.ts` (add migration v2 tests)

**Context:** The migration system uses a `schema_version` table with a single row. Migration v1 creates the initial 4 tables. Migration v2 adds after the `if (currentVersion < 1)` block.

**Step 1: Write the failing test for migration v2 tables**

Add to `lib/db.test.ts` inside the existing `describe("db", ...)` block:

```typescript
it("migration v2 creates task_events table and updates tasks schema", () => {
  const db = getDb();
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain("task_events");
});

it("migration v2 tasks table has status and owner columns", () => {
  const db = getDb();
  const cols = db.query("PRAGMA table_info(tasks)").all() as { name: string }[];
  const colNames = cols.map(c => c.name);
  expect(colNames).toContain("status");
  expect(colNames).toContain("owner");
  expect(colNames).toContain("blocks");
  expect(colNames).toContain("blocked_by");
  expect(colNames).toContain("created_at");
  expect(colNames).toContain("updated_at");
});

it("migration v2 tasks table has primary key on id", () => {
  const db = getDb();
  const cols = db.query("PRAGMA table_info(tasks)").all() as { name: string; pk: number }[];
  const idCol = cols.find(c => c.name === "id");
  expect(idCol!.pk).toBe(1);
});

it("migration v2 creates indexes on task_events", () => {
  const db = getDb();
  const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_events'").all() as { name: string }[];
  const names = indexes.map(i => i.name);
  expect(names).toContain("idx_task_events_task_id");
  expect(names).toContain("idx_task_events_timestamp");
});
```

**Step 2: Run tests to verify they fail**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test lib/db.test.ts`
Expected: FAIL — `task_events` table doesn't exist, tasks table lacks new columns

**Step 3: Implement migration v2 in db.ts**

Add after the closing `}` of `if (currentVersion < 1)` (after line 93), before `runMigrations` closing brace:

```typescript
if (currentVersion < 2) {
  // Create new tasks table with full lifecycle columns
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks_v2 (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      subject TEXT,
      description TEXT,
      status TEXT DEFAULT 'pending',
      owner TEXT,
      team_name TEXT,
      blocks TEXT,
      blocked_by TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  // Migrate existing task data
  db.run(`
    INSERT OR IGNORE INTO tasks_v2 (id, session_id, subject, description, status, owner, team_name, completed_at, created_at, updated_at)
    SELECT id, session_id, subject, description, 'completed', teammate_name, team_name, completed_at, completed_at, completed_at
    FROM tasks
  `);

  db.run("DROP TABLE IF EXISTS tasks");
  db.run("ALTER TABLE tasks_v2 RENAME TO tasks");

  // Task events history table
  db.run(`
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      session_id TEXT,
      event_type TEXT,
      field_name TEXT,
      old_value TEXT,
      new_value TEXT,
      timestamp INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_task_events_timestamp ON task_events(timestamp)");

  if (currentVersion === 0) {
    // Fresh install — version was just set to 1 above, now update to 2
    db.run("UPDATE schema_version SET version = 2");
  } else {
    db.run("UPDATE schema_version SET version = 2");
  }
}
```

**Important:** Also update the v1 migration's version insert. The v1 block sets version=1, and v2 block runs `if (currentVersion < 2)`. For fresh installs, v1 inserts version=1, then v2 updates to 2. For existing v1 databases, v2 runs and updates to 2. This is correct as-is.

**Step 4: Run tests to verify they pass**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test lib/db.test.ts`
Expected: All tests PASS (old tests still pass, new tests pass)

**Step 5: Commit**

```bash
git add lib/db.ts lib/db.test.ts
git commit -m "feat: add schema migration v2 for task lifecycle tables"
```

---

### Task 2: Task lifecycle ingest — parse TaskCreate/TaskUpdate from PostToolUse

**Files:**
- Modify: `lib/ingest.ts:61-71` (enhance handleToolUse)
- Modify: `lib/ingest.ts:90-102` (update handleTaskCompleted)
- Modify: `lib/ingest.test.ts` (add task lifecycle tests)

**Context:** `handleToolUse` already receives `event.tool_name`, `event.tool_input`, and `event.tool_response`. For PostToolUse events where tool_name is `TaskCreate` or `TaskUpdate`, we need to extract task data and maintain the tasks/task_events tables. The `tool_input` is the raw object before truncation. We must parse it BEFORE truncation happens.

**Step 1: Write failing tests for TaskCreate via PostToolUse**

Add to `lib/ingest.test.ts` inside the existing `describe("ingestEvent", ...)` block:

```typescript
it("creates task from PostToolUse of TaskCreate", () => {
  ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tc1", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
  ingestEvent({
    hook_event_name: "PostToolUse",
    session_id: "sess-tc1",
    tool_name: "TaskCreate",
    tool_use_id: "toolu_tc1",
    tool_input: { subject: "Build API", description: "Create REST endpoints" },
    tool_response: "Created task 42",
    cwd: "/tmp",
    permission_mode: "default",
  });
  const db = getDb();
  const task = db.query("SELECT * FROM tasks WHERE id = '42'").get() as any;
  expect(task).not.toBeNull();
  expect(task.subject).toBe("Build API");
  expect(task.description).toBe("Create REST endpoints");
  expect(task.status).toBe("pending");
  expect(task.session_id).toBe("sess-tc1");
  expect(task.created_at).not.toBeNull();

  const events = db.query("SELECT * FROM task_events WHERE task_id = '42'").all() as any[];
  expect(events.length).toBe(1);
  expect(events[0].event_type).toBe("created");
});

it("creates task from PostToolUse of TaskCreate with blocks/blockedBy", () => {
  ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tc2", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
  ingestEvent({
    hook_event_name: "PostToolUse",
    session_id: "sess-tc2",
    tool_name: "TaskCreate",
    tool_use_id: "toolu_tc2",
    tool_input: { subject: "Deploy", addBlocks: ["10"], addBlockedBy: ["5", "6"] },
    tool_response: "Created task 99",
    cwd: "/tmp",
    permission_mode: "default",
  });
  const db = getDb();
  const task = db.query("SELECT * FROM tasks WHERE id = '99'").get() as any;
  expect(JSON.parse(task.blocks)).toEqual(["10"]);
  expect(JSON.parse(task.blocked_by)).toEqual(["5", "6"]);
});
```

**Step 2: Run tests to verify they fail**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test lib/ingest.test.ts`
Expected: FAIL — tasks table has no rows for these PostToolUse events

**Step 3: Write failing tests for TaskUpdate via PostToolUse**

Add to `lib/ingest.test.ts`:

```typescript
it("updates task from PostToolUse of TaskUpdate", () => {
  ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tu1", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
  // First create the task
  ingestEvent({
    hook_event_name: "PostToolUse",
    session_id: "sess-tu1",
    tool_name: "TaskCreate",
    tool_use_id: "toolu_c1",
    tool_input: { subject: "Write tests" },
    tool_response: "Created task 50",
    cwd: "/tmp",
    permission_mode: "default",
  });
  // Then update it
  ingestEvent({
    hook_event_name: "PostToolUse",
    session_id: "sess-tu1",
    tool_name: "TaskUpdate",
    tool_use_id: "toolu_u1",
    tool_input: { taskId: "50", owner: "backend-dev", status: "in_progress" },
    tool_response: "Updated task 50",
    cwd: "/tmp",
    permission_mode: "default",
  });
  const db = getDb();
  const task = db.query("SELECT * FROM tasks WHERE id = '50'").get() as any;
  expect(task.owner).toBe("backend-dev");
  expect(task.status).toBe("in_progress");
  expect(task.updated_at).not.toBeNull();

  const events = db.query("SELECT * FROM task_events WHERE task_id = '50' ORDER BY id").all() as any[];
  expect(events.length).toBe(3); // created + assigned + status_change
  expect(events[1].event_type).toBe("assigned");
  expect(events[1].new_value).toBe("backend-dev");
  expect(events[2].event_type).toBe("status_change");
  expect(events[2].old_value).toBe("pending");
  expect(events[2].new_value).toBe("in_progress");
});

it("sets completed_at when TaskUpdate sets status to completed", () => {
  ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tu2", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
  ingestEvent({
    hook_event_name: "PostToolUse",
    session_id: "sess-tu2",
    tool_name: "TaskCreate",
    tool_use_id: "toolu_c2",
    tool_input: { subject: "Fix bug" },
    tool_response: "Created task 60",
    cwd: "/tmp",
    permission_mode: "default",
  });
  ingestEvent({
    hook_event_name: "PostToolUse",
    session_id: "sess-tu2",
    tool_name: "TaskUpdate",
    tool_use_id: "toolu_u2",
    tool_input: { taskId: "60", status: "completed" },
    tool_response: "Updated task 60",
    cwd: "/tmp",
    permission_mode: "default",
  });
  const db = getDb();
  const task = db.query("SELECT * FROM tasks WHERE id = '60'").get() as any;
  expect(task.status).toBe("completed");
  expect(task.completed_at).not.toBeNull();
});
```

**Step 4: Write failing test for TaskCompleted fallback**

Add to `lib/ingest.test.ts`:

```typescript
it("TaskCompleted creates task if not already tracked", () => {
  ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tc-fb", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
  ingestEvent({
    hook_event_name: "TaskCompleted",
    session_id: "sess-tc-fb",
    task_id: "task-legacy",
    task_subject: "Legacy task",
    task_description: "Created before plugin",
    teammate_name: "worker",
    team_name: "team-a",
    cwd: "/tmp",
    permission_mode: "default",
  });
  const db = getDb();
  const task = db.query("SELECT * FROM tasks WHERE id = 'task-legacy'").get() as any;
  expect(task).not.toBeNull();
  expect(task.status).toBe("completed");
  expect(task.owner).toBe("worker");
  expect(task.completed_at).not.toBeNull();

  const events = db.query("SELECT * FROM task_events WHERE task_id = 'task-legacy'").all() as any[];
  expect(events.length).toBe(1);
  expect(events[0].event_type).toBe("completed");
});

it("TaskCompleted updates existing tracked task to completed", () => {
  ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tc-ex", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
  // Create task via PostToolUse first
  ingestEvent({
    hook_event_name: "PostToolUse",
    session_id: "sess-tc-ex",
    tool_name: "TaskCreate",
    tool_use_id: "toolu_pre",
    tool_input: { subject: "Tracked task" },
    tool_response: "Created task 77",
    cwd: "/tmp",
    permission_mode: "default",
  });
  // Then TaskCompleted fires
  ingestEvent({
    hook_event_name: "TaskCompleted",
    session_id: "sess-tc-ex",
    task_id: "77",
    task_subject: "Tracked task",
    teammate_name: "builder",
    team_name: "team-b",
    cwd: "/tmp",
    permission_mode: "default",
  });
  const db = getDb();
  const task = db.query("SELECT * FROM tasks WHERE id = '77'").get() as any;
  expect(task.status).toBe("completed");
  expect(task.completed_at).not.toBeNull();
});
```

**Step 5: Run all new ingest tests to verify they fail**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test lib/ingest.test.ts`
Expected: FAIL — new task lifecycle tests fail

**Step 6: Implement task lifecycle handlers in ingest.ts**

Add these helper functions before `handleToolUse` in `lib/ingest.ts`:

```typescript
function parseTaskIdFromResponse(response: any): string | null {
  if (typeof response === "string") {
    const match = response.match(/task\s+(\d+)/i);
    return match ? match[1] : null;
  }
  if (typeof response === "object" && response !== null) {
    return String(response.taskId ?? response.task_id ?? response.id ?? "");
  }
  return null;
}

function handleTaskCreate(event: Record<string, any>): void {
  const input = event.tool_input;
  if (!input || typeof input !== "object") return;

  const taskId = parseTaskIdFromResponse(event.tool_response);
  if (!taskId) return;

  const db = getDb();
  const now = Date.now();
  const teamContext = resolveTeamContext(event);

  db.run(
    `INSERT OR IGNORE INTO tasks (id, session_id, subject, description, status, owner, team_name, blocks, blocked_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?)`,
    [
      taskId,
      event.session_id,
      input.subject ?? null,
      input.description ?? null,
      teamContext?.team_name ?? event.team_name ?? null,
      input.addBlocks ? JSON.stringify(input.addBlocks) : null,
      input.addBlockedBy ? JSON.stringify(input.addBlockedBy) : null,
      now,
      now,
    ],
  );

  db.run(
    "INSERT INTO task_events (task_id, session_id, event_type, timestamp) VALUES (?, ?, 'created', ?)",
    [taskId, event.session_id, now],
  );
}

function handleTaskUpdate(event: Record<string, any>): void {
  const input = event.tool_input;
  if (!input || typeof input !== "object" || !input.taskId) return;

  const db = getDb();
  const taskId = String(input.taskId);
  const now = Date.now();

  const existing = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, any> | null;
  if (!existing) return; // Can't update a task we haven't seen created

  // Track field changes
  if (input.owner !== undefined && input.owner !== existing.owner) {
    db.run(
      "INSERT INTO task_events (task_id, session_id, event_type, field_name, old_value, new_value, timestamp) VALUES (?, ?, 'assigned', 'owner', ?, ?, ?)",
      [taskId, event.session_id, existing.owner, input.owner, now],
    );
  }

  if (input.status !== undefined && input.status !== existing.status) {
    db.run(
      "INSERT INTO task_events (task_id, session_id, event_type, field_name, old_value, new_value, timestamp) VALUES (?, ?, 'status_change', 'status', ?, ?, ?)",
      [taskId, event.session_id, existing.status, input.status, now],
    );
  }

  if (input.addBlocks) {
    const currentBlocks = existing.blocks ? JSON.parse(existing.blocks) : [];
    const merged = [...new Set([...currentBlocks, ...input.addBlocks])];
    db.run("UPDATE tasks SET blocks = ?, updated_at = ? WHERE id = ?", [JSON.stringify(merged), now, taskId]);
  }

  if (input.addBlockedBy) {
    const currentBlockedBy = existing.blocked_by ? JSON.parse(existing.blocked_by) : [];
    const merged = [...new Set([...currentBlockedBy, ...input.addBlockedBy])];
    db.run("UPDATE tasks SET blocked_by = ?, updated_at = ? WHERE id = ?", [JSON.stringify(merged), now, taskId]);
  }

  // Build UPDATE for scalar fields
  const updates: string[] = ["updated_at = ?"];
  const params: any[] = [now];

  if (input.owner !== undefined) { updates.push("owner = ?"); params.push(input.owner); }
  if (input.status !== undefined) {
    updates.push("status = ?");
    params.push(input.status);
    if (input.status === "completed") {
      updates.push("completed_at = ?");
      params.push(now);
    }
  }

  params.push(taskId);
  db.run(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`, params);
}
```

Then modify `handleToolUse` to call these after recording the event:

```typescript
function handleToolUse(event: Record<string, any>): void {
  ensureSession(event);
  const rule = getContentRule(event.tool_name ?? "default");
  const { tool_input, tool_response } = truncateContent(
    event.tool_name ?? "unknown",
    event.tool_input,
    event.tool_response,
    rule,
  );
  recordEvent(event, { tool_input, tool_response, error: event.error, is_interrupt: event.is_interrupt });

  // Parse task lifecycle from PostToolUse events
  if (event.hook_event_name === "PostToolUse") {
    if (event.tool_name === "TaskCreate") {
      handleTaskCreate(event);
    } else if (event.tool_name === "TaskUpdate") {
      handleTaskUpdate(event);
    }
  }
}
```

Then update `handleTaskCompleted` to work as a fallback/finalizer:

```typescript
function handleTaskCompleted(event: Record<string, any>): void {
  ensureSession(event);
  const db = getDb();
  const now = Date.now();
  const taskId = event.task_id;

  const existing = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, any> | null;

  if (existing) {
    // Task already tracked — just mark completed
    db.run("UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [now, now, taskId]);
    if (existing.status !== "completed") {
      db.run(
        "INSERT INTO task_events (task_id, session_id, event_type, field_name, old_value, new_value, timestamp) VALUES (?, ?, 'completed', 'status', ?, 'completed', ?)",
        [taskId, event.session_id, existing.status, now],
      );
    }
  } else {
    // Fallback: task created before plugin was installed
    db.run(
      `INSERT INTO tasks (id, session_id, subject, description, status, owner, team_name, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`,
      [taskId, event.session_id, event.task_subject, event.task_description ?? null, event.teammate_name ?? null, event.team_name ?? null, now, now, now],
    );
    db.run(
      "INSERT INTO task_events (task_id, session_id, event_type, field_name, new_value, timestamp) VALUES (?, ?, 'completed', 'status', 'completed', ?)",
      [taskId, event.session_id, now],
    );
  }

  if (event.team_name) {
    db.run("UPDATE sessions SET team_name = ?, teammate_name = ? WHERE id = ? AND team_name IS NULL",
      [event.team_name, event.teammate_name ?? null, event.session_id]);
  }
  recordEvent(event);
}
```

**Step 7: Run tests to verify they pass**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test lib/ingest.test.ts`
Expected: All tests PASS

**Step 8: Run full test suite**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test`
Expected: All tests PASS (existing tests still work with migration v2)

**Step 9: Commit**

```bash
git add lib/ingest.ts lib/ingest.test.ts
git commit -m "feat: parse TaskCreate/TaskUpdate from PostToolUse for lifecycle tracking"
```

---

### Task 3: Query engine — add task detail and task history subcommands

**Files:**
- Modify: `lib/query.ts:142-151` (expand cmdTasks)
- Modify: `lib/query.ts:172-186` (add cmdTask, update runQuery switch)
- Modify: `lib/query.test.ts` (add query tests)

**Step 1: Write failing tests for expanded task queries**

Add to `lib/query.test.ts`. First update the `beforeEach` to seed task data:

```typescript
// Add after the existing seed events in beforeEach:
ingestEvent({
  hook_event_name: "PostToolUse",
  session_id: "s1",
  tool_name: "TaskCreate",
  tool_use_id: "tc1",
  tool_input: { subject: "Build auth", description: "Add login" },
  tool_response: "Created task 1",
  cwd: "/project-a",
  permission_mode: "default",
});
ingestEvent({
  hook_event_name: "PostToolUse",
  session_id: "s1",
  tool_name: "TaskUpdate",
  tool_use_id: "tu1",
  tool_input: { taskId: "1", owner: "dev-1", status: "in_progress" },
  tool_response: "Updated task 1",
  cwd: "/project-a",
  permission_mode: "default",
});
```

Then add tests:

```typescript
it("lists tasks with status and owner", () => {
  const result = runQuery(["tasks"]);
  expect(result).toContain("Build auth");
  expect(result).toContain("in_progress");
  expect(result).toContain("dev-1");
});

it("filters tasks by status", () => {
  const result = runQuery(["tasks", "--status", "in_progress"]);
  expect(result).toContain("Build auth");
});

it("filters tasks by owner", () => {
  const result = runQuery(["tasks", "--owner", "dev-1"]);
  expect(result).toContain("Build auth");
});

it("shows task detail with history", () => {
  const result = runQuery(["task", "1"]);
  expect(result).toContain("Build auth");
  expect(result).toContain("created");
  expect(result).toContain("assigned");
  expect(result).toContain("status_change");
});
```

**Step 2: Run tests to verify they fail**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test lib/query.test.ts`
Expected: FAIL — tasks output missing new columns, `task` subcommand unknown

**Step 3: Implement query changes**

Update `cmdTasks` in `lib/query.ts`:

```typescript
function cmdTasks(args: string[]): string {
  const db = getDb();
  const team = getFlag(args, "--team");
  const status = getFlag(args, "--status");
  const owner = getFlag(args, "--owner");
  let query = "SELECT id, subject, status, owner, team_name, created_at, updated_at, completed_at FROM tasks WHERE 1=1";
  const params: any[] = [];
  if (team) { query += " AND team_name = ?"; params.push(team); }
  if (status) { query += " AND status = ?"; params.push(status); }
  if (owner) { query += " AND owner = ?"; params.push(owner); }
  query += " ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50";
  const rows = db.query(query).all(...params) as Record<string, any>[];
  return formatTable(rows, ["id", "subject", "status", "owner", "team_name", "updated_at"]);
}
```

Add new `cmdTask` function:

```typescript
function cmdTask(args: string[]): string {
  const id = args[1];
  if (!id) return "Usage: task <id>";
  const db = getDb();
  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, any> | null;
  if (!task) return `Task '${id}' not found`;
  let result = `Task: ${task.id}\n`;
  result += `Subject: ${task.subject}\n`;
  result += `Description: ${task.description ?? "(none)"}\n`;
  result += `Status: ${task.status}\n`;
  result += `Owner: ${task.owner ?? "(unassigned)"}\n`;
  result += `Team: ${task.team_name ?? "(none)"}\n`;
  result += `Blocks: ${task.blocks ?? "(none)"}\n`;
  result += `Blocked By: ${task.blocked_by ?? "(none)"}\n`;
  result += `Created: ${task.created_at}\n`;
  result += `Updated: ${task.updated_at}\n`;
  result += `Completed: ${task.completed_at ?? "(active)"}\n\n`;

  const events = db.query("SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp ASC").all(id) as Record<string, any>[];
  if (events.length > 0) {
    result += "History:\n" + formatTable(events, ["event_type", "field_name", "old_value", "new_value", "timestamp"]);
  }
  return result;
}
```

Update the `runQuery` switch to add the `task` case:

```typescript
case "task": return cmdTask(args);
```

And update the default/help text to include `task`:

```typescript
default:
  return `Unknown command: ${subcommand}\n\nAvailable: sessions, session, events, event, tools, agents, tasks, task, stats`;
```

Also update the CLI help at the bottom:

```typescript
console.log("Usage: stalker <command> [options]\n\nCommands: sessions, session, events, event, tools, agents, tasks, task, stats");
```

**Step 4: Run tests to verify they pass**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test lib/query.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add lib/query.ts lib/query.test.ts
git commit -m "feat: add task detail subcommand and status/owner filters to tasks query"
```

---

### Task 4: API endpoints — expand /api/tasks, add /api/tasks/:id and /api/tasks/:id/events

**Files:**
- Modify: `ui/server.ts:75-82` (expand /api/tasks)
- Modify: `ui/server.ts` (add new routes before the 404 catch-all)

**Step 1: Write the failing test**

There are no existing server tests (noted in the review), so we test indirectly by verifying the API integration works. However, since the plan calls for TDD, add a test file `ui/server.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getDb, closeDb } from "../lib/db";
import { ingestEvent } from "../lib/ingest";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("API /api/tasks", () => {
  const testDbPath = join(tmpdir(), `agent-stalker-api-${Date.now()}.db`);
  let server: any;

  beforeAll(async () => {
    process.env.AGENT_STALKER_DB_PATH = testDbPath;

    // Seed task data
    ingestEvent({ hook_event_name: "SessionStart", session_id: "api-s1", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
    ingestEvent({
      hook_event_name: "PostToolUse",
      session_id: "api-s1",
      tool_name: "TaskCreate",
      tool_use_id: "tc-api-1",
      tool_input: { subject: "API task", description: "Test task" },
      tool_response: "Created task 100",
      cwd: "/tmp",
      permission_mode: "default",
    });
    ingestEvent({
      hook_event_name: "PostToolUse",
      session_id: "api-s1",
      tool_name: "TaskUpdate",
      tool_use_id: "tu-api-1",
      tool_input: { taskId: "100", owner: "tester", status: "in_progress" },
      tool_response: "Updated task 100",
      cwd: "/tmp",
      permission_mode: "default",
    });

    // Start server on a random port
    server = Bun.serve({
      port: 0, // random available port
      async fetch(req) {
        const { handleApi: h } = await import("../ui/server-api");
        return h(new URL(req.url));
      },
    });
  });

  afterAll(() => {
    server?.stop();
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
    try { unlinkSync(testDbPath + "-wal"); } catch {}
    try { unlinkSync(testDbPath + "-shm"); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("/api/tasks returns tasks with status and owner", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/tasks`);
    const data = await res.json();
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].status).toBe("in_progress");
    expect(data[0].owner).toBe("tester");
  });

  it("/api/tasks filters by status", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/tasks?status=in_progress`);
    const data = await res.json();
    expect(data.length).toBe(1);
  });

  it("/api/tasks/:id returns single task", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/tasks/100`);
    const data = await res.json();
    expect(data.subject).toBe("API task");
    expect(data.status).toBe("in_progress");
  });

  it("/api/tasks/:id/events returns task history", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/tasks/100/events`);
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(2); // created + assigned + status_change
    expect(data[0].event_type).toBe("created");
  });
});
```

**Note:** This requires extracting `handleApi` into a separate module so it can be imported by tests. Alternatively, test the API inline by starting the actual server.ts — but the simpler approach is to extract the API handler.

**Step 2: Extract handleApi to a testable module**

Create `ui/server-api.ts`:

```typescript
import { getDb } from "../lib/db";

export function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export function handleApi(url: URL): Response {
  // ... (move entire handleApi body from server.ts here)
}
```

Then `ui/server.ts` imports from `./server-api`.

**IMPORTANT: This refactoring is optional.** If extracting makes the task too large, skip the server test file and just implement the API changes directly. The ingest tests in Task 2 already verify the data is correct in SQLite. The API layer is thin.

**Simpler approach — just modify `ui/server.ts` directly:**

Replace the `/api/tasks` block in `ui/server.ts`:

```typescript
if (path === "/api/tasks") {
  const team = params.get("team");
  const status = params.get("status");
  const owner = params.get("owner");
  const sessionId = params.get("session");
  let query = "SELECT * FROM tasks WHERE 1=1";
  const qParams: any[] = [];
  if (team) { query += " AND team_name = ?"; qParams.push(team); }
  if (status) { query += " AND status = ?"; qParams.push(status); }
  if (owner) { query += " AND owner = ?"; qParams.push(owner); }
  if (sessionId) { query += " AND session_id = ?"; qParams.push(sessionId); }
  query += " ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50";
  return jsonResponse(db.query(query).all(...qParams));
}

if (path.startsWith("/api/tasks/")) {
  const rest = path.slice("/api/tasks/".length);
  const parts = rest.split("/");
  const taskId = parts[0];

  if (parts[1] === "events") {
    const events = db.query("SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp ASC").all(taskId);
    return jsonResponse(events);
  }

  const task = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) return jsonResponse({ error: "Not found" }, 404);
  return jsonResponse(task);
}
```

**Important:** The `/api/tasks/:id` and `/api/tasks/:id/events` routes MUST come before the catch-all 404 at the end of `handleApi`. Place them right after the existing `/api/tasks` block.

**Step 3: Run full test suite to verify nothing broke**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add ui/server.ts
git commit -m "feat: expand /api/tasks with filters, add /api/tasks/:id and /api/tasks/:id/events"
```

---

### Task 5: Web UI — task sidebar with status colors, owner badges, and task detail panel

**Files:**
- Modify: `ui/index.html` (task sidebar rendering, task detail panel, status colors)

**Context:** The web UI is a single-file SPA. Task rendering is at line ~887. The sidebar shows tasks with amber dots. We need status-colored dots and owner badges, plus a click handler to show task detail with history.

**Step 1: Update task sidebar rendering**

In `ui/index.html`, replace the `renderTasks()` function (around line 887):

```javascript
function taskStatusColor(status) {
  switch (status) {
    case 'completed': return 'var(--accent-green)';
    case 'in_progress': return 'var(--accent-blue)';
    case 'blocked': return 'var(--accent-red, #f87171)';
    default: return 'var(--text-dim)'; // pending
  }
}

function renderTasks() {
  const el = document.getElementById('taskList');
  document.getElementById('taskCount').textContent = state.tasks.length;
  el.innerHTML = state.tasks.map(t =>
    `<div class="sidebar-item" title="${esc(t.id)}: ${esc(t.status || 'pending')}" onclick="showTaskDetail('${esc(t.id)}')" style="cursor:pointer">
      <span class="dot" style="background:${taskStatusColor(t.status)}"></span>
      <span class="label">${esc(t.subject || t.id)}</span>
      ${t.owner ? `<span class="badge">${esc(t.owner)}</span>` : ''}
      ${t.status ? `<span class="badge" style="opacity:0.6">${esc(t.status)}</span>` : ''}
    </div>`
  ).join('') || '<div style="padding:6px 8px;color:var(--text-dim);font-size:11px">(none)</div>';
}
```

**Step 2: Add task detail function**

Add this function near the other detail/show functions in the JS section:

```javascript
async function showTaskDetail(taskId) {
  const task = await fetchJSON(`/api/tasks/${taskId}`);
  if (!task || task.error) return;
  const events = await fetchJSON(`/api/tasks/${taskId}/events`);

  const historyHtml = (events || []).map(e =>
    `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px">
      <span style="color:var(--text-dim);min-width:120px">${new Date(e.timestamp).toLocaleTimeString()}</span>
      <span style="color:var(--accent-blue);min-width:100px">${esc(e.event_type)}</span>
      ${e.field_name ? `<span>${esc(e.field_name)}: ${esc(e.old_value || '')} → ${esc(e.new_value || '')}</span>` : ''}
    </div>`
  ).join('');

  const blocksHtml = task.blocks ? JSON.parse(task.blocks).map(id => `<span class="badge">${esc(id)}</span>`).join(' ') : '(none)';
  const blockedByHtml = task.blocked_by ? JSON.parse(task.blocked_by).map(id => `<span class="badge">${esc(id)}</span>`).join(' ') : '(none)';

  const detailHtml = `
    <div style="padding:16px">
      <h3 style="margin:0 0 12px 0;color:var(--text-primary)">${esc(task.subject || task.id)}</h3>
      <div style="display:grid;grid-template-columns:100px 1fr;gap:6px;font-size:13px;margin-bottom:16px">
        <span style="color:var(--text-dim)">ID:</span><span>${esc(task.id)}</span>
        <span style="color:var(--text-dim)">Status:</span><span style="color:${taskStatusColor(task.status)}">${esc(task.status || 'pending')}</span>
        <span style="color:var(--text-dim)">Owner:</span><span>${esc(task.owner || '(unassigned)')}</span>
        <span style="color:var(--text-dim)">Team:</span><span>${esc(task.team_name || '(none)')}</span>
        <span style="color:var(--text-dim)">Description:</span><span>${esc(task.description || '(none)')}</span>
        <span style="color:var(--text-dim)">Blocks:</span><span>${blocksHtml}</span>
        <span style="color:var(--text-dim)">Blocked by:</span><span>${blockedByHtml}</span>
        <span style="color:var(--text-dim)">Created:</span><span>${task.created_at ? new Date(task.created_at).toLocaleString() : '?'}</span>
        <span style="color:var(--text-dim)">Updated:</span><span>${task.updated_at ? new Date(task.updated_at).toLocaleString() : '?'}</span>
        <span style="color:var(--text-dim)">Completed:</span><span>${task.completed_at ? new Date(task.completed_at).toLocaleString() : '(active)'}</span>
      </div>
      <h4 style="margin:0 0 8px 0;color:var(--text-secondary)">History</h4>
      ${historyHtml || '<div style="color:var(--text-dim);font-size:12px">(no events)</div>'}
    </div>`;

  // Show in the main content area (reuse the event detail pattern)
  document.getElementById('eventDetail').innerHTML = detailHtml;
  document.getElementById('eventDetail').style.display = 'block';
}
```

**Step 3: Update task polling to refresh task list**

Find the polling/refresh function and ensure `loadTasks()` is called during polling (not just on initial load). Look for the `pollNewEvents` or refresh interval and add `loadTasks()` to it.

**Step 4: Manual test**

Start the UI: `bun ui/server.ts`
Navigate to `http://localhost:3141`
Verify:
- Tasks sidebar shows status-colored dots
- Task items show owner badges
- Clicking a task shows detail panel with history timeline

**Step 5: Commit**

```bash
git add ui/index.html
git commit -m "feat: task sidebar with status colors, owner badges, and detail panel"
```

---

### Task 6: Update slash command docs

**Files:**
- Modify: `commands/stalker.md` (add `task` subcommand, update `tasks` description)

**Step 1: Update the stalker command doc**

Add the `task` subcommand and update the `tasks` description to mention `--status` and `--owner` flags.

**Step 2: Commit**

```bash
git add commands/stalker.md
git commit -m "docs: update stalker command with task detail subcommand and new filters"
```

---

### Task 7: Full integration test — end-to-end task lifecycle

**Files:**
- Create: `lib/task-lifecycle.test.ts`

**Step 1: Write the integration test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ingestEvent } from "./ingest";
import { getDb, closeDb } from "./db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("task lifecycle end-to-end", () => {
  const testDbPath = join(tmpdir(), `agent-stalker-lifecycle-${Date.now()}.db`);

  beforeEach(() => {
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
    ingestEvent({ hook_event_name: "SessionStart", session_id: "lifecycle-1", cwd: "/project", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
  });

  afterEach(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
    try { unlinkSync(testDbPath + "-wal"); } catch {}
    try { unlinkSync(testDbPath + "-shm"); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("tracks full lifecycle: create -> assign -> in_progress -> complete", () => {
    const db = getDb();

    // 1. TaskCreate
    ingestEvent({
      hook_event_name: "PostToolUse",
      session_id: "lifecycle-1",
      tool_name: "TaskCreate",
      tool_use_id: "tc-lc1",
      tool_input: { subject: "Implement feature", description: "Full feature implementation" },
      tool_response: "Created task 200",
      cwd: "/project",
      permission_mode: "default",
    });
    let task = db.query("SELECT * FROM tasks WHERE id = '200'").get() as any;
    expect(task.status).toBe("pending");
    expect(task.owner).toBeNull();

    // 2. Assign
    ingestEvent({
      hook_event_name: "PostToolUse",
      session_id: "lifecycle-1",
      tool_name: "TaskUpdate",
      tool_use_id: "tu-lc1",
      tool_input: { taskId: "200", owner: "backend-eng" },
      tool_response: "Updated task 200",
      cwd: "/project",
      permission_mode: "default",
    });
    task = db.query("SELECT * FROM tasks WHERE id = '200'").get() as any;
    expect(task.owner).toBe("backend-eng");
    expect(task.status).toBe("pending");

    // 3. Start work
    ingestEvent({
      hook_event_name: "PostToolUse",
      session_id: "lifecycle-1",
      tool_name: "TaskUpdate",
      tool_use_id: "tu-lc2",
      tool_input: { taskId: "200", status: "in_progress" },
      tool_response: "Updated task 200",
      cwd: "/project",
      permission_mode: "default",
    });
    task = db.query("SELECT * FROM tasks WHERE id = '200'").get() as any;
    expect(task.status).toBe("in_progress");

    // 4. Complete via TaskCompleted hook
    ingestEvent({
      hook_event_name: "TaskCompleted",
      session_id: "lifecycle-1",
      task_id: "200",
      task_subject: "Implement feature",
      teammate_name: "backend-eng",
      team_name: "my-team",
      cwd: "/project",
      permission_mode: "default",
    });
    task = db.query("SELECT * FROM tasks WHERE id = '200'").get() as any;
    expect(task.status).toBe("completed");
    expect(task.completed_at).not.toBeNull();

    // 5. Verify full history
    const events = db.query("SELECT * FROM task_events WHERE task_id = '200' ORDER BY id").all() as any[];
    expect(events.length).toBe(4); // created, assigned, status_change, completed
    expect(events[0].event_type).toBe("created");
    expect(events[1].event_type).toBe("assigned");
    expect(events[2].event_type).toBe("status_change");
    expect(events[3].event_type).toBe("completed");
  });
});
```

**Step 2: Run test**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test lib/task-lifecycle.test.ts`
Expected: PASS (all ingest code already implemented in Task 2)

**Step 3: Run full suite**

Run: `cd C:/Users/ehart/repos/agent-stalker && bun test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add lib/task-lifecycle.test.ts
git commit -m "test: add end-to-end task lifecycle integration test"
```

---

## Task Dependencies

```
Task 1 (schema) ──→ Task 2 (ingest) ──→ Task 3 (query)
                                    ──→ Task 4 (API)
                                    ──→ Task 5 (UI)
                                    ──→ Task 7 (e2e test)
Task 6 (docs) — independent
```

Tasks 3, 4, 5, 6, 7 can run in parallel after Task 2 completes.
