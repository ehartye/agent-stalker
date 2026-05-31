# Meta-Analysis of Agentic Workflows — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach).

**Goal:** Surface pockets of high thrash/churn/error/token usage across agentic workflows via the existing agent-stalker dashboard (structured metrics in TS) plus an opt-in Python semantic sidecar (frustration, topics, error clusters, pivot detection, LLM triage).

**Architecture:** The SQLite DB is the contract. The TS core captures raw events and computes structured metrics; an opt-in Python batch job reads the same DB and writes `semantic_*` tables; the web dashboard reads both and hides semantic panels when those tables are empty. No live cross-language calls.

**Tech Stack:** Bun + bun:sqlite + TypeScript (core, analytics, server, UI as vanilla ES modules); Python 3 + sentence-transformers + BERTopic + hdbscan + VADER + anthropic (opt-in sidecar).

**Design doc:** `docs/superpowers/specs/2026-05-31-meta-analysis-design.md`

---

## Conventions used throughout

- **Tests:** Bun's test runner (`bun test`). Pattern mirrors `lib/db.test.ts`: set `process.env.AGENT_STALKER_DB_PATH` to a temp file in `beforeEach`, `closeDb()` + `unlinkSync` in `afterEach`.
- **Run a single test file:** `bun test lib/analytics/errors.test.ts`
- **Run all tests:** `bun test`
- **Commit cadence:** one commit per task (after its tests pass).
- **Analytics compute in JS, not SQL:** event payloads live in the `data` JSON column, so analytics functions load filtered rows via SQL then parse/aggregate in JS. This is fine for a local single-user DB.

### Shared test helper (referenced by many tasks)

Several tasks use a helper to insert synthetic events. Create it in Task 3; later tasks import it.

---

## PHASE 0 — Capture additions (core)

### Task 1: DB migration v6 — `usage` table + `sessions.transcript_path`

**Files:**
- Modify: `lib/db.ts` (add migration block after the `currentVersion < 5` block, before the closing brace of `runMigrations`)
- Test: `lib/db.test.ts` (add a `describe("v6 migration", ...)` block)

**Step 1: Write the failing test**

Add to `lib/db.test.ts` after the `describe("v4 migration", ...)` block:

```typescript
describe("v6 migration", () => {
  it("sessions table has transcript_path column", () => {
    const db = getDb();
    const cols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("transcript_path");
  });

  it("creates usage table with token columns", () => {
    const db = getDb();
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("usage");
    const cols = db.query("PRAGMA table_info(usage)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("message_uuid");
    expect(names).toContain("session_id");
    expect(names).toContain("agent_id");
    expect(names).toContain("input_tokens");
    expect(names).toContain("cache_creation_input_tokens");
    expect(names).toContain("cache_read_input_tokens");
    expect(names).toContain("output_tokens");
  });

  it("schema_version is at least 6", () => {
    const db = getDb();
    const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(6);
  });
});
```

Also update the existing `v4 migration` test that asserts `schema_version is 5` — change it to `toBeGreaterThanOrEqual(5)` so later migrations don't break it:

```typescript
    it("schema_version is at least 5", () => {
      const db = getDb();
      const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
      expect(row.version).toBeGreaterThanOrEqual(5);
    });
```

**Step 2: Run test to verify it fails**

Run: `bun test lib/db.test.ts`
Expected: FAIL — `usage` table and `transcript_path` column do not exist.

**Step 3: Write minimal implementation**

In `lib/db.ts`, inside `runMigrations`, after the `if (currentVersion < 5) { ... }` block and before the function's closing `}`:

```typescript
  if (currentVersion < 6) {
    db.run("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
    db.run(`CREATE TABLE usage (
      message_uuid TEXT PRIMARY KEY,
      session_id TEXT,
      agent_id TEXT,
      role TEXT,
      input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      output_tokens INTEGER,
      timestamp INTEGER
    )`);
    db.run("CREATE INDEX idx_usage_session_id ON usage(session_id)");
    db.run("UPDATE schema_version SET version = 6");
  }
```

**Step 4: Run test to verify it passes**

Run: `bun test lib/db.test.ts`
Expected: PASS (all migration tests, including v6).

**Step 5: Commit**

```bash
git add lib/db.ts lib/db.test.ts
git commit -m "feat(db): add v6 migration (usage table + sessions.transcript_path)"
```

---

### Task 2: Capture main-session `transcript_path` + lock prompt untruncation

**Files:**
- Modify: `lib/ingest.ts` (`handleSessionStart`, `ensureSession`)
- Test: `lib/ingest.test.ts` (create)

**Step 1: Write the failing test**

Create `lib/ingest.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "./db";
import { ingestEvent } from "./ingest";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ingest capture additions", () => {
  const testDbPath = join(tmpdir(), `agent-stalker-ingest-${Date.now()}.db`);

  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
    try { unlinkSync(testDbPath + "-wal"); } catch {}
    try { unlinkSync(testDbPath + "-shm"); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("stores transcript_path on the session at SessionStart", () => {
    ingestEvent({
      hook_event_name: "SessionStart",
      session_id: "s1",
      cwd: "/repo",
      permission_mode: "default",
      transcript_path: "/home/u/.claude/projects/p/s1.jsonl",
      source: "startup",
    });
    const db = getDb();
    const row = db.query("SELECT transcript_path FROM sessions WHERE id = ?").get("s1") as any;
    expect(row.transcript_path).toBe("/home/u/.claude/projects/p/s1.jsonl");
  });

  it("keeps user prompts untruncated", () => {
    const longPrompt = "x".repeat(5000);
    ingestEvent({
      hook_event_name: "UserPromptSubmit",
      session_id: "s2",
      cwd: "/repo",
      prompt: longPrompt,
    });
    const db = getDb();
    const row = db.query("SELECT data FROM events WHERE session_id = ? AND hook_event_name = 'UserPromptSubmit'").get("s2") as any;
    const data = JSON.parse(row.data);
    expect(data.prompt).toBe(longPrompt);
    expect(data.prompt.length).toBe(5000);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test lib/ingest.test.ts`
Expected: FAIL — `transcript_path` is null (not stored).

**Step 3: Write minimal implementation**

In `lib/ingest.ts`, update `handleSessionStart` to persist `transcript_path` in both branches:

```typescript
function handleSessionStart(event: Record<string, any>): void {
  const db = getDb();
  const existing = db.query("SELECT id FROM sessions WHERE id = ?").get(event.session_id);
  if (existing) {
    db.run(
      "UPDATE sessions SET cwd = ?, permission_mode = ?, model = ?, agent_type = ?, transcript_path = ?, started_at = ? WHERE id = ?",
      [event.cwd, event.permission_mode, event.model ?? null, event.agent_type ?? null, event.transcript_path ?? null, Date.now(), event.session_id],
    );
  } else {
    db.run(
      "INSERT INTO sessions (id, cwd, permission_mode, model, agent_type, transcript_path, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [event.session_id, event.cwd, event.permission_mode, event.model ?? null, event.agent_type ?? null, event.transcript_path ?? null, Date.now()],
    );
  }
  recordEvent(event, { source: event.source });
}
```

(The prompt-untruncation test already passes — `UserPromptSubmit` flows through `handleGeneric` which does not truncate. The test exists to lock that behavior against future regressions.)

**Step 4: Run test to verify it passes**

Run: `bun test lib/ingest.test.ts`
Expected: PASS (both tests).

**Step 5: Commit**

```bash
git add lib/ingest.ts lib/ingest.test.ts
git commit -m "feat(ingest): persist main-session transcript_path; lock prompt untruncation"
```

---

## PHASE 1 — Structured metrics + Insights dashboard

### Task 3: Analytics config + shared test helper

**Files:**
- Create: `lib/analytics/config.ts`
- Create: `lib/analytics/test-helpers.ts`

**Step 1: Write the config**

Create `lib/analytics/config.ts`:

```typescript
// All tunable thresholds for structured analytics. No magic numbers elsewhere.
export const ANALYTICS_CONFIG = {
  // Error→retry chain: a failure followed by another call to the same tool+target
  // by the same agent within this window counts as a retry link.
  retryWindowMs: 2 * 60 * 1000,
  // Tool retry: this many near-consecutive same-tool+target calls by one agent = thrash.
  retryMinRepeats: 3,
  // Churn: a file edited at least this many times in one session is a churn hotspot.
  churnMinEdits: 3,
  // Pain score weights (normalized signals, should roughly sum to 1).
  painWeights: {
    errorRate: 0.3,
    churn: 0.2,
    thrash: 0.3,
    effort: 0.2,
  },
};
```

**Step 2: Write the test helper**

Create `lib/analytics/test-helpers.ts`:

```typescript
import { getDb } from "../db";

let eventClock = 1_700_000_000_000;

/** Insert a session row (id only is enough for most analytics). */
export function seedSession(id: string, extra: Record<string, any> = {}): void {
  const db = getDb();
  db.run(
    "INSERT OR IGNORE INTO sessions (id, cwd, started_at) VALUES (?, ?, ?)",
    [id, extra.cwd ?? "/repo", extra.started_at ?? eventClock],
  );
}

/**
 * Insert an event. `data` is stored as JSON (matching ingest behavior).
 * Pass an explicit timestamp or let the helper auto-increment.
 */
export function seedEvent(opts: {
  session_id: string;
  hook_event_name: string;
  tool_name?: string;
  agent_id?: string;
  timestamp?: number;
  data?: any;
}): void {
  const db = getDb();
  const ts = opts.timestamp ?? (eventClock += 1000);
  db.run(
    `INSERT INTO events (session_id, hook_event_name, agent_id, timestamp, tool_name, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      opts.session_id,
      opts.hook_event_name,
      opts.agent_id ?? null,
      ts,
      opts.tool_name ?? null,
      opts.data ? JSON.stringify(opts.data) : null,
    ],
  );
}

/** Convenience: a successful tool call (PostToolUse). */
export function seedToolCall(session_id: string, tool_name: string, toolInput: any, opts: { agent_id?: string; timestamp?: number } = {}): void {
  seedEvent({
    session_id, hook_event_name: "PostToolUse", tool_name,
    agent_id: opts.agent_id, timestamp: opts.timestamp,
    data: { tool_input: toolInput, tool_response: { ok: true } },
  });
}

/** Convenience: a failed tool call (PostToolUseFailure). */
export function seedToolFailure(session_id: string, tool_name: string, toolInput: any, opts: { agent_id?: string; timestamp?: number } = {}): void {
  seedEvent({
    session_id, hook_event_name: "PostToolUseFailure", tool_name,
    agent_id: opts.agent_id, timestamp: opts.timestamp,
    data: { tool_input: toolInput, error: "boom" },
  });
}
```

**Step 3: Commit** (no tests yet — these are infrastructure used by the next tasks)

```bash
git add lib/analytics/config.ts lib/analytics/test-helpers.ts
git commit -m "feat(analytics): add config thresholds and test helpers"
```

---

### Task 4: File-path / target extraction

**Files:**
- Create: `lib/analytics/extract.ts`
- Test: `lib/analytics/extract.test.ts`

**Step 1: Write the failing test**

Create `lib/analytics/extract.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { extractFilePath, extractTarget } from "./extract";

