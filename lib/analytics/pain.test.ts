import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall, seedToolFailure } from "./test-helpers";
import { painLeaderboard } from "./pain";

describe("pain score", () => {
  const testDbPath = join(tmpdir(), `as-pain-${Date.now()}.db`);
  beforeEach(() => { process.env.AGENT_STALKER_DB_PATH = testDbPath; });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("ranks a high-error/high-churn session above a clean one, with an explainable breakdown", () => {
    // painful session
    seedSession("painful");
    for (let i = 0; i < 5; i++) {
      seedToolFailure("painful", "Edit", { file_path: "/hot.ts" }, { timestamp: 1000 + i * 1000, agent_id: "ag1" });
      seedToolCall("painful", "Edit", { file_path: "/hot.ts" }, { timestamp: 1500 + i * 1000, agent_id: "ag1" });
    }
    // clean session
    seedSession("clean");
    seedToolCall("clean", "Edit", { file_path: "/a.ts" }, { timestamp: 1000 });
    seedToolCall("clean", "Bash", { command: "ls" }, { timestamp: 2000 });

    const board = painLeaderboard(getDb());
    expect(board[0].session_id).toBe("painful");
    expect(board[0].score).toBeGreaterThan(board[board.length - 1].score);
    // breakdown is present and explains the score
    expect(board[0].breakdown).toHaveProperty("errorRate");
    expect(board[0].breakdown).toHaveProperty("churn");
    expect(board[0].breakdown).toHaveProperty("thrash");
    expect(board[0].breakdown).toHaveProperty("effort");
  });
});
