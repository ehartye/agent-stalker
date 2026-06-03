import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { ingestUsageFromLines } from "./parse-transcript";

/** Ingest token usage for one session from its main transcript + any subagent transcripts. */
export function ingestUsageForSession(db: Database, sessionId: string): number {
  let inserted = 0;

  const session = db.query("SELECT transcript_path FROM sessions WHERE id = ?").get(sessionId) as { transcript_path: string | null } | null;
  if (session?.transcript_path && existsSync(session.transcript_path)) {
    const lines = readFileSync(session.transcript_path, "utf-8").split("\n");
    inserted += ingestUsageFromLines(db, lines, sessionId, null);
  }

  const agents = db.query("SELECT id, transcript_path FROM agents WHERE session_id = ? AND transcript_path IS NOT NULL").all(sessionId) as { id: string; transcript_path: string }[];
  for (const a of agents) {
    if (existsSync(a.transcript_path)) {
      const lines = readFileSync(a.transcript_path, "utf-8").split("\n");
      inserted += ingestUsageFromLines(db, lines, sessionId, a.id);
    }
  }
  return inserted;
}

/** Ingest usage for every session that has a transcript path (manual command). */
export function ingestUsageAll(db: Database): number {
  const sessions = db.query("SELECT id FROM sessions").all() as { id: string }[];
  let total = 0;
  for (const s of sessions) total += ingestUsageForSession(db, s.id);
  return total;
}

// CLI: `bun run lib/usage/ingest-usage.ts`
if (import.meta.main) {
  const { getDb } = await import("../db");
  const db = getDb();
  const n = ingestUsageAll(db);
  console.log(`Ingested ${n} usage rows.`);
}
