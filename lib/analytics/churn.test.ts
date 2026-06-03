import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall } from "./test-helpers";
import { fileChurn } from "./churn";

describe("churn metrics", () => {
  let testDbPath: string;
  beforeEach(() => {
    testDbPath = join(tmpdir(), `as-churn-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
  });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("counts edits per file and the sessions touching it", () => {
    seedSession("s1");
    seedToolCall("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 1000 });
    seedToolCall("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 2000 });
    seedToolCall("s1", "Write", { file_path: "/a.ts" }, { timestamp: 3000 });
    seedToolCall("s1", "Read", { file_path: "/a.ts" }, { timestamp: 4000 }); // not an edit
    seedToolCall("s1", "Edit", { file_path: "/b.ts" }, { timestamp: 5000 });

    const churn = fileChurn(getDb());
    const a = churn.find((c) => c.file_path === "/a.ts")!;
    expect(a.edits).toBe(3);          // 2 Edit + 1 Write, Read excluded
    expect(a.sessions).toBe(1);
    expect(a.medianGapMs).toBe(1000); // gaps: 1000, 1000 -> median 1000
  });

  it("orders files by edit count descending", () => {
    seedSession("s1");
    seedToolCall("s1", "Edit", { file_path: "/low.ts" });
    seedToolCall("s1", "Edit", { file_path: "/high.ts" });
    seedToolCall("s1", "Edit", { file_path: "/high.ts" });
    const churn = fileChurn(getDb());
    expect(churn[0].file_path).toBe("/high.ts");
  });
});
