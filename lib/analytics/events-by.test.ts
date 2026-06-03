import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getDb, closeDb } from "../db";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { seedSession, seedToolCall, seedToolFailure, seedEvent } from "./test-helpers";
import { constituentEvents } from "./events-by";

describe("constituentEvents", () => {
  let testDbPath: string;
  beforeEach(() => {
    testDbPath = join(tmpdir(), `as-eventsby-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.AGENT_STALKER_DB_PATH = testDbPath;
  });
  afterEach(() => {
    closeDb();
    for (const s of ["", "-wal", "-shm"]) { try { unlinkSync(testDbPath + s); } catch {} }
    delete process.env.AGENT_STALKER_DB_PATH;
  });

  it("by=file returns edit events for that file", () => {
    seedSession("s1");
    seedToolCall("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Write", { file_path: "/a.ts" });
    seedToolCall("s1", "Edit", { file_path: "/b.ts" });
    seedToolCall("s1", "Read", { file_path: "/a.ts" }); // not an edit
    const { events } = constituentEvents(getDb(), { by: "file", value: "/a.ts" });
    expect(events.length).toBe(2);
    expect(events.every((e) => e.tool_name === "Edit" || e.tool_name === "Write")).toBe(true);
  });

  it("by=tool with errorsOnly returns only failures of that tool", () => {
    seedSession("s1");
    seedToolCall("s1", "Bash", { command: "ok" });
    seedToolFailure("s1", "Bash", { command: "bad" });
    seedToolFailure("s1", "Edit", { file_path: "/x" });
    const { events } = constituentEvents(getDb(), { by: "tool", value: "Bash", errorsOnly: true });
    expect(events.length).toBe(1);
    expect(events[0].hook_event_name).toBe("PostToolUseFailure");
  });

  it("by=errorCluster joins semantic_error_assignments", () => {
    seedSession("s1");
    seedToolFailure("s1", "Bash", { command: "a" }); // event id 1
    seedToolFailure("s1", "Bash", { command: "b" }); // event id 2
    const db = getDb();
    db.run("INSERT INTO semantic_error_assignments (event_id, session_id, cluster_id) VALUES (1,'s1',7)");
    db.run("INSERT INTO semantic_error_assignments (event_id, session_id, cluster_id) VALUES (2,'s1',9)");
    const { events } = constituentEvents(db, { by: "errorCluster", value: "7" });
    expect(events.length).toBe(1);
    expect(events[0].id).toBe(1);
  });

  it("by=topic maps doc ids to events", () => {
    seedSession("s1");
    seedEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit", data: { prompt: "hi" } }); // id 1
    const db = getDb();
    db.run("INSERT INTO semantic_topic_assignments (doc_id, session_id, topic_id, prob) VALUES ('prompt-1','s1',3,0.9)");
    db.run("INSERT INTO semantic_topic_assignments (doc_id, session_id, topic_id, prob) VALUES ('task-9-s1','s1',3,0.5)"); // no event
    const { events } = constituentEvents(db, { by: "topic", value: "3" });
    expect(events.length).toBe(1);
    expect(events[0].id).toBe(1);
  });

  it("by=retry filters one session+tool to a target", () => {
    seedSession("s1");
    seedToolFailure("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Edit", { file_path: "/a.ts" });
    seedToolCall("s1", "Edit", { file_path: "/b.ts" });
    const { events } = constituentEvents(getDb(), { by: "retry", value: "/a.ts", tool: "Edit", session: "s1" });
    expect(events.length).toBe(2);
  });

  it("scopes by sessionIds and caps at 500", () => {
    seedSession("keep"); seedSession("drop");
    seedToolFailure("keep", "Bash", { command: "a" });
    seedToolFailure("drop", "Bash", { command: "b" });
    const { events } = constituentEvents(getDb(), { by: "tool", value: "Bash", errorsOnly: true, sessionIds: ["keep"] });
    expect(events.length).toBe(1);
    expect(events[0].session_id).toBe("keep");
  });

  it("caps results at 500 and sets truncated", () => {
    seedSession("s1");
    for (let i = 0; i < 600; i++) seedToolCall("s1", "Bash", { command: `c${i}` });
    const { events, truncated } = constituentEvents(getDb(), { by: "tool", value: "Bash" });
    expect(events.length).toBe(500);
    expect(truncated).toBe(true);
  });

  it("throws on unknown by", () => {
    expect(() => constituentEvents(getDb(), { by: "nope" as any, value: "x" })).toThrow();
  });
});
