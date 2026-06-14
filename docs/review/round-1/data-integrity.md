# Data Integrity Review - Round 1

## Findings

### 1. No transaction wrapping for multi-statement operations in ingest handlers

- **What:** Several ingest handlers perform multiple database writes that should be atomic but are not wrapped in a transaction. For example, `handleSessionStart` does a SELECT, then either an INSERT or UPDATE to `sessions`, then calls `recordEvent` which does another INSERT to `events`. `handleTaskCompleted` inserts into `tasks`, conditionally updates `sessions`, and inserts into `events`. If the process is killed or times out (hooks have a 10-second timeout) between any of these statements, data becomes inconsistent.
- **Where:** `lib/ingest.ts:38-53` (handleSessionStart), `lib/ingest.ts:90-102` (handleTaskCompleted), `lib/ingest.ts:73-81` (handleSubagentStart), `lib/ingest.ts:83-88` (handleSubagentStop)
- **Why it matters:** A partial write could leave a session row with no corresponding event, or a task row without the session's team_name being updated, or an agent row with a started_at but the event never recorded. Since hooks are async with a 10-second timeout, crash/timeout mid-ingest is a realistic scenario. The result is ghost records that skew queries and stats.
- **Confidence:** High
- **Suggested alternative:** Wrap each handler's DB writes in an explicit transaction: `db.run("BEGIN"); ... db.run("COMMIT");` or use `db.transaction(() => { ... })()` (bun:sqlite supports this). This ensures either all writes for a single hook event succeed or none do.

### 2. `tasks` table has no PRIMARY KEY

- **What:** The `tasks` table defines `id TEXT` without a PRIMARY KEY constraint. Unlike `sessions` (which has `id TEXT PRIMARY KEY`) and `agents` (same), `tasks` allows duplicate rows with the same `id`. There is no UNIQUE constraint either.
- **Where:** `lib/db.ts:70-80`
- **Why it matters:** If a `TaskCompleted` hook fires more than once for the same task (e.g., due to retry logic or duplicate delivery), duplicate task rows will be inserted. Queries like `cmdTasks` will show duplicates, and `COUNT(*)` in stats will overcount. This also means there is no way to efficiently look up a specific task by ID (no index, no PK).
- **Confidence:** High
- **Suggested alternative:** Add `PRIMARY KEY` to the `id` column or at minimum a UNIQUE constraint. Use `INSERT OR IGNORE` or `INSERT OR REPLACE` in `handleTaskCompleted` to handle duplicate delivery idempotently, similar to how `handleSubagentStart` uses `INSERT OR IGNORE`.

### 3. `handleSessionEnd` does not call `ensureSession`, creating a potential orphaned update

- **What:** `handleSessionEnd` at line 55 directly updates the `sessions` table and calls `recordEvent`, but it does not call `ensureSession` first. If a `SessionEnd` event arrives without a prior `SessionStart` (possible if the process started before the plugin was installed, or if events arrive out of order), the UPDATE will match zero rows and silently do nothing. However, `recordEvent` will still INSERT into `events` with a `session_id` that has no matching `sessions` row.
- **Where:** `lib/ingest.ts:55-59`
- **Why it matters:** An event references a session_id via foreign key that does not exist in the `sessions` table. While SQLite does not enforce foreign keys by default (PRAGMA foreign_keys is never enabled), this creates logically orphaned event records. The `cmdSession` query will return "not found" while events for that session exist.
- **Confidence:** High
- **Suggested alternative:** Either call `ensureSession(event)` at the start of `handleSessionEnd` (consistent with all other handlers), or enable `PRAGMA foreign_keys = ON` and handle the constraint error.

### 4. Foreign keys are declared but never enforced

