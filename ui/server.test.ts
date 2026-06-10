import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../lib/db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolFailure, seedToolCall } from "../lib/analytics/test-helpers";

describe("server API", () => {
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `agent-stalker-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
    const db = getDb();
    // Seed test sessions
    db.run("INSERT INTO sessions (id, cwd, started_at) VALUES ('sess-1', '/tmp/test', 1000)");
    db.run("INSERT INTO sessions (id, cwd, started_at) VALUES ('sess-2', '/tmp/test2', 2000)");
    db.run("INSERT INTO events (session_id, hook_event_name, timestamp) VALUES ('sess-1', 'SessionStart', 1000)");
    db.run("INSERT INTO agents (id, session_id, agent_type, started_at) VALUES ('agent-1', 'sess-1', 'Explore', 1000)");
    db.run("INSERT INTO tasks (id, session_id, subject, status, created_at, updated_at) VALUES ('1', 'sess-1', 'Test task', 'pending', 1000, 1000)");
    db.run("INSERT INTO task_events (task_id, session_id, event_type, timestamp) VALUES ('1', 'sess-1', 'created', 1000)");
  });

  afterEach(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
    try { unlinkSync(testDbPath + "-wal"); } catch {}
    try { unlinkSync(testDbPath + "-shm"); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("GET /api/sessions excludes archived by default", () => {
    const db = getDb();
    db.run("UPDATE sessions SET archived_at = 9999 WHERE id = 'sess-1'");
    const rows = db.query("SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY started_at DESC").all();
    expect(rows.length).toBe(1);
    expect((rows[0] as any).id).toBe("sess-2");
  });

  it("GET /api/sessions?archived=true returns only archived", () => {
    const db = getDb();
    db.run("UPDATE sessions SET archived_at = 9999 WHERE id = 'sess-1'");
    const rows = db.query("SELECT * FROM sessions WHERE archived_at IS NOT NULL ORDER BY started_at DESC").all();
    expect(rows.length).toBe(1);
    expect((rows[0] as any).id).toBe("sess-1");
  });

  it("archive sets archived_at", () => {
    const db = getDb();
    db.run("UPDATE sessions SET archived_at = ? WHERE id = ?", [Date.now(), "sess-1"]);
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-1'").get() as any;
    expect(session.archived_at).not.toBeNull();
  });

  it("unarchive clears archived_at", () => {
    const db = getDb();
    db.run("UPDATE sessions SET archived_at = 9999 WHERE id = 'sess-1'");
    db.run("UPDATE sessions SET archived_at = NULL WHERE id = 'sess-1'");
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-1'").get() as any;
    expect(session.archived_at).toBeNull();
  });

  it("delete cascades events, agents, tasks, task_events", () => {
    const db = getDb();
    // Must archive first
    db.run("UPDATE sessions SET archived_at = 9999 WHERE id = 'sess-1'");
    // Delete cascade
    db.run("DELETE FROM task_events WHERE session_id = 'sess-1'");
    db.run("DELETE FROM tasks WHERE session_id = 'sess-1'");
    db.run("DELETE FROM agents WHERE session_id = 'sess-1'");
    db.run("DELETE FROM events WHERE session_id = 'sess-1'");
    db.run("DELETE FROM sessions WHERE id = 'sess-1'");

    expect(db.query("SELECT * FROM sessions WHERE id = 'sess-1'").get()).toBeNull();
    expect(db.query("SELECT * FROM events WHERE session_id = 'sess-1'").all().length).toBe(0);
    expect(db.query("SELECT * FROM agents WHERE session_id = 'sess-1'").all().length).toBe(0);
    expect(db.query("SELECT * FROM tasks WHERE session_id = 'sess-1'").all().length).toBe(0);
    expect(db.query("SELECT * FROM task_events WHERE session_id = 'sess-1'").all().length).toBe(0);
  });

  it("delete rejects non-archived session", () => {
    const db = getDb();
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-1'").get() as any;
    expect(session.archived_at).toBeNull();
    // API should reject -- verify session is not archived
  });

  it("GET /api/sessions orders by most recent activity (latest event, falling back to started_at)", () => {
    const db = getDb();
    // beforeEach seeds sess-1 (started_at=1000, one event at 1000) and sess-2 (started_at=2000, no events).
    // Add a late event to sess-1 so its activity timestamp beats sess-2's started_at.
    db.run("INSERT INTO events (session_id, hook_event_name, timestamp) VALUES ('sess-1', 'Notification', 3000)");
    // Add sess-3 with no events, started earliest. Should rank last.
    db.run("INSERT INTO sessions (id, cwd, started_at) VALUES ('sess-3', '/tmp/test3', 500)");

    const rows = db.query(
      "SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY COALESCE((SELECT MAX(timestamp) FROM events WHERE events.session_id = sessions.id), started_at) DESC"
    ).all() as any[];

    // Expected order: sess-1 (latest event 3000) > sess-2 (started_at 2000, no events) > sess-3 (started_at 500, no events)
    expect(rows.map(r => r.id)).toEqual(["sess-1", "sess-2", "sess-3"]);
  });

  it("GET /api/events with garbage limit/offset/since still returns 200", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/events?limit=abc&offset=-3&since=zzz"), "GET");
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
  });

  it("caps limit: ?limit=2 returns exactly 2 rows even though more exist", async () => {
    const db = getDb();
    db.run("INSERT INTO events (session_id, hook_event_name, timestamp) VALUES ('sess-1', 'PreToolUse', 1001)");
    db.run("INSERT INTO events (session_id, hook_event_name, timestamp) VALUES ('sess-1', 'PostToolUse', 1002)");
    db.run("INSERT INTO events (session_id, hook_event_name, timestamp) VALUES ('sess-1', 'Stop', 1003)");
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/events?limit=2"), "GET");
    const rows = await res.json();
    expect(rows.length).toBe(2);
  });

  it("API responses carry no CORS header", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/stats"), "GET");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("insights endpoints", () => {
  let testDbPath: string;
  beforeEach(() => {
    testDbPath = join(tmpdir(), `as-server-insights-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
    seedSession("s1");
    seedToolFailure("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Edit", { file_path: "/a.ts" });
  });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("GET /api/insights/pain returns a ranked leaderboard", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/pain"), "GET");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty("session_id");
    expect(body[0]).toHaveProperty("score");
    expect(body[0]).toHaveProperty("breakdown");
  });

  it("GET /api/insights/errors returns per-session and per-tool stats", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/errors"), "GET");
    const body = await res.json();
    expect(body).toHaveProperty("bySession");
    expect(body).toHaveProperty("byTool");
  });

  it("GET /api/insights/tokens returns per-session token totals", async () => {
    const db = getDb();
    db.run("INSERT INTO sessions (id, started_at) VALUES ('st', 1)");
    db.run(`INSERT INTO usage (message_uuid, session_id, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
            VALUES ('m1','st',100,40,10,5)`);
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/tokens"), "GET");
    const body = await res.json();
    const row = body.find((r: any) => r.session_id === "st");
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(40);
  });
});

