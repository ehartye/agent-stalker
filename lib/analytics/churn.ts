import type { Database } from "bun:sqlite";
import { extractFilePath } from "./extract";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

interface EventRow { session_id: string; tool_name: string | null; timestamp: number; data: string | null; }

export interface FileChurnStat { file_path: string; edits: number; sessions: number; medianGapMs: number; }

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function fileChurn(db: Database): FileChurnStat[] {
  const rows = db.query(
    "SELECT session_id, tool_name, timestamp, data FROM events WHERE hook_event_name = 'PostToolUse' AND tool_name IS NOT NULL ORDER BY timestamp ASC",
  ).all() as EventRow[];

  const byFile = new Map<string, { sessions: Set<string>; times: number[] }>();
  for (const r of rows) {
    if (!r.tool_name || !EDIT_TOOLS.has(r.tool_name) || !r.data) continue;
    let input: any;
    try { input = JSON.parse(r.data).tool_input; } catch { continue; }
    const fp = extractFilePath(r.tool_name, input);
    if (!fp) continue;
    const e = byFile.get(fp) ?? { sessions: new Set<string>(), times: [] };
    e.sessions.add(r.session_id);
    e.times.push(r.timestamp);
    byFile.set(fp, e);
  }

  return [...byFile.entries()].map(([file_path, e]) => {
    const gaps: number[] = [];
    for (let i = 1; i < e.times.length; i++) gaps.push(e.times[i] - e.times[i - 1]);
    return { file_path, edits: e.times.length, sessions: e.sessions.size, medianGapMs: median(gaps) };
  }).sort((a, b) => b.edits - a.edits);
}
