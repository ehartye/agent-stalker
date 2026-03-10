import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type ContentRule = "full" | "metadata" | { maxLength: number };

export interface StalkerConfig {
  contentRules: Record<string, ContentRule>;
  pausedPaths: string[];
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
  pausedPaths: [],
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
      pausedPaths: parsed.pausedPaths ?? [],
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function getContentRule(toolName: string): ContentRule {
  const config = getConfig();
  return config.contentRules[toolName] ?? config.contentRules.default ?? { maxLength: 500 };
}

export function isPaused(cwd: string): boolean {
  const config = getConfig();
  return config.pausedPaths.some(
    (p) => cwd === p || cwd.startsWith(p + "/"),
  );
}

export function writeConfig(config: StalkerConfig): void {
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function addPausedPath(path: string): void {
  const config = getConfig();
  if (!config.pausedPaths.includes(path)) {
    config.pausedPaths.push(path);
    writeConfig(config);
  }
}

export function removePausedPath(path: string): void {
  const config = getConfig();
  config.pausedPaths = config.pausedPaths.filter((p) => p !== path);
  writeConfig(config);
}
