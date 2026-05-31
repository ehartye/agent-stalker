import type { Database } from "bun:sqlite";

export interface UsageRow {
  message_uuid: string; session_id: string; agent_id: string | null; role: string;
  input_tokens: number; cache_creation_input_tokens: number;
  cache_read_input_tokens: number; output_tokens: number; timestamp: number;
}

export function parseTranscriptLines(lines: string[], sessionId: string, agentId: string | null): UsageRow[] {
  const out: UsageRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const usage = obj?.message?.usage;
    if (!usage || typeof usage.input_tokens !== "number") continue;
    const uuid = obj.uuid;
    if (!uuid) continue;
    out.push({
      message_uuid: String(uuid),
      session_id: sessionId,
      agent_id: agentId,
      role: obj.type ?? obj.message?.role ?? "assistant",
      input_tokens: usage.input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      timestamp: obj.timestamp ? Date.parse(obj.timestamp) : Date.now(),
    });
  }
  return out;
}

export function ingestUsageFromLines(db: Database, lines: string[], sessionId: string, agentId: string | null): number {
  const rows = parseTranscriptLines(lines, sessionId, agentId);
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO usage
     (message_uuid, session_id, agent_id, role, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  for (const r of rows) {
    const res = stmt.run(r.message_uuid, r.session_id, r.agent_id, r.role,
      r.input_tokens, r.cache_creation_input_tokens, r.cache_read_input_tokens, r.output_tokens, r.timestamp);
    if (res.changes > 0) inserted += 1;
  }
  return inserted;
}
