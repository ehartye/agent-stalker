# Ingest Reliability Implementation Plan (Review Batch B)

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hook→ingest hot path reliable: async UserPromptSubmit, structural event validation, whole-event transactions, no orphaned SessionEnd events, per-team error isolation, and a working `isPaused` on Windows.

**Architecture:** All changes live in four existing files (`hooks/hooks.json`, `lib/ingest.ts`, `lib/resolve-team.ts`, `lib/config.ts`) plus one new test file (`hooks/hooks.test.ts`). The `ingestEvent` entry point gains a validation guard and an explicit `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` wrapper around the (extracted) dispatch switch, with `ingestUsageForSession` moved to a post-commit step. Spec: `docs/superpowers/specs/2026-06-10-ingest-reliability-design.md`.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test. Run tests with `bun test <file>` from the repo root.

**Codebase notes for the implementer:**
- Test isolation pattern: every `describe` sets a unique `AGENT_STALKER_DB_PATH` (or `AGENT_STALKER_CONFIG_PATH` / `AGENT_STALKER_TEAMS_DIR`) per test in `beforeEach`, cleans up in `afterEach`. Follow the existing files' exact pattern.
- CRITICAL: use explicit `db.run("BEGIN IMMEDIATE")` / `db.run("COMMIT")` / `db.run("ROLLBACK")` — NEVER `db.transaction(fn).immediate()`. The latter caches prepared statements that keep the DB file locked after `closeDb()` on Windows (causes EBUSY unlink failures in tests; this was diagnosed and fixed once already in `lib/db.ts`, which uses the explicit pattern — see `runMigrations`).
- bun:sqlite throws on unsupported bind types (e.g. binding a plain object as a parameter) — the atomicity test exploits this to force a mid-event failure.

---

### Task 1: Async UserPromptSubmit + hooks.json regression test

**Files:**
- Create: `hooks/hooks.test.ts`
- Modify: `hooks/hooks.json` (the `UserPromptSubmit` entry)

- [ ] **Step 1: Write the failing test**

Create `hooks/hooks.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("hooks.json", () => {
  const raw = readFileSync(join(import.meta.dir, "hooks.json"), "utf-8");
  const config = JSON.parse(raw);

  it("every hook command is async with a numeric timeout", () => {
    const hookEvents = Object.entries(config.hooks as Record<string, any[]>);
    expect(hookEvents.length).toBeGreaterThan(0);
    for (const [eventName, matchers] of hookEvents) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          expect(hook.async, `${eventName} hook must be async`).toBe(true);
          expect(typeof hook.timeout, `${eventName} hook must have a numeric timeout`).toBe("number");
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test hooks/hooks.test.ts`
Expected: FAIL — `UserPromptSubmit hook must be async` (it is the only entry without `"async": true`).

- [ ] **Step 3: Add async to the UserPromptSubmit entry**

In `hooks/hooks.json`, the `UserPromptSubmit` hook object currently reads:

```json
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "timeout": 10
          }
        ]
      }
    ],
```

Add `"async": true` so it matches every other entry:

```json
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ],
```

