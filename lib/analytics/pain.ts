import type { Database } from "bun:sqlite";
import { ANALYTICS_CONFIG } from "./config";
import { sessionErrorStats } from "./errors";
import { errorRetryChains, taskBounces } from "./thrash";
import { sessionEffort } from "./effort";
import { sessionClause } from "./filter";

export interface PainEntry {
  session_id: string;
  score: number;
  breakdown: { errorRate: number; churn: number; thrash: number; effort: number };
  // Pre-weight normalized signals (each 0..1 against its own max), so a UI can
  // render comparable bars. `breakdown` is these multiplied by the pain weights.
  normalized: { errorRate: number; churn: number; thrash: number; effort: number };
  raw: { errorRate: number; churnEdits: number; thrashDepth: number; effort: number };
}

/** Normalize a value to 0..1 by dividing by the max in the set (0 if all zero). */
function normalizer(values: number[]): (v: number) => number {
  const max = Math.max(0, ...values);
  return (v: number) => (max > 0 ? v / max : 0);
}

export function painLeaderboard(db: Database, sessionIds?: string[]): PainEntry[] {
  const errors = sessionErrorStats(db, sessionIds);
  const effort = sessionEffort(db, sessionIds);
  const chains = errorRetryChains(db, sessionIds);
  const bounces = taskBounces(db, sessionIds);

  // sessions = union of all session ids seen
  const seenIds = new Set<string>();
  errors.forEach((e) => seenIds.add(e.session_id));
  effort.forEach((e) => seenIds.add(e.session_id));

  // per-session raw signals
  const errorRateBy = new Map(errors.map((e) => [e.session_id, e.errorRate]));
  const effortBy = new Map(effort.map((e) => [e.session_id, e.realTokens ?? e.bytes]));

  const thrashBy = new Map<string, number>();
  for (const c of chains) thrashBy.set(c.session_id, (thrashBy.get(c.session_id) ?? 0) + c.chainLength);
  for (const b of bounces) thrashBy.set(b.session_id, (thrashBy.get(b.session_id) ?? 0) + b.bounces);

  // churn is per-file; attribute to sessions via a per-session edit count
  const churnBy = new Map<string, number>();
  // recompute session churn from events: count edit events per session over churnMinEdits files
  const editFilter = sessionClause(sessionIds);
  const editRows = db.query(
    `SELECT session_id, COUNT(*) AS edits FROM events WHERE hook_event_name='PostToolUse' AND tool_name IN ('Edit','Write','MultiEdit','NotebookEdit')${editFilter.clause} GROUP BY session_id`,
  ).all(...editFilter.params) as { session_id: string; edits: number }[];
  for (const r of editRows) churnBy.set(r.session_id, r.edits);

  const ids = [...seenIds];
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
    const normalized = {
      errorRate: normErr(rawErr),
      churn: normChurn(rawChurn),
      thrash: normThrash(rawThrash),
      effort: normEffort(rawEffort),
    };
    const breakdown = {
      errorRate: w.errorRate * normalized.errorRate,
      churn: w.churn * normalized.churn,
      thrash: w.thrash * normalized.thrash,
      effort: w.effort * normalized.effort,
    };
    const score = breakdown.errorRate + breakdown.churn + breakdown.thrash + breakdown.effort;
    return { session_id, score, breakdown, normalized, raw: { errorRate: rawErr, churnEdits: rawChurn, thrashDepth: rawThrash, effort: rawEffort } };
  }).sort((a, b) => b.score - a.score);
}
