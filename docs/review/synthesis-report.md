# Agent Stalker Review -- Synthesis Report

This report consolidates findings from four independent review perspectives (Adversary, User/Consumer, Data Integrity, Testing Strategy) across two rounds: independent analysis (Round 1) and cross-pollination (Round 2).

---

## Independent Findings (Round 1)

### Consensus Concerns

Issues flagged independently by 2+ perspectives. These carry the highest confidence -- multiple independent procedures converged without cross-contamination.

#### 1. CORS wildcard + no authentication exposes the full event database

- **Flagged by:** Adversary (#1, #12), User/Consumer (#8)
- **Summary:** The web server binds to `0.0.0.0` by default with `Access-Control-Allow-Origin: *` on every API response and zero authentication. Any device on the local network can read the entire event database. Any website the user visits can silently `fetch('http://localhost:3141/api/events?limit=99999')` and exfiltrate the full development history, including file contents, bash commands, and session metadata.
- **Where:** `ui/server.ts:11` (CORS header), `ui/server.ts:101-123` (server bind)
- **Impact:** Critical. This turns an observability tool into an information disclosure vulnerability. Combined with full-content capture defaults, API keys, credentials, and private code are network-accessible.

#### 2. Unbounded database growth with no retention policy

- **Flagged by:** Adversary (#2), User/Consumer (#7)
- **Summary:** Events accumulate indefinitely. There is no `DELETE` path, no TTL, no max-rows check, no vacuum schedule. 11 hook types fire continuously during Claude Code sessions, generating thousands of events per hour. The default database path (`~/.claude/agent-stalker.db`) grows silently.
- **Where:** `lib/ingest.ts` (all insert paths), `lib/db.ts` (no cleanup in migrations)
- **Impact:** High. Database will reach hundreds of MB over weeks. SQLite performance degrades with table size (5 indexes on `events`). Hook processes may timeout as inserts slow down, causing silent data loss.

#### 3. No input validation at the ingestion boundary

- **Flagged by:** Adversary (#6), Data Integrity (#6)
- **Summary:** `ingestEvent()` accepts `Record<string, any>` with no validation of required fields. Missing `session_id` or `hook_event_name` values are silently inserted as NULL, creating un-queryable records. The `handleGeneric` default handler stores the entire event payload without size limits.
- **Where:** `hooks/tracker.ts:15-16`, `lib/ingest.ts:114-118,120-148`
- **Impact:** High. Malformed events corrupt the database silently. No `NOT NULL` constraints on critical columns. Future Claude Code payload changes would cause silent failures.

#### 4. No tests for system boundaries (tracker.ts entry point, server API)

- **Flagged by:** Testing Strategy (#1, #2), reinforced by all perspectives in Round 2
- **Summary:** The two most critical boundaries -- the hook entry point (`hooks/tracker.ts`) and the HTTP API layer (`ui/server.ts`) -- have zero test coverage. These handle stdin parsing, JSON deserialization, URL parameter validation, path traversal protection, and CORS configuration.
- **Where:** `hooks/tracker.ts` (no test file), `ui/server.ts` (no test file)
- **Impact:** High. Security fixes (path traversal, XSS) have no regression protection. API behavior is entirely unverified. The entry point where real-world data enters the application is untested.

#### 5. SPA fallback serves index.html for all non-API, non-matching paths

- **Flagged by:** Adversary (#8), User/Consumer (#12)
- **Summary:** The server returns 200 OK with the SPA HTML for any unrecognized path. Never returns 404. Security scanners see every probed path as "found." Mistyped API routes silently return HTML.
- **Where:** `ui/server.ts:120-121`
- **Impact:** Low-Medium. HTTP semantics violation, scanner confusion, silent failures for mis-addressed requests.

#### 6. Sensitive data captured and stored in plaintext by default

- **Flagged by:** Adversary (#3), User/Consumer (Round 2 reaction)
- **Summary:** `Edit` and `Write` tools default to `"full"` capture, storing complete file contents. Even `metadata` mode only strips a limited set of keys. The database at `~/.claude/agent-stalker.db` has no encryption. Users are not warned about what is captured.
- **Where:** `lib/config.ts:12-13`, `lib/truncate.ts:3`
- **Impact:** High. API keys in `.env` files, passwords in bash commands, and private code are stored in plaintext. Combined with the CORS/auth issue, this data is remotely accessible.

---

### Unique Findings

Findings only one perspective caught. Organized by perspective.

#### Adversary Perspective

| # | Finding | Confidence |
|---|---------|------------|
| 4 | Path traversal protection bypassable on Windows (backslash/forward-slash normalization in `resolve()` + `startsWith()`) | Medium |
| 5 | SQLite concurrent write contention under multi-agent scenarios (writer-writer locks with 5s busy_timeout) | Medium-High |
| 7 | `since`, `limit`, `offset` API parameters parsed without bounds (enables full-table extraction, potential OOM) | High |
| 9 | Per-event process spawning creates performance bottleneck (Bun startup + DB open + migration check per hook) | High |
| 10 | `UserPromptSubmit` hook is synchronous, blocking user interaction on every prompt | High |
| 11 | `syntaxHighlight` regex on untrusted JSON, potential ReDoS on pathological input | Low-Medium |

#### User/Consumer Perspective

| # | Finding | Confidence |
|---|---------|------------|
| 1 | Timestamps displayed as raw Unix milliseconds in CLI output | High |
| 2 | No `--help` flag or usage guidance for any subcommand | High |
| 3 | `cmdSession` uses positional arg inconsistently with flag-based `cmdEvents` | Medium |
| 4 | `/stalker-config set` instructions are ambiguous about config syntax | Medium |
| 5 | Web UI polling discovers new events but never refreshes sessions or agents (breaks "LIVE" promise) | High |
| 6 | Team filtering selects only the first matching session, not all sessions for the team | High |
| 9 | Search is client-side only, searches raw JSON blobs, and limited to loaded events | Medium |
| 10 | `/stalker-ui stop` uses `pkill` which doesn't work on Windows | High |
| 11 | `parseDuration` silently returns 0 for unrecognized format strings | Medium |
| 13 | `since` parameter semantics differ between CLI (relative duration) and API (absolute timestamp) | Medium |
| 14 | `renderToolFilter` doesn't escape HTML in tool names (residual XSS vector) | Medium |
| 15 | No graceful handling of database lock/corruption errors in the web server | Medium |

#### Data Integrity Perspective

| # | Finding | Confidence |
|---|---------|------------|
| 1 | No transaction wrapping for multi-statement ingest handlers (partial-write hazard) | High |
| 2 | `tasks` table has no PRIMARY KEY (allows duplicate rows) | High |
| 3 | `handleSessionEnd` does not call `ensureSession` (orphaned events possible) | High |
| 4 | Foreign keys declared but never enforced (`PRAGMA foreign_keys` never enabled) | High |
| 5 | `schema_version` table has no constraint preventing multiple rows (concurrent init race) | Medium |
| 7 | Timestamps use `Date.now()` at storage time, not event occurrence time | Medium |
| 8 | `pollNewEvents` can duplicate or miss events at timestamp boundaries | Medium |
| 9 | `events.data` column stores JSON with no size limit (especially via `handleGeneric`) | Medium |
| 10 | `ensureSession` creates sessions with incomplete data; `handleSessionStart` overwrites `started_at` | Medium |

#### Testing Strategy Perspective

| # | Finding | Confidence |
|---|---------|------------|
| 3 | Module-level DB singleton causes test isolation fragility | Medium |
| 4 | Query test assertions are too loose to catch regressions (`toContain("1")` matches anything) | High |
| 5 | `Date.now()` not controlled in tests, making timestamp assertions non-deterministic | High |
| 6 | Config tests don't verify merge behavior edge cases or malformed config handling | Medium |
| 7 | No test for `SubagentStop`, `TeammateIdle`, `PostToolUse`, or generic event handlers | High |
| 8 | Truncate metadata test only covers 2 of 8 strip keys | Medium |
| 9 | `resolveTeamContext` filesystem error handling path is untested | Medium |
| 10 | Test database cleanup uses `Date.now()` in paths, risking collision | Low |

---

## Cross-Pollination Insights (Round 2)

### Tradeoff Tensions

Where perspectives explicitly conflict or highlight opposing design priorities.

#### Tension 1: Full content capture vs. security exposure

- **Adversary** argues that `Edit`/`Write` at `"full"` by default is a security risk (stores credentials, private code).
- **User/Consumer** implicitly values comprehensive data capture for observability (their findings focus on making captured data more usable).
- **Resolution direction:** Capture less by default (metadata mode), let users opt into full capture per-tool, and surface clear warnings about what is captured.

#### Tension 2: Daemon architecture vs. process-per-event simplicity

- **Adversary** proposes a long-running daemon to eliminate per-event process spawning overhead.
- **Data Integrity** wants transaction wrapping, which aligns with a persistent process.
- **Tension:** A daemon introduces new failure modes (crashes, socket cleanup, connection leaks). Process-per-event is simple and failure-isolated -- each invocation succeeds or fails independently.
- **Resolution direction:** Both perspectives converge on a persistent process as the better long-term architecture, but the migration has real complexity costs.

#### Tension 3: Comprehensive error path testing vs. trusted input assumption

- **Adversary** acknowledges a trust boundary argument (hook events come from Claude Code).
- **Testing Strategy** argues for comprehensive validation regardless of trust level.
- **Resolution direction:** Defense-in-depth wins. The cost of basic validation is low, and even trusted sources have bugs. Future Claude Code versions may change payload shapes.

---

### Amplified Concerns

Round 1 findings that other perspectives validated or escalated in Round 2.

#### CORS + sensitive data = active exfiltration vulnerability (not just a "concern")

- **Original:** User/Consumer called CORS "a security concern." Adversary called it "actively exploitable."
- **Amplification:** Data Integrity (Round 2) connected unbounded `data` column size to CORS -- larger untruncated payloads make the exfiltration target more valuable. User/Consumer (Round 2) acknowledged they underestimated the scope: binding to `0.0.0.0` means the entire local network has access, not just malicious websites.

#### Synchronous UserPromptSubmit is the highest-priority UX fix

- **Original:** Adversary Finding #10.
- **Amplification:** User/Consumer (Round 2) called this "the single most important user-experience finding across all perspectives." Data Integrity (Round 2) added that under SQLite contention, this hook is most likely to both block the user AND lose data. All four perspectives converge: this should be `async: true`.

#### Loose test assertions systematically mask data integrity bugs

- **Original:** Testing Strategy Finding #4.
- **Amplification:** Data Integrity (Round 2) showed that `toContain("1")` would never catch duplicate tasks, overwritten timestamps, or orphaned sessions. User/Consumer (Round 2) noted that raw-timestamp formatting bugs are invisible to current tests. The test suite provides false confidence.

#### Missing `ensureSession` in `handleSessionEnd` is a concrete bug

- **Original:** Data Integrity Finding #3.
- **Amplification:** Testing Strategy (Round 2) showed the existing test always sends SessionStart before SessionEnd, hiding the bug. Adversary (Round 2) noted orphaned events create hidden data that could be missed in security audits.

#### Input validation at the ingest boundary would prevent cascading failures

- **Original:** Data Integrity Finding #6.
- **Amplification:** Data Integrity (Round 2) concluded that input validation "would have prevented or mitigated at least 4 issues found across all perspectives." The chain: no validation -> corrupt data in DB -> corrupt filter behavior in UI -> incorrect query results.

---

### New Insights

Things that emerged ONLY from cross-pollination -- not present in any Round 1 output.

#### 1. Consent/transparency gap is a first-order problem

No perspective independently flagged this, but combining Adversary (sensitive data capture), Data Integrity (no validation), and Testing (no entry point tests): a user who installs this plugin has no way to know what data is being captured, that full file contents are stored by default, or that the data is network-accessible. There is no `--dry-run` mode, no first-run notice, and no opt-in for full content capture. This is an ethical/consent issue, not just a technical one.

#### 2. Error cascades are completely invisible to the user

Across all perspectives: errors in hook processing, database contention, partial writes, and malformed events all fail silently (stderr only). There is no error counter in stats, no health check endpoint, no "last error" indicator in the dashboard. A user whose plugin is silently failing 50% of events has no way to know. An `/api/health` endpoint or "capture rate" metric would make failures visible.

#### 3. `handleGeneric` catch-all creates unpredictable data growth

The default handler stores the entire event payload for any unrecognized hook event type. Any new hook event Claude Code introduces will be silently captured with all its data. Storage consumption becomes unpredictable and may increase without user action.

#### 4. Client-side data model becomes internally inconsistent during polling

Events polled via `pollNewEvents` can reference session IDs and agent IDs that the client has never loaded (since `loadSessions` and `loadAgents` are not polled). The UI's in-memory model diverges from server truth, causing display inconsistencies.

#### 5. Concurrent first-initialization creates a database race condition

When a user first installs the plugin, the first batch of hook events all try to create the database simultaneously. Multiple processes running `CREATE TABLE IF NOT EXISTS` and `INSERT INTO schema_version` concurrently could create duplicate schema_version rows. The `schema_version` table has no PRIMARY KEY constraint.

#### 6. `resolveTeamContext` failure silently corrupts team attribution for entire sessions

If one team's `config.json` is malformed, the `for` loop inside the `try` block aborts scanning ALL remaining teams. Events that should have team context are stored with `team_name = null`. Because `handleTeammateIdle` and `handleTaskCompleted` conditionally update `sessions.team_name`, a single bad config can cause an entire session to lose its team association permanently.

#### 7. Port 3141 is vulnerable to preemptive binding

The server is started in the background with no port conflict detection. An attacker (or another local process) could bind port 3141 first to intercept requests. No diagnostic output informs the user if the server fails to start.

---

## Suggested Alternatives

Concrete alternatives surfaced across both rounds, prioritized by impact.

### Critical (fix before any production/shared use)

1. **Bind to `127.0.0.1` explicitly.** Remove `Access-Control-Allow-Origin: *`. Either don't set CORS headers (same-origin only) or restrict to `http://localhost:3141`.
2. **Add `"async": true` to the UserPromptSubmit hook** in `hooks/hooks.json`. There is no reason this hook needs to be synchronous.
3. **Default `Edit`/`Write` capture to `metadata`, not `full`.** Add a first-run notice or documentation warning about what is captured and where data is stored.
4. **Add a residual XSS fix:** apply `esc()` to tool names in `renderToolFilter` at `ui/index.html:903`.

### High Priority

5. **Add data retention:** configurable max age (e.g., `maxAgeDays: 30`), a `stalker prune --older-than 7d` command, and periodic `DELETE` + `VACUUM`.
6. **Add input validation at the ingest boundary:** verify `session_id` and `hook_event_name` are non-empty strings, cap total event JSON size, reject unknown event types.
7. **Wrap multi-statement ingest handlers in transactions** (`db.transaction(() => { ... })()`).
8. **Add PRIMARY KEY to `tasks.id`** and use `INSERT OR IGNORE` for idempotent insertion.
9. **Call `ensureSession` in `handleSessionEnd`** for consistency with all other handlers.
10. **Clamp API `limit` to a maximum (e.g., 1000)** and validate `since` is a positive integer.
11. **Add server integration tests:** each API endpoint, path traversal attempts, CORS header assertions.

### Medium Priority

12. **Add `--help` output** to each CLI subcommand.
13. **Format timestamps** as human-readable dates in CLI output.
14. **Poll sessions/agents** in the web UI alongside events (at lower frequency).
15. **Fix team filtering** to show all sessions for a team, not just the first match.
16. **Use event `id` instead of `timestamp`** as the poll cursor to prevent duplicates/gaps.
17. **Tighten query test assertions** to specific substrings or structured data.
18. **Add tests for remaining event handlers:** SubagentStop, TeammateIdle, PostToolUse, generic handler.
19. **Add `PRAGMA foreign_keys = ON`** or remove the FK declarations to avoid false confidence.
20. **Cross-platform `/stalker-ui stop`:** use PID file approach or `process.kill()` instead of `pkill`.
21. **Prefer event timestamps from the payload** over `Date.now()` when available.

### Low Priority / Hardening

22. **Add `schema_version` PRIMARY KEY** with single-row constraint.
23. **Normalize path separators** in the static file traversal check for Windows safety.
24. **Support additional duration formats** in `parseDuration` (`s`, `w`) and error on unrecognized input.
25. **Add an `/api/health` endpoint** or capture-rate metric for error visibility.
26. **Limit `data` column size** (global max-length before INSERT).
27. **Control `Date.now()` in tests** (mock or inject clock) for deterministic timestamp assertions.

---

## Blind Spots

Areas the selected perspectives didn't adequately cover.

1. **Plugin lifecycle management.** No perspective deeply examined what happens when the plugin is installed, upgraded, or uninstalled. Migration behavior for existing databases when schema changes is untested. There is no versioning contract between the plugin and Claude Code's hook payload format.

2. **Multi-user / shared-machine scenarios.** The perspectives touched on network exposure but didn't consider multiple OS users sharing a machine, each running their own Claude Code sessions. Database file permissions, process isolation, and port conflicts in multi-user environments were not examined.

3. **Performance profiling / benchmarks.** While Adversary noted process spawning overhead and SQLite contention, no perspective provided concrete numbers or benchmarks. The actual latency impact of the synchronous UserPromptSubmit hook, the actual database growth rate, and the actual memory footprint of the web server under load are all unquantified.

4. **Accessibility of the web UI.** No perspective evaluated keyboard navigation, screen reader compatibility, color contrast, or responsive design of the dashboard.

5. **Plugin discoverability and onboarding.** The plugin.json metadata, command descriptions, and initial user experience (what happens the first time a user types `/stalker`) were not reviewed for clarity or completeness.

6. **Backup and recovery.** There is no mechanism to back up, export, or restore the SQLite database. If the database becomes corrupted, all historical data is lost with no recovery path.
