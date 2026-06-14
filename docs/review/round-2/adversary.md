# Adversary Perspective - Round 2: Cross-Pollination

## Reactions

### Reaction to User/Consumer Finding 8 (CORS wildcard)

The user/consumer perspective independently identified the `Access-Control-Allow-Origin: *` issue (their Finding 8), confirming my Finding 12 (CSRF/CORS exfiltration). They framed it as a security concern; from my adversary lens, I want to emphasize this is not just a "concern" -- it is an actively exploitable vulnerability right now. Any webpage the user visits can silently read their entire development history. The user/consumer suggestion to "restrict to `http://localhost:3141`" is necessary but insufficient: even with localhost CORS, a malicious page served from localhost (e.g., another local dev server) could still read the data. The correct fix is to remove CORS headers entirely (same-origin policy then blocks cross-origin reads) and serve the UI from the same origin as the API.

### Reaction to User/Consumer Finding 10 (pkill on Windows)

Their finding that `pkill` doesn't work on Windows highlights a broader adversary concern I didn't call out: the stop mechanism is entirely trust-based. `pkill -f` matches on command-line patterns, which means any process with "bun.*ui/server.ts" in its command line would be killed. A malicious process could name itself to match the pattern and either (a) avoid being killed by the real stop command, or (b) trick the stop command into killing the wrong process. More practically, if the PID file approach is adopted (their suggestion), the PID file becomes a new attack surface (symlink attacks, stale PIDs belonging to different processes). On Windows, `taskkill` by PID is safer but still needs validation.

### Reaction to User/Consumer Finding 14 (unescaped tool names in dropdown)

They identified a residual XSS vector in `renderToolFilter` at line 903 where `esc()` is not applied to tool names. This is directly relevant to my adversary perspective. While I noted the XSS fix in the memory (a prior commit escaped template literals), this specific location was missed. An attacker who can influence tool names stored in the database (e.g., by registering an MCP tool with a name containing `<script>` tags) could achieve stored XSS through the dropdown. The impact is limited since this requires write access to the SQLite database, but combined with the lack of input validation (my Finding 6), a crafted hook event with a malicious `tool_name` could inject HTML.

### Reaction to Data Integrity Finding 1 (no transactions)

