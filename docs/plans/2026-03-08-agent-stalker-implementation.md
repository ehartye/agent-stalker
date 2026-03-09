# agent-stalker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach).

**Goal:** Build a Claude Code plugin that captures all hook events into SQLite and provides slash commands + a web UI for querying them.

**Architecture:** Single Bun entry point (`tracker.ts`) handles all hook events, routes to handlers in `lib/`, writes to a global SQLite DB at `~/.claude/agent-stalker.db`. Web dashboard is a vanilla SPA served by `Bun.serve()`.

**Tech Stack:** Bun, SQLite (via `bun:sqlite`), vanilla HTML/CSS/JS

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.claude-plugin/plugin.json`

**Step 1: Initialize Bun project**

```bash
cd /c/Users/ehart/repos/agent-stalker
bun init -y
```

**Step 2: Create plugin.json**

Create `.claude-plugin/plugin.json`:

```json
{
  "name": "agent-stalker",
  "description": "Track agent team task assignment, messages, and tool use across Claude Code sessions",
  "author": {
    "name": "ehart"
  },
  "version": "0.1.0",
  "license": "MIT",
  "keywords": ["tracking", "observability", "agents", "teams", "tools"]
}
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts"]
}
```

**Step 4: Create .gitignore**

```
node_modules/
*.db
*.db-wal
*.db-shm
```

**Step 5: Install bun-types**

```bash
bun add -d bun-types
```

**Step 6: Commit**

```bash
git add .claude-plugin/ package.json tsconfig.json .gitignore bunfig.toml
git commit -m "feat: scaffold agent-stalker plugin"
```

---

### Task 2: Config Module

**Files:**
- Create: `lib/config.ts`
- Create: `lib/config.test.ts`

**Step 1: Write the failing test**

Create `lib/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getConfig, getContentRule, DEFAULT_CONFIG } from "./config";
import { unlinkSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("config", () => {
  const testDir = join(tmpdir(), "agent-stalker-test-config");
  const testConfigPath = join(testDir, "agent-stalker.config.json");
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    mkdirSync(join(testDir, ".claude"), { recursive: true });
    process.env.AGENT_STALKER_CONFIG_PATH = testConfigPath;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.AGENT_STALKER_CONFIG_PATH;
    try { unlinkSync(testConfigPath); } catch {}
  });

  it("returns default config when no file exists", () => {
    const config = getConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("reads config from file", () => {
    const custom = { contentRules: { Bash: "full", default: { maxLength: 100 } } };
    writeFileSync(testConfigPath, JSON.stringify(custom));
    const config = getConfig();
    expect(config.contentRules.Bash).toBe("full");
  });

  it("returns correct content rule for known tool", () => {
    const rule = getContentRule("Edit");
    expect(rule).toBe("full");
  });

  it("returns default rule for unknown tool", () => {
    const rule = getContentRule("SomeNewTool");
    expect(rule).toEqual({ maxLength: 500 });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test lib/config.test.ts
```

Expected: FAIL — module `./config` not found.

**Step 3: Write minimal implementation**

Create `lib/config.ts`:

```typescript
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type ContentRule = "full" | "metadata" | { maxLength: number };

export interface StalkerConfig {
  contentRules: Record<string, ContentRule>;
}

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
};

function getConfigPath(): string {
  if (process.env.AGENT_STALKER_CONFIG_PATH) {
    return process.env.AGENT_STALKER_CONFIG_PATH;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".claude", "agent-stalker.config.json");
}

export function getConfig(): StalkerConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      contentRules: { ...DEFAULT_CONFIG.contentRules, ...parsed.contentRules },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getContentRule(toolName: string): ContentRule {
  const config = getConfig();
  return config.contentRules[toolName] ?? config.contentRules.default ?? { maxLength: 500 };
}
```

**Step 4: Run test to verify it passes**

```bash
bun test lib/config.test.ts
```

Expected: All 4 tests PASS.

**Step 5: Commit**

```bash
git add lib/config.ts lib/config.test.ts
git commit -m "feat: add config module with content rules"
```

---

### Task 3: Database Module

**Files:**
- Create: `lib/db.ts`
- Create: `lib/db.test.ts`

**Step 1: Write the failing test**

Create `lib/db.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

```bash
bun test lib/db.test.ts
```

Expected: FAIL — module `./db` not found.

**Step 3: Write minimal implementation**

Create `lib/db.ts`:

```typescript
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
```

**Step 4: Run test to verify it passes**

```bash
bun test lib/db.test.ts
```

Expected: All 4 tests PASS.

**Step 5: Commit**

```bash
git add lib/db.ts lib/db.test.ts
git commit -m "feat: add database module with schema and migrations"
```

---

### Task 4: Content Truncation Module

**Files:**
- Create: `lib/truncate.ts`
- Create: `lib/truncate.test.ts`

**Step 1: Write the failing test**

Create `lib/truncate.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { truncateContent } from "./truncate";

describe("truncateContent", () => {
  it("returns full content for 'full' rule", () => {
    const input = { file_path: "/foo.ts", content: "a".repeat(10000) };
    const response = { success: true };
    const result = truncateContent("Edit", input, response, "full");
    expect(result.tool_input).toEqual(input);
    expect(result.tool_response).toEqual(response);
  });

  it("strips content for 'metadata' rule", () => {
    const input = { file_path: "/foo.ts", content: "a".repeat(10000) };
    const response = { filePath: "/foo.ts", success: true, data: "lots of data" };
    const result = truncateContent("Read", input, response, "metadata");
    expect(result.tool_input.file_path).toBe("/foo.ts");
    expect(result.tool_input.content).toBeUndefined();
    expect(result.tool_response.data).toBeUndefined();
  });

  it("truncates content for maxLength rule", () => {
    const input = { command: "a".repeat(5000) };
    const response = { output: "b".repeat(5000) };
    const result = truncateContent("Bash", input, response, { maxLength: 100 });
    expect(result.tool_input.command.length).toBeLessThanOrEqual(113); // 100 + "... [truncated]"
    expect(result.tool_response.output.length).toBeLessThanOrEqual(113);
  });

  it("handles null/undefined inputs gracefully", () => {
    const result = truncateContent("Bash", null, undefined, "full");
    expect(result.tool_input).toBeNull();
    expect(result.tool_response).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test lib/truncate.test.ts
```

Expected: FAIL — module `./truncate` not found.

**Step 3: Write minimal implementation**

Create `lib/truncate.ts`:

```typescript
import type { ContentRule } from "./config";

const METADATA_STRIP_KEYS = new Set(["content", "data", "output", "text", "body", "result", "stdout", "stderr"]);

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + "... [truncated]";
}

function stripToMetadata(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripToMetadata);
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (METADATA_STRIP_KEYS.has(key) && typeof value === "string" && value.length > 200) {
      continue;
    }
    result[key] = typeof value === "object" ? stripToMetadata(value) : value;
  }
  return result;
}

function truncateValues(obj: any, maxLength: number): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return truncateString(obj, maxLength);
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => truncateValues(v, maxLength));
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = truncateValues(value, maxLength);
  }
  return result;
}

export function truncateContent(
  toolName: string,
  toolInput: any,
  toolResponse: any,
  rule: ContentRule,
): { tool_input: any; tool_response: any } {
  if (rule === "full") {
    return { tool_input: toolInput, tool_response: toolResponse };
  }
  if (rule === "metadata") {
    return {
      tool_input: stripToMetadata(toolInput),
      tool_response: stripToMetadata(toolResponse),
    };
  }
  const maxLength = rule.maxLength;
  return {
    tool_input: truncateValues(toolInput, maxLength),
    tool_response: truncateValues(toolResponse, maxLength),
  };
}
```

**Step 4: Run test to verify it passes**

```bash
bun test lib/truncate.test.ts
```

Expected: All 4 tests PASS.

**Step 5: Commit**

```bash
git add lib/truncate.ts lib/truncate.test.ts
git commit -m "feat: add content truncation module"
```

---

### Task 5: Team Resolution Module

**Files:**
- Create: `lib/resolve-team.ts`
- Create: `lib/resolve-team.test.ts`

**Step 1: Write the failing test**

Create `lib/resolve-team.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveTeamContext } from "./resolve-team";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("resolveTeamContext", () => {
  const testDir = join(tmpdir(), `agent-stalker-test-teams-${Date.now()}`);
  const teamsDir = join(testDir, ".claude", "teams");

  beforeEach(() => {
    process.env.AGENT_STALKER_TEAMS_DIR = teamsDir;
    mkdirSync(join(teamsDir, "my-project"), { recursive: true });
    writeFileSync(
      join(teamsDir, "my-project", "config.json"),
      JSON.stringify({
        members: [
          { name: "researcher", agentId: "agent-abc", agentType: "Explore" },
          { name: "implementer", agentId: "agent-def", agentType: "general-purpose" },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.AGENT_STALKER_TEAMS_DIR;
  });

  it("resolves team context by agent_id", () => {
    const result = resolveTeamContext({ agent_id: "agent-abc" });
    expect(result?.team_name).toBe("my-project");
    expect(result?.teammate_name).toBe("researcher");
  });

  it("returns null when no match found", () => {
    const result = resolveTeamContext({ agent_id: "agent-unknown" });
    expect(result).toBeNull();
  });

  it("returns null when no agent_id provided", () => {
    const result = resolveTeamContext({});
    expect(result).toBeNull();
  });

  it("passes through team_name and teammate_name if already present", () => {
    const result = resolveTeamContext({ team_name: "direct-team", teammate_name: "direct-mate" });
    expect(result?.team_name).toBe("direct-team");
    expect(result?.teammate_name).toBe("direct-mate");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test lib/resolve-team.test.ts
```

Expected: FAIL — module `./resolve-team` not found.

**Step 3: Write minimal implementation**

Create `lib/resolve-team.ts`:

```typescript
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

interface TeamContext {
  team_name: string;
  teammate_name: string;
}

interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
}

interface TeamConfig {
  members: TeamMember[];
}

function getTeamsDir(): string {
  if (process.env.AGENT_STALKER_TEAMS_DIR) {
    return process.env.AGENT_STALKER_TEAMS_DIR;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".claude", "teams");
}

export function resolveTeamContext(event: Record<string, any>): TeamContext | null {
  if (event.team_name && event.teammate_name) {
    return { team_name: event.team_name, teammate_name: event.teammate_name };
  }

  const agentId = event.agent_id;
  if (!agentId) return null;

  const teamsDir = getTeamsDir();
  if (!existsSync(teamsDir)) return null;

  try {
    const teamDirs = readdirSync(teamsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const teamName of teamDirs) {
      const configPath = join(teamsDir, teamName, "config.json");
      if (!existsSync(configPath)) continue;

      const raw = readFileSync(configPath, "utf-8");
      const config: TeamConfig = JSON.parse(raw);
      const member = config.members?.find((m) => m.agentId === agentId);
      if (member) {
        return { team_name: teamName, teammate_name: member.name };
      }
    }
  } catch {
    // Scan failed, return null
  }

  return null;
}
```

**Step 4: Run test to verify it passes**

```bash
bun test lib/resolve-team.test.ts
```

Expected: All 4 tests PASS.

**Step 5: Commit**

```bash
git add lib/resolve-team.ts lib/resolve-team.test.ts
git commit -m "feat: add team resolution by scanning team config files"
```

---

### Task 6: Event Ingestion Module

**Files:**
- Create: `lib/ingest.ts`
- Create: `lib/ingest.test.ts`

**Step 1: Write the failing test**

Create `lib/ingest.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ingestEvent } from "./ingest";
import { getDb, closeDb } from "./db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ingestEvent", () => {
  const testDbPath = join(tmpdir(), `agent-stalker-ingest-${Date.now()}.db`);

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

  it("creates a session on SessionStart", () => {
    ingestEvent({
      hook_event_name: "SessionStart",
      session_id: "sess-1",
      cwd: "/home/user/project",
      permission_mode: "default",
      source: "startup",
      model: "claude-sonnet-4-6",
    });
    const db = getDb();
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-1'").get() as any;
    expect(session).not.toBeNull();
    expect(session.model).toBe("claude-sonnet-4-6");
    expect(session.cwd).toBe("/home/user/project");
  });

  it("records a PreToolUse event", () => {
    ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-2", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
    ingestEvent({
      hook_event_name: "PreToolUse",
      session_id: "sess-2",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_use_id: "toolu_123",
      cwd: "/tmp",
      permission_mode: "default",
    });
    const db = getDb();
    const events = db.query("SELECT * FROM events WHERE session_id = 'sess-2'").all() as any[];
    expect(events.length).toBe(2); // SessionStart + PreToolUse
    const toolEvent = events.find((e: any) => e.hook_event_name === "PreToolUse");
    expect(toolEvent.tool_name).toBe("Bash");
    expect(toolEvent.tool_use_id).toBe("toolu_123");
  });

  it("records a SubagentStart and creates an agent row", () => {
    ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-3", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
    ingestEvent({
      hook_event_name: "SubagentStart",
      session_id: "sess-3",
      agent_id: "agent-xyz",
      agent_type: "Explore",
      cwd: "/tmp",
      permission_mode: "default",
    });
    const db = getDb();
    const agent = db.query("SELECT * FROM agents WHERE id = 'agent-xyz'").get() as any;
    expect(agent).not.toBeNull();
    expect(agent.agent_type).toBe("Explore");
  });

  it("updates session on SessionEnd", () => {
    ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-4", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
    ingestEvent({
      hook_event_name: "SessionEnd",
      session_id: "sess-4",
      reason: "other",
      cwd: "/tmp",
      permission_mode: "default",
    });
    const db = getDb();
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-4'").get() as any;
    expect(session.end_reason).toBe("other");
    expect(session.ended_at).not.toBeNull();
  });

  it("records TaskCompleted event and creates task row", () => {
    ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-5", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
    ingestEvent({
      hook_event_name: "TaskCompleted",
      session_id: "sess-5",
      task_id: "task-001",
      task_subject: "Implement auth",
      task_description: "Add login endpoints",
      teammate_name: "implementer",
      team_name: "my-project",
      cwd: "/tmp",
      permission_mode: "default",
    });
    const db = getDb();
    const task = db.query("SELECT * FROM tasks WHERE id = 'task-001'").get() as any;
    expect(task).not.toBeNull();
    expect(task.subject).toBe("Implement auth");
    expect(task.team_name).toBe("my-project");
  });

  it("upserts session if SessionStart not seen yet", () => {
    ingestEvent({
      hook_event_name: "PreToolUse",
      session_id: "sess-late",
      tool_name: "Read",
      tool_input: { file_path: "/foo.ts" },
      cwd: "/tmp",
      permission_mode: "default",
    });
    const db = getDb();
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-late'").get() as any;
    expect(session).not.toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test lib/ingest.test.ts
```

Expected: FAIL — module `./ingest` not found.

**Step 3: Write minimal implementation**

Create `lib/ingest.ts`:

```typescript
import { getDb } from "./db";
import { getContentRule } from "./config";
import { truncateContent } from "./truncate";
import { resolveTeamContext } from "./resolve-team";

function ensureSession(event: Record<string, any>): void {
  const db = getDb();
  const existing = db.query("SELECT id FROM sessions WHERE id = ?").get(event.session_id);
  if (!existing) {
    db.run(
      "INSERT INTO sessions (id, cwd, permission_mode, started_at) VALUES (?, ?, ?, ?)",
      [event.session_id, event.cwd, event.permission_mode, Date.now()],
    );
  }
}

function recordEvent(event: Record<string, any>, data?: any): void {
  const db = getDb();
  const teamContext = resolveTeamContext(event);
  db.run(
    `INSERT INTO events (session_id, hook_event_name, agent_id, agent_type, team_name, teammate_name, timestamp, tool_name, tool_use_id, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.session_id,
      event.hook_event_name,
      event.agent_id ?? null,
      event.agent_type ?? null,
      teamContext?.team_name ?? event.team_name ?? null,
      teamContext?.teammate_name ?? event.teammate_name ?? null,
      Date.now(),
      event.tool_name ?? null,
      event.tool_use_id ?? null,
      data ? JSON.stringify(data) : null,
    ],
  );
}

function handleSessionStart(event: Record<string, any>): void {
  const db = getDb();
  const existing = db.query("SELECT id FROM sessions WHERE id = ?").get(event.session_id);
  if (existing) {
    db.run(
      "UPDATE sessions SET cwd = ?, permission_mode = ?, model = ?, agent_type = ?, started_at = ? WHERE id = ?",
      [event.cwd, event.permission_mode, event.model ?? null, event.agent_type ?? null, Date.now(), event.session_id],
    );
  } else {
    db.run(
      "INSERT INTO sessions (id, cwd, permission_mode, model, agent_type, started_at) VALUES (?, ?, ?, ?, ?, ?)",
      [event.session_id, event.cwd, event.permission_mode, event.model ?? null, event.agent_type ?? null, Date.now()],
    );
  }
  recordEvent(event, { source: event.source });
}

function handleSessionEnd(event: Record<string, any>): void {
  const db = getDb();
  db.run("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?", [Date.now(), event.reason, event.session_id]);
  recordEvent(event, { reason: event.reason });
}

function handleToolUse(event: Record<string, any>): void {
  ensureSession(event);
  const rule = getContentRule(event.tool_name ?? "default");
  const { tool_input, tool_response } = truncateContent(
    event.tool_name ?? "unknown",
    event.tool_input,
    event.tool_response,
    rule,
  );
  recordEvent(event, { tool_input, tool_response, error: event.error, is_interrupt: event.is_interrupt });
}

function handleSubagentStart(event: Record<string, any>): void {
  ensureSession(event);
  const db = getDb();
  db.run(
    "INSERT OR IGNORE INTO agents (id, session_id, agent_type, transcript_path, started_at) VALUES (?, ?, ?, ?, ?)",
    [event.agent_id, event.session_id, event.agent_type, event.transcript_path ?? null, Date.now()],
  );
  recordEvent(event);
}

function handleSubagentStop(event: Record<string, any>): void {
  ensureSession(event);
  const db = getDb();
  db.run("UPDATE agents SET ended_at = ? WHERE id = ?", [Date.now(), event.agent_id]);
  recordEvent(event, { last_assistant_message: event.last_assistant_message });
}

function handleTaskCompleted(event: Record<string, any>): void {
  ensureSession(event);
  const db = getDb();
  db.run(
    "INSERT INTO tasks (id, session_id, subject, description, teammate_name, team_name, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [event.task_id, event.session_id, event.task_subject, event.task_description ?? null, event.teammate_name ?? null, event.team_name ?? null, Date.now()],
  );
  // Update session team context if we now know it
  if (event.team_name) {
    db.run("UPDATE sessions SET team_name = ?, teammate_name = ? WHERE id = ? AND team_name IS NULL",
      [event.team_name, event.teammate_name ?? null, event.session_id]);
  }
  recordEvent(event);
}

function handleTeammateIdle(event: Record<string, any>): void {
  ensureSession(event);
  if (event.team_name) {
    const db = getDb();
    db.run("UPDATE sessions SET team_name = ?, teammate_name = ? WHERE id = ? AND team_name IS NULL",
      [event.team_name, event.teammate_name ?? null, event.session_id]);
  }
  recordEvent(event, { teammate_name: event.teammate_name, team_name: event.team_name });
}

function handleGeneric(event: Record<string, any>): void {
  ensureSession(event);
  const { session_id, hook_event_name, cwd, permission_mode, transcript_path, ...rest } = event;
  recordEvent(event, rest);
}

export function ingestEvent(event: Record<string, any>): void {
  switch (event.hook_event_name) {
    case "SessionStart":
      handleSessionStart(event);
      break;
    case "SessionEnd":
      handleSessionEnd(event);
      break;
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      handleToolUse(event);
      break;
    case "SubagentStart":
      handleSubagentStart(event);
      break;
    case "SubagentStop":
      handleSubagentStop(event);
      break;
    case "TaskCompleted":
      handleTaskCompleted(event);
      break;
    case "TeammateIdle":
      handleTeammateIdle(event);
      break;
    default:
      handleGeneric(event);
      break;
  }
}
```

**Step 4: Run test to verify it passes**

```bash
bun test lib/ingest.test.ts
```

Expected: All 6 tests PASS.

**Step 5: Commit**

```bash
git add lib/ingest.ts lib/ingest.test.ts
git commit -m "feat: add event ingestion with per-type handlers"
```

---

### Task 7: Hook Entry Point

**Files:**
- Create: `hooks/tracker.ts`
- Create: `hooks/hooks.json`

**Step 1: Write tracker.ts**

Create `hooks/tracker.ts`:

```typescript
import { ingestEvent } from "../lib/ingest";
import { closeDb } from "../lib/db";

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    process.exit(0);
  }

  try {
    const event = JSON.parse(raw);
    ingestEvent(event);
  } catch (err) {
    console.error(`agent-stalker: failed to ingest event: ${err}`);
  } finally {
    closeDb();
  }
}

