import { describe, it, expect } from "bun:test";
import { truncateContent } from "./truncate";

describe("truncateContent", () => {
  it("returns full content for 'full' rule", () => {
    const input = { file_path: "/foo.ts", content: "a".repeat(10000) };
    const response = { success: true };
    const result = truncateContent("Edit", input, response, "full");
    expect(result.tool_input).toEqual(input);
    expect(result.tool_response).toEqual(response);
  });

  it("strips content for 'metadata' rule", () => {
    const input = { file_path: "/foo.ts", content: "a".repeat(10000) };
    const response = { filePath: "/foo.ts", success: true, data: "lots of data" };
    const result = truncateContent("Read", input, response, "metadata");
    expect(result.tool_input.file_path).toBe("/foo.ts");
    expect(result.tool_input.content).toBeUndefined();
    expect(result.tool_response.data).toBeUndefined();
  });

  it("truncates content for maxLength rule", () => {
    const input = { command: "a".repeat(5000) };
    const response = { output: "b".repeat(5000) };
    const result = truncateContent("Bash", input, response, { maxLength: 100 });
    expect(result.tool_input.command.length).toBeLessThanOrEqual(113); // 100 + "... [truncated]"
    expect(result.tool_response.output.length).toBeLessThanOrEqual(113);
  });

  it("handles null/undefined inputs gracefully", () => {
    const result = truncateContent("Bash", null, undefined, "full");
    expect(result.tool_input).toBeNull();
    expect(result.tool_response).toBeUndefined();
  });
});
