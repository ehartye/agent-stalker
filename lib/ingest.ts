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

function parseTaskIdFromResponse(response: any): string | null {
  if (typeof response === "string") {
    const match = response.match(/task\s+#?(\d+)/i);
    return match ? match[1] : null;
  }
  if (response && typeof response === "object" && response.taskId) {
    return String(response.taskId);
  }
  return null;
}

function handleTaskCreate(event: Record<string, any>): void {
  const input = event.tool_input;
  if (!input) return;
  const taskId = parseTaskIdFromResponse(event.tool_response);
  if (!taskId) return;

  const db = getDb();
  const now = Date.now();
  const blocks = input.addBlocks ? JSON.stringify(input.addBlocks) : null;
  const blockedBy = input.addBlockedBy ? JSON.stringify(input.addBlockedBy) : null;

  db.run(
    `INSERT OR IGNORE INTO tasks (id, session_id, subject, description, status, blocks, blocked_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [taskId, event.session_id, input.subject ?? null, input.description ?? null, blocks, blockedBy, now, now],
  );

  db.run(
    `INSERT INTO task_events (task_id, session_id, event_type, timestamp)
     VALUES (?, ?, 'created', ?)`,
    [taskId, event.session_id, now],
  );
}

function handleTaskUpdate(event: Record<string, any>): void {
  const input = event.tool_input;
  if (!input || !input.taskId) return;
  const taskId = String(input.taskId);

  const db = getDb();
  const now = Date.now();

  // Get current state
  const current = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as any;
  if (!current) return;

  // Record per-field events and build update
  if (input.owner !== undefined && input.owner !== current.owner) {
    db.run(
      `INSERT INTO task_events (task_id, session_id, event_type, field_name, old_value, new_value, timestamp)
       VALUES (?, ?, 'assigned', 'owner', ?, ?, ?)`,
      [taskId, event.session_id, current.owner, input.owner, now],
    );
  }

  if (input.status !== undefined && input.status !== current.status) {
    db.run(
      `INSERT INTO task_events (task_id, session_id, event_type, field_name, old_value, new_value, timestamp)
       VALUES (?, ?, 'status_change', 'status', ?, ?, ?)`,
      [taskId, event.session_id, current.status, input.status, now],
    );
  }

  // Build dynamic UPDATE
  const sets: string[] = ["updated_at = ?"];
  const params: any[] = [now];

  if (input.owner !== undefined) { sets.push("owner = ?"); params.push(input.owner); }
  if (input.status !== undefined) { sets.push("status = ?"); params.push(input.status); }
  if (input.subject !== undefined) { sets.push("subject = ?"); params.push(input.subject); }
  if (input.description !== undefined) { sets.push("description = ?"); params.push(input.description); }
  if (input.addBlocks) { sets.push("blocks = ?"); params.push(JSON.stringify(input.addBlocks)); }
  if (input.addBlockedBy) { sets.push("blocked_by = ?"); params.push(JSON.stringify(input.addBlockedBy)); }
  if (input.status === "completed") { sets.push("completed_at = ?"); params.push(now); }

  params.push(taskId);
  db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, params);
}

function handleToolUse(event: Record<string, any>): void {
  ensureSession(event);

  // Intercept PostToolUse for TaskCreate/TaskUpdate before truncation
  if (event.hook_event_name === "PostToolUse") {
    if (event.tool_name === "TaskCreate") {
      handleTaskCreate(event);
    } else if (event.tool_name === "TaskUpdate") {
      handleTaskUpdate(event);
    }
  }

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
  const now = Date.now();
  const existing = db.query("SELECT * FROM tasks WHERE id = ?").get(event.task_id) as any;

  if (existing) {
    // Update existing tracked task
    db.run(
      "UPDATE tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
      [now, now, event.task_id],
    );
    db.run(
      `INSERT INTO task_events (task_id, session_id, event_type, field_name, old_value, new_value, timestamp)
       VALUES (?, ?, 'completed', 'status', ?, 'completed', ?)`,
      [event.task_id, event.session_id, existing.status, now],
    );
  } else {
    // Fallback: create task with status='completed'
    db.run(
      "INSERT INTO tasks (id, session_id, subject, description, status, owner, team_name, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)",
      [event.task_id, event.session_id, event.task_subject, event.task_description ?? null, event.teammate_name ?? null, event.team_name ?? null, now, now, now],
    );
  }

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
