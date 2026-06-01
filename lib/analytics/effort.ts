import type { Database } from "bun:sqlite";
import { extractFilePath } from "./extract";
import { sessionClause } from "./filter";

interface EventRow { session_id: string; tool_name: string | null; timestamp: number; data: string | null; }

export interface SessionEffort {
  session_id: string; events: number; toolCalls: number; bytes: number;
  files: number; durationMs: number; realTokens: number | null;
}

export function sessionEffort(db: Database, sessionIds?: string[]): SessionEffort[] {
  const { clause, params } = sessionClause(sessionIds);
  const rows = db.query(
    `SELECT session_id, tool_name, timestamp, data FROM events WHERE 1=1${clause} ORDER BY timestamp ASC`,
  ).all(...params) as EventRow[];

  const map = new Map<string, { events: number; toolCalls: number; bytes: number; files: Set<string>; min: number; max: number }>();
  for (const r of rows) {
    const m = map.get(r.session_id) ?? { events: 0, toolCalls: 0, bytes: 0, files: new Set<string>(), min: r.timestamp, max: r.timestamp };
    m.events += 1;
    if (r.tool_name) m.toolCalls += 1;
    if (r.data) {
      m.bytes += r.data.length;
      try {
        const fp = extractFilePath(r.tool_name ?? "", JSON.parse(r.data).tool_input);
        if (fp) m.files.add(fp);
      } catch { /* ignore */ }
    }
    m.min = Math.min(m.min, r.timestamp);
    m.max = Math.max(m.max, r.timestamp);
    map.set(r.session_id, m);
  }

  // real tokens, if the usage table is populated
  const tokenRows = db.query(
    `SELECT session_id, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS total
     FROM usage WHERE 1=1${clause} GROUP BY session_id`,
  ).all(...params) as { session_id: string; total: number }[];
  const tokenMap = new Map(tokenRows.map((r) => [r.session_id, r.total]));

  return [...map.entries()].map(([session_id, m]) => ({
    session_id, events: m.events, toolCalls: m.toolCalls, bytes: m.bytes,
    files: m.files.size, durationMs: m.max - m.min,
    realTokens: tokenMap.has(session_id) ? tokenMap.get(session_id)! : null,
  })).sort((a, b) => b.events - a.events);
}
