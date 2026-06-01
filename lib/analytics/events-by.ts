import type { Database } from "bun:sqlite";
import { extractFilePath, extractTarget } from "./extract";
import { sessionClause } from "./filter";

export interface ConstituentOpts {
  by: "file" | "tool" | "errorCluster" | "topic" | "retry";
  value: string;
  sessionIds?: string[];
  errorsOnly?: boolean;
  tool?: string;     // retry: the chain's tool
  session?: string;  // retry: the chain's single session
}

export interface EventRow {
  id: number; session_id: string; hook_event_name: string;
  tool_name: string | null; timestamp: number; data: string | null;
}

export interface ConstituentResult { events: EventRow[]; truncated: boolean; }

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX = 500;
const SELECT = "id, session_id, hook_event_name, tool_name, timestamp, data";

function isError(r: EventRow): boolean {
  if (r.hook_event_name === "PostToolUseFailure") return true;
  if (r.data) { try { return JSON.parse(r.data).error != null; } catch { return false; } }
  return false;
}

export function constituentEvents(db: Database, opts: ConstituentOpts): ConstituentResult {
  let rows: EventRow[] = [];

  if (opts.by === "file") {
    const { clause, params } = sessionClause(opts.sessionIds);
    const candidates = db.query(
      `SELECT ${SELECT} FROM events WHERE hook_event_name='PostToolUse' AND tool_name IS NOT NULL${clause} ORDER BY timestamp ASC`,
    ).all(...params) as EventRow[];
    rows = candidates.filter((r) => {
      if (!r.tool_name || !EDIT_TOOLS.has(r.tool_name) || !r.data) return false;
      try { return extractFilePath(r.tool_name, JSON.parse(r.data).tool_input) === opts.value; }
      catch { return false; }
    });
  } else if (opts.by === "tool") {
    const { clause, params } = sessionClause(opts.sessionIds);
    const all = db.query(
      `SELECT ${SELECT} FROM events WHERE tool_name = ?${clause} ORDER BY timestamp ASC`,
    ).all(opts.value, ...params) as EventRow[];
    rows = opts.errorsOnly ? all.filter(isError) : all;
  } else if (opts.by === "errorCluster") {
    const { clause, params } = sessionClause(opts.sessionIds, "e.session_id");
    rows = db.query(
      `SELECT e.id, e.session_id, e.hook_event_name, e.tool_name, e.timestamp, e.data
       FROM events e JOIN semantic_error_assignments a ON e.id = a.event_id
       WHERE a.cluster_id = ?${clause} ORDER BY e.timestamp ASC`,
    ).all(opts.value, ...params) as EventRow[];
  } else if (opts.by === "topic") {
    const { clause, params } = sessionClause(opts.sessionIds);
    const assigns = db.query(
      `SELECT doc_id FROM semantic_topic_assignments WHERE topic_id = ?${clause}`,
    ).all(opts.value, ...params) as { doc_id: string }[];
    const eventIds = assigns
      .map((a) => { const m = /^(?:prompt|assistant)-(\d+)$/.exec(a.doc_id); return m ? parseInt(m[1]) : null; })
      .filter((x): x is number => x != null);
    if (eventIds.length) {
      const ph = eventIds.map(() => "?").join(",");
      rows = db.query(
        `SELECT ${SELECT} FROM events WHERE id IN (${ph}) ORDER BY timestamp ASC`,
      ).all(...eventIds) as EventRow[];
    }
  } else if (opts.by === "retry") {
    const candidates = db.query(
      `SELECT ${SELECT} FROM events
       WHERE session_id = ? AND tool_name = ? AND hook_event_name IN ('PostToolUse','PostToolUseFailure')
       ORDER BY timestamp ASC`,
    ).all(opts.session ?? "", opts.tool ?? "") as EventRow[];
    rows = candidates.filter((r) => {
      if (!r.tool_name || !r.data) return false;
      try { return extractTarget(r.tool_name, JSON.parse(r.data).tool_input) === opts.value; }
      catch { return false; }
    });
  } else {
    throw new Error(`unknown by: ${opts.by}`);
  }

  return { events: rows.slice(0, MAX), truncated: rows.length > MAX };
}
