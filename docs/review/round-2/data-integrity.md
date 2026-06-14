# Data Integrity Review - Round 2 (Cross-Pollination)

These are new insights triggered by the other perspectives. My Round 1 findings are unchanged.

---

### Insight A: CORS wildcard + no auth makes data integrity moot for confidentiality (from Adversary Findings 1, 3, 12)

The Adversary perspective highlights that `Access-Control-Allow-Origin: *` with no authentication means any website can read the full event database. This amplifies my Round 1 Finding #9 (unbounded JSON in data column) in an unexpected way: it is not just a storage/bloat concern, but a **confidentiality exfiltration surface**. The larger the untruncated data stored, the more valuable the exfiltration target. My finding about `handleGeneric` storing the full rest-spread of unknown events becomes security-critical when the data is network-accessible. I would now prioritize truncation/size-limiting of the `data` column as a security mitigation, not just a storage optimization.

---

### Insight B: Unbounded `limit`/`offset` API parameters enable full-table extraction (from Adversary Finding 7)

The Adversary identified that `parseInt(params.get("limit"))` has no upper bound clamping. From a data integrity perspective, I had not considered the retrieval side as a vector, but this interacts with my concerns: if the database grows unboundedly (my Finding #9, Adversary Finding 2), a single API request with `limit=999999999` could cause the server process to OOM trying to serialize the entire events table as JSON. This is a denial-of-service against the data access layer, not just a data exfiltration concern. SQLite would read the full table into memory, Bun would serialize it all to JSON, and the response would balloon. Clamping `limit` to a reasonable max (e.g., 1000) protects both confidentiality and server stability.

---

### Insight C: The synchronous UserPromptSubmit hook creates a data integrity race window (from Adversary Finding 10)

The Adversary correctly notes that `UserPromptSubmit` is the only synchronous hook. From a data integrity angle, this creates an interesting problem: because it blocks the user prompt, if it hits a `SQLITE_BUSY` timeout (my Round 1 concern about concurrent writes), the user's prompt is delayed by up to 5 seconds. But more subtly, if the busy_timeout is exhausted and the write fails, the event is silently lost (tracker.ts catch block logs to stderr). So the one hook that is *most visible* to the user (it blocks their interaction) is also the one most likely to lose data under contention, because the user is the one most likely to be impatient and trigger concurrent activity. Making it async would fix the UX problem but would not fix the silent data loss.

---

### Insight D: Client-side poll duplication is worse than I described (from User/Consumer Finding 5)

The User/Consumer perspective notes that `loadSessions()` and `loadAgents()` are not polled, only events are. This means the client-side `state.events` array can contain events referencing session IDs and agent IDs that the client has never loaded. My Round 1 Finding #8 focused on timestamp-boundary duplicates/gaps, but the User/Consumer finding reveals a second inconsistency: the client's data model becomes internally inconsistent because events reference entities (sessions, agents) that are absent from the client state. Clicking a session ID in an event row would have no corresponding sidebar entry. This is a client-side data integrity issue where the UI's in-memory model diverges from the server's truth.

---

### Insight E: Loose test assertions mask the data integrity bugs I found (from Testing Strategy Finding 4)

The Testing Strategy reviewer found that `query.test.ts` assertions are so loose they would pass with nearly any output (e.g., `toContain("1")`). This directly explains why several of my findings went undetected. For instance, my Finding #10 (ensureSession creates sessions with incomplete data, then handleSessionStart overwrites started_at) would be caught by a test that asserts the specific value of `started_at`, but the current tests only check `not.toBeNull`. My Finding #2 (tasks table allows duplicates) would be caught by a test that inserts the same task_id twice and asserts only one row exists, but no such test exists. The testing gaps are not random -- they systematically avoid the precision needed to catch the exact class of data integrity bugs I identified.

---

### Insight F: `resolveTeamContext` filesystem scan failure silently corrupts team attribution (from Testing Strategy Finding 9)

The Testing Strategy reviewer notes that `resolveTeamContext` has an uncovered try/catch that silently returns null on any filesystem error. From a data integrity perspective, this means: if the teams directory exists but a config.json is malformed, team resolution fails silently for ALL subsequent teams in the scan (the `for` loop is inside the try, so one bad config.json aborts scanning all remaining teams). Events that should have team context will be stored with `team_name = null` and `teammate_name = null`. This is silent data corruption -- the event is stored, but with missing attribution. Worse, because `handleTeammateIdle` and `handleTaskCompleted` conditionally update `sessions.team_name` based on the resolved context, a single malformed team config can cause an entire session to lose its team association permanently.

---

### Insight G: The `since` parameter semantic mismatch creates silent data gaps (from User/Consumer Finding 13)

The User/Consumer notes that the CLI `--since 1h` uses relative duration while the API `?since=<timestamp>` expects absolute milliseconds. From a data integrity perspective, this mismatch in the polling path (`pollNewEvents` uses `since=${state.lastTimestamp}`) combined with my Finding #7 (timestamps reflect processing time, not event time) means: events that were processed late (e.g., due to SQLite contention or slow disk) get a `timestamp` later than their logical occurrence. If you query `since=<T>`, you might get events that logically happened before T but were written after T. The UI poll would pick them up as "new" events and append them out of logical order. The user sees events appearing at the bottom of the timeline that should have been interleaved earlier.

---

### Insight H: Missing tool_name escaping in renderToolFilter is an injection vector into the filter (from User/Consumer Finding 14)

The User/Consumer found that `renderToolFilter` does not use `esc()` on tool names in `<option>` elements. From a data integrity perspective, the `tool_name` comes from the events table, which comes from hook event payloads with no validation (my Finding #6). If a tool_name contained a double-quote character, it would break the `value` attribute of the option, causing the filter to send a truncated or wrong tool name to the API. This is a chain: no input validation at ingestion -> corrupt data in DB -> corrupt filter behavior in UI -> incorrect query results displayed to user. The data integrity failure at the boundary propagates all the way to the presentation layer.

---

## Summary

The other perspectives significantly strengthen the case for several of my Round 1 findings. The Adversary's CORS/auth findings transform my "unbounded data storage" concern from a performance issue into a security-critical exfiltration surface. The Testing Strategy's finding about loose assertions explains precisely why the data integrity bugs I identified have survived -- the tests lack the precision to catch them. The User/Consumer's polling and filter-escaping findings reveal that data integrity failures at the ingestion boundary cascade through the entire stack to corrupt the UI's in-memory state and query behavior. The most actionable compound insight: **input validation at the ingest boundary (my Finding #6) would have prevented or mitigated at least 4 issues found across all perspectives**.