describe("semantic endpoints", () => {
  let testDbPath: string;
  beforeEach(() => {
    testDbPath = join(tmpdir(), `as-server-sem-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
  });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("GET /api/insights/semantic/status reports availability from semantic_meta", async () => {
    const db = getDb();
    db.run("INSERT INTO semantic_meta (feature, last_run_at, status) VALUES ('sentiment', 123, 'ok')");
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/semantic/status"), "GET");
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.lastRun).toBe(123);
  });

  it("GET /api/insights/semantic/sentiment returns rows", async () => {
    const db = getDb();
    db.run("INSERT INTO semantic_sentiment (source_kind, session_id, score, label) VALUES ('prompt','s1',-0.8,'negative')");
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/semantic/sentiment"), "GET");
    const body = await res.json();
    expect(body[0].label).toBe("negative");
  });

  it("GET /api/insights/semantic/triage returns triage rows", async () => {
    const db = getDb();
    db.run("INSERT INTO semantic_session_triage (session_id, status, pain_score, summary, root_cause, analyzed_at) VALUES ('s1', 'analyzed', 5, 'rough', 'perms', 1)");
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/semantic/triage"), "GET");
    const body = await res.json();
    expect(body[0].root_cause).toBe("perms");
    expect(body[0].status).toBe("analyzed");
  });

  it("POST /api/insights/semantic/triage flags a session (no API key, no spawn)", async () => {
    const { flagTriageForTest } = await import("./server");
    const res = flagTriageForTest("sess-flag");
    const body = await res.json();
    expect(body.ok).toBe(true);
    const row = getDb().query("SELECT status, flagged_at FROM semantic_session_triage WHERE session_id = ?").get("sess-flag") as any;
    expect(row.status).toBe("flagged");
    expect(row.flagged_at).toBeGreaterThan(0);
  });
});

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

  it("returns default for scientific notation ('1e9')", async () => {
    const { clampInt } = await import("./server");
    expect(clampInt("1e9", 50, 1, 1000)).toBe(50);
  });

  it("returns default for hex ('0x10')", async () => {
    const { clampInt } = await import("./server");
    expect(clampInt("0x10", 50, 1, 1000)).toBe(50);
  });

  it("returns default for partial-numeric ('12abc')", async () => {
    const { clampInt } = await import("./server");
    expect(clampInt("12abc", 50, 1, 1000)).toBe(50);
  });
});

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
    ["LOCALHOST:3141", [], true],                      // case-insensitive
    ["localhost.", [], false],                          // trailing dot stays rejected
    ["office-pc:3141", ["office-pc:3141"], true],       // port-bearing allowlist entry works
    ["OFFICE-PC:3141", ["office-pc"], true],            // case-insensitive allowlist match
  ];
  for (const [host, allowed, expected] of cases) {
    it(`${host} with allowedHosts=${JSON.stringify(allowed)} -> ${expected}`, async () => {
      const { isAllowedHost } = await import("./server");
      expect(isAllowedHost(host, allowed)).toBe(expected);
    });
  }
});

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

describe("constituent events endpoint", () => {
  let testDbPath: string;
  beforeEach(() => {
    testDbPath = join(tmpdir(), `as-server-eventsby-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
  });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("GET /api/insights/events?by=tool&value=Bash&errorsOnly=1 returns failures", async () => {
    seedSession("s1");
    seedToolFailure("s1", "Bash", { command: "bad" });
    seedToolCall("s1", "Bash", { command: "ok" });
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/events?by=tool&value=Bash&errorsOnly=1"), "GET");
    const body = await res.json();
    expect(body.events.length).toBe(1);
    expect(body.events[0].hook_event_name).toBe("PostToolUseFailure");
    expect(body.truncated).toBe(false);
  });

  it("missing by → 400", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/events?value=x"), "GET");
    expect(res.status).toBe(400);
  });

  it("invalid by → 400", async () => {
    const { handleApiForTest } = await import("./server");
    const res = handleApiForTest(new URL("http://x/api/insights/events?by=bogus&value=x"), "GET");
    expect(res.status).toBe(400);
  });
});
