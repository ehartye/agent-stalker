import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall, seedToolFailure } from "./test-helpers";
import { sessionErrorStats, errorsByTool } from "./errors";

describe("error metrics", () => {
  const testDbPath = join(tmpdir(), `as-errors-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("computes per-session error count and rate", () => {
    seedSession("s1");
    seedToolCall("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Bash", { command: "ls" });
    seedToolFailure("s1", "Bash", { command: "bad" });

    const stats = sessionErrorStats(getDb());
    const row = stats.find((r) => r.session_id === "s1")!;
    expect(row.errors).toBe(1);
    expect(row.toolCalls).toBe(4); // 3 PostToolUse + 1 PostToolUseFailure
    expect(row.errorRate).toBeCloseTo(0.25, 5);
  });

  it("counts data.error on PostToolUse as an error too", () => {
    seedSession("s2");
    const db = getDb();
    db.run(
      `INSERT INTO events (session_id, hook_event_name, tool_name, timestamp, data) VALUES (?, 'PostToolUse', 'Edit', 1, ?)`,
      ["s2", JSON.stringify({ tool_input: { file_path: "/x" }, error: "nope" })],
    );
    const row = sessionErrorStats(db).find((r) => r.session_id === "s2")!;
    expect(row.errors).toBe(1);
  });

  it("aggregates errors by tool", () => {
    seedSession("s3");
    seedToolFailure("s3", "Bash", { command: "a" });
    seedToolFailure("s3", "Bash", { command: "b" });
    seedToolFailure("s3", "Edit", { file_path: "/y" });
    const byTool = errorsByTool(getDb());
    expect(byTool.find((r) => r.tool_name === "Bash")!.errors).toBe(2);
    expect(byTool.find((r) => r.tool_name === "Edit")!.errors).toBe(1);
  });

  it("scopes to the given session ids when provided", () => {
    seedSession("keep");
    seedSession("drop");
    seedToolFailure("keep", "Bash", { command: "a" });
    seedToolCall("keep", "Bash", { command: "b" });
    seedToolFailure("drop", "Edit", { file_path: "/z" });

    const scoped = sessionErrorStats(getDb(), ["keep"]);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].session_id).toBe("keep");
    expect(scoped[0].errors).toBe(1);

    // errorsByTool restricted to "keep" excludes the Edit failure in "drop"
    const byTool = errorsByTool(getDb(), ["keep"]);
    expect(byTool.find((r) => r.tool_name === "Edit")).toBeUndefined();
    expect(byTool.find((r) => r.tool_name === "Bash")!.errors).toBe(1);

    // no filter → both sessions counted
    expect(sessionErrorStats(getDb()).length).toBe(2);
  });
});
