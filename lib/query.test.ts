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
