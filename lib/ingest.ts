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
