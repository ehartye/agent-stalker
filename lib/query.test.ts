import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { runQuery } from "./query";
import { ingestEvent } from "./ingest";
import { closeDb } from "./db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("query", () => {
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `agent-stalker-query-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

  describe("triage queue/save", () => {
    it("triage-queue lists flagged sessions with a digest; triage-save marks them analyzed", () => {
      const { getDb } = require("./db");
      const db = getDb();
      db.run("INSERT INTO semantic_session_triage (session_id, status, flagged_at) VALUES ('s1','flagged',1)");

      const queue = runQuery(["triage-queue"]);
      expect(queue).toContain("SESSION s1");
      expect(queue).toContain("TOOL: Bash"); // digest built from seeded events

      const saved = runQuery(["triage-save", "--session", "s1", "--score", "4", "--summary", "rough run", "--root-cause", "flaky tests"]);
      expect(saved).toContain("pain=4");

      const row = db.query("SELECT status, pain_score, summary, root_cause FROM semantic_session_triage WHERE session_id='s1'").get() as any;
      expect(row.status).toBe("analyzed");
      expect(row.pain_score).toBe(4);
      expect(row.summary).toBe("rough run");
      expect(row.root_cause).toBe("flaky tests");

      // once analyzed, it leaves the queue
      expect(runQuery(["triage-queue"])).toContain("no sessions flagged");
    });

    it("triage-queue reports empty when nothing is flagged", () => {
      expect(runQuery(["triage-queue"])).toContain("no sessions flagged");
    });
  });

  describe("tokens", () => {
    function seedUsage(uuid: string, opts: Record<string, any>) {
      const { getDb } = require("./db");
      getDb().run(
        `INSERT INTO usage (message_uuid, session_id, agent_id, role, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, timestamp)
         VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?)`,
        [uuid, opts.session_id, opts.agent_id ?? null, opts.input ?? 0, opts.output ?? 0, opts.cw ?? 0, opts.cr ?? 0, opts.ts ?? 1000],
      );
    }

    it("reports grand total and per-session breakdown", () => {
      seedUsage("m1", { session_id: "s1", input: 100, output: 40, cr: 5 });
      seedUsage("m2", { session_id: "s1", agent_id: "ag1", input: 50, output: 20 });
      const out = runQuery(["tokens"]);
      expect(out).toContain("Total: 210"); // (100+40)+(50+20)
      expect(out).toContain("s1");
    });

    it("--by agent groups by agent (null → main)", () => {
      seedUsage("m1", { session_id: "s1", agent_id: "ag1", input: 100, output: 40 });
      seedUsage("m2", { session_id: "s1", input: 50, output: 20 });
      const out = runQuery(["tokens", "--by", "agent"]);
      expect(out).toContain("ag1");
      expect(out).toContain("(main)");
    });

    it("reports an empty-state message when no usage is recorded", () => {
      expect(runQuery(["tokens"])).toContain("no token usage");
    });
  });

  describe("task queries", () => {
    beforeEach(() => {
      // Seed task data via PostToolUse TaskCreate + TaskUpdate
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "s1",
        tool_name: "TaskCreate",
        tool_input: { subject: "Build auth" },
        tool_response: "Created task #1",
        cwd: "/project-a",
        permission_mode: "default",
      });
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "s1",
        tool_name: "TaskCreate",
        tool_input: { subject: "Write tests" },
        tool_response: "Created task #2",
        cwd: "/project-a",
        permission_mode: "default",
      });
      // Assign and start task 1
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "s1",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "1", owner: "alice", status: "in_progress" },
        tool_response: "Updated task #1 owner, status",
        cwd: "/project-a",
        permission_mode: "default",
      });
      // Complete task 2
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "s1",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "2", owner: "bob", status: "completed" },
        tool_response: "Updated task #2 owner, status",
        cwd: "/project-a",
        permission_mode: "default",
      });
    });

    it("tasks list shows status and owner", () => {
      const result = runQuery(["tasks"]);
      expect(result).toContain("status");
      expect(result).toContain("owner");
      expect(result).toContain("alice");
      expect(result).toContain("bob");
      expect(result).toContain("in_progress");
      expect(result).toContain("completed");
    });

    it("--status filter works", () => {
      const result = runQuery(["tasks", "--status", "completed"]);
      expect(result).toContain("bob");
      expect(result).not.toContain("alice");
    });

    it("--owner filter works", () => {
      const result = runQuery(["tasks", "--owner", "alice"]);
      expect(result).toContain("alice");
      expect(result).not.toContain("bob");
    });

    it("task detail shows history", () => {
      const result = runQuery(["task", "1"]);
      expect(result).toContain("Build auth");
      expect(result).toContain("created");
      expect(result).toContain("assigned");
      expect(result).toContain("status_change");
    });

    it("help text includes task", () => {
      const result = runQuery(["unknown-cmd"]);
      expect(result).toContain("task");
    });
  });
});
