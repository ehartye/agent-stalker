# Testing Strategy Review -- Round 2 (Cross-Pollination)

These are NEW insights that emerge from reading the Adversary, User/Consumer, and Data Integrity perspectives. My Round 1 findings are unchanged.

---

## Reactions and New Insights

### Insight 1: The CORS + no-auth combination (Adversary #1, #12) demands an integration test, not just a code fix

The Adversary perspective identified that `Access-Control-Allow-Origin: *` combined with no authentication allows any webpage to exfiltrate the database. From a testing strategy standpoint, this is the kind of bug that **must have a regression test**, not just a fix. Specifically: a test should make a cross-origin `fetch` to the API and assert the response headers do NOT include `Access-Control-Allow-Origin: *`. Without that test, a future contributor adding CORS back "for convenience" would re-open the vulnerability silently. This reinforces my Round 1 Finding #2 (no server tests) -- the absence of server tests isn't just a coverage gap, it's a security assurance gap.

**Concrete test suggestion:** A server test that starts the Bun server, makes a request with an `Origin: http://evil.com` header, and asserts the response lacks `Access-Control-Allow-Origin: *` (or includes a restricted value).

---

### Insight 2: The missing transaction wrapping (Data Integrity #1) creates an untestable failure mode

Data Integrity identified that multi-statement handlers like `handleSessionStart` and `handleTaskCompleted` lack transaction wrapping. From a testing perspective, this is important because **you cannot write a deterministic test for partial-write corruption without transactions**. If we had transactions, a test could verify rollback behavior (e.g., simulate a failure mid-handler and assert the DB is clean). Without transactions, the only way to test this is to kill the process at the right millisecond, which is inherently flaky. The fix (adding transactions) both resolves the integrity issue AND makes the system testable for these failure modes.

---

### Insight 3: Data Integrity's `tasks` table missing PRIMARY KEY (#2) exposes a gap in my db.test.ts assessment

My Round 1 review noted that db.test.ts checks tables and indexes exist, but I missed that the tests don't verify column constraints (PRIMARY KEY, NOT NULL, FOREIGN KEY). Data Integrity found that `tasks.id` lacks PRIMARY KEY, which `db.test.ts` would never catch because it only checks `sqlite_master` for table names, not their DDL. A more useful db test would query `PRAGMA table_info(tasks)` and assert that `id` has `pk = 1`. This is a concrete testing gap I did not identify in Round 1.

**Concrete test suggestion:** Add schema constraint tests that use `PRAGMA table_info(<table>)` to verify PRIMARY KEY columns, NOT NULL constraints, and column types for each table.

---

### Insight 4: User/Consumer's raw timestamp finding (#1) reveals that query.test.ts isn't testing user-facing output at all

User/Consumer found that timestamps render as raw Unix milliseconds in CLI output. My Round 1 Finding #4 noted the assertions are too loose, but I focused on data correctness (e.g., "contains 1" matching anything). The User/Consumer perspective adds a dimension I missed: even if the assertions were tighter, **the tests don't validate output format at all**. A test that checked `expect(result).toContain("2026-")` would both verify the data AND catch the raw-timestamp usability bug. The query tests are testing "does the code run without crashing" rather than "does the output serve the user."

---

### Insight 5: The `since` parameter semantic inconsistency (User/Consumer #13) exposes a missing parameterized test

User/Consumer found that CLI `--since 1h` uses relative durations while the API `?since=` expects absolute timestamps. From a testing angle, `parseDuration` in `query.ts:17-27` has ZERO test coverage. My Round 1 didn't call this out specifically (I mentioned `Date.now()` control issues), but this is a concrete missing unit test. `parseDuration` handles `m`, `h`, `d` suffixes and returns 0 for unrecognized formats -- there should be a test that covers valid inputs, edge cases (e.g., `"0h"`, `"999d"`), and invalid inputs (e.g., `"1w"`, `"abc"`, `""`, `"1"`).

**Concrete test suggestion:**
```ts
describe("parseDuration", () => {
  it("parses minutes", () => expect(parseDuration("30m")).toBe(30 * 60 * 1000));
  it("parses hours", () => expect(parseDuration("2h")).toBe(2 * 60 * 60 * 1000));
  it("parses days", () => expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000));
  it("returns 0 for unsupported units", () => expect(parseDuration("1w")).toBe(0));
  it("returns 0 for empty string", () => expect(parseDuration("")).toBe(0));
  it("returns 0 for garbage", () => expect(parseDuration("abc")).toBe(0));
});
```