(Match the key order used by the other entries in the file — check one, e.g. `SessionStart`, and mirror it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test hooks/hooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hooks/hooks.json hooks/hooks.test.ts
git commit -m "fix(hooks): make UserPromptSubmit async so prompts never block on ingest"
```

---

### Task 2: `isValidEvent` guard

**Files:**
- Modify: `lib/ingest.ts` (top of file + `ingestEvent`)
- Test: `lib/ingest.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new top-level `describe` block in `lib/ingest.test.ts` (pure function — no DB needed):

```ts
describe("isValidEvent", () => {
  it("accepts a minimal valid event", async () => {
    const { isValidEvent } = await import("./ingest");
    expect(isValidEvent({ session_id: "s1", hook_event_name: "SessionStart" })).toBe(true);
  });

  const invalid: Array<[string, unknown]> = [
    ["null", null],
    ["array", []],
    ["string", "event"],
    ["missing session_id", { hook_event_name: "SessionStart" }],
    ["empty session_id", { session_id: "", hook_event_name: "SessionStart" }],
    ["non-string session_id", { session_id: 42, hook_event_name: "SessionStart" }],
    ["missing hook_event_name", { session_id: "s1" }],
    ["empty hook_event_name", { session_id: "s1", hook_event_name: "" }],
    ["non-string hook_event_name", { session_id: "s1", hook_event_name: { x: 1 } }],
  ];
  for (const [label, value] of invalid) {
    it(`rejects ${label}`, async () => {
      const { isValidEvent } = await import("./ingest");
      expect(isValidEvent(value)).toBe(false);
    });
  }
});
```

And inside the existing `describe("ingestEvent")` block (which has the per-test DB):

```ts
  it("drops an event with no session_id without inserting anything", () => {
    ingestEvent({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    const db = getDb();
    const count = db.query("SELECT COUNT(*) as c FROM events").get() as any;
    expect(count.c).toBe(0);
    const sessions = db.query("SELECT COUNT(*) as c FROM sessions").get() as any;
    expect(sessions.c).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/ingest.test.ts`
Expected: `isValidEvent` tests fail (not exported); the drop test fails (today a NULL-session event row IS inserted, so count is 1).

- [ ] **Step 3: Implement**

In `lib/ingest.ts`, add above `ensureSession`:

```ts
export function isValidEvent(event: unknown): event is Record<string, any> {
  return (
    typeof event === "object" && event !== null && !Array.isArray(event) &&
    typeof (event as any).session_id === "string" && (event as any).session_id.length > 0 &&
    typeof (event as any).hook_event_name === "string" && (event as any).hook_event_name.length > 0
  );
}
```

In `ingestEvent`, add the guard as the first statement:

```ts
export function ingestEvent(event: Record<string, any>): void {
  if (!isValidEvent(event)) {
    console.error("agent-stalker: dropped event (missing session_id/hook_event_name)");
    return;
  }
  switch (event.hook_event_name) {
    // ... existing switch unchanged in this task ...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/ingest.test.ts`, then full `bun test`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ingest.ts lib/ingest.test.ts
git commit -m "fix(ingest): drop events without session_id/hook_event_name instead of inserting NULL rows"
```

---

### Task 3: `ensureSession` in `handleSessionEnd`

**Files:**
- Modify: `lib/ingest.ts:56-63` (`handleSessionEnd`)
- Test: `lib/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe("ingestEvent")`:

```ts
  it("SessionEnd without prior SessionStart creates the session row", () => {
    ingestEvent({
      hook_event_name: "SessionEnd",
      session_id: "sess-end-only",
      cwd: "/tmp/late",
      permission_mode: "default",
      reason: "clear",
    });
    const db = getDb();
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-end-only'").get() as any;
    expect(session).not.toBeNull();
    expect(session.ended_at).not.toBeNull();
    expect(session.end_reason).toBe("clear");
    const events = db.query("SELECT COUNT(*) as c FROM events WHERE session_id = 'sess-end-only'").get() as any;
    expect(events.c).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/ingest.test.ts`
Expected: FAIL — `session` is null (the UPDATE targeted a non-existent row; only the orphaned event row was written).

- [ ] **Step 3: Implement**

In `lib/ingest.ts`, `handleSessionEnd` currently reads:

```ts
function handleSessionEnd(event: Record<string, any>): void {
  const db = getDb();
  db.run("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?", [Date.now(), event.reason, event.session_id]);
  recordEvent(event, { reason: event.reason });
  try {
    ingestUsageForSession(db, event.session_id);
  } catch { /* usage ingest is best-effort */ }
}
```

Add `ensureSession(event);` as the first line (the usage-ingest block moves in Task 4 — leave it for now):

```ts
function handleSessionEnd(event: Record<string, any>): void {
  ensureSession(event);
  const db = getDb();
  db.run("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?", [Date.now(), event.reason, event.session_id]);
  recordEvent(event, { reason: event.reason });
  try {
    ingestUsageForSession(db, event.session_id);
  } catch { /* usage ingest is best-effort */ }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/ingest.test.ts`, then full `bun test`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ingest.ts lib/ingest.test.ts
git commit -m "fix(ingest): ensureSession in handleSessionEnd so late SessionEnd events aren't orphaned"
```

---

### Task 4: Whole-event transaction with post-commit usage carve-out

**Files:**
- Modify: `lib/ingest.ts` (`ingestEvent`, `handleSessionEnd`)
- Test: `lib/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe("ingestEvent")`. The test forces a mid-event failure: `handleTaskCompleted` first calls `ensureSession` (writes the session row), then runs `SELECT ... .get(event.task_id, ...)` — binding a plain object as `task_id` makes bun:sqlite throw. Without a transaction the session row survives (partial write); with the transaction it must be rolled back.

```ts
  it("rolls back all writes when a handler fails mid-event", () => {
    expect(() =>
      ingestEvent({
        hook_event_name: "TaskCompleted",
        session_id: "sess-atomic",
        cwd: "/tmp",
        permission_mode: "default",
        task_id: { bad: "object" },
      }),
    ).toThrow();
    const db = getDb();
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-atomic'").get();
    expect(session).toBeNull();
    const events = db.query("SELECT COUNT(*) as c FROM events WHERE session_id = 'sess-atomic'").get() as any;
    expect(events.c).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/ingest.test.ts`
Expected: FAIL — the throw happens, but `session` is NOT null (ensureSession's insert persisted: the partial-write bug).

If the throw does NOT happen (bun:sqlite accepts the object binding), STOP and report: the failure-injection vector needs rethinking — try `task_id: Symbol("bad")` or consult the controller. Do not weaken the assertion to make it pass.

- [ ] **Step 3: Implement**

In `lib/ingest.ts`, rework the bottom of the file. Rename the existing exported `ingestEvent` switch to a private `dispatchEvent`, and create the new transactional `ingestEvent`:

```ts
function dispatchEvent(event: Record<string, any>): void {
  switch (event.hook_event_name) {
    case "SessionStart":
      handleSessionStart(event);
      break;
    case "SessionEnd":
      handleSessionEnd(event);
      break;
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      handleToolUse(event);
      break;
    case "SubagentStart":
      handleSubagentStart(event);
      break;
    case "SubagentStop":
      handleSubagentStop(event);
      break;
    case "TaskCompleted":
      handleTaskCompleted(event);
      break;
    case "TeammateIdle":
      handleTeammateIdle(event);
      break;
    default:
      handleGeneric(event);
      break;
  }
}

export function ingestEvent(event: Record<string, any>): void {
  if (!isValidEvent(event)) {
    console.error("agent-stalker: dropped event (missing session_id/hook_event_name)");
    return;
  }
  const db = getDb();
  db.run("BEGIN IMMEDIATE");
  try {
    dispatchEvent(event);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e; // tracker.ts logs ingest failures
  }
  // Post-commit, outside the transaction: transcript parsing is best-effort
  // and must never roll back the session-end write.
  if (event.hook_event_name === "SessionEnd") {
    try {
      ingestUsageForSession(db, event.session_id);
    } catch { /* usage ingest is best-effort */ }
  }
}
```

And remove the usage-ingest block from `handleSessionEnd`, which becomes:

```ts
function handleSessionEnd(event: Record<string, any>): void {
  ensureSession(event);
  const db = getDb();
  db.run("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?", [Date.now(), event.reason, event.session_id]);
  recordEvent(event, { reason: event.reason });
}
```

(`ingestUsageForSession` is already imported at the top of the file; the import stays.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/ingest.test.ts`, then full `bun test`.
Expected: PASS — including the usage-ingest tests in `lib/usage/ingest-usage.test.ts` and `lib/db.test.ts` (the explicit BEGIN pattern must not leave the DB file locked; if any test fails with EBUSY on cleanup, the transaction statements are being cached — re-check that `db.run("BEGIN IMMEDIATE")` is used, not `db.transaction()`).

- [ ] **Step 5: Commit**

```bash
git add lib/ingest.ts lib/ingest.test.ts
git commit -m "fix(ingest): wrap each event's writes in one transaction; usage ingest runs post-commit"
```

---

### Task 5: Per-team error isolation in `resolveTeamContext`

**Files:**
- Modify: `lib/resolve-team.ts:38-56`
- Test: `lib/resolve-team.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe("resolveTeamContext")` (the `beforeEach` already creates a valid `my-project` team; alphabetical scan order makes a team named `a-broken` come first):

```ts
  it("skips a malformed team config and keeps scanning", () => {
    mkdirSync(join(teamsDir, "a-broken"), { recursive: true });
    writeFileSync(join(teamsDir, "a-broken", "config.json"), "{ not valid json !!");
    const result = resolveTeamContext({ agent_id: "agent-abc" });
    expect(result?.team_name).toBe("my-project");
    expect(result?.teammate_name).toBe("researcher");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/resolve-team.test.ts`
Expected: FAIL — `result` is null (the JSON.parse throw aborts the whole scan before reaching `my-project`).

- [ ] **Step 3: Implement**

In `lib/resolve-team.ts`, move the try/catch inside the loop. The scan block currently reads:

```ts
  try {
    const teamDirs = readdirSync(teamsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const teamName of teamDirs) {
      const configPath = join(teamsDir, teamName, "config.json");
      if (!existsSync(configPath)) continue;

      const raw = readFileSync(configPath, "utf-8");
      const config: TeamConfig = JSON.parse(raw);
      const member = config.members?.find((m) => m.agentId === agentId);
      if (member) {
        return { team_name: teamName, teammate_name: member.name };
      }
    }
  } catch {
    // Scan failed, return null
  }
```

Replace with:

```ts
  let teamDirs: string[];
  try {
    teamDirs = readdirSync(teamsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null; // teams dir unreadable
  }

  for (const teamName of teamDirs) {
    try {
      const configPath = join(teamsDir, teamName, "config.json");
      if (!existsSync(configPath)) continue;

      const raw = readFileSync(configPath, "utf-8");
      const config: TeamConfig = JSON.parse(raw);
      const member = config.members?.find((m) => m.agentId === agentId);
      if (member) {
        return { team_name: teamName, teammate_name: member.name };
      }
    } catch {
      // One team's config is unreadable/malformed: skip it, keep scanning
      continue;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/resolve-team.test.ts`, then full `bun test`.
Expected: PASS (all 4 pre-existing tests plus the new one).

- [ ] **Step 5: Commit**

```bash
git add lib/resolve-team.ts lib/resolve-team.test.ts
git commit -m "fix(resolve-team): one malformed team config no longer aborts the whole scan"
```

---

### Task 6: `isPaused` Windows path separators

**Files:**
- Modify: `lib/config.ts` (`isPaused`)
- Test: `lib/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside `describe("config")` in `lib/config.test.ts` (`writeFileSync` and `testConfigPath` already exist there; add `isPaused` to the import from `./config`):

```ts
  it("isPaused matches a backslash cwd against a forward-slash paused path", () => {
    writeFileSync(testConfigPath, JSON.stringify({ pausedPaths: ["C:/repos/proj"] }));
    expect(isPaused("C:\\repos\\proj")).toBe(true);
    expect(isPaused("C:\\repos\\proj\\sub")).toBe(true);
  });

  it("isPaused matches a forward-slash cwd against a backslash paused path", () => {
    writeFileSync(testConfigPath, JSON.stringify({ pausedPaths: ["C:\\repos\\proj"] }));
    expect(isPaused("C:/repos/proj")).toBe(true);
  });

  it("isPaused does not match a sibling directory sharing a prefix", () => {
    writeFileSync(testConfigPath, JSON.stringify({ pausedPaths: ["C:/repos/proj"] }));
    expect(isPaused("C:\\repos\\proj2")).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/config.test.ts`
Expected: the two cross-separator tests FAIL (`startsWith(p + "/")` never matches backslash paths); the sibling test passes already (regression guard).

- [ ] **Step 3: Implement**

In `lib/config.ts`, `isPaused` currently reads:

```ts
export function isPaused(cwd: string): boolean {
  const config = getConfig();
  return config.pausedPaths.some(
    (p) => cwd === p || cwd.startsWith(p + "/"),
  );
}
```

Replace with:

```ts
export function isPaused(cwd: string): boolean {
  const config = getConfig();
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const c = norm(cwd);
  return config.pausedPaths.some((p) => {
    const q = norm(p);
    return c === q || c.startsWith(q + "/");
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/config.test.ts`, then the FULL suite `bun test` as the batch's final verification.
Expected: all pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts lib/config.test.ts
git commit -m "fix(config): isPaused matches Windows backslash paths against pausedPaths"
```
