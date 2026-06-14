# Adversary Perspective - Round 1

## Analytical Approach

I assumed this system has already been exploited or has failed catastrophically in production. I worked backward from specific failure scenarios to identify the vulnerabilities and design weaknesses that enabled them.

---

### Findings

#### Finding 1: Web UI server binds to all interfaces with no authentication

- **What:** `ui/server.ts` calls `Bun.serve({ port })` which binds to `0.0.0.0` by default. Combined with `Access-Control-Allow-Origin: *` on every API response, any machine on the local network can read the full event database -- session IDs, working directories, tool inputs/outputs, agent transcripts, task descriptions. There is zero authentication, zero authorization.
- **Where:** `ui/server.ts:101-123` (server creation), `ui/server.ts:11` (CORS wildcard)
- **Why it matters:** The database contains a surveillance log of everything a developer does with Claude Code -- every file read, every bash command, every edit. On a shared network (office, coffee shop, hotel), an attacker gets a passive feed of all development activity. This is the highest-impact finding because it turns a monitoring tool into an information disclosure vulnerability. If `tool_input` contains API keys, credentials, or `.env` file contents passed through tool calls, they are all exposed.
- **Confidence:** High
- **Suggested alternative:** Bind to `127.0.0.1` explicitly (`Bun.serve({ hostname: '127.0.0.1', port })`). Remove the wildcard CORS header or restrict to `localhost`. Add a bearer token or session cookie for API access.

---

#### Finding 2: Unbounded database growth with no retention policy or size limits

- **What:** Every hook event is recorded forever. There are 11 hook types, many firing on every tool call (PreToolUse, PostToolUse). A heavy Claude Code session can generate thousands of events per hour. There is no `DELETE` path, no TTL, no max-rows check, no vacuum schedule. The `data` column stores JSON blobs (tool inputs/outputs) that can be kilobytes each even after truncation.
- **Where:** `lib/ingest.ts` (all insert paths), `lib/db.ts` (no cleanup in migrations)
- **Why it matters:** Over days/weeks of active use, the database will grow to hundreds of MB or GB. SQLite performance degrades with table size, especially on the `events` table with 5 indexes. The hook process has a 10-second timeout (hooks.json), and as the DB grows, inserts may start timing out, causing silent data loss. On machines with limited disk (CI runners, containers), this could fill the volume.
- **Confidence:** High
- **Suggested alternative:** Add a configurable retention period (e.g., 7 days default). Run `DELETE FROM events WHERE timestamp < ?` and `VACUUM` periodically (either on session start or via a scheduled command). Add a max DB size check.

---

#### Finding 3: Sensitive data captured and stored in plaintext

- **What:** Tool inputs and responses are stored in the `data` column. The truncation rules help but are insufficient. `Edit` and `Write` tools are configured as `"full"` by default, meaning **the complete contents of every file edit and write are captured**. Bash commands with `maxLength: 2000` still capture most credential-bearing commands. Even `metadata` mode only strips specific keys (`content`, `data`, `output`, etc.) -- other keys with sensitive data pass through.
- **Where:** `lib/config.ts:12-13` (full capture for Edit/Write), `lib/truncate.ts:3` (limited strip-key set), `lib/ingest.ts:64-70` (stored as JSON in data column)
- **Why it matters:** The database becomes a treasure trove of sensitive information: API keys in .env files written via Write tool, passwords in Bash commands, private code in Edit operations. Combined with Finding 1 (no auth on web UI), this data is network-accessible. Even without Finding 1, the database file sitting on disk at `~/.claude/agent-stalker.db` has no encryption.
- **Confidence:** High
- **Suggested alternative:** Default Edit/Write to `metadata` not `full`. Add a configurable redaction layer that scrubs patterns matching API keys, tokens, passwords (regex-based). Consider encrypting the database at rest. At minimum, warn users in documentation that full capture mode stores sensitive content.

---

#### Finding 4: Path traversal protection is bypassable on Windows

- **What:** The static file serving in `ui/server.ts:113-118` uses `resolve()` + `startsWith(pluginRoot)` to prevent path traversal. However, on Windows, `resolve()` normalizes to backslash paths while `startsWith` does a string comparison. An attacker could construct a URL that resolves to a path outside `pluginRoot` if there are case-sensitivity or path separator mismatches. More critically, `pluginRoot` is `import.meta.dir` (the `ui/` subdirectory), and the check is `fullPath.startsWith(pluginRoot)` -- but a request to `/index.html` resolves inside `ui/`, while a request with encoded characters (`%2e%2e`) may bypass depending on how `new URL()` decodes the pathname.
- **Where:** `ui/server.ts:111-121`
- **Why it matters:** Successful path traversal gives read access to arbitrary files on the system through the web server. Given that the server already has no authentication (Finding 1), this is remotely exploitable from the local network.
- **Confidence:** Medium (the specific bypass depends on how Bun's URL parser and Node's `resolve()` interact on Windows -- needs empirical testing)
- **Suggested alternative:** Use an allowlist approach: only serve `index.html` from the `ui/` directory, reject all other static file requests. Alternatively, normalize path separators before comparison and add explicit rejection of `..` segments in the raw pathname before resolution.

