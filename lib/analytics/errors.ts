import type { Database } from "bun:sqlite";

interface EventRow { session_id: string; hook_event_name: string; tool_name: string | null; data: string | null; }

function isError(row: EventRow): boolean {
  if (row.hook_event_name === "PostToolUseFailure") return true;
  if (row.data) {
    try {
      const d = JSON.parse(row.data);
      if (d && d.error != null) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function toolCallRows(db: Database): EventRow[] {
  return db.query(
    "SELECT session_id, hook_event_name, tool_name, data FROM events WHERE hook_event_name IN ('PostToolUse','PostToolUseFailure')",
  ).all() as EventRow[];
}

export interface SessionErrorStat { session_id: string; errors: number; toolCalls: number; errorRate: number; }

export function sessionErrorStats(db: Database): SessionErrorStat[] {
  const rows = toolCallRows(db);
  const map = new Map<string, { errors: number; toolCalls: number }>();
  for (const r of rows) {
    const m = map.get(r.session_id) ?? { errors: 0, toolCalls: 0 };
    m.toolCalls += 1;
    if (isError(r)) m.errors += 1;
    map.set(r.session_id, m);
  }
  return [...map.entries()].map(([session_id, m]) => ({
    session_id, errors: m.errors, toolCalls: m.toolCalls,
    errorRate: m.toolCalls ? m.errors / m.toolCalls : 0,
  })).sort((a, b) => b.errors - a.errors);
}

export interface ToolErrorStat { tool_name: string; errors: number; }

export function errorsByTool(db: Database): ToolErrorStat[] {
  const rows = toolCallRows(db).filter(isError);
  const map = new Map<string, number>();
  for (const r of rows) {
    const t = r.tool_name ?? "(unknown)";
    map.set(t, (map.get(t) ?? 0) + 1);
  }
  return [...map.entries()].map(([tool_name, errors]) => ({ tool_name, errors }))
    .sort((a, b) => b.errors - a.errors);
}
