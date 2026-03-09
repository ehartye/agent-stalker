import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "./db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("db", () => {
  const testDbPath = join(tmpdir(), `agent-stalker-test-${Date.now()}.db`);

  beforeEach(() => {
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
  });

  afterEach(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
    try { unlinkSync(testDbPath + "-wal"); } catch {}
    try { unlinkSync(testDbPath + "-shm"); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("creates all tables on first connection", () => {
    const db = getDb();
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("sessions");
    expect(names).toContain("events");
    expect(names).toContain("agents");
    expect(names).toContain("tasks");
    expect(names).toContain("schema_version");
  });

  it("uses WAL mode", () => {
    const db = getDb();
    const result = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
  });

  it("creates indexes on events table", () => {
    const db = getDb();
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_events_session_id");
    expect(names).toContain("idx_events_hook_event_name");
    expect(names).toContain("idx_events_tool_name");
    expect(names).toContain("idx_events_agent_id");
    expect(names).toContain("idx_events_timestamp");
  });

  it("is idempotent on repeated calls", () => {
    const db1 = getDb();
    closeDb();
    const db2 = getDb();
    const tables = db2.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
  });
});
