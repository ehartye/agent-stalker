import type { Database } from "bun:sqlite";
import { ANALYTICS_CONFIG } from "./config";
import { sessionErrorStats } from "./errors";
import { errorRetryChains, taskBounces } from "./thrash";
import { sessionEffort } from "./effort";

export interface PainEntry {
  session_id: string;
  score: number;
  breakdown: { errorRate: number; churn: number; thrash: number; effort: number };
  raw: { errorRate: number; churnEdits: number; thrashDepth: number; effort: number };
}

/** Normalize a value to 0..1 by dividing by the max in the set (0 if all zero). */
function normalizer(values: number[]): (v: number) => number {
  const max = Math.max(0, ...values);
  return (v: number) => (max > 0 ? v / max : 0);
}

export function painLeaderboard(db: Database): PainEntry[] {
  const errors = sessionErrorStats(db);
  const effort = sessionEffort(db);
  const chains = errorRetryChains(db);
  const bounces = taskBounces(db);

  // sessions = union of all session ids seen
  const sessionIds = new Set<string>();
  errors.forEach((e) => sessionIds.add(e.session_id));
  effort.forEach((e) => sessionIds.add(e.session_id));

  // per-session raw signals
  const errorRateBy = new Map(errors.map((e) => [e.session_id, e.errorRate]));
  const effortBy = new Map(effort.map((e) => [e.session_id, e.realTokens ?? e.bytes]));

  const thrashBy = new Map<string, number>();
  for (const c of chains) thrashBy.set(c.session_id, (thrashBy.get(c.session_id) ?? 0) + c.chainLength);
  for (const b of bounces) thrashBy.set(b.session_id, (thrashBy.get(b.session_id) ?? 0) + b.bounces);

  // churn is per-file; attribute to sessions via a per-session edit count
  const churnBy = new Map<string, number>();
  // recompute session churn from events: count edit events per session over churnMinEdits files
  const editRows = db.query(
    "SELECT session_id, COUNT(*) AS edits FROM events WHERE hook_event_name='PostToolUse' AND tool_name IN ('Edit','Write','MultiEdit','NotebookEdit') GROUP BY session_id",
  ).all() as { session_id: string; edits: number }[];
  for (const r of editRows) churnBy.set(r.session_id, r.edits);

  const ids = [...sessionIds];
  const normErr = normalizer(ids.map((id) => errorRateBy.get(id) ?? 0));
  const normChurn = normalizer(ids.map((id) => churnBy.get(id) ?? 0));
  const normThrash = normalizer(ids.map((id) => thrashBy.get(id) ?? 0));
  const normEffort = normalizer(ids.map((id) => effortBy.get(id) ?? 0));

  const w = ANALYTICS_CONFIG.painWeights;
  return ids.map((session_id) => {
    const rawErr = errorRateBy.get(session_id) ?? 0;
    const rawChurn = churnBy.get(session_id) ?? 0;
    const rawThrash = thrashBy.get(session_id) ?? 0;
    const rawEffort = effortBy.get(session_id) ?? 0;
    const breakdown = {
      errorRate: w.errorRate * normErr(rawErr),
      churn: w.churn * normChurn(rawChurn),
      thrash: w.thrash * normThrash(rawThrash),
      effort: w.effort * normEffort(rawEffort),
    };
    const score = breakdown.errorRate + breakdown.churn + breakdown.thrash + breakdown.effort;
    return { session_id, score, breakdown, raw: { errorRate: rawErr, churnEdits: rawChurn, thrashDepth: rawThrash, effort: rawEffort } };
  }).sort((a, b) => b.score - a.score);
}
