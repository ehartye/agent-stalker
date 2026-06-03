import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { ingestUsageForSession } from "./ingest-usage";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ingestUsageForSession", () => {
  let testDbPath: string;
  let transcriptPath: string;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `as-usage-job-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    transcriptPath = join(tmpdir(), `as-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
    writeFileSync(transcriptPath, [
      JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "s1", timestamp: "2026-05-31T10:00:01.000Z", message: { usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
    ].join("\n"));
  });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    try { unlinkSync(transcriptPath); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("reads the session transcript file and inserts usage rows", () => {
    const db = getDb();
    db.run("INSERT INTO sessions (id, transcript_path, started_at) VALUES ('s1', ?, 1)", [transcriptPath]);
    const inserted = ingestUsageForSession(db, "s1");
    expect(inserted).toBe(1);
    const row = db.query("SELECT * FROM usage WHERE session_id='s1'").get() as any;
    expect(row.input_tokens).toBe(7);
  });

  it("returns 0 when the session has no transcript_path", () => {
    const db = getDb();
    db.run("INSERT INTO sessions (id, started_at) VALUES ('s2', 1)");
    expect(ingestUsageForSession(db, "s2")).toBe(0);
  });
});
