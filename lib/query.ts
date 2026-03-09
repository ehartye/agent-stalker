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
