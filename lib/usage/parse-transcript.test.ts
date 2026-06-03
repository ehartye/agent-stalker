import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { parseTranscriptLines, ingestUsageFromLines } from "./parse-transcript";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SAMPLE = [
  JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", timestamp: "2026-05-31T10:00:00.000Z", message: { role: "user", content: "hi" } }),
  JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "s1", timestamp: "2026-05-31T10:00:01.000Z", message: { role: "assistant", usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 20 } } }),
  "not json, should be skipped",
  JSON.stringify({ type: "assistant", uuid: "a2", sessionId: "s1", timestamp: "2026-05-31T10:00:02.000Z", message: { role: "assistant" } }), // no usage -> skipped
];

describe("transcript parser", () => {
  let testDbPath: string;
  beforeEach(() => {
    testDbPath = join(tmpdir(), `as-usage-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
  });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("extracts only assistant lines that have usage", () => {
    const rows = parseTranscriptLines(SAMPLE, "s1", null);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      message_uuid: "a1", session_id: "s1", role: "assistant",
      input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 20,
    });
    expect(rows[0].timestamp).toBe(Date.parse("2026-05-31T10:00:01.000Z"));
  });

  it("ingests rows idempotently (INSERT OR IGNORE on uuid)", () => {
    const db = getDb();
    ingestUsageFromLines(db, SAMPLE, "s1", null);
    ingestUsageFromLines(db, SAMPLE, "s1", null); // second run no dupes
    const count = db.query("SELECT COUNT(*) c FROM usage").get() as { c: number };
    expect(count.c).toBe(1);
    const total = db.query("SELECT SUM(input_tokens) t FROM usage").get() as { t: number };
    expect(total.t).toBe(10);
  });
});
