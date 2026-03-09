import type { ContentRule } from "./config";

const METADATA_STRIP_KEYS = new Set(["content", "data", "output", "text", "body", "result", "stdout", "stderr"]);

const TRUNCATION_SUFFIX = "... [truncated]";

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cutAt = Math.max(0, maxLength - TRUNCATION_SUFFIX.length);
  return value.slice(0, cutAt) + TRUNCATION_SUFFIX;
}

function stripToMetadata(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripToMetadata);
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (METADATA_STRIP_KEYS.has(key) && typeof value === "string") {
      continue;
    }
    result[key] = typeof value === "object" ? stripToMetadata(value) : value;
  }
  return result;
}

function truncateValues(obj: any, maxLength: number): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return truncateString(obj, maxLength);
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((v) => truncateValues(v, maxLength));
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = truncateValues(value, maxLength);
  }
  return result;
}

export function truncateContent(
  toolName: string,
  toolInput: any,
  toolResponse: any,
  rule: ContentRule,
): { tool_input: any; tool_response: any } {
  if (rule === "full") {
    return { tool_input: toolInput, tool_response: toolResponse };
  }
  if (rule === "metadata") {
    return {
      tool_input: stripToMetadata(toolInput),
      tool_response: stripToMetadata(toolResponse),
    };
  }
  const maxLength = rule.maxLength;
  return {
    tool_input: truncateValues(toolInput, maxLength),
    tool_response: truncateValues(toolResponse, maxLength),
  };
}