---

#### Finding 5: SQLite concurrent write contention under team/multi-agent scenarios

- **What:** The system uses a module-level singleton `db` variable (`let db: Database | null = null`). Each hook invocation spawns a new `bun` process (via hooks.json commands), each getting its own DB connection. WAL mode helps, but `busy_timeout = 5000` means writes can block for up to 5 seconds. In a team scenario with multiple agents, each firing PreToolUse + PostToolUse hooks concurrently, you get N*2 processes competing for write locks every few seconds.
- **Where:** `lib/db.ts:4,96-103` (singleton per-process), `hooks/hooks.json` (every hook spawns a process)
- **Why it matters:** Under high concurrency, `SQLITE_BUSY` errors will occur despite WAL and busy_timeout. The 10-second hook timeout means a process waiting 5 seconds on busy_timeout has only 5 seconds left for everything else (Bun startup, stdin read, parse, insert). In pathological cases, events are silently dropped (the catch in tracker.ts logs to stderr but doesn't retry).
- **Confidence:** Medium-High (WAL mitigates reader-writer contention but writer-writer contention remains a real SQLite limitation)
- **Suggested alternative:** Use a write-ahead queue: have hooks append to a file/pipe, and a single writer process drain the queue into SQLite. Alternatively, batch inserts using a shared long-running process instead of spawning per-event.

---

#### Finding 6: No input validation on hook event data

- **What:** `ingestEvent()` accepts `Record<string, any>` and directly destructures fields for SQL insertion without validating types, presence, or format. If `session_id` is undefined, null, an object, or an absurdly long string, it gets inserted as-is. The `handleGeneric` path (line 114-118) does a rest spread of the entire event and stores it, meaning any field in the hook payload ends up in the database.
- **Where:** `lib/ingest.ts:120-149` (switch with no validation), `lib/ingest.ts:114-118` (handleGeneric stores everything)
- **Why it matters:** A malformed or maliciously crafted hook event could: (a) insert corrupt data that breaks queries, (b) store extremely large payloads that bloat the database (the hook event size is not bounded before storage), (c) cause SQL errors on type mismatches. While the hook system is a trusted input boundary (controlled by Claude Code), a compromised or buggy hook source could exploit this.
- **Confidence:** Medium (the trust boundary argument reduces likelihood, but defense-in-depth says validate anyway)
- **Suggested alternative:** Add a schema validation layer (even a simple one) that checks required fields (session_id, hook_event_name) are non-empty strings, caps total event JSON size (e.g., 1MB), and rejects unknown hook_event_name values.

---

#### Finding 7: The `since` parameter in the events API is parsed as raw integer without bounds

- **What:** In `ui/server.ts:53`, the `since` query parameter is parsed with `parseInt()` and used directly in a SQL `WHERE timestamp > ?` clause. An attacker can pass `since=0` to get all events, or `since=NaN` (which parseInt returns for garbage input, and SQLite compares as 0). The `limit` and `offset` parameters at lines 21-22 and 45-46 are similarly unbounded -- `limit=999999999` dumps the entire table.
- **Where:** `ui/server.ts:21-22` (limit/offset), `ui/server.ts:45-46` (limit/offset), `ui/server.ts:53` (since)
- **Why it matters:** Combined with no authentication (Finding 1), this allows full database exfiltration via carefully crafted API requests. Even with authentication, unbounded limits enable denial-of-service by forcing the server to serialize massive result sets.
- **Confidence:** High
- **Suggested alternative:** Clamp `limit` to a maximum (e.g., 1000). Validate `since` is a positive integer. Return 400 for invalid parameters.

---

#### Finding 8: SPA fallback serves index.html for any non-API, non-matching path

- **What:** `ui/server.ts:121` returns `index.html` for any request that doesn't match an API route or static file. This means `/.env`, `/etc/passwd`, `/secrets.json` all return 200 with the SPA HTML, making it impossible to distinguish "not found" from "found" by status code. This also means the server never returns 404, which violates HTTP semantics and could confuse security scanners or reverse proxies.
- **Where:** `ui/server.ts:120-121`
- **Why it matters:** A security scanner probing for sensitive files would get 200 OK for every path, making it appear that all probed paths exist. This is a minor issue but reflects a "fail open" design philosophy. More practically, any mistyped API route silently returns HTML instead of an error.
- **Confidence:** High (it's a definite behavior, impact is moderate)
- **Suggested alternative:** Return 404 for non-API paths that don't match known static files. Only use SPA fallback for a defined set of client-side routes if needed.

---

#### Finding 9: Process spawning overhead creates performance bottleneck

- **What:** Every hook event spawns a new `bun` process (`bun "hooks/tracker.ts"`). Bun startup is fast but not zero -- it must parse TypeScript, resolve imports, open the SQLite database, run migrations (checking schema_version on every invocation), read stdin, parse JSON, execute SQL, then close. For high-frequency events like PreToolUse (fires before *every* tool call), this creates significant overhead.
- **Where:** `hooks/hooks.json` (all 11 hooks spawn processes), `lib/db.ts:14-93` (migration check on every connection), `hooks/tracker.ts` (full pipeline per invocation)
- **Why it matters:** In a busy session, the tool could generate 50+ events per minute. Each one: fork process, ~50ms Bun startup, open DB, check schema, read stdin, parse, insert, close DB, exit. This adds latency to synchronous hooks (UserPromptSubmit is not marked `async: true` in hooks.json line 33-37) and wastes system resources. On resource-constrained machines, this could noticeably slow down Claude Code.
- **Confidence:** High
- **Suggested alternative:** Use a long-running daemon process that accepts events via a Unix socket or named pipe. The daemon handles DB connection pooling and batched writes. Hooks become thin clients that just pipe stdin to the socket.

---

#### Finding 10: UserPromptSubmit hook is synchronous, blocking user interaction

- **What:** In `hooks/hooks.json:28-37`, the UserPromptSubmit hook does NOT have `"async": true`, unlike all other hooks. This means Claude Code will wait for the hook to complete (up to 10 seconds) before processing the user's prompt. Every user prompt submission is delayed by the full hook processing pipeline.
- **Where:** `hooks/hooks.json:28-37`
- **Why it matters:** This creates user-perceptible latency on every prompt. If the SQLite database is locked (Finding 5) or the disk is slow, the user experiences a multi-second delay every time they submit a prompt. This is the most likely reason a user would uninstall the plugin -- it makes Claude Code feel sluggish.
- **Confidence:** High
- **Suggested alternative:** Add `"async": true` to the UserPromptSubmit hook. There is no reason this hook needs to be synchronous -- it's recording telemetry, not modifying the prompt.

---

#### Finding 11: `syntaxHighlight` in frontend uses regex on untrusted JSON, potential ReDoS

- **What:** The `syntaxHighlight()` function at `ui/index.html:997-1006` applies regex replacements to JSON strings for syntax coloring. The regex `/"([^"\\]*(\\.[^"\\]*)*)"\s*:/g` is applied to user-controlled data (event payloads stored in the database). While the function first HTML-escapes the input (line 1000), the regex patterns include nested quantifiers (`[^"\\]*` inside a group with `*`) that could cause catastrophic backtracking on specially crafted input.
- **Where:** `ui/index.html:999-1005`
- **Why it matters:** A malicious or extremely large JSON payload in the event data could cause the browser tab to hang when viewing the event detail. This is a client-side DoS.
- **Confidence:** Low-Medium (the regex is relatively standard for JSON highlighting and catastrophic backtracking requires specific pathological input patterns, but the input is unbounded)
- **Suggested alternative:** Use a proper JSON tokenizer or limit the input size before applying regex highlighting. Set a timeout or use a web worker for the highlighting operation.

---

#### Finding 12: No CSRF protection on the API

- **What:** The API has no CSRF protection. Combined with `Access-Control-Allow-Origin: *`, any website the user visits can make fetch requests to `http://localhost:3141/api/*` and read the responses. This means a malicious webpage can silently exfiltrate the user's entire Claude Code activity history.
- **Where:** `ui/server.ts:11` (CORS header), `ui/server.ts:14-98` (all API endpoints are GET-only but expose all data)
- **Why it matters:** This is a realistic attack: user visits `evil.com`, which runs `fetch('http://localhost:3141/api/events?limit=99999')` and exfiltrates the response to the attacker's server. The attacker gets every tool call, every file edit, every bash command. This works even if the server is bound to localhost (Finding 1 fix alone doesn't solve this).
- **Confidence:** High
- **Suggested alternative:** Remove `Access-Control-Allow-Origin: *`. Either don't set CORS headers (same-origin only) or set it to `http://localhost:3141`. For write operations, add CSRF tokens. Consider using `SameSite=Strict` cookies.

---

### Summary

The most critical issue is the combination of Findings 1 + 3 + 12: the web server exposes a complete surveillance log of developer activity with no authentication, wildcard CORS, and no CSRF protection. Any website the user visits can silently exfiltrate their entire development history, including file contents. This turns a developer productivity tool into a data exfiltration vector. The secondary concern is operational: unbounded database growth (Finding 2) and per-event process spawning with a synchronous hook (Findings 9 + 10) will degrade both disk usage and interactive performance over time, eventually pushing users to disable the plugin.
