# Security Hardening Implementation Plan (Review Batch A)

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Localhost-by-default server binding with config opt-in to LAN, CORS wildcard removed with a Host-header guard, Edit/Write capture defaulting to metadata, clamped API parameters, and a clear port-conflict message.

**Architecture:** All changes live in `lib/config.ts` (new `ui` config section, capture defaults) and `ui/server.ts` (three new pure exported functions — `resolveHost`, `isAllowedHost`, `clampInt` — wired into the existing `Bun.serve` block and `handleApi`). No new files except doc edits. Spec: `docs/superpowers/specs/2026-06-10-security-hardening-design.md`.

**Tech Stack:** Bun, TypeScript, bun:test. Run tests with `bun test <file>` from the repo root.

**Codebase notes for the implementer:**
- `ui/server.ts` exports `handleApiForTest(url, method)` so tests can hit the API router without starting a server. Use it for integration assertions.
- `lib/config.test.ts` sets `process.env.AGENT_STALKER_CONFIG_PATH` to a temp file per test — follow that pattern.
- The server reads config/argv at module top-level inside `if (import.meta.main)`; pure helpers must be exported at module level so tests can import them without starting the server.

---

### Task 1: `ui` config section (host + allowedHosts)

**Files:**
- Modify: `lib/config.ts`
- Test: `lib/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the `describe("config", ...)` block in `lib/config.test.ts`:

```ts
  it("defaults ui to host 127.0.0.1 with no allowedHosts", () => {
    const config = getConfig();
    expect(config.ui).toEqual({ host: "127.0.0.1", allowedHosts: [] });
  });

  it("merges a partial ui section over defaults", () => {
    writeFileSync(testConfigPath, JSON.stringify({ ui: { host: "0.0.0.0" } }));
    const config = getConfig();
    expect(config.ui.host).toBe("0.0.0.0");
    expect(config.ui.allowedHosts).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/config.test.ts`
Expected: 2 failures — `config.ui` is `undefined` (TypeScript may also error; that counts as the red state).

- [ ] **Step 3: Implement**

In `lib/config.ts`, add the `UiConfig` interface and extend `StalkerConfig` (after the `ContentRule` type):

```ts
export interface UiConfig {
  host: string;
  allowedHosts: string[];
}

export interface StalkerConfig {
  contentRules: Record<string, ContentRule>;
  pausedPaths: string[];
  ui: UiConfig;
}
```

Add `ui` to `DEFAULT_CONFIG`:

```ts
export const DEFAULT_CONFIG: StalkerConfig = {
  contentRules: {
    Edit: "full",
    Write: "full",
    Read: "metadata",
    Glob: "metadata",
    Grep: "metadata",
    Bash: { maxLength: 2000 },
    default: { maxLength: 500 },
  },
  pausedPaths: [],
  ui: { host: "127.0.0.1", allowedHosts: [] },
};
```

(The `Edit`/`Write` values change in Task 2 — leave them as `"full"` here.)

In `getConfig()`, merge the `ui` section in the success branch:

```ts
    return {
      contentRules: { ...DEFAULT_CONFIG.contentRules, ...parsed.contentRules },
      pausedPaths: parsed.pausedPaths ?? [],
      ui: { ...DEFAULT_CONFIG.ui, ...parsed.ui },
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/config.test.ts`
Expected: all pass (the pre-existing `toEqual(DEFAULT_CONFIG)` test still passes because the missing-file branch returns `DEFAULT_CONFIG` directly).

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts lib/config.test.ts
git commit -m "feat(config): add ui section with host and allowedHosts defaults"
```

---

### Task 2: Flip Edit/Write capture defaults to metadata

**Files:**
- Modify: `lib/config.ts:13-14`
- Test: `lib/config.test.ts` (one existing test changes expectation)

- [ ] **Step 1: Update the existing test and add a new one**

In `lib/config.test.ts`, the test `"returns correct content rule for known tool"` currently expects `"full"` for Edit. Change it and add a Write assertion:

```ts
  it("returns correct content rule for known tool", () => {
    const rule = getContentRule("Edit");
    expect(rule).toBe("metadata");
  });

  it("defaults Write capture to metadata", () => {
    const rule = getContentRule("Write");
    expect(rule).toBe("metadata");
  });
```

- [ ] **Step 2: Run tests to verify the new expectations fail**

Run: `bun test lib/config.test.ts`
Expected: 2 failures — both still return `"full"`.

- [ ] **Step 3: Implement**

In `lib/config.ts` `DEFAULT_CONFIG.contentRules`, change:

```ts
    Edit: "metadata",
    Write: "metadata",
```

- [ ] **Step 4: Run the full suite to catch any other default-dependent tests**

Run: `bun test`
Expected: all pass. (`lib/truncate.test.ts` passes rules explicitly and is unaffected. If anything else fails on the new default, fix the test's expectation — the new default is intentional.)

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts lib/config.test.ts
git commit -m "feat(config): default Edit/Write capture to metadata

Full file contents are no longer stored by default. Opt back in with
/stalker-config set Edit full (and/or Write)."
```

---

### Task 3: `clampInt` and bounded API parameters

**Files:**
- Modify: `ui/server.ts:29-30,87-99,104`
- Test: `ui/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the end of `ui/server.test.ts` (outside the existing `describe("server API")` — these are pure-function tests needing no DB):

```ts
describe("clampInt", () => {
  it("clamps above max", async () => {
    const { clampInt } = await import("./server");
    expect(clampInt("99999", 50, 1, 1000)).toBe(1000);
  });

  it("clamps below min", async () => {
    const { clampInt } = await import("./server");
    expect(clampInt("-5", 0, 0, Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("returns default for non-numeric", async () => {
    const { clampInt } = await import("./server");
    expect(clampInt("abc", 50, 1, 1000)).toBe(50);
  });

  it("returns default for null", async () => {
    const { clampInt } = await import("./server");
    expect(clampInt(null, 200, 1, 1000)).toBe(200);
  });
});
```

And inside the existing `describe("server API")` block (it has the seeded DB), add an integration test proving garbage params can't reach SQL:

```ts
  it("GET /api/events with garbage limit/offset/since still returns 200", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/events?limit=abc&offset=-3&since=zzz"), "GET");
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ui/server.test.ts`
Expected: the `clampInt` tests fail with "clampInt is not a function" (not exported yet).

- [ ] **Step 3: Implement `clampInt` and apply it at every parse site**

In `ui/server.ts`, add below the `jsonResponse` function:

```ts
export function clampInt(raw: string | null, def: number, min: number, max: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
```

Apply it at each parse site:

`/api/sessions` (lines 29-30), replace:

```ts
    const limit = clampInt(params.get("limit"), 50, 1, 1000);
    const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
```

`/api/events` (lines 87-99), replace the `since`/`limit`/`offset` handling:

```ts
    const since = params.get("since");
    const sinceTs = since === null ? null : clampInt(since, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(params.get("limit"), 200, 1, 1000);
    const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

    let query = "SELECT * FROM events WHERE 1=1";
    const qParams: any[] = [];
    if (sessionId) { query += " AND session_id = ?"; qParams.push(sessionId); }
    if (toolName) { query += " AND tool_name = ?"; qParams.push(toolName); }
    if (agentId) { query += " AND agent_id = ?"; qParams.push(agentId); }
    if (sinceTs !== null) { query += " AND timestamp > ?"; qParams.push(sinceTs); }
    const order = sinceTs !== null ? "ASC" : "DESC";
    query += ` ORDER BY timestamp ${order} LIMIT ? OFFSET ?`;
    qParams.push(limit, offset);
```

`/api/events/:id` (line 104), replace the bare `parseInt` so NaN never binds into SQL (event ids are autoincrement starting at 1, so a default of 0 yields the existing 404 behavior):

```ts
    const id = clampInt(path.split("/api/events/")[1], 0, 0, Number.MAX_SAFE_INTEGER);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ui/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/server.ts ui/server.test.ts
git commit -m "fix(server): clamp limit/offset/since query params (max limit 1000)"
```

---

### Task 4: Remove CORS wildcard, add Host-header guard

**Files:**
- Modify: `ui/server.ts:14-19` (jsonResponse), `ui/server.ts:326-341` (fetch handler)
- Test: `ui/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe("server API")` block:

```ts
  it("API responses carry no CORS header", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/stats"), "GET");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
```

Add a new top-level `describe` block (pure function, no DB):

```ts
describe("isAllowedHost", () => {
  const cases: Array<[string | null, string[], boolean]> = [
    ["localhost:3141", [], true],
    ["localhost", [], true],
    ["127.0.0.1:3141", [], true],
    ["[::1]:3141", [], true],
    ["192.168.1.50:3141", [], true],
    ["evil.example:3141", [], false],
    ["office-pc:3141", [], false],
    ["office-pc:3141", ["office-pc"], true],
    [null, [], false],
  ];
  for (const [host, allowed, expected] of cases) {
    it(`${host} with allowedHosts=${JSON.stringify(allowed)} -> ${expected}`, async () => {
      const { isAllowedHost } = await import("./server");
      expect(isAllowedHost(host, allowed)).toBe(expected);
    });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ui/server.test.ts`
Expected: CORS test fails (header is `*`), `isAllowedHost` tests fail (not exported).

- [ ] **Step 3: Implement**

In `ui/server.ts`, remove the CORS header from `jsonResponse`:

```ts
function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

Add the guard predicate below `clampInt`:

```ts
/**
 * DNS-rebinding guard: only serve requests whose Host header is localhost,
 * an IP literal, or an explicitly allowlisted name (config ui.allowedHosts).
 * A rebinding attack must use a DNS name, which this rejects.
 */
export function isAllowedHost(hostHeader: string | null, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;
  // Strip the port: "[::1]:3141" -> "[::1]", "host:3141" -> "host"
  let host = hostHeader;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return false;
    host = host.slice(0, end + 1);
  } else {
    const colon = host.indexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  if (host === "localhost") return true;
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  if (allowedHosts.includes(host) || allowedHosts.includes(bare)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4 literal
  if (host.startsWith("[") && bare.includes(":")) return true; // IPv6 literal
  return false;
}
```

Wire it into the `fetch` handler inside `if (import.meta.main)` — first lines of `fetch(req)`, before any routing:

```ts
    async fetch(req) {
      if (!isAllowedHost(req.headers.get("host"), config.ui.allowedHosts)) {
        return jsonResponse({ error: "Host not allowed. Add it to ui.allowedHosts in agent-stalker.config.json." }, 403);
      }
      const url = new URL(req.url);
```

This requires `config` in scope — Task 5 introduces it; for this task, add at the top of the `if (import.meta.main)` block:

```ts
  const config = getConfig();
```

and add the import at the top of the file:

```ts
import { getConfig } from "../lib/config";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ui/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/server.ts ui/server.test.ts
git commit -m "fix(server): remove CORS wildcard, reject non-allowlisted Host headers

Dashboard requests are same-origin (localhost or LAN IP), so no CORS
header is needed. The Host guard blocks DNS-rebinding; named hosts can
be allowlisted via ui.allowedHosts."
```

---

### Task 5: Bind host resolution + port-conflict message

**Files:**
- Modify: `ui/server.ts:12` (port parse area), `ui/server.ts:319-364` (`import.meta.main` block)
- Test: `ui/server.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a top-level `describe` block in `ui/server.test.ts`:

```ts
describe("resolveHost", () => {
  const baseConfig = {
    contentRules: {},
    pausedPaths: [],
    ui: { host: "0.0.0.0", allowedHosts: [] },
  } as any;

  it("--host flag beats config", async () => {
    const { resolveHost } = await import("./server");
    expect(resolveHost(["bun", "server.ts", "--host", "10.0.0.5"], baseConfig)).toBe("10.0.0.5");
  });

  it("config ui.host beats default", async () => {
    const { resolveHost } = await import("./server");
    expect(resolveHost(["bun", "server.ts"], baseConfig)).toBe("0.0.0.0");
  });

  it("falls back to 127.0.0.1", async () => {
    const { resolveHost } = await import("./server");
    const cfg = { ...baseConfig, ui: undefined };
    expect(resolveHost(["bun", "server.ts"], cfg)).toBe("127.0.0.1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ui/server.test.ts`
Expected: `resolveHost` tests fail (not exported).

- [ ] **Step 3: Implement**

In `ui/server.ts`, add below `isAllowedHost` (import `StalkerConfig` as a type from `../lib/config`):

```ts
export function resolveHost(argv: string[], config: StalkerConfig): string {
  const flag = argv.find((_, i, a) => a[i - 1] === "--host");
  return flag ?? config.ui?.host ?? "127.0.0.1";
}
```

Update the import added in Task 4:

```ts
import { getConfig, type StalkerConfig } from "../lib/config";
```

Rework the `if (import.meta.main)` block: resolve the hostname, pass it to `Bun.serve`, and wrap the call for `EADDRINUSE`. The `fetch` body stays exactly as it is after Task 4 — only the surrounding structure changes:

```ts
if (import.meta.main) {
  const config = getConfig();
  const hostname = resolveHost(process.argv, config);

  let server;
  try {
    server = Bun.serve({
      port,
      hostname,
      // The semantic /run route awaits a Python dependency check that imports
      // heavy ML modules (can take >10s cold). Raise the default 10s idleTimeout
      // so the POST response isn't cut off before runSemanticBatch resolves.
      idleTimeout: 30,
      async fetch(req) {
        // ... unchanged fetch body from Task 4 ...
      },
    });
  } catch (e: any) {
    if (e?.code === "EADDRINUSE" || /in use/i.test(String(e?.message))) {
      console.error(`Port ${port} already in use — is another stalker UI running? (use --port to change)`);
      process.exit(1);
    }
    throw e;
  }

  console.log(`agent-stalker UI running at http://localhost:${server.port}`);

  process.on("SIGINT", () => {
    closeDb();
    process.exit(0);
  });
}
```

- [ ] **Step 4: Run tests, then verify the two behaviors manually**

Run: `bun test ui/server.test.ts`
Expected: PASS.

Manual check 1 — localhost binding (PowerShell):

```powershell
Start-Process bun -ArgumentList "ui/server.ts","--port","3997" -WindowStyle Hidden; Start-Sleep 1
(Invoke-WebRequest http://127.0.0.1:3997/api/stats -UseBasicParsing).StatusCode   # expect 200
Get-NetTCPConnection -LocalPort 3997 -State Listen | Select-Object LocalAddress  # expect 127.0.0.1
```

Manual check 2 — Host guard wiring returns 403 (the guard lives in the live `fetch` handler, which `handleApiForTest` bypasses — this is the spec's "disallowed Host → 403" check):

```powershell
(Invoke-WebRequest http://127.0.0.1:3997/api/stats -Headers @{Host="evil.example"} -UseBasicParsing -SkipHttpErrorCheck).StatusCode   # expect 403
```

Manual check 3 — port conflict: with the first server still running, run `bun ui/server.ts --port 3997` in the foreground. Expected output: `Port 3997 already in use — is another stalker UI running? (use --port to change)`, exit code 1.

Then stop the test server:

```powershell
Get-NetTCPConnection -LocalPort 3997 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

- [ ] **Step 5: Commit**

```bash
git add ui/server.ts ui/server.test.ts
git commit -m "feat(server): bind 127.0.0.1 by default with ui.host/--host opt-in; clear port-conflict error"
```

---

### Task 6: Documentation updates + full verification

**Files:**
- Modify: `README.md:135-141` (capture defaults table area)
- Modify: `skills/stalker-config/SKILL.md` (config shape + defaults)
- Modify: `skills/stalker-ui/SKILL.md` (LAN note)

- [ ] **Step 1: Update README**

In `README.md`, change the capture-defaults table rows (currently `| Edit, Write | full |`):

```markdown
Default capture rules:
| Tool | Rule |
|------|------|
| Edit, Write | metadata |
| Read, Glob, Grep | metadata |
| Bash | maxLength 2000 |
| Everything else | maxLength 500 |

> **What is captured:** events are stored in plaintext SQLite at
> `~/.claude/agent-stalker.db`. By default file contents are **not** stored
> (metadata only); opt into full capture per-tool with
> `/stalker-config set Edit full`. The dashboard binds `127.0.0.1` — to view
> it from another machine, set `"ui": { "host": "0.0.0.0" }` in
> `~/.claude/agent-stalker.config.json`.
```

- [ ] **Step 2: Update skills/stalker-config/SKILL.md**

In the config-shape code block, extend the example JSON to show the `ui` section:

```json
{
  "contentRules": { "Bash": { "maxLength": 2000 }, "Read": "metadata", "Edit": "full" },
  "pausedPaths": ["/abs/path/to/project"],
  "ui": { "host": "127.0.0.1", "allowedHosts": [] }
}
```

After that code block's explanatory line about `contentRules` values, add:

```markdown
The `ui` section controls the dashboard server: `host` is the bind address
(default `127.0.0.1`; set `0.0.0.0` to allow LAN access) and `allowedHosts`
lists extra hostnames the dashboard may be browsed at (e.g. `["office-pc"]`
for `http://office-pc:3141` — IPs and `localhost` always work).

Note: the default capture rule for `Edit` and `Write` is now `metadata`
(file contents not stored). `set Edit full` restores full capture.
```

- [ ] **Step 3: Update skills/stalker-ui/SKILL.md**

In the `## Notes` section, add:

```markdown
- The server binds `127.0.0.1` by default. For LAN access (e.g. viewing from
  another machine), set `"ui": { "host": "0.0.0.0" }` in
  `~/.claude/agent-stalker.config.json`, or pass `--host 0.0.0.0`. If browsing
  by machine name rather than IP, also add the name to `ui.allowedHosts`.
- If the port is already in use, the server prints a clear error and exits —
  suggest `--port <number>` to the user.
```

- [ ] **Step 4: Run the full suite**

Run: `bun test`
Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add README.md skills/stalker-config/SKILL.md skills/stalker-ui/SKILL.md
git commit -m "docs: capture defaults, LAN opt-in, and what-is-captured notes"
```