main();
```

**Step 2: Write hooks.json**

Create `hooks/hooks.json`:

```json
{
  "description": "agent-stalker: tracks agent team task assignment, messages, and tool use",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "TeammateIdle": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun \"${CLAUDE_PLUGIN_ROOT}/hooks/tracker.ts\"",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Step 3: Manual smoke test**

```bash
echo '{"hook_event_name":"SessionStart","session_id":"test-1","cwd":"/tmp","permission_mode":"default","source":"startup","model":"claude-sonnet-4-6"}' | bun hooks/tracker.ts
```

Verify DB was created and has data:

```bash
bun -e "import {Database} from 'bun:sqlite'; const db = new Database(require('os').homedir() + '/.claude/agent-stalker.db'); console.log(db.query('SELECT * FROM sessions').all());"
```

**Step 4: Commit**

```bash
git add hooks/tracker.ts hooks/hooks.json
git commit -m "feat: add hook entry point and hooks.json registration"
```

---

### Task 8: Query Engine

**Files:**
- Create: `lib/query.ts`
- Create: `lib/query.test.ts`

**Step 1: Write the failing test**

Create `lib/query.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { runQuery } from "./query";
import { ingestEvent } from "./ingest";
import { closeDb } from "./db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("query", () => {
  const testDbPath = join(tmpdir(), `agent-stalker-query-${Date.now()}.db`);

  beforeEach(() => {
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
    // Seed data
    ingestEvent({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/project-a", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
    ingestEvent({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t1", cwd: "/project-a", permission_mode: "default" });
    ingestEvent({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 }, tool_use_id: "t1", cwd: "/project-a", permission_mode: "default" });
    ingestEvent({ hook_event_name: "SessionEnd", session_id: "s1", reason: "other", cwd: "/project-a", permission_mode: "default" });
  });

  afterEach(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
    try { unlinkSync(testDbPath + "-wal"); } catch {}
    try { unlinkSync(testDbPath + "-shm"); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("lists sessions", () => {
    const result = runQuery(["sessions"]);
    expect(result).toContain("s1");
  });

  it("shows session detail", () => {
    const result = runQuery(["session", "s1"]);
    expect(result).toContain("s1");
    expect(result).toContain("claude-sonnet-4-6");
  });

  it("lists events for a session", () => {
    const result = runQuery(["events", "--session", "s1"]);
    expect(result).toContain("PreToolUse");
    expect(result).toContain("PostToolUse");
  });

  it("filters events by tool", () => {
    const result = runQuery(["events", "--tool", "Bash"]);
    expect(result).toContain("Bash");
  });

  it("shows stats", () => {
    const result = runQuery(["stats"]);
    expect(result).toContain("1"); // 1 session
  });

  it("lists tools with counts", () => {
    const result = runQuery(["tools"]);
    expect(result).toContain("Bash");
  });

  it("shows event detail", () => {
    const result = runQuery(["event", "1"]);
    expect(result).toContain("SessionStart");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test lib/query.test.ts
```

Expected: FAIL — module `./query` not found.

**Step 3: Write minimal implementation**

Create `lib/query.ts`:

```typescript
import { getDb } from "./db";

function formatTable(rows: Record<string, any>[], columns?: string[]): string {
  if (rows.length === 0) return "(no results)";
  const keys = columns ?? Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)),
  );
  const header = keys.map((k, i) => k.padEnd(widths[i])).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((r) => keys.map((k, i) => String(r[k] ?? "").padEnd(widths[i])).join("  "))
    .join("\n");
  return `${header}\n${separator}\n${body}`;
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(m|h|d)$/);
  if (!match) return 0;
  const value = parseInt(match[1]);
  switch (match[2]) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 0;
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function cmdSessions(args: string[]): string {
  const db = getDb();
  const team = getFlag(args, "--team");
  let query = "SELECT id, cwd, model, team_name, teammate_name, started_at, ended_at, end_reason FROM sessions";
  const params: any[] = [];
  if (team) {
    query += " WHERE team_name = ?";
    params.push(team);
  }
  query += " ORDER BY started_at DESC LIMIT 50";
  const rows = db.query(query).all(...params) as Record<string, any>[];
  return formatTable(rows, ["id", "cwd", "model", "team_name", "started_at"]);
}

function cmdSession(args: string[]): string {
  const id = args[1];
  if (!id) return "Usage: session <id>";
  const db = getDb();
  const session = db.query("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, any> | null;
  if (!session) return `Session '${id}' not found`;
  const eventCount = db.query("SELECT COUNT(*) as count FROM events WHERE session_id = ?").get(id) as { count: number };
  const toolCounts = db.query("SELECT tool_name, COUNT(*) as count FROM events WHERE session_id = ? AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC").all(id) as Record<string, any>[];
  let result = `Session: ${session.id}\n`;
  result += `CWD: ${session.cwd}\n`;
  result += `Model: ${session.model}\n`;
  result += `Mode: ${session.permission_mode}\n`;
  result += `Team: ${session.team_name ?? "(none)"}\n`;
  result += `Teammate: ${session.teammate_name ?? "(none)"}\n`;
  result += `Started: ${session.started_at}\n`;
  result += `Ended: ${session.ended_at ?? "(active)"}\n`;
  result += `End Reason: ${session.end_reason ?? "(active)"}\n`;
  result += `Events: ${eventCount.count}\n\n`;
  if (toolCounts.length > 0) {
    result += "Tool Usage:\n" + formatTable(toolCounts);
  }
  return result;
}

function cmdEvents(args: string[]): string {
  const db = getDb();
  const sessionId = getFlag(args, "--session");
  const toolName = getFlag(args, "--tool");
  const agentId = getFlag(args, "--agent-id");
  const since = getFlag(args, "--since");

  let query = "SELECT id, session_id, hook_event_name, tool_name, agent_id, agent_type, timestamp FROM events WHERE 1=1";
  const params: any[] = [];

  if (sessionId) { query += " AND session_id = ?"; params.push(sessionId); }
  if (toolName) { query += " AND tool_name = ?"; params.push(toolName); }
  if (agentId) { query += " AND agent_id = ?"; params.push(agentId); }
  if (since) {
    const ms = parseDuration(since);
    if (ms > 0) { query += " AND timestamp > ?"; params.push(Date.now() - ms); }
  }

  query += " ORDER BY timestamp ASC LIMIT 200";
  const rows = db.query(query).all(...params) as Record<string, any>[];
  return formatTable(rows, ["id", "hook_event_name", "tool_name", "agent_id", "timestamp"]);
}

function cmdEvent(args: string[]): string {
  const id = args[1];
  if (!id) return "Usage: event <id>";
  const db = getDb();
  const event = db.query("SELECT * FROM events WHERE id = ?").get(parseInt(id)) as Record<string, any> | null;
  if (!event) return `Event '${id}' not found`;
  let result = `Event #${event.id}\n`;
  result += `Type: ${event.hook_event_name}\n`;
  result += `Session: ${event.session_id}\n`;
  result += `Tool: ${event.tool_name ?? "(none)"}\n`;
  result += `Tool Use ID: ${event.tool_use_id ?? "(none)"}\n`;
  result += `Agent: ${event.agent_id ?? "(main thread)"}\n`;
  result += `Agent Type: ${event.agent_type ?? "(none)"}\n`;
  result += `Timestamp: ${event.timestamp}\n`;
  if (event.data) {
    result += `\nData:\n${JSON.stringify(JSON.parse(event.data), null, 2)}`;
  }
  return result;
}

