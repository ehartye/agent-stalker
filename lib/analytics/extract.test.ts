import { describe, it, expect } from "bun:test";
import { extractFilePath, extractTarget } from "./extract";

describe("extractFilePath", () => {
  it("returns file_path for Edit/Write/Read/MultiEdit", () => {
    expect(extractFilePath("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(extractFilePath("Write", { file_path: "/a/c.ts" })).toBe("/a/c.ts");
    expect(extractFilePath("MultiEdit", { file_path: "/a/d.ts" })).toBe("/a/d.ts");
    expect(extractFilePath("Read", { file_path: "/a/e.ts" })).toBe("/a/e.ts");
  });

  it("returns null for non-file tools or missing path", () => {
    expect(extractFilePath("Bash", { command: "ls" })).toBeNull();
    expect(extractFilePath("Edit", {})).toBeNull();
    expect(extractFilePath("Edit", null)).toBeNull();
  });
});

describe("extractTarget", () => {
  it("uses file_path for file tools", () => {
    expect(extractTarget("Edit", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
  });
  it("uses normalized command for Bash", () => {
    expect(extractTarget("Bash", { command: "  ls -la  " })).toBe("ls -la");
  });
  it("falls back to a stable JSON key for other tools", () => {
    expect(extractTarget("Grep", { pattern: "foo", path: "src" }))
      .toBe(extractTarget("Grep", { path: "src", pattern: "foo" }));
  });
  it("returns null for empty input", () => {
    expect(extractTarget("Edit", null)).toBeNull();
  });
});
