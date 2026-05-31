const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "Read", "NotebookEdit"]);

export function extractFilePath(toolName: string, toolInput: any): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  if (!FILE_TOOLS.has(toolName)) return null;
  return typeof toolInput.file_path === "string" ? toolInput.file_path : null;
}

/** A stable identity for "the thing this tool acted on", for retry detection. */
export function extractTarget(toolName: string, toolInput: any): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const filePath = extractFilePath(toolName, toolInput);
  if (filePath) return filePath;
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    return toolInput.command.trim();
  }
  // Fallback: deterministic stringification (sorted keys) so equal inputs match.
  const keys = Object.keys(toolInput).sort();
  if (keys.length === 0) return null;
  return JSON.stringify(keys.map((k) => [k, toolInput[k]]));
}
