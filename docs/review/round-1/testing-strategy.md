# Testing Strategy Review -- Round 1

## Findings

### Finding 1: No tests for hooks/tracker.ts (the actual entry point)

- **What:** The hook entry point `hooks/tracker.ts` -- the file that actually receives stdin JSON from Claude Code and calls `ingestEvent` -- has zero test coverage. This is the system boundary where real-world data enters the application.
- **Where:** `hooks/tracker.ts` (no corresponding test file exists)
- **Why it matters:** This is the most critical boundary in the system. It handles stdin parsing, JSON deserialization, error handling, and the empty-input exit path. A malformed JSON payload, unexpected encoding, or partial stdin read would be caught by nothing. The `try/catch` on line 17 silently swallows parse errors with only a stderr message -- tests should verify this behavior. The `closeDb()` in `finally` is also untested; if it throws, the process could hang or mask the original error.
- **Confidence:** High
- **Suggested alternative:** Add an integration test that spawns `tracker.ts` as a subprocess with various stdin payloads (valid JSON, empty string, malformed JSON, huge payload) and asserts on exit code, stderr output, and database state.

---

### Finding 2: No tests for ui/server.ts (HTTP API layer)

- **What:** The web UI server has 13 API endpoints and a static file server with path traversal protection, but zero test coverage.
- **Where:** `ui/server.ts` (no corresponding test file exists)
- **Why it matters:** The API layer is the other major system boundary. SQL query construction with dynamic parameters, URL path parsing (`path.split("/api/sessions/")[1]`), `parseInt` of user-supplied query params (limit, offset, since), and the path traversal guard on static files are all untested. The path traversal check (`fullPath.startsWith(pluginRoot)`) is particularly security-sensitive and easy to get wrong on Windows (backslash vs forward slash normalization). A regression here would be invisible.
- **Confidence:** High
- **Suggested alternative:** Use `Bun.serve` test patterns or direct `handleApi` calls (extract it to be testable) to cover: each API endpoint with valid/missing/malformed params, 404 responses, path traversal attempts (`../../etc/passwd`, URL-encoded variants), and the static file fallback.

---

### Finding 3: Module-level singleton state causes test isolation issues

