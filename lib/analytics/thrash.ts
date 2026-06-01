import type { Database } from "bun:sqlite";
import { extractTarget } from "./extract";
import { ANALYTICS_CONFIG } from "./config";
import { sessionClause } from "./filter";

interface EventRow {
  session_id: string; hook_event_name: string; tool_name: string | null;
  agent_id: string | null; timestamp: number; data: string | null;
}

export interface RetryChain { session_id: string; agent_id: string | null; tool_name: string; target: string; chainLength: number; }

/**
 * A chain link = two adjacent calls to the same (agent, tool, target) within
 * retryWindowMs where at least one of the pair is a failure. chainLength counts
 * the links — i.e. how much retrying/churn clustered around failures on that target.
 */
export function errorRetryChains(db: Database, sessionIds?: string[]): RetryChain[] {
  const { clause, params } = sessionClause(sessionIds);
  const rows = db.query(
    `SELECT session_id, hook_event_name, tool_name, agent_id, timestamp, data
     FROM events WHERE hook_event_name IN ('PostToolUse','PostToolUseFailure') AND tool_name IS NOT NULL${clause}
     ORDER BY timestamp ASC`,
  ).all(...params) as EventRow[];

  // group by session|agent|tool|target
  const groups = new Map<string, { row: EventRow; isError: boolean; target: string }[]>();
  for (const r of rows) {
    if (!r.data || !r.tool_name) continue;
    let input: any;
    try { input = JSON.parse(r.data).tool_input; } catch { continue; }
    const target = extractTarget(r.tool_name, input);
    if (!target) continue;
    const key = `${r.session_id}|${r.agent_id ?? ""}|${r.tool_name}|${target}`;
    const isError = r.hook_event_name === "PostToolUseFailure" ||
      (() => { try { return JSON.parse(r.data!).error != null; } catch { return false; } })();
    const arr = groups.get(key) ?? [];
    arr.push({ row: r, isError, target });
    groups.set(key, arr);
  }

  const out: RetryChain[] = [];
  for (const [key, items] of groups) {
    items.sort((a, b) => a.row.timestamp - b.row.timestamp);
    let chainLength = 0;
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1], cur = items[i];
      const withinWindow = cur.row.timestamp - prev.row.timestamp <= ANALYTICS_CONFIG.retryWindowMs;
      const isLink = (prev.isError || cur.isError) && withinWindow;
      if (isLink) chainLength += 1;
    }
    if (chainLength > 0) {
      const [session_id, agent_id, tool_name] = key.split("|");
      out.push({ session_id, agent_id: agent_id || null, tool_name, target: items[0].target, chainLength });
    }
  }
  return out.sort((a, b) => b.chainLength - a.chainLength);
}

interface TaskEventRow { task_id: string; session_id: string; new_value: string | null; timestamp: number; }

export interface TaskBounce { task_id: string; session_id: string; bounces: number; }

/** A bounce = a status_change whose new_value equals a status the task was already in earlier. */
export function taskBounces(db: Database, sessionIds?: string[]): TaskBounce[] {
  const { clause, params } = sessionClause(sessionIds);
  const rows = db.query(
    `SELECT task_id, session_id, new_value, timestamp FROM task_events
     WHERE event_type = 'status_change'${clause} ORDER BY timestamp ASC`,
  ).all(...params) as TaskEventRow[];

  const seen = new Map<string, Set<string>>(); // key task|session -> statuses seen
  const bounceCount = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.task_id}|${r.session_id}`;
    const set = seen.get(key) ?? new Set<string>();
    if (r.new_value && set.has(r.new_value)) {
      bounceCount.set(key, (bounceCount.get(key) ?? 0) + 1);
    }
    if (r.new_value) set.add(r.new_value);
    seen.set(key, set);
  }
  return [...bounceCount.entries()].map(([key, bounces]) => {
    const [task_id, session_id] = key.split("|");
    return { task_id, session_id, bounces };
  }).sort((a, b) => b.bounces - a.bounces);
}