---

### Insight 6: Adversary's path traversal bypass on Windows (#4) should have a targeted test

The Adversary identified that the `resolve()` + `startsWith()` path traversal check in `ui/server.ts` may be bypassable on Windows due to backslash/forward-slash normalization. My Round 1 Finding #2 called out the general absence of server tests, but the Adversary's specific attack vector makes a compelling case for a **platform-specific path traversal test suite**. Given this project explicitly runs on Windows (MINGW64), the test should exercise: `/../../../etc/passwd`, `\..\..\..`, `%2e%2e%2f`, URL-encoded backslashes, and mixed-separator paths. This is a test that must exist *before* any fix is applied, to prove the fix works.

---

### Insight 7: Data Integrity's `handleSessionEnd` missing `ensureSession` (#3) is a gap the existing ingest tests could have caught

Data Integrity found that `handleSessionEnd` doesn't call `ensureSession`, so a `SessionEnd` without a prior `SessionStart` creates orphaned events. Looking at `ingest.test.ts`, the `SessionEnd` test (line 74-87) always sends a `SessionStart` first. This is a case where the **test setup hides the bug** -- the test always creates the prerequisite state, so it never exercises the error path. This validates my Round 1 methodology (checking whether tests actually test what they claim) but is a specific instance I missed. A test that sends `SessionEnd` without `SessionStart` first would immediately expose this.

**Concrete test suggestion:**
```ts
it("handles SessionEnd without prior SessionStart", () => {
  ingestEvent({
    hook_event_name: "SessionEnd",
    session_id: "sess-orphan",
    reason: "other",
    cwd: "/tmp",
    permission_mode: "default",
  });
  const db = getDb();
  const session = db.query("SELECT * FROM sessions WHERE id = 'sess-orphan'").get();
  // Should either create the session (ensureSession) or reject the event
  // Currently: session is null, but an orphaned event exists
});
```

---

### Insight 8: The `UserPromptSubmit` synchronous hook (Adversary #10) cannot be tested within the current test architecture

The Adversary found that `UserPromptSubmit` is the only non-async hook, which blocks the user. From a testing perspective, there is no test that validates hook configuration correctness. The `hooks.json` file is static configuration with no test coverage -- nobody verifies that all hooks have `async: true` when they should. This is a category of "configuration testing" that the test suite completely omits. A simple test could parse `hooks.json`, iterate all hooks, and assert specific properties (e.g., all hooks should have `async: true`, or at least document why one doesn't).

**Concrete test suggestion:**
```ts
import hooks from "../hooks/hooks.json";
describe("hooks.json", () => {
  it("all hooks are async", () => {
    for (const [name, matchers] of Object.entries(hooks.hooks)) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          expect(hook.async).toBe(true);
          // or: if not async, it should be explicitly documented why
        }
      }
    }
  });
});
```

---

### Insight 9: Adversary's unbounded `limit` parameter (Adversary #7) + Data Integrity's unbounded `data` column (#9) compound into an untested DoS vector

The Adversary noted that `limit=999999999` dumps the entire table, and Data Integrity noted that `data` column has no size limit (especially via `handleGeneric`). Together: a few large `handleGeneric` events followed by a `?limit=999999999` API call could force the server to serialize gigabytes of JSON, crashing the process or exhausting memory. The test suite has no performance or resource-limit tests. While performance testing is often out-of-scope for unit tests, a simple boundary test -- insert 1000 events with 10KB data each, then query with limit=10 and verify the response is bounded -- would protect against the most obvious regression.

---

## Summary

The other perspectives surfaced several bugs and design issues that the current test suite is structurally incapable of catching: security regressions (CORS, path traversal), configuration correctness (hooks.json async flag), data integrity under partial failure (no transactions), and output format usability (raw timestamps). The strongest cross-cutting theme is that **test setup routinely hides bugs by always providing the happy-path prerequisites** (SessionStart before SessionEnd, valid event payloads, sequential execution). The most impactful new testing additions would be: (1) negative/adversarial test cases that omit expected prerequisites, (2) a server integration test layer with security assertions, and (3) configuration validation tests for hooks.json.