function cmdTools(args: string[]): string {
  const db = getDb();
  const sessionId = getFlag(args, "--session");
  const agentType = getFlag(args, "--agent");
  const name = getFlag(args, "--name");

  let query = "SELECT tool_name, COUNT(*) as count FROM events WHERE tool_name IS NOT NULL";
  const params: any[] = [];
  if (sessionId) { query += " AND session_id = ?"; params.push(sessionId); }
  if (agentType) { query += " AND agent_type = ?"; params.push(agentType); }
  if (name) { query += " AND tool_name = ?"; params.push(name); }
  query += " GROUP BY tool_name ORDER BY count DESC";
  const rows = db.query(query).all(...params) as Record<string, any>[];
  return formatTable(rows);
}

function cmdAgents(args: string[]): string {
  const db = getDb();
  const sessionId = getFlag(args, "--session");
  let query = "SELECT id, session_id, agent_type, started_at, ended_at FROM agents";
  const params: any[] = [];
  if (sessionId) { query += " WHERE session_id = ?"; params.push(sessionId); }
  query += " ORDER BY started_at DESC LIMIT 50";
  const rows = db.query(query).all(...params) as Record<string, any>[];
  return formatTable(rows);
}

function cmdTasks(args: string[]): string {
  const db = getDb();
  const team = getFlag(args, "--team");
  let query = "SELECT id, subject, teammate_name, team_name, completed_at FROM tasks";
  const params: any[] = [];
  if (team) { query += " WHERE team_name = ?"; params.push(team); }
  query += " ORDER BY completed_at DESC LIMIT 50";
  const rows = db.query(query).all(...params) as Record<string, any>[];
  return formatTable(rows);
}

