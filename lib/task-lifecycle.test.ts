import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ingestEvent } from "./ingest";
import { getDb, closeDb } from "./db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("task lifecycle end-to-end", () => {
  const testDbPath = join(tmpdir(), `agent-stalker-lifecycle-${Date.now()}.db`);

  beforeEach(() => {
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
    // Start a session
    ingestEvent({
      hook_event_name: "SessionStart",
      session_id: "lifecycle-sess",
      cwd: "/project",
      permission_mode: "default",
      source: "startup",
      model: "claude-sonnet-4-6",
    });
  });

  afterEach(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
    try { unlinkSync(testDbPath + "-wal"); } catch {}
    try { unlinkSync(testDbPath + "-shm"); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("tracks full task lifecycle: create -> assign -> in_progress -> completed", () => {
    const db = getDb();

    // Step 1: TaskCreate via PostToolUse
    ingestEvent({
      hook_event_name: "PostToolUse",
      session_id: "lifecycle-sess",
      tool_name: "TaskCreate",
      tool_input: { subject: "Implement feature X", description: "Build the thing" },
      tool_response: "Created task #10",
      cwd: "/project",
      permission_mode: "default",
    });

    let task = db.query("SELECT * FROM tasks WHERE id = '10'").get() as any;
    expect(task).not.toBeNull();
    expect(task.status).toBe("pending");
    expect(task.owner).toBeNull();
    expect(task.subject).toBe("Implement feature X");
    expect(task.description).toBe("Build the thing");

    // Step 2: TaskUpdate -- assign owner
    ingestEvent({
      hook_event_name: "PostToolUse",
      session_id: "lifecycle-sess",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "10", owner: "developer-1" },
      tool_response: "Updated task #10 owner",
      cwd: "/project",
      permission_mode: "default",
    });

    task = db.query("SELECT * FROM tasks WHERE id = '10'").get() as any;
    expect(task.owner).toBe("developer-1");
    expect(task.status).toBe("pending");

    // Step 3: TaskUpdate -- status to in_progress
    ingestEvent({
      hook_event_name: "PostToolUse",
      session_id: "lifecycle-sess",
      tool_name: "TaskUpdate",
      tool_input: { taskId: "10", status: "in_progress" },
      tool_response: "Updated task #10 status",
      cwd: "/project",
      permission_mode: "default",
    });

    task = db.query("SELECT * FROM tasks WHERE id = '10'").get() as any;
    expect(task.status).toBe("in_progress");

    // Step 4: TaskCompleted hook
    ingestEvent({
      hook_event_name: "TaskCompleted",
      session_id: "lifecycle-sess",
      task_id: "10",
      task_subject: "Implement feature X",
      teammate_name: "developer-1",
      team_name: "my-team",
      cwd: "/project",
      permission_mode: "default",
    });

    task = db.query("SELECT * FROM tasks WHERE id = '10'").get() as any;
    expect(task.status).toBe("completed");
    expect(task.completed_at).not.toBeNull();

    // Step 5: Verify full task_events history
    const events = db.query("SELECT event_type, field_name, old_value, new_value FROM task_events WHERE task_id = '10' ORDER BY id ASC").all() as any[];
    expect(events.length).toBe(4);

    // Event 1: created
    expect(events[0].event_type).toBe("created");

    // Event 2: assigned
    expect(events[1].event_type).toBe("assigned");
    expect(events[1].field_name).toBe("owner");
    expect(events[1].old_value).toBeNull();
    expect(events[1].new_value).toBe("developer-1");

    // Event 3: status_change (pending -> in_progress)
    expect(events[2].event_type).toBe("status_change");
    expect(events[2].field_name).toBe("status");
    expect(events[2].old_value).toBe("pending");
    expect(events[2].new_value).toBe("in_progress");

    // Event 4: completed (in_progress -> completed)
    expect(events[3].event_type).toBe("completed");
    expect(events[3].field_name).toBe("status");
    expect(events[3].old_value).toBe("in_progress");
    expect(events[3].new_value).toBe("completed");
  });
});