- **What:** The schema declares `FOREIGN KEY (session_id) REFERENCES sessions(id)` on `events`, `agents`, and `tasks` tables, but `PRAGMA foreign_keys` is never set to `ON`. SQLite defaults to `OFF` for foreign key enforcement.
- **Where:** `lib/db.ts:53,65,78` (FK declarations), `lib/db.ts:96-103` (getDb - no foreign_keys pragma)
- **Why it matters:** The foreign key declarations are documentation-only; they provide no runtime protection. Orphaned events, agents, or tasks can reference non-existent sessions. This is especially relevant given finding #3 above. Either enforce them (and handle errors gracefully) or remove the declarations to avoid false confidence.
- **Confidence:** High
- **Suggested alternative:** If the intent is purely documentation, this is acceptable but should be commented. If integrity is desired, add `db.run("PRAGMA foreign_keys = ON")` in `getDb()` and ensure `ensureSession` is called everywhere. However, enabling foreign keys would also mean `handleSessionEnd` and any event arriving before `SessionStart` would fail, so the `ensureSession` pattern must be consistent.

### 5. `schema_version` table has no constraint preventing multiple rows

- **What:** The `schema_version` table is `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)` with no PRIMARY KEY or UNIQUE constraint and no CHECK that limits it to one row. The code assumes there is always exactly zero or one row (via `LIMIT 1`), but nothing prevents a second row from being inserted if the migration logic has a bug or is called concurrently.
- **Where:** `lib/db.ts:16-19,88-92`
- **Why it matters:** If two processes run migrations concurrently (e.g., two hook invocations hit an uninitialized DB simultaneously), both could see `currentVersion === 0` and both insert a row, leaving two rows in `schema_version`. Future migration reads `LIMIT 1` and would get an arbitrary one (both version=1 so it's OK now, but becomes fragile as versions increase). This is a latent bug.
- **Confidence:** Medium (concurrent first-init is rare but possible since hooks are async)
- **Suggested alternative:** Make the table `schema_version (version INTEGER NOT NULL PRIMARY KEY)` or better yet use a single-row pattern: `CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)` and use `INSERT OR REPLACE`.

### 6. No validation of incoming event data shape at the ingest boundary

- **What:** `hooks/tracker.ts` does `JSON.parse(raw)` and passes the result directly to `ingestEvent` as `Record<string, any>`. There is no validation that required fields like `session_id`, `hook_event_name`, or `cwd` exist. If any are missing, the code silently inserts NULL values into columns that should logically be NOT NULL (e.g., `session_id` in events, `hook_event_name`).
- **Where:** `hooks/tracker.ts:15-16`, `lib/ingest.ts:120-148`
- **Why it matters:** A malformed event (or a new hook event type from a future Claude Code version with a different payload shape) will insert garbage data into the DB. The `session_id` column in `events` is the primary join key, and if it's NULL, the event becomes un-queryable by session. The `hook_event_name` is used for filtering and if NULL, events become invisible in the UI type filter.
- **Confidence:** High
- **Suggested alternative:** Add a minimal validation check before calling `ingestEvent`: verify that `event.session_id` and `event.hook_event_name` are non-empty strings. Reject or log-and-skip events that fail validation. Consider adding `NOT NULL` constraints to `session_id` and `hook_event_name` columns in the events table.

### 7. Timestamps use `Date.now()` at storage time rather than event timestamps

- **What:** All handlers use `Date.now()` for timestamps rather than extracting a timestamp from the incoming event payload. The events table stores the time the hook was *processed*, not when the event *occurred*. With async hooks and a 10-second timeout, there can be meaningful clock skew between occurrence and recording.
- **Where:** `lib/ingest.ts:30` (recordEvent uses Date.now()), `lib/ingest.ts:11,44,57,77,86,95` (all Date.now() calls)
- **Why it matters:** When events arrive out of order or are delayed, the stored timestamps won't reflect the true event ordering. The `ORDER BY timestamp ASC` queries in the query engine and API assume timestamps correspond to event occurrence order, but they actually reflect processing order. Two events from the same session could appear out of logical order.
- **Confidence:** Medium (depends on whether Claude Code provides an event timestamp in the payload)
- **Suggested alternative:** Check if the event payload contains a timestamp field (e.g., `event.timestamp`) and prefer it over `Date.now()`. Fall back to `Date.now()` if no event timestamp is provided.

### 8. `pollNewEvents` in the UI can duplicate events when polling

- **What:** The polling mechanism in `ui/index.html:791-804` fetches events where `timestamp > lastTimestamp` and appends them to `state.events` via `concat`. However, if two events share the exact same millisecond timestamp, and the first poll catches one of them, the second poll will miss the equal-timestamp events (strict `>`) or could re-fetch them if the API uses `>=`. Additionally, events are never deduplicated by ID.
- **Where:** `ui/index.html:791-804` (pollNewEvents), `ui/server.ts:53` (API uses strict `>`)
- **Why it matters:** With high-frequency tool use, multiple events can share a millisecond timestamp. Events at the boundary timestamp could be lost (with strict `>`) or duplicated (if changed to `>=`). The `state.events` array grows unboundedly during long sessions since old events are never evicted.
- **Confidence:** Medium
- **Suggested alternative:** Use the event `id` (auto-incrementing) instead of `timestamp` for poll cursors. The API could accept a `since_id` parameter, guaranteeing no gaps or duplicates. Also add a maximum array size to prevent unbounded memory growth.

### 9. `events.data` column stores JSON as text with no size limit

- **What:** The `data` column in the events table stores `JSON.stringify(data)` with no upper bound. While `truncateContent` limits tool_input and tool_response for tool-use events, the `handleGeneric` handler at line 114 passes the entire rest-of-event spread as data with no truncation. Additionally, `handleToolUse` includes `error` and `is_interrupt` fields alongside truncated data.
- **Where:** `lib/ingest.ts:114-118` (handleGeneric), `lib/ingest.ts:70` (handleToolUse includes error which could be large), `lib/db.ts:52` (data TEXT, no constraint)
- **Why it matters:** A single large event (e.g., a UserPromptSubmit with a very long prompt, or a generic event with a large payload) could insert megabytes of data into a single row. Over time this leads to database bloat. The `handleGeneric` path is particularly concerning since it captures everything not in the destructured set.
- **Confidence:** Medium
- **Suggested alternative:** Apply `truncateContent` or a global max-length to the serialized JSON before inserting. Add a size check like `if (jsonStr.length > MAX_DATA_SIZE) jsonStr = jsonStr.slice(0, MAX_DATA_SIZE) + '..."}'`.

### 10. `ensureSession` creates sessions with incomplete data

- **What:** When `ensureSession` creates a session (for events arriving before SessionStart), it only captures `id`, `cwd`, `permission_mode`, and `started_at`. It does not set `model`, `agent_type`, or team context. If `SessionStart` arrives later, `handleSessionStart` does an upsert, but it overwrites `started_at` with the SessionStart's time. This means the `started_at` no longer reflects the first activity in the session.
- **Where:** `lib/ingest.ts:6-15` (ensureSession), `lib/ingest.ts:38-52` (handleSessionStart overwrites)
- **Why it matters:** The `started_at` field becomes unreliable. If a tool-use event arrives first (creating the session), and then SessionStart arrives a few seconds later (overwriting started_at), the actual first-activity time is lost. Duration calculations based on `started_at` to `ended_at` will be wrong.
- **Confidence:** Medium
- **Suggested alternative:** In `handleSessionStart`, only update `started_at` if it's currently NULL (i.e., the session was genuinely created by ensureSession and the original started_at should be preserved), or better yet, add a `first_seen_at` column that is set once and never overwritten.

## Summary

The most critical data integrity issues are: (1) lack of transactions around multi-statement ingest operations creating partial-write hazards, (2) the `tasks` table missing a PRIMARY KEY allowing unbounded duplicates, and (3) `handleSessionEnd` not calling `ensureSession`, creating orphaned events. The schema declares foreign keys but never enforces them, and there is no input validation at the ingestion boundary, meaning malformed events silently corrupt the database. These issues are individually modest in a low-traffic plugin context, but compound in team scenarios where multiple concurrent agents fire hooks simultaneously.
