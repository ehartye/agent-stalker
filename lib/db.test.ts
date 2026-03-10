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

  describe("v2 migration", () => {
    it("creates task_events table", () => {
      const db = getDb();
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain("task_events");
    });

    it("tasks table has status, owner, blocks, blocked_by, created_at, updated_at columns", () => {
      const db = getDb();
      const cols = db.query("PRAGMA table_info(tasks)").all() as { name: string }[];
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("status");
      expect(colNames).toContain("owner");
      expect(colNames).toContain("blocks");
      expect(colNames).toContain("blocked_by");
      expect(colNames).toContain("created_at");
      expect(colNames).toContain("updated_at");
    });

    it("tasks table has PRIMARY KEY on id", () => {
      const db = getDb();
      const cols = db.query("PRAGMA table_info(tasks)").all() as { name: string; pk: number }[];
      const pkCol = cols.find((c) => c.pk === 1);
      expect(pkCol).toBeDefined();
      expect(pkCol!.name).toBe("id");
    });

    it("task_events has correct columns", () => {
      const db = getDb();
      const cols = db.query("PRAGMA table_info(task_events)").all() as { name: string }[];
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("id");
      expect(colNames).toContain("task_id");
      expect(colNames).toContain("session_id");
      expect(colNames).toContain("event_type");
      expect(colNames).toContain("field_name");
      expect(colNames).toContain("old_value");
      expect(colNames).toContain("new_value");
      expect(colNames).toContain("timestamp");
    });

    it("task_events indexes exist", () => {
      const db = getDb();
      const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_events'").all() as { name: string }[];
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_task_events_task_id");
      expect(names).toContain("idx_task_events_timestamp");
    });

    it("schema_version is at least 2", () => {
      const db = getDb();
      const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
      expect(row.version).toBeGreaterThanOrEqual(2);
    });

  });

  describe("v3 migration", () => {
    it("sessions table has archived_at column", () => {
      const db = getDb();
      const cols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("archived_at");
    });

    it("schema_version is at least 3", () => {
      const db = getDb();
      const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
      expect(row.version).toBeGreaterThanOrEqual(3);
    });

    it("archived_at index exists", () => {
      const db = getDb();
      const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'").all() as { name: string }[];
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_sessions_archived_at");
    });
  });

  describe("v4 migration", () => {
    it("agents table has color column", () => {
      const db = getDb();
      const cols = db.query("PRAGMA table_info(agents)").all() as { name: string }[];
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("color");
    });

    it("schema_version is 5", () => {
      const db = getDb();
      const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
      expect(row.version).toBe(5);
    });
  });

  describe("v2 migration - data migration", () => {
    it("migrates existing v1 tasks data", () => {
      // Manually create a v1-only database, insert data, then run migration
      const { Database } = require("bun:sqlite");
      const migrationDbPath = join(tmpdir(), `agent-stalker-migrate-${Date.now()}.db`);
      const rawDb = new Database(migrationDbPath);
      try {
        rawDb.run("PRAGMA journal_mode = WAL");
        // Create v1 schema manually
        rawDb.run("CREATE TABLE schema_version (version INTEGER NOT NULL)");
        rawDb.run("INSERT INTO schema_version (version) VALUES (1)");
        rawDb.run(`CREATE TABLE sessions (
          id TEXT PRIMARY KEY, cwd TEXT, permission_mode TEXT, model TEXT,
          agent_type TEXT, team_name TEXT, teammate_name TEXT,
          started_at INTEGER, ended_at INTEGER, end_reason TEXT
        )`);
        rawDb.run(`CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
          hook_event_name TEXT, agent_id TEXT, agent_type TEXT,
          team_name TEXT, teammate_name TEXT, timestamp INTEGER,
          tool_name TEXT, tool_use_id TEXT, data TEXT
        )`);
        rawDb.run(`CREATE TABLE agents (
          id TEXT PRIMARY KEY, session_id TEXT, agent_type TEXT,
          transcript_path TEXT, started_at INTEGER, ended_at INTEGER
        )`);
        rawDb.run(`CREATE TABLE tasks (
          id TEXT, session_id TEXT, subject TEXT, description TEXT,
          teammate_name TEXT, team_name TEXT, completed_at INTEGER
        )`);
        // Insert a v1 task row
        rawDb.run(`INSERT INTO tasks (id, session_id, subject, description, teammate_name, team_name, completed_at)
          VALUES ('task-1', 'sess-1', 'Test task', 'A description', 'alice', 'team-a', 1700000000)`);
        rawDb.close();

        // Now open via getDb to trigger migration
        process.env.AGENT_STALKER_DB_PATH = migrationDbPath;
        closeDb(); // reset singleton
        const db = getDb();

        // Verify migrated data
        const task = db.query("SELECT * FROM tasks WHERE id = 'task-1'").get() as any;
        expect(task).toBeDefined();
        expect(task.subject).toBe("Test task");
        expect(task.owner).toBe("alice"); // teammate_name -> owner
        expect(task.status).toBe("completed"); // default for migrated rows
        expect(task.completed_at).toBe(1700000000);

        closeDb();
      } finally {
        try { unlinkSync(migrationDbPath); } catch {}
        try { unlinkSync(migrationDbPath + "-wal"); } catch {}
        try { unlinkSync(migrationDbPath + "-shm"); } catch {}
        // Restore original test db path
        process.env.AGENT_STALKER_DB_PATH = testDbPath;
      }
    });
  });
});