The data integrity perspective's Finding 1 (no transaction wrapping) has a direct security implication I want to highlight. Partial writes don't just create data quality issues -- they create confusion that an attacker could exploit. If an adversary can cause targeted timeouts (e.g., by saturating the SQLite write lock during a victim's session), they can selectively cause `handleSessionEnd` events to partially fail, leaving sessions appearing "active" indefinitely. This wouldn't be a deliberate attack vector in practice, but it means the system's state can become misleading under adversarial conditions (DoS on the database).

### Reaction to Data Integrity Finding 3 (handleSessionEnd missing ensureSession)

This is a correctness bug with a subtle security angle. If `SessionEnd` events can create orphaned events without a parent session, and the `cmdSession` query returns "not found" for that session ID while events exist, this creates a data discoverability gap. An attacker analyzing the database (if they gained access via Finding 1 or 12 from my Round 1) might find events that don't appear in session listings -- orphaned events are effectively hidden data that could be overlooked during a security audit of what was captured.

### Reaction to Data Integrity Finding 6 (no input validation)

This directly reinforces my Finding 6. The data integrity perspective adds the important point about `NOT NULL` constraints on `session_id` and `hook_event_name` columns. From an adversary perspective, the absence of these constraints means a single null `session_id` event creates an un-queryable record -- it exists in the database but is invisible through all standard query paths. This is a minor data exfiltration concern: if the goal is completeness of the surveillance log, silent data loss means the log cannot be trusted.

### Reaction to Data Integrity Finding 7 (Date.now() vs event timestamps)

The timestamp issue compounds my Finding 5 (SQLite write contention). Under high concurrency, events queue up behind the busy_timeout. By the time they're written, `Date.now()` reflects when the write happened, not when the event occurred. An agent's activity timeline could appear shuffled or compressed. From an adversary standpoint, this means the audit trail is unreliable for forensic analysis -- you cannot trust event ordering to reconstruct what actually happened.

### Reaction to Testing Strategy Finding 2 (no server tests)

The lack of server tests is especially concerning from a security perspective. My Finding 4 (path traversal bypass on Windows) and Finding 12 (CSRF via CORS) are both in `ui/server.ts`, which has zero test coverage. These are the exact kinds of bugs that regression tests prevent -- a developer "fixing" the path traversal check could easily introduce a new bypass, and without tests, it would ship unnoticed. The testing perspective's suggestion to test path traversal attempts with encoded variants is exactly what's needed to validate my Finding 4.

### Reaction to Testing Strategy Finding 4 (loose query assertions)

From an adversary perspective, the loose test assertions are concerning because they could mask data leakage bugs. If a query function accidentally returned data from all sessions instead of just the requested one (a horizontal privilege escalation bug in a multi-user context), the test `expect(result).toContain("s1")` would still pass. The tests don't verify that data from *other* sessions is absent.

---

## Tensions

### Tension 1: Full content capture (my Finding 3) vs. User/Consumer's observability needs

My Finding 3 argues that `Edit` and `Write` at `"full"` capture by default is a security risk because it stores sensitive file contents. However, the user/consumer perspective implicitly values comprehensive data capture -- their findings focus on making the captured data more usable (better timestamps, better search, better filtering). There's a fundamental tension: the more data you capture, the more useful the tool is for observability, but the larger the attack surface becomes. The resolution should be: capture less by default (metadata mode), let users opt into full capture per-tool, and always flag the security implications in documentation.

### Tension 2: My Finding 9 (process-per-event overhead) vs. Data Integrity's transaction concerns

My Finding 9 suggests moving to a long-running daemon to eliminate per-event process spawning overhead. Data Integrity's Finding 1 argues for wrapping operations in transactions. These are aligned in direction (both favor a single persistent process), but there's a tension: a daemon with a persistent connection and transactions is more complex and introduces new failure modes (daemon crashes, socket cleanup, connection leaks). The process-per-event model is simple and failure-isolated -- each invocation either succeeds or fails independently. The daemon model trades simplicity for performance and atomicity.

### Tension 3: Testing Strategy's desire for comprehensive error path testing vs. the "trusted input" assumption

My Finding 6 (no input validation) and Testing Strategy's Finding 6 (no validation at ingest boundary) both flag the same gap, but my Finding 6 acknowledges a trust boundary argument: hook events come from Claude Code, a trusted source. The testing perspective argues for comprehensive error path testing regardless of trust level. The tension is about where to invest effort. From an adversary perspective, defense-in-depth wins: even trusted sources have bugs, and the cost of basic validation is low.

---

## New Insights

### New Insight 1: The combination of loose test assertions + no input validation creates a compound vulnerability

The testing perspective's Finding 4 (loose assertions) combined with data integrity's Finding 6 (no validation) means that if Claude Code starts sending events with a new payload structure (e.g., a future version changes field names), the system would: (a) silently store garbage (no validation), (b) not be caught by tests (assertions too loose), and (c) surface as mysterious "no results" in the UI days later when someone queries the data. This is not a security vulnerability per se, but it's a data reliability failure mode I didn't consider in Round 1. An adversary could exploit this by understanding that the stalker's audit trail is unreliable and acting during periods of high event volume where data loss goes unnoticed.

### New Insight 2: The pkill-based stop mechanism exposes the plugin's process model as an attack surface

The user/consumer perspective's Finding 10 made me realize the process lifecycle management is entirely external (shell commands in slash command markdown). There's no internal health check, no graceful shutdown protocol, no way for the web server to know if it's the only instance running. A user could accidentally start multiple server instances on the same port, and Bun would either fail silently or bind to a different port. From an adversary perspective, a port conflict could cause the server to fail to start, and the user would have no diagnostic output (the server is started with `&` in the background per stalker-ui.md). An attacker on the same machine could preemptively bind port 3141 to intercept requests intended for the stalker UI.

### New Insight 3: Database corruption risk from concurrent first-initialization

Data Integrity's Finding 5 (schema_version with no PK) combined with Testing Strategy's Finding 3 (singleton state) reveals a startup race condition I didn't consider. When a user first installs the plugin, the first batch of hook events will all try to create the database simultaneously. Multiple processes running `CREATE TABLE IF NOT EXISTS` and `INSERT INTO schema_version` concurrently could, in a pathological case, create duplicate schema_version rows. While this is mitigated by SQLite's file-level locking, the busy_timeout only applies after the database file exists -- the very first `new Database(path)` call creates the file, and concurrent processes might all succeed at creation before any starts the migration.
