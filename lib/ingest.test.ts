import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ingestEvent } from "./ingest";
import { getDb, closeDb } from "./db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ingestEvent", () => {
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `agent-stalker-ingest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

  it("SessionEnd without prior SessionStart creates the session row", () => {
    ingestEvent({
      hook_event_name: "SessionEnd",
      session_id: "sess-end-only",
      cwd: "/tmp/late",
      permission_mode: "default",
      reason: "clear",
    });
    const db = getDb();
    const session = db.query("SELECT * FROM sessions WHERE id = 'sess-end-only'").get() as any;
    expect(session).not.toBeNull();
    expect(session.ended_at).not.toBeNull();
    expect(session.end_reason).toBe("clear");
    const events = db.query("SELECT COUNT(*) as c FROM events WHERE session_id = 'sess-end-only'").get() as any;
    expect(events.c).toBe(1);
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

  describe("TaskCreate via PostToolUse", () => {
    it("creates task row with correct fields and task_event", () => {
      ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tc1", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "sess-tc1",
        tool_name: "TaskCreate",
        tool_input: { subject: "Build auth module", description: "Implement OAuth2 flow" },
        tool_response: "Created task #42",
        cwd: "/tmp",
        permission_mode: "default",
      });
      const db = getDb();
      const task = db.query("SELECT * FROM tasks WHERE id = '42'").get() as any;
      expect(task).not.toBeNull();
      expect(task.subject).toBe("Build auth module");
      expect(task.description).toBe("Implement OAuth2 flow");
      expect(task.status).toBe("pending");
      expect(task.created_at).not.toBeNull();

      const evt = db.query("SELECT * FROM task_events WHERE task_id = '42'").get() as any;
      expect(evt).not.toBeNull();
      expect(evt.event_type).toBe("created");
    });

    it("stores addBlocks/addBlockedBy as JSON arrays", () => {
      ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tc2", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "sess-tc2",
        tool_name: "TaskCreate",
        tool_input: { subject: "Task with deps", addBlocks: ["5", "6"], addBlockedBy: ["1", "2"] },
        tool_response: "Created task #43",
        cwd: "/tmp",
        permission_mode: "default",
      });
      const db = getDb();
      const task = db.query("SELECT * FROM tasks WHERE id = '43'").get() as any;
      expect(task).not.toBeNull();
      expect(JSON.parse(task.blocks)).toEqual(["5", "6"]);
      expect(JSON.parse(task.blocked_by)).toEqual(["1", "2"]);
    });
  });

  describe("TaskUpdate via PostToolUse", () => {
    it("updates fields and records per-field task_events", () => {
      ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tu1", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
      // Create task first
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "sess-tu1",
        tool_name: "TaskCreate",
        tool_input: { subject: "Original subject" },
        tool_response: "Created task #50",
        cwd: "/tmp",
        permission_mode: "default",
      });
      // Update the task
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "sess-tu1",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "50", owner: "alice", status: "in_progress" },
        tool_response: "Updated task #50 owner, status",
        cwd: "/tmp",
        permission_mode: "default",
      });
      const db = getDb();
      const task = db.query("SELECT * FROM tasks WHERE id = '50'").get() as any;
      expect(task.owner).toBe("alice");
      expect(task.status).toBe("in_progress");

      const events = db.query("SELECT * FROM task_events WHERE task_id = '50' ORDER BY id").all() as any[];
      // 'created' + 'assigned' + 'status_change' = 3
      expect(events.length).toBe(3);
      const assigned = events.find((e: any) => e.event_type === "assigned");
      expect(assigned).not.toBeNull();
      expect(assigned.new_value).toBe("alice");
      const statusChange = events.find((e: any) => e.event_type === "status_change");
      expect(statusChange).not.toBeNull();
      expect(statusChange.old_value).toBe("pending");
      expect(statusChange.new_value).toBe("in_progress");
    });

    it("sets completed_at when status='completed'", () => {
      ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tu2", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "sess-tu2",
        tool_name: "TaskCreate",
        tool_input: { subject: "Task to complete" },
        tool_response: "Created task #51",
        cwd: "/tmp",
        permission_mode: "default",
      });
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "sess-tu2",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "51", status: "completed" },
        tool_response: "Updated task #51 status",
        cwd: "/tmp",
        permission_mode: "default",
      });
      const db = getDb();
      const task = db.query("SELECT * FROM tasks WHERE id = '51'").get() as any;
      expect(task.status).toBe("completed");
      expect(task.completed_at).not.toBeNull();
    });
  });

  describe("Task re-creation within same session", () => {
    it("resets completed task to pending when re-created with same number", () => {
      ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-reuse1", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
      // Create task #1
      ingestEvent({
        hook_event_name: "PostToolUse", session_id: "sess-reuse1", tool_name: "TaskCreate",
        tool_input: { subject: "First iteration" }, tool_response: "Created task #1",
        cwd: "/tmp", permission_mode: "default",
      });
      // Complete task #1
      ingestEvent({
        hook_event_name: "PostToolUse", session_id: "sess-reuse1", tool_name: "TaskUpdate",
        tool_input: { taskId: "1", status: "completed" }, tool_response: "Updated task #1 status",
        cwd: "/tmp", permission_mode: "default",
      });
      const db = getDb();
      let task = db.query("SELECT * FROM tasks WHERE id = '1' AND session_id = 'sess-reuse1'").get() as any;
      expect(task.status).toBe("completed");

      // Re-create task #1 (new series)
      ingestEvent({
        hook_event_name: "PostToolUse", session_id: "sess-reuse1", tool_name: "TaskCreate",
        tool_input: { subject: "Second iteration" }, tool_response: "Created task #1",
        cwd: "/tmp", permission_mode: "default",
      });
      task = db.query("SELECT * FROM tasks WHERE id = '1' AND session_id = 'sess-reuse1'").get() as any;
      expect(task.status).toBe("pending");
      expect(task.subject).toBe("Second iteration");
    });
  });

  it("drops an event with no session_id without inserting anything", () => {
    ingestEvent({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    const db = getDb();
    const count = db.query("SELECT COUNT(*) as c FROM events").get() as any;
    expect(count.c).toBe(0);
    const sessions = db.query("SELECT COUNT(*) as c FROM sessions").get() as any;
    expect(sessions.c).toBe(0);
  });

  describe("Task isolation across sessions", () => {
    it("allows same task number in different sessions", () => {
      ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-iso1", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
      ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-iso2", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
      // Create task #1 in session 1
      ingestEvent({
        hook_event_name: "PostToolUse", session_id: "sess-iso1", tool_name: "TaskCreate",
        tool_input: { subject: "Session 1 task" }, tool_response: "Created task #1",
        cwd: "/tmp", permission_mode: "default",
      });
      // Create task #1 in session 2
      ingestEvent({
        hook_event_name: "PostToolUse", session_id: "sess-iso2", tool_name: "TaskCreate",
        tool_input: { subject: "Session 2 task" }, tool_response: "Created task #1",
        cwd: "/tmp", permission_mode: "default",
      });
      const db = getDb();
      const task1 = db.query("SELECT * FROM tasks WHERE id = '1' AND session_id = 'sess-iso1'").get() as any;
      const task2 = db.query("SELECT * FROM tasks WHERE id = '1' AND session_id = 'sess-iso2'").get() as any;
      expect(task1).not.toBeNull();
      expect(task2).not.toBeNull();
      expect(task1.subject).toBe("Session 1 task");
      expect(task2.subject).toBe("Session 2 task");
    });
  });

  describe("TaskCompleted fallback behavior", () => {
    it("creates task if not already tracked", () => {
      ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tf1", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
      ingestEvent({
        hook_event_name: "TaskCompleted",
        session_id: "sess-tf1",
        task_id: "untracked-1",
        task_subject: "Mystery task",
        task_description: "Not previously created",
        teammate_name: "bob",
        team_name: "team-x",
        cwd: "/tmp",
        permission_mode: "default",
      });
      const db = getDb();
      const task = db.query("SELECT * FROM tasks WHERE id = 'untracked-1'").get() as any;
      expect(task).not.toBeNull();
      expect(task.status).toBe("completed");
      expect(task.owner).toBe("bob");
      expect(task.completed_at).not.toBeNull();
    });

    it("updates existing tracked task on TaskCompleted", () => {
      ingestEvent({ hook_event_name: "SessionStart", session_id: "sess-tf2", cwd: "/tmp", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
      // Create task via PostToolUse first
      ingestEvent({
        hook_event_name: "PostToolUse",
        session_id: "sess-tf2",
        tool_name: "TaskCreate",
        tool_input: { subject: "Pre-existing task" },
        tool_response: "Created task #60",
        cwd: "/tmp",
        permission_mode: "default",
      });
      // Now TaskCompleted fires for same task
      ingestEvent({
        hook_event_name: "TaskCompleted",
        session_id: "sess-tf2",
        task_id: "60",
        task_subject: "Pre-existing task",
        teammate_name: "carol",
        team_name: "team-y",
        cwd: "/tmp",
        permission_mode: "default",
      });
      const db = getDb();
      const task = db.query("SELECT * FROM tasks WHERE id = '60'").get() as any;
      expect(task).not.toBeNull();
      expect(task.status).toBe("completed");
      expect(task.completed_at).not.toBeNull();

      // Should have a 'completed' task_event
      const events = db.query("SELECT * FROM task_events WHERE task_id = '60' AND event_type = 'completed'").all() as any[];
      expect(events.length).toBe(1);
    });
  });
});

describe("isValidEvent", () => {
  it("accepts a minimal valid event", async () => {
    const { isValidEvent } = await import("./ingest");
    expect(isValidEvent({ session_id: "s1", hook_event_name: "SessionStart" })).toBe(true);
  });

  const invalid: Array<[string, unknown]> = [
    ["null", null],
    ["array", []],
    ["string", "event"],
    ["missing session_id", { hook_event_name: "SessionStart" }],
    ["empty session_id", { session_id: "", hook_event_name: "SessionStart" }],
    ["non-string session_id", { session_id: 42, hook_event_name: "SessionStart" }],
    ["missing hook_event_name", { session_id: "s1" }],
    ["empty hook_event_name", { session_id: "s1", hook_event_name: "" }],
    ["non-string hook_event_name", { session_id: "s1", hook_event_name: { x: 1 } }],
  ];
  for (const [label, value] of invalid) {
    it(`rejects ${label}`, async () => {
      const { isValidEvent } = await import("./ingest");
      expect(isValidEvent(value)).toBe(false);
    });
  }
});

describe("ingest capture additions", () => {
  let testDbPath: string;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `agent-stalker-ingest-cap-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
  });
  afterEach(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
    try { unlinkSync(testDbPath + "-wal"); } catch {}
    try { unlinkSync(testDbPath + "-shm"); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("stores transcript_path on the session at SessionStart", () => {
    ingestEvent({
      hook_event_name: "SessionStart",
      session_id: "s1",
      cwd: "/repo",
      permission_mode: "default",
      transcript_path: "/home/u/.claude/projects/p/s1.jsonl",
      source: "startup",
    });
    const db = getDb();
    const row = db.query("SELECT transcript_path FROM sessions WHERE id = ?").get("s1") as any;
    expect(row.transcript_path).toBe("/home/u/.claude/projects/p/s1.jsonl");
  });

  it("keeps user prompts untruncated", () => {
    const longPrompt = "x".repeat(5000);
    ingestEvent({
      hook_event_name: "UserPromptSubmit",
      session_id: "s2",
      cwd: "/repo",
      prompt: longPrompt,
    });
    const db = getDb();
    const row = db.query("SELECT data FROM events WHERE session_id = ? AND hook_event_name = 'UserPromptSubmit'").get("s2") as any;
    const data = JSON.parse(row.data);
    expect(data.prompt).toBe(longPrompt);
    expect(data.prompt.length).toBe(5000);
  });
});
