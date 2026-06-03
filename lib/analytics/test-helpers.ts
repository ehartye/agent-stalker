import { getDb } from "../db";

let eventClock = 1_700_000_000_000;

/** Insert a session row (id only is enough for most analytics). */
export function seedSession(id: string, extra: Record<string, any> = {}): void {
  const db = getDb();
  db.run(
    "INSERT OR IGNORE INTO sessions (id, cwd, started_at) VALUES (?, ?, ?)",
    [id, extra.cwd ?? "/repo", extra.started_at ?? eventClock],
  );
}

/**
 * Insert an event. `data` is stored as JSON (matching ingest behavior).
 * Pass an explicit timestamp or let the helper auto-increment.
 */
export function seedEvent(opts: {
  session_id: string;
  hook_event_name: string;
  tool_name?: string;
  agent_id?: string;
  timestamp?: number;
  data?: any;
}): void {
  const db = getDb();
  const ts = opts.timestamp ?? (eventClock += 1000);
  db.run(
    `INSERT INTO events (session_id, hook_event_name, agent_id, timestamp, tool_name, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      opts.session_id,
      opts.hook_event_name,
      opts.agent_id ?? null,
      ts,
      opts.tool_name ?? null,
      opts.data ? JSON.stringify(opts.data) : null,
    ],
  );
}

/** Convenience: a successful tool call (PostToolUse). */
export function seedToolCall(session_id: string, tool_name: string, toolInput: any, opts: { agent_id?: string; timestamp?: number } = {}): void {
  seedEvent({
    session_id, hook_event_name: "PostToolUse", tool_name,
    agent_id: opts.agent_id, timestamp: opts.timestamp,
    data: { tool_input: toolInput, tool_response: { ok: true } },
  });
}

/** Convenience: a failed tool call (PostToolUseFailure). */
export function seedToolFailure(session_id: string, tool_name: string, toolInput: any, opts: { agent_id?: string; timestamp?: number } = {}): void {
  seedEvent({
    session_id, hook_event_name: "PostToolUseFailure", tool_name,
    agent_id: opts.agent_id, timestamp: opts.timestamp,
    data: { tool_input: toolInput, error: "boom" },
  });
}