function cmdStats(args: string[]): string {
  const db = getDb();
  const sessionId = getFlag(args, "--session");

  if (sessionId) {
    const eventCount = db.query("SELECT COUNT(*) as count FROM events WHERE session_id = ?").get(sessionId) as { count: number };
    const toolCount = db.query("SELECT COUNT(DISTINCT tool_name) as count FROM events WHERE session_id = ? AND tool_name IS NOT NULL").get(sessionId) as { count: number };
    const agentCount = db.query("SELECT COUNT(*) as count FROM agents WHERE session_id = ?").get(sessionId) as { count: number };
    return `Session ${sessionId}:\n  Events: ${eventCount.count}\n  Distinct Tools: ${toolCount.count}\n  Agents: ${agentCount.count}`;
  }

  const sessionCount = db.query("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
  const eventCount = db.query("SELECT COUNT(*) as count FROM events").get() as { count: number };
  const toolCount = db.query("SELECT COUNT(DISTINCT tool_name) as count FROM events WHERE tool_name IS NOT NULL").get() as { count: number };
  const agentCount = db.query("SELECT COUNT(*) as count FROM agents").get() as { count: number };
  const taskCount = db.query("SELECT COUNT(*) as count FROM tasks").get() as { count: number };
  return `Global Stats:\n  Sessions: ${sessionCount.count}\n  Events: ${eventCount.count}\n  Distinct Tools: ${toolCount.count}\n  Agents: ${agentCount.count}\n  Tasks: ${taskCount.count}`;
}

export function runQuery(args: string[]): string {
  const subcommand = args[0];
  switch (subcommand) {
    case "sessions": return cmdSessions(args);
    case "session": return cmdSession(args);
    case "events": return cmdEvents(args);
    case "event": return cmdEvent(args);
    case "tools": return cmdTools(args);
    case "agents": return cmdAgents(args);
    case "tasks": return cmdTasks(args);
    case "stats": return cmdStats(args);
    default:
      return `Unknown command: ${subcommand}\n\nAvailable: sessions, session, events, event, tools, agents, tasks, stats`;
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: stalker <command> [options]\n\nCommands: sessions, session, events, event, tools, agents, tasks, stats");
  } else {
    console.log(runQuery(args));
  }
}
```

**Step 4: Run test to verify it passes**

```bash
bun test lib/query.test.ts
```

Expected: All 7 tests PASS.

**Step 5: Commit**

```bash
git add lib/query.ts lib/query.test.ts
git commit -m "feat: add query engine with CLI subcommands"
```

---

### Task 9: Slash Commands

**Files:**
- Create: `commands/stalker.md`
- Create: `commands/stalker-ui.md`
- Create: `commands/stalker-config.md`

**Step 1: Create stalker command**

Create `commands/stalker.md`:

```markdown
---
description: Query agent-stalker tracking data (sessions, events, tools, agents, tasks, stats)
allowed-tools: ["Bash", "Read"]
---

Run the agent-stalker query engine with the user's arguments.

Run: `bun "${CLAUDE_PLUGIN_ROOT}/lib/query.ts" $ARGUMENTS`

Present the output to the user. If no arguments are provided, show the help text.

Available subcommands:
- `sessions [--team <name>]` — list recent sessions
- `session <id>` — session detail
- `tools [--session <id>] [--agent <type>] [--name <tool>]` — tool use frequency
- `events [--session <id>] [--tool <name>] [--agent-id <id>] [--since <duration>]` — event log
- `event <id>` — full event detail with content
- `agents [--session <id>]` — agents spawned
- `tasks [--team <name>]` — task completions
- `stats [--session <id>]` — summary statistics
```

**Step 2: Create stalker-ui command**

Create `commands/stalker-ui.md`:

```markdown
---
description: Start the agent-stalker web dashboard for browsing tracked sessions, events, and tool use
allowed-tools: ["Bash"]
---

Start the agent-stalker web UI server.

If the user passes "stop" as an argument, kill any running stalker-ui server:
Run: `pkill -f "bun.*ui/server.ts" 2>/dev/null && echo "Server stopped" || echo "No server running"`

Otherwise, start the server:
Run: `bun "${CLAUDE_PLUGIN_ROOT}/ui/server.ts" $ARGUMENTS &`

Default port is 3141. User can pass `--port <number>` to change it.

After starting, tell the user the URL: `http://localhost:<port>`
```

**Step 3: Create stalker-config command**

Create `commands/stalker-config.md`:

```markdown
---
description: Configure agent-stalker content capture rules
allowed-tools: ["Bash", "Read", "Write"]
---

Manage agent-stalker configuration at `~/.claude/agent-stalker.config.json`.

If the user passes "show" or no arguments, read and display the current config file. If it doesn't exist, show the defaults.

If the user passes "set <tool> <rule>", update the config file:
- `set Bash full` — store full content for Bash
- `set Read metadata` — metadata only for Read
- `set Bash maxLength 2000` — truncate Bash at 2000 chars

If the user passes "reset", delete the config file to restore defaults.

Default content rules:
- Edit, Write: full
- Read, Glob, Grep: metadata
- Bash: maxLength 2000
- default: maxLength 500
```

**Step 4: Commit**

```bash
git add commands/
git commit -m "feat: add slash commands for stalker, stalker-ui, stalker-config"
```

---

### Task 10: Web UI API Server

**Files:**
- Create: `ui/server.ts`

**Step 1: Write the API server**

Create `ui/server.ts`:

```typescript
import { getDb } from "../lib/db";
import { closeDb } from "../lib/db";
import { join } from "path";
import { existsSync } from "fs";

const port = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "3141");

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function getFlag(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

function handleApi(url: URL): Response {
  const db = getDb();
  const path = url.pathname;
  const params = url.searchParams;

  if (path === "/api/sessions") {
    const team = params.get("team");
    const limit = parseInt(params.get("limit") ?? "50");
    const offset = parseInt(params.get("offset") ?? "0");
    let query = "SELECT * FROM sessions";
    const qParams: any[] = [];
    if (team) { query += " WHERE team_name = ?"; qParams.push(team); }
    query += " ORDER BY started_at DESC LIMIT ? OFFSET ?";
    qParams.push(limit, offset);
    return jsonResponse(db.query(query).all(...qParams));
  }

  if (path.startsWith("/api/sessions/")) {
    const id = path.split("/api/sessions/")[1];
    const session = db.query("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!session) return jsonResponse({ error: "Not found" }, 404);
    const eventCount = db.query("SELECT COUNT(*) as count FROM events WHERE session_id = ?").get(id);
    const toolCounts = db.query("SELECT tool_name, COUNT(*) as count FROM events WHERE session_id = ? AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC").all(id);
    return jsonResponse({ session, eventCount, toolCounts });
  }

  if (path === "/api/events") {
    const sessionId = params.get("session");
    const toolName = params.get("tool");
    const agentId = params.get("agent_id");
    const since = params.get("since");
    const limit = parseInt(params.get("limit") ?? "200");
    const offset = parseInt(params.get("offset") ?? "0");

    let query = "SELECT * FROM events WHERE 1=1";
    const qParams: any[] = [];
    if (sessionId) { query += " AND session_id = ?"; qParams.push(sessionId); }
    if (toolName) { query += " AND tool_name = ?"; qParams.push(toolName); }
    if (agentId) { query += " AND agent_id = ?"; qParams.push(agentId); }
    if (since) { query += " AND timestamp > ?"; qParams.push(parseInt(since)); }
    query += " ORDER BY timestamp ASC LIMIT ? OFFSET ?";
    qParams.push(limit, offset);
    return jsonResponse(db.query(query).all(...qParams));
  }

  if (path.startsWith("/api/events/")) {
    const id = parseInt(path.split("/api/events/")[1]);
    const event = db.query("SELECT * FROM events WHERE id = ?").get(id);
    if (!event) return jsonResponse({ error: "Not found" }, 404);
    return jsonResponse(event);
  }

  if (path === "/api/agents") {
    const sessionId = params.get("session");
    let query = "SELECT * FROM agents";
    const qParams: any[] = [];
    if (sessionId) { query += " WHERE session_id = ?"; qParams.push(sessionId); }
    query += " ORDER BY started_at DESC LIMIT 50";
    return jsonResponse(db.query(query).all(...qParams));
  }

  if (path === "/api/tasks") {
    const team = params.get("team");
    let query = "SELECT * FROM tasks";
    const qParams: any[] = [];
    if (team) { query += " WHERE team_name = ?"; qParams.push(team); }
    query += " ORDER BY completed_at DESC LIMIT 50";
    return jsonResponse(db.query(query).all(...qParams));
  }

  if (path === "/api/stats") {
    const sessions = db.query("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
    const events = db.query("SELECT COUNT(*) as count FROM events").get() as { count: number };
    const tools = db.query("SELECT COUNT(DISTINCT tool_name) as count FROM events WHERE tool_name IS NOT NULL").get() as { count: number };
    const agents = db.query("SELECT COUNT(*) as count FROM agents").get() as { count: number };
    const tasks = db.query("SELECT COUNT(*) as count FROM tasks").get() as { count: number };
    return jsonResponse({ sessions: sessions.count, events: events.count, tools: tools.count, agents: agents.count, tasks: tasks.count });
  }

  if (path === "/api/tools") {
    const rows = db.query("SELECT tool_name, COUNT(*) as count, COUNT(DISTINCT session_id) as sessions FROM events WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC").all();
    return jsonResponse(rows);
  }

  return jsonResponse({ error: "Not found" }, 404);
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(url);
    }

    // Serve static files from ui/ directory
    const pluginRoot = import.meta.dir;
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const fullPath = join(pluginRoot, filePath);

    if (existsSync(fullPath)) {
      return new Response(Bun.file(fullPath));
    }

    // Fallback to index.html for SPA routing
    return new Response(Bun.file(join(pluginRoot, "index.html")));
  },
});

