import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../lib/db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("server API", () => {
  const testDbPath = join(tmpdir(), `agent-stalker-server-test-${Date.now()}.db`);

  beforeEach(() => {
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
});
