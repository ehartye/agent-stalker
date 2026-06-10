# Hook & Ingest Reliability Design (Review Batch B)

**Date:** 2026-06-10
**Source:** `docs/review/TRIAGE.md` items C2, H2, H3, H4, H13 + the `isPaused`
Windows path bug found during the Batch A final review.
**Status:** Approved by user

## Problem

The ingest hot path (hook process → `tracker.ts` → `ingestEvent`) has five
reliability gaps:

1. **C2:** `UserPromptSubmit` is the only hook in `hooks/hooks.json` without
   `"async": true` — every user prompt blocks on a Bun process spawn + DB write
   (up to the 10s timeout under contention).
2. **H2:** `ingestEvent()` accepts any object. Events missing `session_id` or
   `hook_event_name` are inserted as NULL rows that no session-scoped query can
   find, silently skewing global counts.
3. **H3:** Multi-statement handlers (task create/update/complete, session
   start/end, subagent start/stop — each also calling `recordEvent`) run without
   transactions. A mid-handler failure leaves partial writes.
4. **H4:** `handleSessionEnd` is the only handler that does not call
   `ensureSession` — a `SessionEnd` for an untracked session orphans the event.
5. **H13:** `resolveTeamContext` wraps its whole team-scan loop in one
   try/catch. One malformed `config.json` aborts scanning ALL remaining teams;
   affected sessions permanently lose team attribution (later handlers only set
   `team_name` when it is currently NULL).
6. **isPaused bug:** `lib/config.ts` matches `cwd.startsWith(p + "/")` with a
   hardcoded forward slash; Windows CWDs use backslashes, so
   `/stalker-config pause` does not work on Windows.

## Decisions

- **Malformed events are rejected, not stored**: skip the insert, one stderr
  line. (Quarantine table rejected as overkill; NULL-insert status quo rejected
  as silent corruption.) Unknown event *types* are still captured via the
  existing `handleGeneric` catch-all — validation only enforces structural
  usability.
- **Transaction granularity = whole event**: one transaction around the
  `ingestEvent` dispatch, not per-handler. Each hook invocation is one process
  handling one event; "all writes land or none do" is exactly the right unit,
  and future handlers inherit it.
- **Explicit `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`**, not
  `db.transaction().immediate()`: the latter caches BEGIN/COMMIT prepared
  statements that keep the DB file handle locked after `db.close()` on Windows
  (proven during the schema-migration work — EBUSY on unlink).

## Design

### 1. Async UserPromptSubmit (C2) — `hooks/hooks.json`

Add `"async": true` to the `UserPromptSubmit` hook command entry, matching the
other ten hook events. No code change.

### 2. Ingest validation (H2) — `lib/ingest.ts`

New exported guard:

```ts
export function isValidEvent(event: unknown): event is Record<string, any> {
  return (
    typeof event === "object" && event !== null && !Array.isArray(event) &&
    typeof (event as any).session_id === "string" && (event as any).session_id.length > 0 &&
    typeof (event as any).hook_event_name === "string" && (event as any).hook_event_name.length > 0
  );
}
```

`ingestEvent` calls it first; on failure it writes
`agent-stalker: dropped event (missing session_id/hook_event_name)` to stderr
and returns without opening a transaction or touching the DB.

### 3. Whole-event transaction (H3) — `lib/ingest.ts`

`ingestEvent` wraps the handler dispatch:

```ts
export function ingestEvent(event: Record<string, any>): void {
  if (!isValidEvent(event)) {
    console.error("agent-stalker: dropped event (missing session_id/hook_event_name)");
    return;
  }
  const db = getDb();
  db.run("BEGIN IMMEDIATE");
  try {
    dispatchEvent(event);          // the existing switch, extracted as-is
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;                       // tracker.ts already logs ingest failures
  }
  // Post-commit, outside the transaction (see carve-out):
  if (event.hook_event_name === "SessionEnd") {
    try { ingestUsageForSession(db, event.session_id); } catch { /* best-effort */ }
  }
}
```

**Carve-out:** `handleSessionEnd` currently calls `ingestUsageForSession`
(best-effort transcript parsing) inline. That call moves out of
`handleSessionEnd` into the post-commit step shown above, keeping its existing
swallow-errors try/catch. Rationale: a slow or failing transcript parse must
not roll back the session-end write. `ingestUsageForSession` itself is left
unchanged.

### 4. `ensureSession` in `handleSessionEnd` (H4) — `lib/ingest.ts`

First line of `handleSessionEnd`, identical to every other handler. The UPDATE
of `ended_at`/`end_reason` then targets a row guaranteed to exist.

### 5. Per-team error isolation (H13) — `lib/resolve-team.ts`

Restructure the scan: the outer try/catch keeps guarding `readdirSync`; each
team's `existsSync` + `readFileSync` + `JSON.parse` + member lookup moves into
a per-iteration try/catch whose catch does `continue`. One malformed team
config no longer aborts the scan.

### 6. `isPaused` separators — `lib/config.ts`

Normalize both sides before comparison:

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

Case sensitivity is left as-is (exact match), consistent with current behavior.

## Out of scope (deliberate)

Retention/size caps (Batch C), event-payload size limits (M1), poll-cursor and
timestamp semantics (M2/M3), validation of unknown event types (handleGeneric
stays a catch-all), daemon architecture (D1/D2).

## Testing (TDD, additions to existing suites)

`lib/ingest.test.ts`:
- `isValidEvent`: missing/empty/non-string `session_id` or `hook_event_name`,
  non-object inputs → false; minimal valid event → true.
- Dropped events insert nothing (event count unchanged) and do not throw.
- Atomicity: a handler failure mid-event (e.g. malformed `tool_response` that
  makes a later statement throw, or a stubbed failure) leaves zero rows from
  that event (no event row, no task row).
- `SessionEnd` without prior `SessionStart` creates the session row AND records
  the event with `ended_at`/`end_reason` set.

`lib/resolve-team.test.ts`:
- Teams dir with team A (malformed config.json) and team B (valid, contains the
  agent) → resolves team B.

`lib/config.test.ts`:
- `isPaused("C:\\repos\\proj", ...)` with paused path `C:/repos/proj` → true;
  forward/backslash mixes both directions; subdirectory match; non-prefix
  sibling (`C:/repos/proj2`) → false.

`hooks/hooks.json` (new tiny test file `hooks/hooks.test.ts`):
- Parse the JSON; assert every hook command entry has `"async": true` and a
  numeric `timeout`. Locks C2 and protects future hook additions.