console.log(`agent-stalker UI running at http://localhost:${server.port}`);

process.on("SIGINT", () => {
  closeDb();
  process.exit(0);
});
```

**Step 2: Commit**

```bash
git add ui/server.ts
git commit -m "feat: add web UI API server"
```

---

### Task 11: Web UI Frontend

**Files:**
- Create: `ui/index.html`

**Step 1: Build the web UI**

Use the `frontend-design` skill to create a distinctive, polished SPA at `ui/index.html`.

**Requirements to pass to the skill:**
- Single-file vanilla HTML/CSS/JS (no build step, no framework)
- Fetches data from the API routes defined in Task 10 (`/api/sessions`, `/api/events`, `/api/events/:id`, `/api/agents`, `/api/tasks`, `/api/stats`, `/api/tools`)
- Layout: left sidebar (sessions, agents, teams as clickable filters), center event timeline (color-coded by event type, agent badges), expandable event detail pane, footer stats bar
- Auto-refresh: poll `/api/events?since=<last_timestamp>` every 2s when viewing active sessions
- Filterable by: tool type, agent, session, time range, text search
- JSON viewer for event data (tool_input/tool_response)
- Dark theme appropriate for a developer tool
- Responsive but optimized for desktop

**Step 2: Commit**

```bash
git add ui/index.html
git commit -m "feat: add web UI dashboard"
```

---

### Task 12: Run All Tests & Final Smoke Test

**Step 1: Run full test suite**

```bash
bun test
```

Expected: All tests pass across config, db, truncate, resolve-team, ingest, query modules.

**Step 2: End-to-end smoke test**

```bash
# Simulate a full session lifecycle
echo '{"hook_event_name":"SessionStart","session_id":"smoke-1","cwd":"/tmp/test","permission_mode":"default","source":"startup","model":"claude-sonnet-4-6"}' | bun hooks/tracker.ts
echo '{"hook_event_name":"PreToolUse","session_id":"smoke-1","tool_name":"Bash","tool_input":{"command":"echo hello"},"tool_use_id":"t1","cwd":"/tmp/test","permission_mode":"default"}' | bun hooks/tracker.ts
echo '{"hook_event_name":"PostToolUse","session_id":"smoke-1","tool_name":"Bash","tool_input":{"command":"echo hello"},"tool_response":{"output":"hello"},"tool_use_id":"t1","cwd":"/tmp/test","permission_mode":"default"}' | bun hooks/tracker.ts
echo '{"hook_event_name":"SessionEnd","session_id":"smoke-1","reason":"other","cwd":"/tmp/test","permission_mode":"default"}' | bun hooks/tracker.ts

# Query it
bun lib/query.ts sessions
bun lib/query.ts events --session smoke-1
bun lib/query.ts stats
```

**Step 3: Clean up smoke test data**

```bash
rm -f ~/.claude/agent-stalker.db ~/.claude/agent-stalker.db-wal ~/.claude/agent-stalker.db-shm
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: finalize v0.1.0"
```