- **What:** `lib/db.ts` uses a module-level `let db: Database | null = null` singleton. Tests in `db.test.ts`, `ingest.test.ts`, and `query.test.ts` all manipulate `process.env.AGENT_STALKER_DB_PATH` and call `closeDb()` in `afterEach`. If tests run in parallel (Bun's default), multiple test files will race on this shared singleton, potentially corrupting state.
- **Where:** `lib/db.ts:4` (singleton), all test files that use `getDb()`
- **Why it matters:** Tests currently work because Bun runs test files sequentially by default, but this is a fragile assumption. Any move to parallel execution (or even reordering within a file if a test forgets to call `closeDb()`) would produce flaky failures that are extremely hard to diagnose. The singleton pattern also means tests can't verify concurrent database access patterns.
- **Confidence:** Medium -- works today but architecturally fragile
- **Suggested alternative:** Either (a) accept the singleton and add a comment/config ensuring sequential test execution, or (b) refactor `getDb` to accept an explicit path parameter for testing, avoiding env var mutation.

---

### Finding 4: Assertions in query.test.ts are too loose to catch regressions

- **What:** The query engine tests (`query.test.ts`) use `toContain` on string output rather than structured assertions. For example, `expect(result).toContain("1")` for the stats test (line 53) would pass even if the output was "10 sessions" or "Event #1" -- it matches any string containing "1".
- **Where:** `lib/query.test.ts:29-64`, every single test in this file
- **Why it matters:** These tests verify almost nothing. The "shows stats" test (line 51-54) asserts that the string contains "1", which would match literally any non-empty output with a digit. The "lists tools with counts" test just checks the string contains "Bash" -- it wouldn't catch a bug where counts were wrong, column ordering changed, or extra/missing rows appeared. You could replace the entire `formatTable` function with `return "1 Bash"` and all tests would pass.
- **Confidence:** High
- **Suggested alternative:** Parse the output or use snapshot testing. At minimum, assert on specific substrings like `"Sessions: 1"` rather than just `"1"`. Better yet, have `runQuery` return structured data (or expose the underlying query functions) and assert on objects. If string output is intentional, use more specific substring matches: `expect(result).toContain("Sessions: 1\n")`.

---

### Finding 5: Date.now() is not controlled in tests, making assertions non-deterministic

- **What:** The `ingest.ts` module calls `Date.now()` directly (lines 12, 46, 49, 57, 77, 86, 94). Tests assert that timestamps are "not null" but cannot verify correctness or ordering because they have no control over the clock.
- **Where:** `lib/ingest.ts:12,46,49,57,77,86,94`; `lib/ingest.test.ts:86` (`expect(session.ended_at).not.toBeNull()`)
- **Why it matters:** If a bug caused all timestamps to be set to 0, or swapped `started_at` and `ended_at`, or used seconds instead of milliseconds, the current tests would not detect it. The `toBeNull`/`not.toBeNull` assertions are necessary but insufficient. In `query.ts`, `parseDuration` feeds `Date.now()` for time-range filtering -- completely untested because the test data timestamps come from uncontrolled `Date.now()` calls.
- **Confidence:** High
- **Suggested alternative:** Use `bun:test`'s `mock` to mock `Date.now` (or inject a clock function), then assert timestamps are within expected ranges. Alternatively, read back the timestamp and assert it's within a small delta of `Date.now()` at test time.

---

### Finding 6: Config tests don't verify the merge behavior edge cases

- **What:** `config.test.ts` tests reading a custom config (line 29-34) but only checks that a single overridden key is correct. It doesn't verify that the merge with `DEFAULT_CONFIG` preserves other default keys. The `getConfig` function on line 39 does `{ ...DEFAULT_CONFIG.contentRules, ...parsed.contentRules }` -- a shallow merge that would silently drop nested object properties if the user partially overrides a key.
- **Where:** `lib/config.test.ts:29-34`, `lib/config.ts:39`
- **Why it matters:** If a user's config has `{ contentRules: { default: { maxLength: 100 } } }`, the test doesn't verify that `Edit: "full"`, `Read: "metadata"`, etc. are still present. More critically, there's no test for malformed config files (invalid JSON, wrong types, missing `contentRules` key, `contentRules` being a string instead of object).
- **Confidence:** Medium
- **Suggested alternative:** Add tests for: (1) partial config preserves defaults for unspecified keys, (2) invalid JSON falls back to defaults, (3) config with wrong types (e.g., `contentRules: "oops"`) doesn't crash, (4) config with unexpected keys is handled gracefully.

---

### Finding 7: No test for the `SubagentStop` event handler

- **What:** The ingest module handles `SubagentStop` events (updating the agent's `ended_at` timestamp), but there is no test covering this path. The test file covers `SessionStart`, `PreToolUse`, `SubagentStart`, `SessionEnd`, `TaskCompleted`, and upsert behavior -- but skips `SubagentStop`, `PostToolUse`, `PostToolUseFailure`, `TeammateIdle`, `UserPromptSubmit`, `Stop`, and the generic handler.
- **Where:** `lib/ingest.ts:83-88` (handleSubagentStop), `lib/ingest.ts:104-112` (handleTeammateIdle), `lib/ingest.ts:114-118` (handleGeneric)
- **Why it matters:** The `handleSubagentStop` function updates agents by `agent_id` -- if the wrong column name is used or the UPDATE condition is wrong, nothing catches it. The `handleTeammateIdle` function updates session team info, which is an important side effect also untested. The `handleGeneric` handler uses destructuring to strip known fields -- if a new field is added to the strip list incorrectly, it would silently lose data.
- **Confidence:** High
- **Suggested alternative:** Add tests for each switch branch in `ingestEvent`. At minimum: `SubagentStop` should verify `agents.ended_at` is set, `TeammateIdle` should verify session team fields get updated, and the generic/default handler should be tested with an unknown event type.

---

### Finding 8: truncate.test.ts metadata test has an implicit coupling to implementation

- **What:** The metadata test (line 13-19) asserts `result.tool_input.content` is `toBeUndefined()`, which tests that the specific key "content" is stripped. However, the production code strips based on `METADATA_STRIP_KEYS` set -- if someone renames a key in that set, or the logic changes from "strip if string" to "strip always", the test wouldn't detect the regression because it only checks one key.
- **Where:** `lib/truncate.test.ts:13-19`, `lib/truncate.ts:3`
- **Why it matters:** Minor. The test does validate the behavior for the "content" key, but the `METADATA_STRIP_KEYS` set has 8 entries (`content, data, output, text, body, result, stdout, stderr`) and only 2 are tested (`content` on input, `data` on response). The rest have zero coverage -- a typo removing "stdout" from the set would go unnoticed.
- **Confidence:** Medium
- **Suggested alternative:** Add a test that exercises multiple strip keys, or parameterize the test across all keys in `METADATA_STRIP_KEYS`. Also test that non-strip keys (like `file_path`) are preserved.

---

### Finding 9: resolve-team.test.ts doesn't test filesystem error handling

- **What:** The `resolveTeamContext` function has a `try/catch` around the filesystem scan (line 38-56) that silently returns null on any error. Tests don't exercise this path.
- **Where:** `lib/resolve-team.ts:38-56`, `lib/resolve-team.test.ts`
- **Why it matters:** If the teams directory exists but contains a file with invalid JSON in `config.json`, the function silently returns null rather than finding subsequent valid teams. This is a design choice that should be tested. Also, if permissions prevent reading a directory, the catch swallows it -- but users would have no idea why team resolution fails. Test coverage of the error path would at least document the expected behavior.
- **Confidence:** Medium
- **Suggested alternative:** Add a test with a malformed `config.json` in one team directory and a valid one in another, verifying that the valid team is still found (or that null is returned -- documenting the actual behavior). Also test with the teams directory pointing to a nonexistent path.

---

### Finding 10: Test database cleanup uses Date.now() in paths, risking collision

- **What:** Multiple test files create database paths using `Date.now()` (e.g., `agent-stalker-test-${Date.now()}.db`). If two test files initialize in the same millisecond (common on fast machines or in parallel runs), they'd share a database path.
- **Where:** `lib/db.test.ts:8`, `lib/ingest.test.ts:9`, `lib/query.test.ts:10`
- **Why it matters:** Low risk today since each file uses a different prefix, but the pattern is fragile. If someone copies a test file or renames it, collisions become likely. The cleanup in `afterEach` with `try { unlinkSync(...) } catch {}` also means cleanup failures are invisible.
- **Confidence:** Low
- **Suggested alternative:** Use `crypto.randomUUID()` or `Bun.randomUUIDv7()` instead of `Date.now()` for test database paths. Or use `mkdtemp` to create unique temporary directories.

## Summary

The test suite covers the core library modules (config, db, truncate, resolve-team, ingest, query) at a basic happy-path level but has significant gaps at system boundaries (hooks/tracker.ts entry point, ui/server.ts API layer) and error paths. The query engine tests use assertions so loose they would pass with almost any output. Approximately 40% of the `ingestEvent` switch branches lack test coverage. The most impactful improvements would be: (1) adding API endpoint tests for the server, (2) tightening query test assertions, and (3) covering the remaining event type handlers in ingest.
