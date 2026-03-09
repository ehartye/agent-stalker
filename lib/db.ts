import { Database } from "bun:sqlite";
import { join } from "path";

let db: Database | null = null;

function getDbPath(): string {
  if (process.env.AGENT_STALKER_DB_PATH) {
    return process.env.AGENT_STALKER_DB_PATH;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".claude", "agent-stalker.db");
}

function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    )
  `);

  const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | null;
  const currentVersion = row?.version ?? 0;

  if (currentVersion < 1) {
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        permission_mode TEXT,
        model TEXT,
        agent_type TEXT,
        team_name TEXT,
        teammate_name TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        end_reason TEXT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        hook_event_name TEXT,
        agent_id TEXT,
        agent_type TEXT,
        team_name TEXT,
        teammate_name TEXT,
        timestamp INTEGER,
        tool_name TEXT,
        tool_use_id TEXT,
        data TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        agent_type TEXT,
        transcript_path TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT,
        session_id TEXT,
        subject TEXT,
        description TEXT,
        teammate_name TEXT,
        team_name TEXT,
        completed_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      )
    `);

    db.run("CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_events_hook_event_name ON events(hook_event_name)");
    db.run("CREATE INDEX IF NOT EXISTS idx_events_tool_name ON events(tool_name)");
    db.run("CREATE INDEX IF NOT EXISTS idx_events_agent_id ON events(agent_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)");

    if (currentVersion === 0) {
      db.run("INSERT INTO schema_version (version) VALUES (1)");
    } else {
      db.run("UPDATE schema_version SET version = 1");
    }
  }

  if (currentVersion < 2) {
    // Migrate tasks table: rename old, create new with expanded columns, copy data, drop old
    db.run(`CREATE TABLE tasks_v2 (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      subject TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      owner TEXT,
      team_name TEXT,
      blocks TEXT,
      blocked_by TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`);

    // Migrate existing data: teammate_name -> owner, status = 'completed' for existing rows
    db.run(`INSERT INTO tasks_v2 (id, session_id, subject, description, status, owner, team_name, completed_at)
      SELECT id, session_id, subject, description, 'completed', teammate_name, team_name, completed_at
      FROM tasks`);

    db.run("DROP TABLE tasks");
    db.run("ALTER TABLE tasks_v2 RENAME TO tasks");

    // Create task_events table
    db.run(`CREATE TABLE task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      session_id TEXT,
      event_type TEXT,
      field_name TEXT,
      old_value TEXT,
      new_value TEXT,
      timestamp INTEGER,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`);

    db.run("CREATE INDEX idx_task_events_task_id ON task_events(task_id)");
    db.run("CREATE INDEX idx_task_events_timestamp ON task_events(timestamp)");

    db.run("UPDATE schema_version SET version = 2");
  }
}

export function getDb(): Database {
  if (db) return db;
  db = new Database(getDbPath());
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  runMigrations(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
