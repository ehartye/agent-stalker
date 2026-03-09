import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type ContentRule = "full" | "metadata" | { maxLength: number };

export interface StalkerConfig {
  contentRules: Record<string, ContentRule>;
}

export const DEFAULT_CONFIG: StalkerConfig = {
  contentRules: {
    Edit: "full",
    Write: "full",
    Read: "metadata",
    Glob: "metadata",
    Grep: "metadata",
    Bash: { maxLength: 2000 },
    default: { maxLength: 500 },
  },
};

function getConfigPath(): string {
  if (process.env.AGENT_STALKER_CONFIG_PATH) {
    return process.env.AGENT_STALKER_CONFIG_PATH;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".claude", "agent-stalker.config.json");
}

export function getConfig(): StalkerConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      contentRules: { ...DEFAULT_CONFIG.contentRules, ...parsed.contentRules },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getContentRule(toolName: string): ContentRule {
  const config = getConfig();
  return config.contentRules[toolName] ?? config.contentRules.default ?? { maxLength: 500 };
}