describe("extractFilePath", () => {
  it("returns file_path for Edit/Write/Read/MultiEdit", () => {
    expect(extractFilePath("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(extractFilePath("Write", { file_path: "/a/c.ts" })).toBe("/a/c.ts");
    expect(extractFilePath("MultiEdit", { file_path: "/a/d.ts" })).toBe("/a/d.ts");
    expect(extractFilePath("Read", { file_path: "/a/e.ts" })).toBe("/a/e.ts");
  });

  it("returns null for non-file tools or missing path", () => {
    expect(extractFilePath("Bash", { command: "ls" })).toBeNull();
    expect(extractFilePath("Edit", {})).toBeNull();
    expect(extractFilePath("Edit", null)).toBeNull();
  });
});

describe("extractTarget", () => {
  it("uses file_path for file tools", () => {
    expect(extractTarget("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
  });
  it("uses normalized command for Bash", () => {
    expect(extractTarget("Bash", { command: "  ls -la  " })).toBe("ls -la");
  });
  it("falls back to a stable JSON key for other tools", () => {
    expect(extractTarget("Grep", { pattern: "foo", path: "src" }))
      .toBe(extractTarget("Grep", { path: "src", pattern: "foo" }));
  });
  it("returns null for empty input", () => {
    expect(extractTarget("Edit", null)).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test lib/analytics/extract.test.ts`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `lib/analytics/extract.ts`:

```typescript
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Read", "NotebookEdit"]);

export function extractFilePath(toolName: string, toolInput: any): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  if (!FILE_TOOLS.has(toolName)) return null;
  return typeof toolInput.file_path === "string" ? toolInput.file_path : null;
}

/** A stable identity for "the thing this tool acted on", for retry detection. */
export function extractTarget(toolName: string, toolInput: any): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const filePath = extractFilePath(toolName, toolInput);
  if (filePath) return filePath;
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    return toolInput.command.trim();
  }
  // Fallback: deterministic stringification (sorted keys) so equal inputs match.
  const keys = Object.keys(toolInput).sort();
  if (keys.length === 0) return null;
  return JSON.stringify(keys.map((k) => [k, toolInput[k]]));
}
```

**Step 4: Run test to verify it passes**

Run: `bun test lib/analytics/extract.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/analytics/extract.ts lib/analytics/extract.test.ts
git commit -m "feat(analytics): file_path and retry-target extraction"
```

---

### Task 5: Error metrics

**Files:**
- Create: `lib/analytics/errors.ts`
- Test: `lib/analytics/errors.test.ts`

**Step 1: Write the failing test**

Create `lib/analytics/errors.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall, seedToolFailure } from "./test-helpers";
import { sessionErrorStats, errorsByTool } from "./errors";

describe("error metrics", () => {
  const testDbPath = join(tmpdir(), `as-errors-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("computes per-session error count and rate", () => {
    seedSession("s1");
    seedToolCall("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Bash", { command: "ls" });
    seedToolFailure("s1", "Bash", { command: "bad" });

    const stats = sessionErrorStats(getDb());
    const row = stats.find((r) => r.session_id === "s1")!;
    expect(row.errors).toBe(1);
    expect(row.toolCalls).toBe(4); // 3 PostToolUse + 1 PostToolUseFailure
    expect(row.errorRate).toBeCloseTo(0.25, 5);
  });

  it("counts data.error on PostToolUse as an error too", () => {
    seedSession("s2");
    const db = getDb();
    db.run(
      `INSERT INTO events (session_id, hook_event_name, tool_name, timestamp, data) VALUES (?, 'PostToolUse', 'Edit', 1, ?)`,
      ["s2", JSON.stringify({ tool_input: { file_path: "/x" }, error: "nope" })],
    );
    const row = sessionErrorStats(db).find((r) => r.session_id === "s2")!;
    expect(row.errors).toBe(1);
  });

  it("aggregates errors by tool", () => {
    seedSession("s3");
    seedToolFailure("s3", "Bash", { command: "a" });
    seedToolFailure("s3", "Bash", { command: "b" });
    seedToolFailure("s3", "Edit", { file_path: "/y" });
    const byTool = errorsByTool(getDb());
    expect(byTool.find((r) => r.tool_name === "Bash")!.errors).toBe(2);
    expect(byTool.find((r) => r.tool_name === "Edit")!.errors).toBe(1);
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test lib/analytics/errors.test.ts`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `lib/analytics/errors.ts`:

```typescript
import type { Database } from "bun:sqlite";

interface EventRow { session_id: string; hook_event_name: string; tool_name: string | null; data: string | null; }

function isError(row: EventRow): boolean {
  if (row.hook_event_name === "PostToolUseFailure") return true;
  if (row.data) {
    try {
      const d = JSON.parse(row.data);
      if (d && d.error != null) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function toolCallRows(db: Database): EventRow[] {
  return db.query(
    "SELECT session_id, hook_event_name, tool_name, data FROM events WHERE hook_event_name IN ('PostToolUse','PostToolUseFailure')",
  ).all() as EventRow[];
}

export interface SessionErrorStat { session_id: string; errors: number; toolCalls: number; errorRate: number; }

export function sessionErrorStats(db: Database): SessionErrorStat[] {
  const rows = toolCallRows(db);
  const map = new Map<string, { errors: number; toolCalls: number }>();
  for (const r of rows) {
    const m = map.get(r.session_id) ?? { errors: 0, toolCalls: 0 };
    m.toolCalls += 1;
    if (isError(r)) m.errors += 1;
    map.set(r.session_id, m);
  }
  return [...map.entries()].map(([session_id, m]) => ({
    session_id, errors: m.errors, toolCalls: m.toolCalls,
    errorRate: m.toolCalls ? m.errors / m.toolCalls : 0,
  })).sort((a, b) => b.errors - a.errors);
}

export interface ToolErrorStat { tool_name: string; errors: number; }

export function errorsByTool(db: Database): ToolErrorStat[] {
  const rows = toolCallRows(db).filter(isError);
  const map = new Map<string, number>();
  for (const r of rows) {
    const t = r.tool_name ?? "(unknown)";
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return [...map.entries()].map(([tool_name, errors]) => ({ tool_name, errors }))
    .sort((a, b) => b.errors - a.errors);
}
```

**Step 4: Run to verify pass**

Run: `bun test lib/analytics/errors.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/analytics/errors.ts lib/analytics/errors.test.ts
git commit -m "feat(analytics): error metrics (per-session, per-tool)"
```

---

### Task 6: Churn metrics

**Files:**
- Create: `lib/analytics/churn.ts`
- Test: `lib/analytics/churn.test.ts`

**Step 1: Write the failing test**

Create `lib/analytics/churn.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall } from "./test-helpers";
import { fileChurn } from "./churn";

describe("churn metrics", () => {
  const testDbPath = join(tmpdir(), `as-churn-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("counts edits per file and the sessions touching it", () => {
    seedSession("s1");
    seedToolCall("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 1000 });
    seedToolCall("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 2000 });
    seedToolCall("s1", "Write", { file_path: "/a.ts" }, { timestamp: 3000 });
    seedToolCall("s1", "Read", { file_path: "/a.ts" }, { timestamp: 4000 }); // not an edit
    seedToolCall("s1", "Edit", { file_path: "/b.ts" }, { timestamp: 5000 });

    const churn = fileChurn(getDb());
    const a = churn.find((c) => c.file_path === "/a.ts")!;
    expect(a.edits).toBe(3);          // 2 Edit + 1 Write, Read excluded
    expect(a.sessions).toBe(1);
    expect(a.medianGapMs).toBe(1000); // gaps: 1000, 1000 -> median 1000
  });

  it("orders files by edit count descending", () => {
    seedSession("s1");
    seedToolCall("s1", "Edit", { file_path: "/low.ts" });
    seedToolCall("s1", "Edit", { file_path: "/high.ts" });
    seedToolCall("s1", "Edit", { file_path: "/high.ts" });
    const churn = fileChurn(getDb());
    expect(churn[0].file_path).toBe("/high.ts");
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test lib/analytics/churn.test.ts`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `lib/analytics/churn.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { extractFilePath } from "./extract";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

interface EventRow { session_id: string; tool_name: string | null; timestamp: number; data: string | null; }

export interface FileChurnStat { file_path: string; edits: number; sessions: number; medianGapMs: number; }

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function fileChurn(db: Database): FileChurnStat[] {
  const rows = db.query(
    "SELECT session_id, tool_name, timestamp, data FROM events WHERE hook_event_name = 'PostToolUse' AND tool_name IS NOT NULL ORDER BY timestamp ASC",
  ).all() as EventRow[];

  const byFile = new Map<string, { sessions: Set<string>; times: number[] }>();
  for (const r of rows) {
    if (!r.tool_name || !EDIT_TOOLS.has(r.tool_name) || !r.data) continue;
    let input: any;
    try { input = JSON.parse(r.data).tool_input; } catch { continue; }
    const fp = extractFilePath(r.tool_name, input);
    if (!fp) continue;
    const e = byFile.get(fp) ?? { sessions: new Set<string>(), times: [] };
    e.sessions.add(r.session_id);
    e.times.push(r.timestamp);
    byFile.set(fp, e);
  }

  return [...byFile.entries()].map(([file_path, e]) => {
    const gaps: number[] = [];
    for (let i = 1; i < e.times.length; i++) gaps.push(e.times[i] - e.times[i - 1]);
    return { file_path, edits: e.times.length, sessions: e.sessions.size, medianGapMs: median(gaps) };
  }).sort((a, b) => b.edits - a.edits);
}
```

**Step 4: Run to verify pass**

Run: `bun test lib/analytics/churn.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/analytics/churn.ts lib/analytics/churn.test.ts
git commit -m "feat(analytics): file churn metrics"
```

---

### Task 7: Thrash / pivot-loop metrics

**Files:**
- Create: `lib/analytics/thrash.ts`
- Test: `lib/analytics/thrash.test.ts`

**Step 1: Write the failing test**

Create `lib/analytics/thrash.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall, seedToolFailure, seedEvent } from "./test-helpers";
import { errorRetryChains, taskBounces } from "./thrash";

describe("thrash metrics", () => {
  const testDbPath = join(tmpdir(), `as-thrash-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("detects an error→retry chain on the same tool+target", () => {
    seedSession("s1");
    // fail Edit /a.ts, then retry Edit /a.ts within window
    seedToolFailure("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 1000, agent_id: "ag1" });
    seedToolCall("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 2000, agent_id: "ag1" });
    seedToolFailure("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 3000, agent_id: "ag1" });

    const chains = errorRetryChains(getDb());
    const c = chains.find((x) => x.session_id === "s1" && x.target === "/a.ts")!;
    expect(c.chainLength).toBeGreaterThanOrEqual(2);
  });

  it("does not chain across a long time gap", () => {
    seedSession("s2");
    seedToolFailure("s2", "Edit", { file_path: "/a.ts" }, { timestamp: 1000, agent_id: "ag1" });
    // retry 10 minutes later — beyond the 2-minute window
    seedToolCall("s2", "Edit", { file_path: "/a.ts" }, { timestamp: 1000 + 10 * 60 * 1000, agent_id: "ag1" });
    const chains = errorRetryChains(getDb());
    expect(chains.find((x) => x.session_id === "s2")).toBeUndefined();
  });

  it("counts task status bounces (re-entering a prior status)", () => {
    seedSession("s3");
    const db = getDb();
    db.run("INSERT INTO tasks (id, session_id, status) VALUES ('1','s3','pending')");
    const ins = (oldV: string, newV: string, ts: number) => db.run(
      `INSERT INTO task_events (task_id, session_id, event_type, field_name, old_value, new_value, timestamp)
       VALUES ('1','s3','status_change','status', ?, ?, ?)`, [oldV, newV, ts]);
    ins("pending", "in_progress", 1);
    ins("in_progress", "blocked", 2);
    ins("blocked", "in_progress", 3); // re-enters in_progress -> bounce
    const bounces = taskBounces(db);
    const b = bounces.find((x) => x.task_id === "1" && x.session_id === "s3")!;
    expect(b.bounces).toBe(1);
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test lib/analytics/thrash.test.ts`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `lib/analytics/thrash.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { extractTarget } from "./extract";
import { ANALYTICS_CONFIG } from "./config";

interface EventRow {
  session_id: string; hook_event_name: string; tool_name: string | null;
  agent_id: string | null; timestamp: number; data: string | null;
}

export interface RetryChain { session_id: string; agent_id: string | null; tool_name: string; target: string; chainLength: number; }

/**
 * A chain = a failure on (agent, tool, target) followed within retryWindowMs by
 * another call to the same (agent, tool, target). chainLength counts the links.
 */
export function errorRetryChains(db: Database): RetryChain[] {
  const rows = db.query(
    `SELECT session_id, hook_event_name, tool_name, agent_id, timestamp, data
     FROM events WHERE hook_event_name IN ('PostToolUse','PostToolUseFailure') AND tool_name IS NOT NULL
     ORDER BY timestamp ASC`,
  ).all() as EventRow[];

  // group by session|agent|tool|target
  const groups = new Map<string, { row: EventRow; isError: boolean; target: string }[]>();
  for (const r of rows) {
    if (!r.data || !r.tool_name) continue;
    let input: any;
    try { input = JSON.parse(r.data).tool_input; } catch { continue; }
    const target = extractTarget(r.tool_name, input);
    if (!target) continue;
    const key = `${r.session_id}|${r.agent_id ?? ""}|${r.tool_name}|${target}`;
    const isError = r.hook_event_name === "PostToolUseFailure" ||
      (() => { try { return JSON.parse(r.data!).error != null; } catch { return false; } })();
    const arr = groups.get(key) ?? [];
    arr.push({ row: r, isError, target });
    groups.set(key, arr);
  }

  const out: RetryChain[] = [];
  for (const [key, items] of groups) {
    items.sort((a, b) => a.row.timestamp - b.row.timestamp);
    let chainLength = 0;
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1], cur = items[i];
      const withinWindow = cur.row.timestamp - prev.row.timestamp <= ANALYTICS_CONFIG.retryWindowMs;
      if (prev.isError && withinWindow) chainLength += 1;
    }
    if (chainLength > 0) {
      const [session_id, agent_id, tool_name] = key.split("|");
      out.push({ session_id, agent_id: agent_id || null, tool_name, target: items[0].target, chainLength });
    }
  }
  return out.sort((a, b) => b.chainLength - a.chainLength);
}

interface TaskEventRow { task_id: string; session_id: string; new_value: string | null; timestamp: number; }

export interface TaskBounce { task_id: string; session_id: string; bounces: number; }

/** A bounce = a status_change whose new_value equals a status the task was already in earlier. */
export function taskBounces(db: Database): TaskBounce[] {
  const rows = db.query(
    `SELECT task_id, session_id, new_value, timestamp FROM task_events
     WHERE event_type = 'status_change' ORDER BY timestamp ASC`,
  ).all() as TaskEventRow[];

  const seen = new Map<string, Set<string>>(); // key task|session -> statuses seen
  const bounceCount = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.task_id}|${r.session_id}`;
    const set = seen.get(key) ?? new Set<string>();
    if (r.new_value && set.has(r.new_value)) {
      bounceCount.set(key, (bounceCount.get(key) ?? 0) + 1);
    }
    if (r.new_value) set.add(r.new_value);
    seen.set(key, set);
  }
  return [...bounceCount.entries()].map(([key, bounces]) => {
    const [task_id, session_id] = key.split("|");
    return { task_id, session_id, bounces };
  }).sort((a, b) => b.bounces - a.bounces);
}
```

**Step 4: Run to verify pass**

Run: `bun test lib/analytics/thrash.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/analytics/thrash.ts lib/analytics/thrash.test.ts
git commit -m "feat(analytics): thrash metrics (retry chains, task bounces)"
```

---

### Task 8: Effort proxy

**Files:**
- Create: `lib/analytics/effort.ts`
- Test: `lib/analytics/effort.test.ts`

**Step 1: Write the failing test**

Create `lib/analytics/effort.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall } from "./test-helpers";
import { sessionEffort } from "./effort";

describe("effort proxy", () => {
  const testDbPath = join(tmpdir(), `as-effort-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("aggregates events, tool calls, bytes, files, and duration per session", () => {
    seedSession("s1");
    seedToolCall("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 1000 });
    seedToolCall("s1", "Edit", { file_path: "/b.ts" }, { timestamp: 4000 });
    const e = sessionEffort(getDb()).find((r) => r.session_id === "s1")!;
    expect(e.events).toBe(2);
    expect(e.toolCalls).toBe(2);
    expect(e.files).toBe(2);
    expect(e.durationMs).toBe(3000);
    expect(e.bytes).toBeGreaterThan(0);
  });

  it("prefers real tokens from the usage table when present", () => {
    seedSession("s2");
    seedToolCall("s2", "Edit", { file_path: "/a.ts" });
    const db = getDb();
    db.run(`INSERT INTO usage (message_uuid, session_id, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
            VALUES ('m1','s2',100,50,0,0)`);
    const e = sessionEffort(db).find((r) => r.session_id === "s2")!;
    expect(e.realTokens).toBe(150);
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test lib/analytics/effort.test.ts`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `lib/analytics/effort.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { extractFilePath } from "./extract";

interface EventRow { session_id: string; tool_name: string | null; timestamp: number; data: string | null; }

export interface SessionEffort {
  session_id: string; events: number; toolCalls: number; bytes: number;
  files: number; durationMs: number; realTokens: number | null;
}

export function sessionEffort(db: Database): SessionEffort[] {
  const rows = db.query(
    "SELECT session_id, tool_name, timestamp, data FROM events ORDER BY timestamp ASC",
  ).all() as EventRow[];

  const map = new Map<string, { events: number; toolCalls: number; bytes: number; files: Set<string>; min: number; max: number }>();
  for (const r of rows) {
    const m = map.get(r.session_id) ?? { events: 0, toolCalls: 0, bytes: 0, files: new Set<string>(), min: r.timestamp, max: r.timestamp };
    m.events += 1;
    if (r.tool_name) m.toolCalls += 1;
    if (r.data) {
      m.bytes += r.data.length;
      try {
        const fp = extractFilePath(r.tool_name ?? "", JSON.parse(r.data).tool_input);
        if (fp) m.files.add(fp);
      } catch { /* ignore */ }
    }
    m.min = Math.min(m.min, r.timestamp);
    m.max = Math.max(m.max, r.timestamp);
    map.set(r.session_id, m);
  }

  // real tokens, if the usage table is populated
  const tokenRows = db.query(
    `SELECT session_id, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS total
     FROM usage GROUP BY session_id`,
  ).all() as { session_id: string; total: number }[];
  const tokenMap = new Map(tokenRows.map((r) => [r.session_id, r.total]));

  return [...map.entries()].map(([session_id, m]) => ({
    session_id, events: m.events, toolCalls: m.toolCalls, bytes: m.bytes,
    files: m.files.size, durationMs: m.max - m.min,
    realTokens: tokenMap.has(session_id) ? tokenMap.get(session_id)! : null,
  })).sort((a, b) => b.events - a.events);
}
```

**Step 4: Run to verify pass**

Run: `bun test lib/analytics/effort.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/analytics/effort.ts lib/analytics/effort.test.ts
git commit -m "feat(analytics): effort proxy with real-token fallback"
```

---

### Task 9: Composite pain score

**Files:**
- Create: `lib/analytics/pain.ts`
- Test: `lib/analytics/pain.test.ts`

**Step 1: Write the failing test**

Create `lib/analytics/pain.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall, seedToolFailure } from "./test-helpers";
import { painLeaderboard } from "./pain";

describe("pain score", () => {
  const testDbPath = join(tmpdir(), `as-pain-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("ranks a high-error/high-churn session above a clean one, with an explainable breakdown", () => {
    // painful session
    seedSession("painful");
    for (let i = 0; i < 5; i++) {
      seedToolFailure("painful", "Edit", { file_path: "/hot.ts" }, { timestamp: 1000 + i * 1000, agent_id: "ag1" });
      seedToolCall("painful", "Edit", { file_path: "/hot.ts" }, { timestamp: 1500 + i * 1000, agent_id: "ag1" });
    }
    // clean session
    seedSession("clean");
    seedToolCall("clean", "Edit", { file_path: "/a.ts" }, { timestamp: 1000 });
    seedToolCall("clean", "Bash", { command: "ls" }, { timestamp: 2000 });

    const board = painLeaderboard(getDb());
    expect(board[0].session_id).toBe("painful");
    expect(board[0].score).toBeGreaterThan(board[board.length - 1].score);
    // breakdown is present and explains the score
    expect(board[0].breakdown).toHaveProperty("errorRate");
    expect(board[0].breakdown).toHaveProperty("churn");
    expect(board[0].breakdown).toHaveProperty("thrash");
    expect(board[0].breakdown).toHaveProperty("effort");
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test lib/analytics/pain.test.ts`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `lib/analytics/pain.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { ANALYTICS_CONFIG } from "./config";
import { sessionErrorStats } from "./errors";
import { fileChurn } from "./churn";
import { errorRetryChains, taskBounces } from "./thrash";
import { sessionEffort } from "./effort";

export interface PainEntry {
  session_id: string;
  score: number;
  breakdown: { errorRate: number; churn: number; thrash: number; effort: number };
  raw: { errorRate: number; churnEdits: number; thrashDepth: number; effort: number };
}

/** Normalize a value to 0..1 by dividing by the max in the set (0 if all zero). */
function normalizer(values: number[]): (v: number) => number {
  const max = Math.max(0, ...values);
  return (v: number) => (max > 0 ? v / max : 0);
}

export function painLeaderboard(db: Database): PainEntry[] {
  const errors = sessionErrorStats(db);
  const effort = sessionEffort(db);
  const chains = errorRetryChains(db);
  const bounces = taskBounces(db);
  const churn = fileChurn(db);

  // sessions = union of all session ids seen
  const sessionIds = new Set<string>();
  errors.forEach((e) => sessionIds.add(e.session_id));
  effort.forEach((e) => sessionIds.add(e.session_id));

  // per-session raw signals
  const errorRateBy = new Map(errors.map((e) => [e.session_id, e.errorRate]));
  const effortBy = new Map(effort.map((e) => [e.session_id, e.realTokens ?? e.bytes]));

  const thrashBy = new Map<string, number>();
  for (const c of chains) thrashBy.set(c.session_id, (thrashBy.get(c.session_id) ?? 0) + c.chainLength);
  for (const b of bounces) thrashBy.set(b.session_id, (thrashBy.get(b.session_id) ?? 0) + b.bounces);

  // churn is per-file; attribute to sessions via a per-session edit count
  const churnBy = new Map<string, number>();
  // recompute session churn from events: count edit events per session over churnMinEdits files
  const editRows = db.query(
    "SELECT session_id, COUNT(*) AS edits FROM events WHERE hook_event_name='PostToolUse' AND tool_name IN ('Edit','Write','MultiEdit','NotebookEdit') GROUP BY session_id",
  ).all() as { session_id: string; edits: number }[];
  for (const r of editRows) churnBy.set(r.session_id, r.edits);

  const ids = [...sessionIds];
  const normErr = normalizer(ids.map((id) => errorRateBy.get(id) ?? 0));
  const normChurn = normalizer(ids.map((id) => churnBy.get(id) ?? 0));
  const normThrash = normalizer(ids.map((id) => thrashBy.get(id) ?? 0));
  const normEffort = normalizer(ids.map((id) => effortBy.get(id) ?? 0));

  const w = ANALYTICS_CONFIG.painWeights;
  return ids.map((session_id) => {
    const rawErr = errorRateBy.get(session_id) ?? 0;
    const rawChurn = churnBy.get(session_id) ?? 0;
    const rawThrash = thrashBy.get(session_id) ?? 0;
    const rawEffort = effortBy.get(session_id) ?? 0;
    const breakdown = {
      errorRate: w.errorRate * normErr(rawErr),
      churn: w.churn * normChurn(rawChurn),
      thrash: w.thrash * normThrash(rawThrash),
      effort: w.effort * normEffort(rawEffort),
    };
    const score = breakdown.errorRate + breakdown.churn + breakdown.thrash + breakdown.effort;
    return { session_id, score, breakdown, raw: { errorRate: rawErr, churnEdits: rawChurn, thrashDepth: rawThrash, effort: rawEffort } };
  }).sort((a, b) => b.score - a.score);
}
```

**Step 4: Run to verify pass**

Run: `bun test lib/analytics/pain.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/analytics/pain.ts lib/analytics/pain.test.ts
git commit -m "feat(analytics): composite pain score leaderboard"
```

---

### Task 10: Analytics API endpoints

**Files:**
- Modify: `ui/server.ts` (add insights routes inside `handleApi`, before the final `return jsonResponse({ error: "Not found" }, 404);`)
- Test: `ui/server.test.ts` (extend)

First inspect the existing `ui/server.test.ts` to match its style (it was added in a recent commit). Then add tests.

**Step 1: Write the failing test**

Append to `ui/server.test.ts` (adapt imports to match the file's existing harness — it spins up the server or calls `handleApi`; if it calls a fetch against a running server, mirror that):

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../lib/db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolFailure, seedToolCall } from "../lib/analytics/test-helpers";

describe("insights endpoints", () => {
  const testDbPath = join(tmpdir(), `as-server-insights-${Date.now()}.db`);
  let server: any;
  beforeEach(() => {
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
    seedSession("s1");
    seedToolFailure("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Edit", { file_path: "/a.ts" });
  });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("GET /api/insights/pain returns a ranked leaderboard", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/pain"), "GET");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty("session_id");
    expect(body[0]).toHaveProperty("score");
    expect(body[0]).toHaveProperty("breakdown");
  });

  it("GET /api/insights/errors returns per-session and per-tool stats", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/errors"), "GET");
    const body = await res.json();
    expect(body).toHaveProperty("bySession");
    expect(body).toHaveProperty("byTool");
  });
});
```

> **Note:** This test imports `handleApiForTest`, a thin exported wrapper. Step 3 exports it. If the existing `ui/server.test.ts` already starts a real server via `Bun.serve`, follow that pattern instead and hit `http://localhost:<port>/api/insights/pain`; either way the assertions on the JSON body are identical.

**Step 2: Run to verify failure**

Run: `bun test ui/server.test.ts`
Expected: FAIL — route + `handleApiForTest` missing.

**Step 3: Write implementation**

In `ui/server.ts`, add imports at the top:

```typescript
import { painLeaderboard } from "../lib/analytics/pain";
import { sessionErrorStats, errorsByTool } from "../lib/analytics/errors";
import { fileChurn } from "../lib/analytics/churn";
import { errorRetryChains, taskBounces } from "../lib/analytics/thrash";
```

Inside `handleApi`, before the final 404 return, add:

```typescript
  if (path === "/api/insights/pain") {
    return jsonResponse(painLeaderboard(db));
  }
  if (path === "/api/insights/errors") {
    return jsonResponse({ bySession: sessionErrorStats(db), byTool: errorsByTool(db) });
  }
  if (path === "/api/insights/churn") {
    return jsonResponse(fileChurn(db));
  }
  if (path === "/api/insights/thrash") {
    return jsonResponse({ retryChains: errorRetryChains(db), taskBounces: taskBounces(db) });
  }
```

At the end of `ui/server.ts`, export a test wrapper (after the `Bun.serve` block is fine; it does not start a second server):

```typescript
export function handleApiForTest(url: URL, method: string): Response {
  return handleApi(url, method);
}
```

> If `Bun.serve` running at import time interferes with tests, guard it: wrap the `const server = Bun.serve({...})` and the two lines after it in `if (import.meta.main) { ... }`. Make that change in this step if the test cannot import the module cleanly.

**Step 4: Run to verify pass**

Run: `bun test ui/server.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add ui/server.ts ui/server.test.ts
git commit -m "feat(server): add /api/insights endpoints (pain, errors, churn, thrash)"
```

---

### Task 11: Insights dashboard view (UI)

**Files:**
- Create: `ui/js/insights.js`
- Create: `ui/css/insights.css`
- Modify: `ui/index.html` (add a nav toggle + an insights panel container + stylesheet link)
- Modify: `ui/js/main.js` (wire up the view toggle)

**Step 1: Add the API calls**

Create `ui/js/insights.js`:

```javascript
import { API } from './state.js';
import { esc } from './util.js';

async function fetchJSON(url) {
  try { const r = await fetch(API + url); return r.ok ? await r.json() : null; } catch { return null; }
}

export async function renderInsights() {
  const panel = document.getElementById('insightsPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="insights-loading">Loading insights…</div>';

  const [pain, errors, churn, thrash, semantic] = await Promise.all([
    fetchJSON('/api/insights/pain'),
    fetchJSON('/api/insights/errors'),
    fetchJSON('/api/insights/churn'),
    fetchJSON('/api/insights/thrash'),
    fetchJSON('/api/insights/semantic/status'),
  ]);

  panel.innerHTML = `
    ${renderPain(pain)}
    ${renderChurn(churn)}
    ${renderErrors(errors)}
    ${renderThrash(thrash)}
    ${renderSemanticSection(semantic)}
  `;
  wireSemanticButton();
}

function bar(frac) {
  const pct = Math.round((frac || 0) * 100);
  return `<span class="pain-bar"><span class="pain-bar-fill" style="width:${pct}%"></span></span>`;
}

function renderPain(pain) {
  if (!pain || !pain.length) return section('Pain leaderboard', '<p class="empty">No data yet.</p>');
  const rows = pain.slice(0, 20).map(p => `
    <tr>
      <td class="mono">${esc(p.session_id.slice(0, 8))}</td>
      <td>${p.score.toFixed(3)}</td>
      <td>${bar(p.breakdown.errorRate)} err</td>
      <td>${bar(p.breakdown.churn)} churn</td>
      <td>${bar(p.breakdown.thrash)} thrash</td>
      <td>${bar(p.breakdown.effort)} effort</td>
    </tr>`).join('');
  return section('Pain leaderboard',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Score</th><th colspan="4">Breakdown</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderChurn(churn) {
  if (!churn || !churn.length) return section('File churn', '<p class="empty">No data yet.</p>');
  const rows = churn.slice(0, 20).map(c => `
    <tr><td class="mono">${esc(c.file_path)}</td><td>${c.edits}</td><td>${c.sessions}</td><td>${Math.round(c.medianGapMs/1000)}s</td></tr>`).join('');
  return section('File churn',
    `<table class="insights-table"><thead><tr><th>File</th><th>Edits</th><th>Sessions</th><th>Median gap</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderErrors(errors) {
  if (!errors) return section('Errors', '<p class="empty">No data yet.</p>');
  const tool = (errors.byTool || []).slice(0, 10).map(t => `<tr><td>${esc(t.tool_name)}</td><td>${t.errors}</td></tr>`).join('');
  const sess = (errors.bySession || []).slice(0, 10).map(s => `<tr><td class="mono">${esc(s.session_id.slice(0,8))}</td><td>${s.errors}</td><td>${(s.errorRate*100).toFixed(1)}%</td></tr>`).join('');
  return section('Errors',
    `<div class="insights-cols">
       <div><h4>By tool</h4><table class="insights-table"><tbody>${tool}</tbody></table></div>
       <div><h4>By session</h4><table class="insights-table"><tbody>${sess}</tbody></table></div>
     </div>`);
}

function renderThrash(thrash) {
  if (!thrash) return section('Thrash / pivot-loops', '<p class="empty">No data yet.</p>');
  const chains = (thrash.retryChains || []).slice(0, 15).map(c =>
    `<tr><td class="mono">${esc(c.session_id.slice(0,8))}</td><td>${esc(c.tool_name)}</td><td class="mono">${esc(String(c.target).slice(0,40))}</td><td>${c.chainLength}</td></tr>`).join('');
  return section('Thrash / pivot-loops',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Tool</th><th>Target</th><th>Retry depth</th></tr></thead><tbody>${chains}</tbody></table>`);
}

function section(title, inner) {
  return `<section class="insights-section"><h3>${esc(title)}</h3>${inner}</section>`;
}

// --- semantic (Phase 3) ---
function renderSemanticSection(status) {
  if (!status || !status.available) {
    return section('Semantic features',
      `<p class="empty">Opt-in AI analysis (frustration, topics, error clusters). ${status && status.pythonMissing ? 'Python or dependencies not detected.' : ''}</p>
       <button id="enableSemanticBtn" class="insights-btn">Enable semantic features</button>
       <pre id="semanticStatusOut" class="semantic-status"></pre>`);
  }
  return section('Semantic features',
    `<p>Last computed: ${status.lastRun ? new Date(status.lastRun).toLocaleString() : 'never'}.</p>
     <button id="enableSemanticBtn" class="insights-btn">Recompute</button>
     <pre id="semanticStatusOut" class="semantic-status"></pre>`);
}

function wireSemanticButton() {
  const btn = document.getElementById('enableSemanticBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const out = document.getElementById('semanticStatusOut');
    out.textContent = 'Starting semantic batch…';
    const res = await fetch(API + '/api/insights/semantic/run', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    out.textContent = body.message || (res.ok ? 'Started.' : 'Failed to start.');
  });
}
```

**Step 2: Add the stylesheet**

Create `ui/css/insights.css`:

```css
#insightsPanel { padding: 16px; overflow-y: auto; }
.insights-section { margin-bottom: 24px; }
.insights-section h3 { margin: 0 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: .04em; opacity: .8; }
.insights-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.insights-table th, .insights-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,.06); }
.insights-table .mono { font-family: ui-monospace, monospace; }
.insights-cols { display: flex; gap: 24px; }
.insights-cols > div { flex: 1; }
.pain-bar { display: inline-block; width: 60px; height: 8px; background: rgba(255,255,255,.1); border-radius: 4px; vertical-align: middle; overflow: hidden; }
.pain-bar-fill { display: block; height: 100%; background: #e0567a; }
.insights-btn { padding: 6px 12px; border: 1px solid rgba(255,255,255,.2); background: transparent; color: inherit; border-radius: 6px; cursor: pointer; }
.insights-btn:hover { background: rgba(255,255,255,.08); }
.semantic-status { margin-top: 8px; font-size: 12px; opacity: .8; white-space: pre-wrap; }
.empty { opacity: .6; font-size: 13px; }
.insights-loading { padding: 24px; opacity: .6; }
```

**Step 3: Wire into index.html**

Add the stylesheet link after the modal css line:

```html
<link rel="stylesheet" href="/css/insights.css">
```

Add a view toggle in `.header-controls` (before the live-indicator div):

```html
      <div class="view-toggle" id="viewToggle">
        <button class="view-btn active" data-view="activity" id="viewActivityBtn">Activity</button>
        <button class="view-btn" data-view="insights" id="viewInsightsBtn">Insights</button>
      </div>
```

Add the insights panel inside `.content`, as a sibling of the existing panels (hidden by default):

```html
    <div class="content-panel" id="insightsPanel" style="display:none"></div>
```

**Step 4: Wire the toggle in main.js**

Add to `ui/js/main.js` imports:

```javascript
import { renderInsights } from './insights.js';
```

Add after the existing event-listener setup (e.g. after the Live toggle block):

```javascript
// View toggle (Activity <-> Insights)
function setView(view) {
  const isInsights = view === 'insights';
  document.getElementById('kanbanPanel').style.display = isInsights ? 'none' : '';
  document.getElementById('activityPanel').style.display = isInsights ? 'none' : '';
  document.getElementById('insightsPanel').style.display = isInsights ? '' : 'none';
  document.getElementById('viewActivityBtn').classList.toggle('active', !isInsights);
  document.getElementById('viewInsightsBtn').classList.toggle('active', isInsights);
  if (isInsights) renderInsights();
}
document.getElementById('viewActivityBtn').addEventListener('click', () => setView('activity'));
document.getElementById('viewInsightsBtn').addEventListener('click', () => setView('insights'));
```

Add minimal `.view-toggle`/`.view-btn` styles to `ui/css/header.css`:

```css
.view-toggle { display: inline-flex; gap: 2px; margin-right: 12px; }
.view-btn { padding: 4px 10px; background: transparent; border: 1px solid rgba(255,255,255,.15); color: inherit; cursor: pointer; font-size: 12px; }
.view-btn:first-child { border-radius: 6px 0 0 6px; }
.view-btn:last-child { border-radius: 0 6px 6px 0; }
.view-btn.active { background: rgba(255,255,255,.14); }
```

**Step 5: Manual verification**

Run: `bun ui/server.ts --port 3141` then open `http://localhost:3141`, click **Insights**.
Expected: Pain leaderboard, churn, errors, thrash sections render; "Enable semantic features" button shows (clicking it will return a not-yet-implemented message until Task 22).

**Step 6: Commit**

```bash
git add ui/js/insights.js ui/css/insights.css ui/index.html ui/js/main.js ui/css/header.css
git commit -m "feat(ui): Insights dashboard view (pain, churn, errors, thrash)"
```

---

## PHASE 2 — Token research spike + usage parser

### Task 12: Research spike — token capture decision note

**Files:**
- Create: `docs/superpowers/specs/2026-05-31-token-capture-spike.md`

**Step 1: Investigate the transcript format**

Run these to gather facts (transcripts live under `~/.claude/projects/<slug>/<uuid>.jsonl`):

```bash
F=$(find "$HOME/.claude/projects" -name "*.jsonl" 2>/dev/null | head -1)
echo "file: $F"
head -3 "$F" | bun -e 'for await (const l of console) { const o = JSON.parse(l); console.log(Object.keys(o)); }'
grep -o '"usage":{[^}]*}' "$F" | head -3
```

Confirm these facts (known from the design spike): each assistant message line contains `message.usage` with `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`; lines carry a `uuid`, a `sessionId`, a `timestamp` (ISO), and a `type` (`user`/`assistant`).

**Step 2: Write the decision note**

Create `docs/superpowers/specs/2026-05-31-token-capture-spike.md` documenting:
- Transcript path source: `sessions.transcript_path` (now captured in Task 2) for the main session; `agents.transcript_path` for subagents.
- Line schema observed (keys, the `message.usage` shape, `uuid` for dedupe, `timestamp` ISO → epoch ms).
- Mapping rule: `message_uuid` = line `uuid`; `session_id` = our session id (the transcript file is per-session); `agent_id` = matched via `agents.transcript_path` when the file is a subagent transcript, else null; `role` = line `type`.
- Idempotency: `INSERT OR IGNORE` on `usage.message_uuid`.
- Format-drift handling: skip lines without `message.usage`; ignore unknown keys.
- Decision: parse on `SessionEnd` + a manual `bun run ingest-usage` command (no daemon).

**Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-31-token-capture-spike.md
git commit -m "docs: token-capture spike decision note"
```

---

### Task 13: Transcript parser → `usage` rows

**Files:**
- Create: `lib/usage/parse-transcript.ts`
- Create: `lib/usage/parse-transcript.test.ts`

**Step 1: Write the failing test**

Create `lib/usage/parse-transcript.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { parseTranscriptLines, ingestUsageFromLines } from "./parse-transcript";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SAMPLE = [
  JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", timestamp: "2026-05-31T10:00:00.000Z", message: { role: "user", content: "hi" } }),
  JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "s1", timestamp: "2026-05-31T10:00:01.000Z", message: { role: "assistant", usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 20 } } }),
  "not json, should be skipped",
  JSON.stringify({ type: "assistant", uuid: "a2", sessionId: "s1", timestamp: "2026-05-31T10:00:02.000Z", message: { role: "assistant" } }), // no usage -> skipped
];

describe("transcript parser", () => {
  const testDbPath = join(tmpdir(), `as-usage-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("extracts only assistant lines that have usage", () => {
    const rows = parseTranscriptLines(SAMPLE, "s1", null);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      message_uuid: "a1", session_id: "s1", role: "assistant",
      input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 20,
    });
    expect(rows[0].timestamp).toBe(Date.parse("2026-05-31T10:00:01.000Z"));
  });

  it("ingests rows idempotently (INSERT OR IGNORE on uuid)", () => {
    const db = getDb();
    ingestUsageFromLines(db, SAMPLE, "s1", null);
    ingestUsageFromLines(db, SAMPLE, "s1", null); // second run no dupes
    const count = db.query("SELECT COUNT(*) c FROM usage").get() as { c: number };
    expect(count.c).toBe(1);
    const total = db.query("SELECT SUM(input_tokens) t FROM usage").get() as { t: number };
    expect(total.t).toBe(10);
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test lib/usage/parse-transcript.test.ts`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `lib/usage/parse-transcript.ts`:

```typescript
import type { Database } from "bun:sqlite";

export interface UsageRow {
  message_uuid: string; session_id: string; agent_id: string | null; role: string;
  input_tokens: number; cache_creation_input_tokens: number;
  cache_read_input_tokens: number; output_tokens: number; timestamp: number;
}

export function parseTranscriptLines(lines: string[], sessionId: string, agentId: string | null): UsageRow[] {
  const out: UsageRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const usage = obj?.message?.usage;
    if (!usage || typeof usage.input_tokens !== "number") continue;
    const uuid = obj.uuid;
    if (!uuid) continue;
    out.push({
      message_uuid: String(uuid),
      session_id: sessionId,
      agent_id: agentId,
      role: obj.type ?? obj.message?.role ?? "assistant",
      input_tokens: usage.input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      timestamp: obj.timestamp ? Date.parse(obj.timestamp) : Date.now(),
    });
  }
  return out;
}

export function ingestUsageFromLines(db: Database, lines: string[], sessionId: string, agentId: string | null): number {
  const rows = parseTranscriptLines(lines, sessionId, agentId);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO usage
     (message_uuid, session_id, agent_id, role, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  for (const r of rows) {
    const res = stmt.run(r.message_uuid, r.session_id, r.agent_id, r.role,
      r.input_tokens, r.cache_creation_input_tokens, r.cache_read_input_tokens, r.output_tokens, r.timestamp);
    if (res.changes > 0) inserted += 1;
  }
  return inserted;
}
```

**Step 4: Run to verify pass**

Run: `bun test lib/usage/parse-transcript.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/usage/parse-transcript.ts lib/usage/parse-transcript.test.ts
git commit -m "feat(usage): transcript line parser with idempotent ingest"
```

---

### Task 14: Usage ingest job (file reader + SessionEnd wiring + manual command)

**Files:**
- Create: `lib/usage/ingest-usage.ts`
- Create: `lib/usage/ingest-usage.test.ts`
- Modify: `lib/ingest.ts` (`handleSessionEnd` triggers usage ingest)

**Step 1: Write the failing test**

Create `lib/usage/ingest-usage.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { ingestUsageForSession } from "./ingest-usage";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ingestUsageForSession", () => {
  const testDbPath = join(tmpdir(), `as-usage-job-${Date.now()}.db`);
  const transcriptPath = join(tmpdir(), `as-transcript-${Date.now()}.jsonl`);

  beforeEach(() => {
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
    writeFileSync(transcriptPath, [
      JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "s1", timestamp: "2026-05-31T10:00:01.000Z", message: { usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    ].join("\n"));
  });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    try { unlinkSync(transcriptPath); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("reads the session transcript file and inserts usage rows", () => {
    const db = getDb();
    db.run("INSERT INTO sessions (id, transcript_path, started_at) VALUES ('s1', ?, 1)", [transcriptPath]);
    const inserted = ingestUsageForSession(db, "s1");
    expect(inserted).toBe(1);
    const row = db.query("SELECT * FROM usage WHERE session_id='s1'").get() as any;
    expect(row.input_tokens).toBe(7);
  });

  it("returns 0 when the session has no transcript_path", () => {
    const db = getDb();
    db.run("INSERT INTO sessions (id, started_at) VALUES ('s2', 1)");
    expect(ingestUsageForSession(db, "s2")).toBe(0);
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test lib/usage/ingest-usage.test.ts`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `lib/usage/ingest-usage.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { ingestUsageFromLines } from "./parse-transcript";

/** Ingest token usage for one session from its main transcript + any subagent transcripts. */
export function ingestUsageForSession(db: Database, sessionId: string): number {
  let inserted = 0;

  const session = db.query("SELECT transcript_path FROM sessions WHERE id = ?").get(sessionId) as { transcript_path: string | null } | null;
  if (session?.transcript_path && existsSync(session.transcript_path)) {
    const lines = readFileSync(session.transcript_path, "utf-8").split("\n");
    inserted += ingestUsageFromLines(db, lines, sessionId, null);
  }

  const agents = db.query("SELECT id, transcript_path FROM agents WHERE session_id = ? AND transcript_path IS NOT NULL").all(sessionId) as { id: string; transcript_path: string }[];
  for (const a of agents) {
    if (existsSync(a.transcript_path)) {
      const lines = readFileSync(a.transcript_path, "utf-8").split("\n");
      inserted += ingestUsageFromLines(db, lines, sessionId, a.id);
    }
  }
  return inserted;
}

/** Ingest usage for every session that has a transcript path (manual command). */
export function ingestUsageAll(db: Database): number {
  const sessions = db.query("SELECT id FROM sessions").all() as { id: string }[];
  let total = 0;
  for (const s of sessions) total += ingestUsageForSession(db, s.id);
  return total;
}

// CLI: `bun run lib/usage/ingest-usage.ts`
if (import.meta.main) {
  const { getDb } = await import("../db");
  const db = getDb();
  const n = ingestUsageAll(db);
  console.log(`Ingested ${n} usage rows.`);
}
```

**Step 4: Wire SessionEnd**

In `lib/ingest.ts`, update `handleSessionEnd` to trigger usage ingest (best-effort, never throws into the hook path):

```typescript
function handleSessionEnd(event: Record<string, any>): void {
  const db = getDb();
  db.run("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?", [Date.now(), event.reason, event.session_id]);
  recordEvent(event, { reason: event.reason });
  try {
    const { ingestUsageForSession } = require("./usage/ingest-usage");
    ingestUsageForSession(db, event.session_id);
  } catch { /* usage ingest is best-effort */ }
}
```

**Step 5: Add a script alias to package.json**

In `package.json`, add a `scripts` block:

```json
  "scripts": {
    "ingest-usage": "bun run lib/usage/ingest-usage.ts",
    "test": "bun test"
  },
```

**Step 6: Run to verify pass**

Run: `bun test lib/usage/ingest-usage.test.ts`
Expected: PASS.

**Step 7: Commit**

```bash
git add lib/usage/ingest-usage.ts lib/usage/ingest-usage.test.ts lib/ingest.ts package.json
git commit -m "feat(usage): session usage ingest on SessionEnd + manual command"
```

---

### Task 15: Surface real tokens in the pain breakdown & Insights UI

**Files:**
- Modify: `ui/server.ts` (add `/api/insights/tokens`)
- Modify: `ui/js/insights.js` (render a tokens section)
- Test: `ui/server.test.ts` (add a tokens test)

**Step 1: Write the failing test**

Append to `ui/server.test.ts`:

```typescript
it("GET /api/insights/tokens returns per-session token totals", async () => {
  const db = getDb();
  db.run("INSERT INTO sessions (id, started_at) VALUES ('st', 1)");
  db.run(`INSERT INTO usage (message_uuid, session_id, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
          VALUES ('m1','st',100,40,10,5)`);
  const { handleApiForTest } = await import("./server");
  const res = handleApiForTest(new URL("http://x/api/insights/tokens"), "GET");
  const body = await res.json();
  const row = body.find((r) => r.session_id === "st");
  expect(row.input_tokens).toBe(100);
  expect(row.output_tokens).toBe(40);
});
```

**Step 2: Run to verify failure**

Run: `bun test ui/server.test.ts`
Expected: FAIL — route missing.

**Step 3: Implement the endpoint**

In `ui/server.ts`, inside `handleApi` before the 404:

```typescript
  if (path === "/api/insights/tokens") {
    const rows = db.query(
      `SELECT session_id,
              SUM(COALESCE(input_tokens,0)) AS input_tokens,
              SUM(COALESCE(output_tokens,0)) AS output_tokens,
              SUM(COALESCE(cache_creation_input_tokens,0)) AS cache_creation_input_tokens,
              SUM(COALESCE(cache_read_input_tokens,0)) AS cache_read_input_tokens
       FROM usage GROUP BY session_id
       ORDER BY (SUM(COALESCE(input_tokens,0))+SUM(COALESCE(output_tokens,0))) DESC`,
    ).all();
    return jsonResponse(rows);
  }
```

**Step 4: Render in insights.js**

In `ui/js/insights.js`, add a fetch and a render call. In `renderInsights`, add `fetchJSON('/api/insights/tokens')` to the `Promise.all` and pass it to a `renderTokens` block:

```javascript
function renderTokens(tokens) {
  if (!tokens || !tokens.length) return section('Token usage', '<p class="empty">Run usage ingest (SessionEnd or `bun run ingest-usage`) to populate.</p>');
  const rows = tokens.slice(0, 20).map(t =>
    `<tr><td class="mono">${esc(t.session_id.slice(0,8))}</td><td>${t.input_tokens}</td><td>${t.output_tokens}</td><td>${t.cache_read_input_tokens}</td></tr>`).join('');
  return section('Token usage',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Input</th><th>Output</th><th>Cache read</th></tr></thead><tbody>${rows}</tbody></table>`);
}
```

Wire it: change the destructure to include tokens and insert `${renderTokens(tokens)}` into the panel template (after `renderPain`).

**Step 5: Run to verify pass**

Run: `bun test ui/server.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add ui/server.ts ui/server.test.ts ui/js/insights.js
git commit -m "feat(insights): real token usage endpoint + UI section"
```

---

## PHASE 3 — Python semantic sidecar (opt-in)

### Task 16: DB migration v7 — empty `semantic_*` tables (TS side)

**Files:**
- Modify: `lib/db.ts` (migration `currentVersion < 7`)
- Test: `lib/db.test.ts` (add `describe("v7 migration", ...)`)

**Step 1: Write the failing test**

Add to `lib/db.test.ts`:

```typescript
describe("v7 migration", () => {
  const semanticTables = [
    "semantic_meta", "semantic_sentiment", "semantic_topics",
    "semantic_topic_assignments", "semantic_error_clusters",
    "semantic_error_assignments", "semantic_pivot_signals", "semantic_session_triage",
  ];
  it("creates all semantic_* tables (empty)", () => {
    const db = getDb();
    const names = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
    for (const t of semanticTables) expect(names).toContain(t);
  });
  it("schema_version is at least 7", () => {
    const db = getDb();
    const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(7);
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test lib/db.test.ts`
Expected: FAIL — semantic tables missing.

**Step 3: Implement migration**

In `lib/db.ts`, after the `currentVersion < 6` block:

```typescript
  if (currentVersion < 7) {
    db.run(`CREATE TABLE semantic_meta (
      feature TEXT PRIMARY KEY, version TEXT, model TEXT, last_run_at INTEGER, corpus_size INTEGER, status TEXT
    )`);
    db.run(`CREATE TABLE semantic_sentiment (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_kind TEXT, event_id INTEGER, session_id TEXT,
      score REAL, label TEXT, timestamp INTEGER
    )`);
    db.run(`CREATE TABLE semantic_topics (
      topic_id INTEGER PRIMARY KEY, label TEXT, keywords TEXT, size INTEGER, pain_score REAL
    )`);
    db.run(`CREATE TABLE semantic_topic_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT, session_id TEXT, topic_id INTEGER, prob REAL
    )`);
    db.run(`CREATE TABLE semantic_error_clusters (
      cluster_id INTEGER PRIMARY KEY, label TEXT, exemplar TEXT, size INTEGER, session_spread INTEGER
    )`);
    db.run(`CREATE TABLE semantic_error_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, session_id TEXT, cluster_id INTEGER
    )`);
    db.run(`CREATE TABLE semantic_pivot_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, window_start INTEGER, window_end INTEGER,
      confidence REAL, evidence TEXT
    )`);
    db.run(`CREATE TABLE semantic_session_triage (
      session_id TEXT PRIMARY KEY, pain_score REAL, summary TEXT, root_cause TEXT,
      model TEXT, cost_tokens INTEGER, created_at INTEGER
    )`);
    db.run("UPDATE schema_version SET version = 7");
  }
```

**Step 4: Run to verify pass**

Run: `bun test lib/db.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add lib/db.ts lib/db.test.ts
git commit -m "feat(db): v7 migration creates empty semantic_* tables"
```

---

### Task 17: Python package scaffold + `check`/`db` modules

**Files:**
- Create: `analysis/requirements.txt`
- Create: `analysis/pyproject.toml`
- Create: `analysis/agent_stalker_analysis/__init__.py`
- Create: `analysis/agent_stalker_analysis/db.py`
- Create: `analysis/agent_stalker_analysis/check.py`
- Create: `analysis/agent_stalker_analysis/__main__.py`
- Create: `analysis/tests/test_db.py`
- Create: `analysis/tests/conftest.py`

**Step 1: requirements + pyproject**

Create `analysis/requirements.txt`:

```
sentence-transformers>=2.2
bertopic>=0.16
hdbscan>=0.8.33
umap-learn>=0.5
vaderSentiment>=3.3
anthropic>=0.39
```

Create `analysis/pyproject.toml`:

```toml
[project]
name = "agent-stalker-analysis"
version = "0.1.0"
description = "Opt-in semantic analysis sidecar for agent-stalker"
requires-python = ">=3.9"

[tool.pytest.ini_options]
testpaths = ["tests"]
```

**Step 2: db helper + fixture**

Create `analysis/agent_stalker_analysis/__init__.py` (empty file).

Create `analysis/agent_stalker_analysis/db.py`:

```python
import json
import os
import sqlite3
from pathlib import Path


def default_db_path() -> str:
    env = os.environ.get("AGENT_STALKER_DB_PATH")
    if env:
        return env
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""
    return str(Path(home) / ".claude" / "agent-stalker.db")


def connect(db_path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or default_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def parse_data(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
```

Create `analysis/tests/conftest.py`:

```python
import sqlite3
import pytest


SEMANTIC_DDL = [
    "CREATE TABLE semantic_meta (feature TEXT PRIMARY KEY, version TEXT, model TEXT, last_run_at INTEGER, corpus_size INTEGER, status TEXT)",
    "CREATE TABLE semantic_sentiment (id INTEGER PRIMARY KEY AUTOINCREMENT, source_kind TEXT, event_id INTEGER, session_id TEXT, score REAL, label TEXT, timestamp INTEGER)",
    "CREATE TABLE semantic_topics (topic_id INTEGER PRIMARY KEY, label TEXT, keywords TEXT, size INTEGER, pain_score REAL)",
    "CREATE TABLE semantic_topic_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT, session_id TEXT, topic_id INTEGER, prob REAL)",
    "CREATE TABLE semantic_error_clusters (cluster_id INTEGER PRIMARY KEY, label TEXT, exemplar TEXT, size INTEGER, session_spread INTEGER)",
    "CREATE TABLE semantic_error_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, session_id TEXT, cluster_id INTEGER)",
    "CREATE TABLE semantic_pivot_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, window_start INTEGER, window_end INTEGER, confidence REAL, evidence TEXT)",
    "CREATE TABLE semantic_session_triage (session_id TEXT PRIMARY KEY, pain_score REAL, summary TEXT, root_cause TEXT, model TEXT, cost_tokens INTEGER, created_at INTEGER)",
]


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "test.db"
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, hook_event_name TEXT, agent_id TEXT, tool_name TEXT, timestamp INTEGER, data TEXT)")
    conn.execute("CREATE TABLE tasks (id TEXT, session_id TEXT, subject TEXT, description TEXT)")
    for ddl in SEMANTIC_DDL:
        conn.execute(ddl)
    conn.commit()
    yield conn
    conn.close()
```

Create `analysis/tests/test_db.py`:

```python
from agent_stalker_analysis.db import parse_data


def test_parse_data_handles_garbage():
    assert parse_data(None) == {}
    assert parse_data("not json") == {}
    assert parse_data('{"a": 1}') == {"a": 1}
```

**Step 3: check + main**

Create `analysis/agent_stalker_analysis/check.py`:

```python
"""Dependency check used by the dashboard's Enable button."""
import importlib

REQUIRED = ["sentence_transformers", "bertopic", "hdbscan", "vaderSentiment"]


def missing_dependencies() -> list[str]:
    missing = []
    for mod in REQUIRED:
        try:
            importlib.import_module(mod)
        except ImportError:
            missing.append(mod)
    return missing


def check() -> dict:
    missing = missing_dependencies()
    return {"ok": len(missing) == 0, "missing": missing}
```

Create `analysis/agent_stalker_analysis/__main__.py`:

```python
import argparse
import json
import sys

from .check import check


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="agent_stalker_analysis")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    run_p = sub.add_parser("run")
    run_p.add_argument("--features", default="sentiment,topics,errors,pivots")
    run_p.add_argument("--db", default=None)
    args = parser.parse_args(argv)

    if args.command == "check":
        print(json.dumps(check()))
        return 0
    if args.command == "run":
        from .run import run
        result = run(args.features.split(","), args.db)
        print(json.dumps(result))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
```

**Step 4: Run to verify pass**

Run: `cd analysis && python -m pytest tests/test_db.py -v`
Expected: PASS. Also `python -m agent_stalker_analysis check` prints JSON listing missing deps (expected before `pip install`).

**Step 5: Commit**

```bash
git add analysis/
git commit -m "feat(analysis): python sidecar scaffold (db, check, cli)"
```

---

### Task 18: Corpus extractor (Python)

**Files:**
- Create: `analysis/agent_stalker_analysis/corpus.py`
- Create: `analysis/tests/test_corpus.py`

**Step 1: Write the failing test**

Create `analysis/tests/test_corpus.py`:

```python
import json
from agent_stalker_analysis.corpus import extract_corpus, extract_errors


def _add_event(db, **kw):
    db.execute(
        "INSERT INTO events (session_id, hook_event_name, tool_name, timestamp, data) VALUES (?,?,?,?,?)",
        (kw.get("session_id"), kw.get("hook_event_name"), kw.get("tool_name"), kw.get("timestamp", 0), kw.get("data")),
    )
    db.commit()


def test_extracts_prompts_and_messages(db):
    _add_event(db, session_id="s1", hook_event_name="UserPromptSubmit", data=json.dumps({"prompt": "fix the bug"}))
    _add_event(db, session_id="s1", hook_event_name="SubagentStop", data=json.dumps({"last_assistant_message": "done"}))
    db.execute("INSERT INTO tasks (id, session_id, subject, description) VALUES ('1','s1','Add auth','desc')")
    db.commit()

    docs = extract_corpus(db)
    kinds = {d["kind"] for d in docs}
    assert "prompt" in kinds
    assert "assistant" in kinds
    assert "task" in kinds
    prompt_doc = next(d for d in docs if d["kind"] == "prompt")
    assert prompt_doc["text"] == "fix the bug"
    assert prompt_doc["session_id"] == "s1"


def test_extracts_error_messages(db):
    _add_event(db, session_id="s1", hook_event_name="PostToolUseFailure", tool_name="Bash",
               data=json.dumps({"error": "permission denied"}))
    errs = extract_errors(db)
    assert len(errs) == 1
    assert "permission denied" in errs[0]["text"]
```

**Step 2: Run to verify failure**

Run: `cd analysis && python -m pytest tests/test_corpus.py -v`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `analysis/agent_stalker_analysis/corpus.py`:

```python
from .db import parse_data


def extract_corpus(conn) -> list[dict]:
    """Natural-language docs for sentiment + topic modeling."""
    docs: list[dict] = []

    for row in conn.execute("SELECT id, session_id, timestamp, data FROM events WHERE hook_event_name = 'UserPromptSubmit'"):
        text = parse_data(row["data"]).get("prompt")
        if text:
            docs.append({"kind": "prompt", "doc_id": f"prompt-{row['id']}", "event_id": row["id"],
                         "session_id": row["session_id"], "timestamp": row["timestamp"], "text": text})

    for row in conn.execute("SELECT id, session_id, timestamp, data FROM events WHERE hook_event_name IN ('Stop','SubagentStop')"):
        text = parse_data(row["data"]).get("last_assistant_message")
        if text:
            docs.append({"kind": "assistant", "doc_id": f"assistant-{row['id']}", "event_id": row["id"],
                         "session_id": row["session_id"], "timestamp": row["timestamp"], "text": text})

    for row in conn.execute("SELECT id, session_id, subject, description FROM tasks"):
        parts = [p for p in (row["subject"], row["description"]) if p]
        if parts:
            docs.append({"kind": "task", "doc_id": f"task-{row['id']}-{row['session_id']}", "event_id": None,
                         "session_id": row["session_id"], "timestamp": None, "text": " — ".join(parts)})

    return docs


def extract_errors(conn) -> list[dict]:
    """Error message docs for clustering."""
    errs: list[dict] = []
    for row in conn.execute("SELECT id, session_id, tool_name, data FROM events WHERE hook_event_name = 'PostToolUseFailure'"):
        data = parse_data(row["data"])
        text = data.get("error")
        if not text and isinstance(data.get("tool_response"), dict):
            text = data["tool_response"].get("error") or data["tool_response"].get("stderr")
        if text:
            errs.append({"event_id": row["id"], "session_id": row["session_id"],
                         "tool_name": row["tool_name"], "text": str(text)})
    return errs
```

**Step 4: Run to verify pass**

Run: `cd analysis && python -m pytest tests/test_corpus.py -v`
Expected: PASS.

**Step 5: Commit**

```bash
git add analysis/agent_stalker_analysis/corpus.py analysis/tests/test_corpus.py
git commit -m "feat(analysis): corpus + error extractor"
```

---

### Task 19: Sentiment / frustration feature (Python)

**Files:**
- Create: `analysis/agent_stalker_analysis/features/__init__.py`
- Create: `analysis/agent_stalker_analysis/features/sentiment.py`
- Create: `analysis/tests/test_sentiment.py`

**Step 1: Write the failing test**

Create `analysis/tests/test_sentiment.py`:

```python
import json
from agent_stalker_analysis.features.sentiment import run_sentiment


def _add_prompt(db, session_id, text, eid=None):
    db.execute("INSERT INTO events (session_id, hook_event_name, timestamp, data) VALUES (?, 'UserPromptSubmit', 0, ?)",
               (session_id, json.dumps({"prompt": text})))
    db.commit()


def test_writes_sentiment_rows_with_scores(db):
    _add_prompt(db, "s1", "this is broken and I am so frustrated, nothing works")
    _add_prompt(db, "s1", "great, thanks, that worked perfectly")
    n = run_sentiment(db)
    assert n == 2
    rows = list(db.execute("SELECT score, label, session_id FROM semantic_sentiment ORDER BY score ASC"))
    assert len(rows) == 2
    # most negative first
    assert rows[0]["score"] < rows[-1]["score"]
    assert rows[0]["label"] in ("negative", "neutral", "positive")
```

**Step 2: Run to verify failure**

Run: `cd analysis && python -m pytest tests/test_sentiment.py -v`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `analysis/agent_stalker_analysis/features/__init__.py` (empty).

Create `analysis/agent_stalker_analysis/features/sentiment.py`:

```python
"""Frustration detection via VADER (no torch dependency for this feature)."""
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from ..corpus import extract_corpus

MODEL = "vaderSentiment-3.3"


def _label(compound: float) -> str:
    if compound <= -0.25:
        return "negative"
    if compound >= 0.25:
        return "positive"
    return "neutral"


def run_sentiment(conn) -> int:
    analyzer = SentimentIntensityAnalyzer()
    docs = [d for d in extract_corpus(conn) if d["kind"] in ("prompt", "assistant")]

    conn.execute("DELETE FROM semantic_sentiment")
    n = 0
    for d in docs:
        compound = analyzer.polarity_scores(d["text"])["compound"]
        conn.execute(
            "INSERT INTO semantic_sentiment (source_kind, event_id, session_id, score, label, timestamp) VALUES (?,?,?,?,?,?)",
            (d["kind"], d["event_id"], d["session_id"], compound, _label(compound), d["timestamp"]),
        )
        n += 1
    conn.commit()
    return n
```

> **Note:** VADER is intentionally used for sentiment (fast, no torch) while the heavier transformer stack is reserved for topic/error embeddings. This keeps the frustration feature usable even on minimal installs.

**Step 4: Run to verify pass**

Run: `cd analysis && python -m pytest tests/test_sentiment.py -v`
Expected: PASS (requires `pip install vaderSentiment`).

**Step 5: Commit**

```bash
git add analysis/agent_stalker_analysis/features/
git commit -m "feat(analysis): frustration/sentiment feature (VADER)"
```

---

### Task 20: Error clustering feature (Python)

**Files:**
- Create: `analysis/agent_stalker_analysis/features/error_clusters.py`
- Create: `analysis/tests/test_error_clusters.py`

**Step 1: Write the failing test**

Create `analysis/tests/test_error_clusters.py`:

```python
import json
import pytest
from agent_stalker_analysis.features.error_clusters import run_error_clusters


def _add_error(db, session_id, text):
    db.execute("INSERT INTO events (session_id, hook_event_name, tool_name, timestamp, data) VALUES (?, 'PostToolUseFailure', 'Bash', 0, ?)",
               (session_id, json.dumps({"error": text})))
    db.commit()


def test_clusters_similar_errors(db):
    pytest.importorskip("sentence_transformers")
    for i in range(4):
        _add_error(db, f"s{i}", "permission denied while writing file")
    for i in range(4):
        _add_error(db, f"t{i}", "module not found: cannot import package")
    n = run_error_clusters(db)
    assert n == 8
    clusters = list(db.execute("SELECT * FROM semantic_error_clusters"))
    assert len(clusters) >= 1
    assignments = list(db.execute("SELECT * FROM semantic_error_assignments"))
    assert len(assignments) == 8
```

**Step 2: Run to verify failure**

Run: `cd analysis && python -m pytest tests/test_error_clusters.py -v`
Expected: FAIL — module not found (or SKIP if sentence-transformers absent).

**Step 3: Write implementation**

Create `analysis/agent_stalker_analysis/features/error_clusters.py`:

```python
"""Cluster recurring failure modes via sentence-transformer embeddings + HDBSCAN."""
from collections import Counter

from ..corpus import extract_errors

MODEL = "all-MiniLM-L6-v2"


def run_error_clusters(conn, min_cluster_size: int = 3) -> int:
    errors = extract_errors(conn)
    conn.execute("DELETE FROM semantic_error_clusters")
    conn.execute("DELETE FROM semantic_error_assignments")
    if not errors:
        conn.commit()
        return 0

    from sentence_transformers import SentenceTransformer
    import hdbscan

    texts = [e["text"] for e in errors]
    embeddings = SentenceTransformer(MODEL).encode(texts)

    if len(texts) >= min_cluster_size:
        labels = hdbscan.HDBSCAN(min_cluster_size=min_cluster_size).fit_predict(embeddings)
    else:
        labels = [0] * len(texts)

    # cluster metadata
    by_cluster: dict[int, list[int]] = {}
    for idx, lab in enumerate(labels):
        by_cluster.setdefault(int(lab), []).append(idx)

    for cluster_id, idxs in by_cluster.items():
        if cluster_id == -1:  # HDBSCAN noise
            label = "misc/uncategorized"
        else:
            # crude label: most common 3 words across the cluster's texts
            words = Counter()
            for i in idxs:
                words.update(w.lower() for w in texts[i].split() if len(w) > 3)
            label = " ".join(w for w, _ in words.most_common(3)) or "cluster"
        sessions = {errors[i]["session_id"] for i in idxs}
        conn.execute(
            "INSERT INTO semantic_error_clusters (cluster_id, label, exemplar, size, session_spread) VALUES (?,?,?,?,?)",
            (cluster_id, label, texts[idxs[0]][:200], len(idxs), len(sessions)),
        )

    for idx, lab in enumerate(labels):
        conn.execute(
            "INSERT INTO semantic_error_assignments (event_id, session_id, cluster_id) VALUES (?,?,?)",
            (errors[idx]["event_id"], errors[idx]["session_id"], int(lab)),
        )

    conn.commit()
    return len(errors)
```

**Step 4: Run to verify pass**

Run: `cd analysis && python -m pytest tests/test_error_clusters.py -v`
Expected: PASS (or SKIP without sentence-transformers installed).

**Step 5: Commit**

```bash
git add analysis/agent_stalker_analysis/features/error_clusters.py analysis/tests/test_error_clusters.py
git commit -m "feat(analysis): error clustering feature"
```

---

### Task 21: Topic modeling feature (Python)

**Files:**
- Create: `analysis/agent_stalker_analysis/features/topics.py`
- Create: `analysis/tests/test_topics.py`

**Step 1: Write the failing test**

Create `analysis/tests/test_topics.py`:

```python
import json
import pytest
from agent_stalker_analysis.features.topics import run_topics


def _add_prompt(db, session_id, text):
    db.execute("INSERT INTO events (session_id, hook_event_name, timestamp, data) VALUES (?, 'UserPromptSubmit', 0, ?)",
               (session_id, json.dumps({"prompt": text})))
    db.commit()


def test_writes_topics_and_assignments(db):
    pytest.importorskip("bertopic")
    samples = [
        "fix the authentication login bug", "auth token refresh is broken", "login session expired error",
        "improve the css layout styling", "the button color and spacing looks off", "redesign the header layout",
    ] * 3
    for i, s in enumerate(samples):
        _add_prompt(db, f"s{i}", s)
    n = run_topics(db)
    assert n > 0
    topics = list(db.execute("SELECT * FROM semantic_topics"))
    assert len(topics) >= 1
    assignments = list(db.execute("SELECT * FROM semantic_topic_assignments"))
    assert len(assignments) == n
```

**Step 2: Run to verify failure**

Run: `cd analysis && python -m pytest tests/test_topics.py -v`
Expected: FAIL — module not found (or SKIP without bertopic).

**Step 3: Write implementation**

Create `analysis/agent_stalker_analysis/features/topics.py`:

```python
"""Topic modeling via BERTopic, with per-topic pain correlation."""
from ..corpus import extract_corpus

MODEL = "all-MiniLM-L6-v2"


def _session_error_rate(conn) -> dict[str, float]:
    rates: dict[str, float] = {}
    rows = conn.execute(
        "SELECT session_id, "
        "SUM(CASE WHEN hook_event_name='PostToolUseFailure' THEN 1 ELSE 0 END) AS errs, "
        "COUNT(*) AS total "
        "FROM events WHERE hook_event_name IN ('PostToolUse','PostToolUseFailure') GROUP BY session_id"
    )
    for r in rows:
        rates[r["session_id"]] = (r["errs"] / r["total"]) if r["total"] else 0.0
    return rates


def run_topics(conn) -> int:
    docs = extract_corpus(conn)
    conn.execute("DELETE FROM semantic_topics")
    conn.execute("DELETE FROM semantic_topic_assignments")
    if len(docs) < 2:
        conn.commit()
        return 0

    from bertopic import BERTopic
    from sentence_transformers import SentenceTransformer

    texts = [d["text"] for d in docs]
    model = BERTopic(embedding_model=SentenceTransformer(MODEL), min_topic_size=2, verbose=False)
    topics, probs = model.fit_transform(texts)

    error_rate = _session_error_rate(conn)

    info = model.get_topic_info()
    # pain per topic = mean session error-rate of its docs
    topic_pain: dict[int, list[float]] = {}
    for d, t in zip(docs, topics):
        topic_pain.setdefault(int(t), []).append(error_rate.get(d["session_id"], 0.0))

    for _, r in info.iterrows():
        tid = int(r["Topic"])
        words = model.get_topic(tid)
        keywords = ", ".join(w for w, _ in words[:8]) if words else ""
        pains = topic_pain.get(tid, [])
        pain = sum(pains) / len(pains) if pains else 0.0
        conn.execute(
            "INSERT INTO semantic_topics (topic_id, label, keywords, size, pain_score) VALUES (?,?,?,?,?)",
            (tid, str(r["Name"]), keywords, int(r["Count"]), pain),
        )

    for d, t, p in zip(docs, topics, probs):
        prob = float(p) if p is not None else 0.0
        conn.execute(
            "INSERT INTO semantic_topic_assignments (doc_id, session_id, topic_id, prob) VALUES (?,?,?,?)",
            (d["doc_id"], d["session_id"], int(t), prob),
        )

    conn.commit()
    return len(docs)
```

**Step 4: Run to verify pass**

Run: `cd analysis && python -m pytest tests/test_topics.py -v`
Expected: PASS (or SKIP without bertopic).

**Step 5: Commit**

```bash
git add analysis/agent_stalker_analysis/features/topics.py analysis/tests/test_topics.py
git commit -m "feat(analysis): BERTopic topic modeling with pain correlation"
```

---

### Task 22: Pivot confirmation + run orchestrator + meta (Python)

**Files:**
- Create: `analysis/agent_stalker_analysis/features/pivots.py`
- Create: `analysis/agent_stalker_analysis/run.py`
- Create: `analysis/tests/test_run.py`

**Step 1: Write the failing test**

Create `analysis/tests/test_run.py`:

```python
import json
from agent_stalker_analysis.run import run


def _add_prompt(db, session_id, text):
    db.execute("INSERT INTO events (session_id, hook_event_name, timestamp, data) VALUES (?, 'UserPromptSubmit', 0, ?)",
               (session_id, json.dumps({"prompt": text})))
    db.commit()


def test_run_sentiment_only_updates_meta(db, monkeypatch):
    # point the run() at our in-memory test db by patching connect
    import agent_stalker_analysis.run as run_mod
    monkeypatch.setattr(run_mod, "connect", lambda _p=None: db)

    _add_prompt(db, "s1", "totally broken, hate this")
    result = run(["sentiment"], db_path="ignored")
    assert result["sentiment"]["count"] == 1
    meta = list(db.execute("SELECT feature, status FROM semantic_meta WHERE feature='sentiment'"))
    assert meta[0]["status"] == "ok"
```

**Step 2: Run to verify failure**

Run: `cd analysis && python -m pytest tests/test_run.py -v`
Expected: FAIL — module not found.

**Step 3: Write pivots + run**

Create `analysis/agent_stalker_analysis/features/pivots.py`:

```python
"""Semantic confirmation of structured pivot windows.

Structured retry signals are computed in TS; here we look for agent messages
that explicitly express retrying / trying another approach, and emit a
confidence signal per session window. Uses keyword heuristics by default so it
needs no model; an LLM upgrade can replace `_score_text` later.
"""
from .. corpus import extract_corpus

PIVOT_MARKERS = [
    "let me try", "try a different", "another approach", "that didn't work",
    "doesn't work", "still failing", "instead", "alternatively", "let's try",
    "didn't work", "not working", "go back", "revert",
]


def _score_text(text: str) -> float:
    low = text.lower()
    hits = sum(1 for m in PIVOT_MARKERS if m in low)
    return min(1.0, hits / 3.0)


def run_pivots(conn) -> int:
    docs = [d for d in extract_corpus(conn) if d["kind"] == "assistant"]
    conn.execute("DELETE FROM semantic_pivot_signals")
    n = 0
    for d in docs:
        conf = _score_text(d["text"])
        if conf <= 0:
            continue
        evidence = [m for m in PIVOT_MARKERS if m in d["text"].lower()]
        conn.execute(
            "INSERT INTO semantic_pivot_signals (session_id, window_start, window_end, confidence, evidence) VALUES (?,?,?,?,?)",
            (d["session_id"], d["timestamp"], d["timestamp"], conf, ", ".join(evidence)),
        )
        n += 1
    conn.commit()
    return n
```

Create `analysis/agent_stalker_analysis/run.py`:

```python
import time

from .db import connect

FEATURE_VERSION = "1"


def _set_meta(conn, feature, model, corpus_size, status):
    conn.execute(
        "INSERT INTO semantic_meta (feature, version, model, last_run_at, corpus_size, status) VALUES (?,?,?,?,?,?) "
        "ON CONFLICT(feature) DO UPDATE SET version=excluded.version, model=excluded.model, "
        "last_run_at=excluded.last_run_at, corpus_size=excluded.corpus_size, status=excluded.status",
        (feature, FEATURE_VERSION, model, int(time.time() * 1000), corpus_size, status),
    )
    conn.commit()


def run(features: list[str], db_path: str | None = None) -> dict:
    conn = connect(db_path)
    result: dict = {}

    for feature in features:
        feature = feature.strip()
        try:
            if feature == "sentiment":
                from .features.sentiment import run_sentiment, MODEL
                count = run_sentiment(conn)
                _set_meta(conn, "sentiment", MODEL, count, "ok")
                result["sentiment"] = {"count": count}
            elif feature == "topics":
                from .features.topics import run_topics, MODEL
                count = run_topics(conn)
                _set_meta(conn, "topics", MODEL, count, "ok")
                result["topics"] = {"count": count}
            elif feature == "errors":
                from .features.error_clusters import run_error_clusters, MODEL
                count = run_error_clusters(conn)
                _set_meta(conn, "errors", MODEL, count, "ok")
                result["errors"] = {"count": count}
            elif feature == "pivots":
                from .features.pivots import run_pivots
                count = run_pivots(conn)
                _set_meta(conn, "pivots", "keyword-1", count, "ok")
                result["pivots"] = {"count": count}
            else:
                result[feature] = {"error": "unknown feature"}
        except Exception as exc:  # per-feature failure, not all-or-nothing
            _set_meta(conn, feature, "", 0, f"error: {exc}")
            result[feature] = {"error": str(exc)}

    return result
```

**Step 4: Run to verify pass**

Run: `cd analysis && python -m pytest tests/ -v`
Expected: PASS for `test_run.py`, `test_corpus.py`, `test_db.py`, `test_sentiment.py`; topic/error tests PASS or SKIP depending on installed ML deps.

**Step 5: Commit**

```bash
git add analysis/agent_stalker_analysis/features/pivots.py analysis/agent_stalker_analysis/run.py analysis/tests/test_run.py
git commit -m "feat(analysis): pivot confirmation + run orchestrator + meta"
```

---

### Task 23: Server endpoints to drive + read the sidecar

**Files:**
- Modify: `ui/server.ts` (semantic status/run + read endpoints)
- Test: `ui/server.test.ts`

**Step 1: Write the failing test**

Append to `ui/server.test.ts`:

```typescript
describe("semantic endpoints", () => {
  const testDbPath = join(tmpdir(), `as-server-sem-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("GET /api/insights/semantic/status reports availability from semantic_meta", async () => {
    const db = getDb();
    db.run("INSERT INTO semantic_meta (feature, last_run_at, status) VALUES ('sentiment', 123, 'ok')");
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/semantic/status"), "GET");
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.lastRun).toBe(123);
  });

  it("GET /api/insights/semantic/sentiment returns rows", async () => {
    const db = getDb();
    db.run("INSERT INTO semantic_sentiment (source_kind, session_id, score, label) VALUES ('prompt','s1',-0.8,'negative')");
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/semantic/sentiment"), "GET");
    const body = await res.json();
    expect(body[0].label).toBe("negative");
  });
});
```

**Step 2: Run to verify failure**

Run: `bun test ui/server.test.ts`
Expected: FAIL — routes missing.

**Step 3: Implement endpoints**

In `ui/server.ts`, add an import near the top:

```typescript
import { spawn } from "child_process";
```

Inside `handleApi`, before the 404, add the read + status routes:

```typescript
  if (path === "/api/insights/semantic/status") {
    const meta = db.query("SELECT feature, last_run_at, model, status, corpus_size FROM semantic_meta ORDER BY last_run_at DESC").all() as any[];
    const lastRun = meta.length ? Math.max(...meta.map((m) => m.last_run_at ?? 0)) : null;
    return jsonResponse({ available: meta.length > 0, lastRun, features: meta });
  }
  if (path === "/api/insights/semantic/sentiment") {
    return jsonResponse(db.query("SELECT * FROM semantic_sentiment ORDER BY score ASC LIMIT 200").all());
  }
  if (path === "/api/insights/semantic/topics") {
    return jsonResponse(db.query("SELECT * FROM semantic_topics ORDER BY pain_score DESC").all());
  }
  if (path === "/api/insights/semantic/errors") {
    return jsonResponse(db.query("SELECT * FROM semantic_error_clusters ORDER BY size DESC").all());
  }
  if (path === "/api/insights/semantic/pivots") {
    return jsonResponse(db.query("SELECT * FROM semantic_pivot_signals ORDER BY confidence DESC LIMIT 200").all());
  }
```

For the `run` trigger (POST), it must be async to await the subprocess. Refactor: add a separate handler called from `fetch` for POST runs. In the `Bun.serve` `fetch`, before the API dispatch, handle the run route:

```typescript
    if (url.pathname === "/api/insights/semantic/run" && req.method === "POST") {
      return runSemanticBatch();
    }
```

Add this function near `handleApi`:

```typescript
function pythonCmd(): string {
  return process.env.AGENT_STALKER_PYTHON ?? "python";
}

async function runSemanticBatch(): Promise<Response> {
  const analysisDir = resolve(join(import.meta.dir, "..", "analysis"));
  // 1. dependency check
  const check = await new Promise<{ ok: boolean; missing: string[] }>((res) => {
    const p = spawn(pythonCmd(), ["-m", "agent_stalker_analysis", "check"], { cwd: analysisDir });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => res({ ok: false, missing: ["python"] }));
    p.on("close", () => {
      try { res(JSON.parse(out)); } catch { res({ ok: false, missing: ["python"] }); }
    });
  });
  if (!check.ok) {
    return jsonResponse({
      ok: false,
      message: `Missing: ${check.missing.join(", ")}. Install with: pip install -r analysis/requirements.txt`,
    }, 200);
  }
  // 2. fire-and-forget the batch (results land in semantic_* tables)
  const env = { ...process.env };
  const p = spawn(pythonCmd(), ["-m", "agent_stalker_analysis", "run"], { cwd: analysisDir, env, detached: true, stdio: "ignore" });
  p.unref();
  return jsonResponse({ ok: true, message: "Semantic batch started. Refresh in a minute to see results." });
}
```

> The Python subprocess writes to the same DB file (via `AGENT_STALKER_DB_PATH`, inherited through `env`). WAL mode + `busy_timeout=5000` (already set in `lib/db.ts`) makes concurrent TS-read / Python-write safe for this local workload.

**Step 4: Run to verify pass**

Run: `bun test ui/server.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add ui/server.ts ui/server.test.ts
git commit -m "feat(server): semantic batch trigger + read endpoints"
```

---

### Task 24: Semantic panels in the Insights UI

**Files:**
- Modify: `ui/js/insights.js` (render sentiment, topics, error clusters, pivots when present)

**Step 1: Extend renderInsights**

In `ui/js/insights.js`, fetch the semantic read endpoints (only worth fetching when status.available) and render panels. Add to the `Promise.all` in `renderInsights` after `semantic`:

```javascript
  const semanticData = semantic && semantic.available ? await Promise.all([
    fetchJSON('/api/insights/semantic/sentiment'),
    fetchJSON('/api/insights/semantic/topics'),
    fetchJSON('/api/insights/semantic/errors'),
    fetchJSON('/api/insights/semantic/pivots'),
  ]) : [null, null, null, null];
  const [sentiment, topics, errClusters, pivots] = semanticData;
```

Insert the rendered panels into the template (after `renderSemanticSection(semantic)`):

```javascript
    ${renderTopics(topics)}
    ${renderErrorClusters(errClusters)}
    ${renderSentiment(sentiment)}
    ${renderPivots(pivots)}
```

Add the render functions:

```javascript
function renderSentiment(rows) {
  if (!rows || !rows.length) return '';
  const neg = rows.filter(r => r.label === 'negative').slice(0, 15).map(r =>
    `<tr><td class="mono">${esc((r.session_id||'').slice(0,8))}</td><td>${r.score.toFixed(2)}</td><td>${esc(r.source_kind)}</td></tr>`).join('');
  return section('Frustration (most negative)',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Score</th><th>Kind</th></tr></thead><tbody>${neg}</tbody></table>`);
}

function renderTopics(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 20).map(t =>
    `<tr><td>${esc(t.label)}</td><td>${esc(t.keywords || '')}</td><td>${t.size}</td><td>${(t.pain_score||0).toFixed(2)}</td></tr>`).join('');
  return section('Topics (ranked by pain)',
    `<table class="insights-table"><thead><tr><th>Topic</th><th>Keywords</th><th>Docs</th><th>Pain</th></tr></thead><tbody>${body}</tbody></table>`);
}

function renderErrorClusters(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 20).map(c =>
    `<tr><td>${esc(c.label)}</td><td>${c.size}</td><td>${c.session_spread}</td><td class="mono">${esc((c.exemplar||'').slice(0,60))}</td></tr>`).join('');
  return section('Error clusters',
    `<table class="insights-table"><thead><tr><th>Label</th><th>Count</th><th>Sessions</th><th>Exemplar</th></tr></thead><tbody>${body}</tbody></table>`);
}

function renderPivots(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 15).map(p =>
    `<tr><td class="mono">${esc((p.session_id||'').slice(0,8))}</td><td>${(p.confidence||0).toFixed(2)}</td><td>${esc(p.evidence||'')}</td></tr>`).join('');
  return section('Agent pivots (semantic)',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Confidence</th><th>Evidence</th></tr></thead><tbody>${body}</tbody></table>`);
}
```

**Step 2: Manual verification**

Run: `pip install -r analysis/requirements.txt` (one-time), then `bun ui/server.ts --port 3141`, open Insights, click **Enable semantic features**, wait ~1 min, refresh.
Expected: Topics, Error clusters, Frustration, Pivots panels populate.

**Step 3: Commit**

```bash
git add ui/js/insights.js
git commit -m "feat(ui): semantic panels (topics, error clusters, frustration, pivots)"
```

---

## PHASE 4 — LLM session triage (further opt-in)

### Task 25: Triage feature (Python, Claude API)

**Files:**
- Create: `analysis/agent_stalker_analysis/features/triage.py`
- Create: `analysis/tests/test_triage.py`
- Modify: `analysis/agent_stalker_analysis/__main__.py` (add `triage` subcommand)

**Step 1: Write the failing test**

Create `analysis/tests/test_triage.py`:

```python
import json
from agent_stalker_analysis.features.triage import build_digest, run_triage


def _add_event(db, session_id, name, tool=None, data=None):
    db.execute("INSERT INTO events (session_id, hook_event_name, tool_name, timestamp, data) VALUES (?,?,?,0,?)",
               (session_id, name, tool, data))
    db.commit()


def test_build_digest_summarizes_session(db):
    _add_event(db, "s1", "UserPromptSubmit", data=json.dumps({"prompt": "add login"}))
    _add_event(db, "s1", "PostToolUseFailure", "Bash", json.dumps({"error": "denied"}))
    digest = build_digest(db, "s1")
    assert "add login" in digest
    assert "denied" in digest


def test_run_triage_uses_injected_client(db):
    _add_event(db, "s1", "UserPromptSubmit", data=json.dumps({"prompt": "add login"}))

    class FakeMessage:
        content = [type("B", (), {"text": json.dumps({"pain_score": 4, "summary": "rough", "root_cause": "perms"})})()]
        usage = type("U", (), {"input_tokens": 100, "output_tokens": 20})()

    class FakeClient:
        class messages:
            @staticmethod
            def create(**kwargs):
                return FakeMessage()

    result = run_triage(db, "s1", client=FakeClient(), model="claude-test")
    assert result["pain_score"] == 4
    row = list(db.execute("SELECT * FROM semantic_session_triage WHERE session_id='s1'"))[0]
    assert row["root_cause"] == "perms"
    assert row["cost_tokens"] == 120
```

**Step 2: Run to verify failure**

Run: `cd analysis && python -m pytest tests/test_triage.py -v`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `analysis/agent_stalker_analysis/features/triage.py`:

```python
"""LLM session triage. Separate opt-in: needs ANTHROPIC_API_KEY, costs tokens."""
import json
import os
import time

from ..db import parse_data

DEFAULT_MODEL = "claude-sonnet-4-6"

PROMPT = """You are analyzing one coding-agent session for workflow pain.
Given the session digest below, respond with ONLY a JSON object:
{{"pain_score": <1-5 int>, "summary": "<one sentence>", "root_cause": "<short phrase>"}}

Digest:
{digest}
"""


def build_digest(conn, session_id: str, max_events: int = 120) -> str:
    lines: list[str] = []
    rows = conn.execute(
        "SELECT hook_event_name, tool_name, data FROM events WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?",
        (session_id, max_events),
    )
    for r in rows:
        data = parse_data(r["data"])
        if r["hook_event_name"] == "UserPromptSubmit":
            lines.append(f"USER: {data.get('prompt','')[:300]}")
        elif r["hook_event_name"] == "PostToolUseFailure":
            lines.append(f"ERROR[{r['tool_name']}]: {str(data.get('error',''))[:200]}")
        elif r["hook_event_name"] in ("Stop", "SubagentStop"):
            msg = data.get("last_assistant_message")
            if msg:
                lines.append(f"ASSISTANT: {str(msg)[:300]}")
        elif r["tool_name"]:
            lines.append(f"TOOL: {r['tool_name']}")
    return "\n".join(lines)


def run_triage(conn, session_id: str, client=None, model: str = DEFAULT_MODEL) -> dict:
    digest = build_digest(conn, session_id)
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    message = client.messages.create(
        model=model,
        max_tokens=300,
        messages=[{"role": "user", "content": PROMPT.format(digest=digest)}],
    )
    text = message.content[0].text
    parsed = json.loads(text)
    cost = (getattr(message.usage, "input_tokens", 0) or 0) + (getattr(message.usage, "output_tokens", 0) or 0)

    conn.execute(
        "INSERT INTO semantic_session_triage (session_id, pain_score, summary, root_cause, model, cost_tokens, created_at) "
        "VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET "
        "pain_score=excluded.pain_score, summary=excluded.summary, root_cause=excluded.root_cause, "
        "model=excluded.model, cost_tokens=excluded.cost_tokens, created_at=excluded.created_at",
        (session_id, parsed["pain_score"], parsed["summary"], parsed["root_cause"], model, cost, int(time.time() * 1000)),
    )
    conn.commit()
    return {**parsed, "cost_tokens": cost}
```

Add a `triage` subcommand in `analysis/agent_stalker_analysis/__main__.py` (inside `main`, after the `run` subparser is defined):

```python
    triage_p = sub.add_parser("triage")
    triage_p.add_argument("--session", required=True)
    triage_p.add_argument("--db", default=None)
```

and in the dispatch section, before `return 1`:

```python
    if args.command == "triage":
        from .db import connect
        from .features.triage import run_triage
        conn = connect(args.db)
        print(json.dumps(run_triage(conn, args.session)))
        return 0
```

**Step 4: Run to verify pass**

Run: `cd analysis && python -m pytest tests/test_triage.py -v`
Expected: PASS (uses the injected fake client; no real API call).

**Step 5: Commit**

```bash
git add analysis/agent_stalker_analysis/features/triage.py analysis/tests/test_triage.py analysis/agent_stalker_analysis/__main__.py
git commit -m "feat(analysis): LLM session triage feature"
```

---

### Task 26: Triage endpoint + UI (cost-gated)

**Files:**
- Modify: `ui/server.ts` (POST `/api/insights/semantic/triage`, GET triage rows)
- Modify: `ui/js/insights.js` (triage button per session in the pain leaderboard)

**Step 1: Write the failing test**

Append to `ui/server.test.ts` (read endpoint only; the POST shells out to Python and is verified manually):

```typescript
it("GET /api/insights/semantic/triage returns triage rows", async () => {
  const db = getDb();
  db.run("INSERT INTO semantic_session_triage (session_id, pain_score, summary, root_cause, created_at) VALUES ('s1', 5, 'rough', 'perms', 1)");
  const { handleApiForTest } = await import("./server");
  const res = handleApiForTest(new URL("http://x/api/insights/semantic/triage"), "GET");
  const body = await res.json();
  expect(body[0].root_cause).toBe("perms");
});
```

**Step 2: Run to verify failure**

Run: `bun test ui/server.test.ts`
Expected: FAIL — route missing.

**Step 3: Implement endpoints**

In `ui/server.ts`, add the GET route inside `handleApi` before the 404:

```typescript
  if (path === "/api/insights/semantic/triage") {
    return jsonResponse(db.query("SELECT * FROM semantic_session_triage ORDER BY pain_score DESC").all());
  }
```

Add the POST handler in the `Bun.serve` `fetch`, near the semantic/run route:

```typescript
    if (url.pathname === "/api/insights/semantic/triage" && req.method === "POST") {
      const sessionId = url.searchParams.get("session");
      if (!sessionId) return jsonResponse({ ok: false, message: "session required" }, 400);
      return runTriage(sessionId);
    }
```

Add the `runTriage` function near `runSemanticBatch`:

```typescript
async function runTriage(sessionId: string): Promise<Response> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonResponse({ ok: false, message: "Set ANTHROPIC_API_KEY to enable triage." }, 200);
  }
  const analysisDir = resolve(join(import.meta.dir, "..", "analysis"));
  return await new Promise<Response>((res) => {
    const p = spawn(pythonCmd(), ["-m", "agent_stalker_analysis", "triage", "--session", sessionId], { cwd: analysisDir, env: { ...process.env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => res(jsonResponse({ ok: false, message: "python not available" }, 200)));
    p.on("close", () => {
      try { res(jsonResponse({ ok: true, result: JSON.parse(out) })); }
      catch { res(jsonResponse({ ok: false, message: "triage failed" }, 200)); }
    });
  });
}
```

**Step 4: Add triage button to the UI**

In `ui/js/insights.js`, in `renderPain`, add a triage cell per row:

```javascript
      <td><button class="insights-btn triage-btn" data-session="${esc(p.session_id)}">Triage</button></td>
```

And wire it in `wireSemanticButton` (rename to `wireInsightsButtons` and call it after render). Add:

```javascript
  document.querySelectorAll('.triage-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const session = btn.dataset.session;
      btn.textContent = 'Triaging…';
      const res = await fetch(API + '/api/insights/semantic/triage?session=' + encodeURIComponent(session), { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      btn.textContent = body.ok && body.result
        ? `pain ${body.result.pain_score}: ${body.result.root_cause}`
        : (body.message || 'failed');
    });
  });
```

> Cost note shown to the user: triage calls the Claude API once per session (~a few hundred tokens). The button label updates in place with the result, so cost is one click = one call.

**Step 5: Run to verify pass**

Run: `bun test ui/server.test.ts`
Expected: PASS (GET test). Manual: with `ANTHROPIC_API_KEY` set, click **Triage** on a session row → label updates with pain score + root cause.

**Step 6: Commit**

```bash
git add ui/server.ts ui/server.test.ts ui/js/insights.js
git commit -m "feat: LLM triage endpoint + cost-gated UI button"
```

---

### Task 27: Full-suite verification + docs

**Files:**
- Modify: `README.md` (document the Insights view + opt-in sidecar)
- Create: `analysis/README.md` (install + run instructions)

**Step 1: Run the full TS suite**

Run: `bun test`
Expected: all tests PASS (db, ingest, analytics/*, usage/*, server).

**Step 2: Run the full Python suite**

Run: `cd analysis && python -m pytest tests/ -v`
Expected: PASS, with topic/error-cluster tests SKIPPED if heavy ML deps aren't installed (and PASS if they are).

**Step 3: Write analysis/README.md**

Create `analysis/README.md` documenting: purpose (opt-in semantic layer), install (`pip install -r requirements.txt`), the SQLite contract (reads raw tables, writes `semantic_*`), `python -m agent_stalker_analysis check|run|triage`, env vars (`AGENT_STALKER_DB_PATH`, `ANTHROPIC_API_KEY`, `AGENT_STALKER_PYTHON`), and that the dashboard's Enable button drives all of it.

**Step 4: Update README.md**

Add an "Insights / meta-analysis" section to the top-level `README.md`: the structured dashboard (always on), what each panel means, and how to enable the opt-in semantic sidecar.

**Step 5: Commit**

```bash
git add README.md analysis/README.md
git commit -m "docs: document Insights dashboard and opt-in semantic sidecar"
```

---

## Self-review notes (addressed during authoring)

- **Spec coverage:** structured metrics (Tasks 5–9), dashboard (Task 11), token spike + parser (Tasks 12–15), semantic sidecar with all four NLP features (Tasks 16–24), LLM triage (Tasks 25–26), capture additions (Tasks 1–2), graceful degradation via empty tables (Task 16) — all covered.
- **Naming consistency:** `handleApiForTest`, `painLeaderboard`, `sessionErrorStats`, `errorsByTool`, `fileChurn`, `errorRetryChains`, `taskBounces`, `sessionEffort`, `ingestUsageForSession`, `run_sentiment`/`run_topics`/`run_error_clusters`/`run_pivots`/`run_triage` are used identically across tasks and consumers.
- **Contract boundary:** semantic tables created by TS migration v7 (always exist), Python only INSERT/DELETEs — no "no such table" risk for the dashboard.
- **Concurrency:** WAL + busy_timeout (already in `lib/db.ts`) covers TS-read / Python-write on the same file.
