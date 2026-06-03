import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall, seedToolFailure, seedEvent } from "./test-helpers";
import { errorRetryChains, taskBounces } from "./thrash";

describe("thrash metrics", () => {
  let testDbPath: string;
  beforeEach(() => {
    testDbPath = join(tmpdir(), `as-thrash-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
  });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("detects an error→retry chain on the same tool+target", () => {
    seedSession("s1");
    // fail Edit /a.ts, then retry Edit /a.ts within window
    seedToolFailure("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 1000, agent_id: "ag1" });
    seedToolCall("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 2000, agent_id: "ag1" });
    seedToolFailure("s1", "Edit", { file_path: "/a.ts" }, { timestamp: 3000, agent_id: "ag1" });

    const chains = errorRetryChains(getDb());
    const c = chains.find((x) => x.session_id === "s1" && x.target === "/a.ts")!;
    expect(c.chainLength).toBeGreaterThanOrEqual(2);
  });

  it("does not chain across a long time gap", () => {
    seedSession("s2");
    seedToolFailure("s2", "Edit", { file_path: "/a.ts" }, { timestamp: 1000, agent_id: "ag1" });
    // retry 10 minutes later — beyond the 2-minute window
    seedToolCall("s2", "Edit", { file_path: "/a.ts" }, { timestamp: 1000 + 10 * 60 * 1000, agent_id: "ag1" });
    const chains = errorRetryChains(getDb());
    expect(chains.find((x) => x.session_id === "s2")).toBeUndefined();
  });

  it("counts task status bounces (re-entering a prior status)", () => {
    seedSession("s3");
    const db = getDb();
    db.run("INSERT INTO tasks (id, session_id, status) VALUES ('1','s3','pending')");
    const ins = (oldV: string, newV: string, ts: number) => db.run(
      `INSERT INTO task_events (task_id, session_id, event_type, field_name, old_value, new_value, timestamp)
       VALUES ('1','s3','status_change','status', ?, ?, ?)`, [oldV, newV, ts]);
    ins("pending", "in_progress", 1);
    ins("in_progress", "blocked", 2);
    ins("blocked", "in_progress", 3); // re-enters in_progress -> bounce
    const bounces = taskBounces(db);
    const b = bounces.find((x) => x.task_id === "1" && x.session_id === "s3")!;
    expect(b.bounces).toBe(1);
  });
});
