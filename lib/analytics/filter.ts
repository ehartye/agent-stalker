// Optional session-scoping for analytics queries. When sessionIds is empty/undefined
// the metrics are global (all sessions); otherwise they are restricted to the set.
export function sessionClause(
  sessionIds: string[] | undefined,
  column = "session_id",
): { clause: string; params: string[] } {
  if (!sessionIds || sessionIds.length === 0) return { clause: "", params: [] };
  return {
    clause: ` AND ${column} IN (${sessionIds.map(() => "?").join(",")})`,
    params: sessionIds,
  };
}
