import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall } from "./test-helpers";
import { sessionEffort } from "./effort";

describe("effort proxy", () => {
  const testDbPath = join(tmpdir(), `as-effort-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("aggregates events, tool calls, bytes, files, and duration per session", () => {
    seedSession("s1");
    seedToolCall("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 1000 });
    seedToolCall("s1", "Edit", { file_path: "/b.ts" }, { timestamp: 4000 });
    const e = sessionEffort(getDb()).find((r) => r.session_id === "s1")!;
    expect(e.events).toBe(2);
    expect(e.toolCalls).toBe(2);
    expect(e.files).toBe(2);
    expect(e.durationMs).toBe(3000);
    expect(e.bytes).toBeGreaterThan(0);
  });

  it("prefers real tokens from the usage table when present", () => {
    seedSession("s2");
    seedToolCall("s2", "Edit", { file_path: "/a.ts" });
    const db = getDb();
    db.run(`INSERT INTO usage (message_uuid, session_id, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
            VALUES ('m1','s2',100,50,0,0)`);
    const e = sessionEffort(db).find((r) => r.session_id === "s2")!;
    expect(e.realTokens).toBe(150);
  });
});
