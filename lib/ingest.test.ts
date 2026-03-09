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
