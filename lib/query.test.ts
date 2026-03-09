import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { runQuery } from "./query";
import { ingestEvent } from "./ingest";
import { closeDb } from "./db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("query", () => {
  const testDbPath = join(tmpdir(), `agent-stalker-query-${Date.now()}.db`);

  beforeEach(() => {
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
    // Seed data
    ingestEvent({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/project-a", permission_mode: "default", source: "startup", model: "claude-sonnet-4-6" });
    ingestEvent({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t1", cwd: "/project-a", permission_mode: "default" });
    ingestEvent({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 }, tool_use_id: "t1", cwd: "/project-a", permission_mode: "default" });
    ingestEvent({ hook_event_name: "SessionEnd", session_id: "s1", reason: "other", cwd: "/project-a", permission_mode: "default" });
  });

  afterEach(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch {}
    try { unlinkSync(testDbPath + "-wal"); } catch {}
    try { unlinkSync(testDbPath + "-shm"); } catch {}
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("lists sessions", () => {
    const result = runQuery(["sessions"]);
    expect(result).toContain("s1");
  });

  it("shows session detail", () => {
    const result = runQuery(["session", "s1"]);
    expect(result).toContain("s1");
    expect(result).toContain("claude-sonnet-4-6");
  });

  it("lists events for a session", () => {
    const result = runQuery(["events", "--session", "s1"]);
    expect(result).toContain("PreToolUse");
    expect(result).toContain("PostToolUse");
  });

  it("filters events by tool", () => {
    const result = runQuery(["events", "--tool", "Bash"]);
    expect(result).toContain("Bash");
  });

  it("shows stats", () => {
    const result = runQuery(["stats"]);
    expect(result).toContain("1"); // 1 session
  });

  it("lists tools with counts", () => {
    const result = runQuery(["tools"]);
    expect(result).toContain("Bash");
  });

  it("shows event detail", () => {
    const result = runQuery(["event", "1"]);
    expect(result).toContain("SessionStart");
  });
});
