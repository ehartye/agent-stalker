import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getConfig, getContentRule, DEFAULT_CONFIG } from "./config";
import { unlinkSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("config", () => {
  const testDir = join(tmpdir(), "agent-stalker-test-config");
  const testConfigPath = join(testDir, "agent-stalker.config.json");
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    mkdirSync(join(testDir, ".claude"), { recursive: true });
    process.env.AGENT_STALKER_CONFIG_PATH = testConfigPath;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.AGENT_STALKER_CONFIG_PATH;
    try { unlinkSync(testConfigPath); } catch {}
  });

  it("returns default config when no file exists", () => {
    const config = getConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("reads config from file", () => {
    const custom = { contentRules: { Bash: "full", default: { maxLength: 100 } } };
    writeFileSync(testConfigPath, JSON.stringify(custom));
    const config = getConfig();
    expect(config.contentRules.Bash).toBe("full");
  });

  it("returns correct content rule for known tool", () => {
    const rule = getContentRule("Edit");
    expect(rule).toBe("full");
  });

  it("returns default rule for unknown tool", () => {
    const rule = getContentRule("SomeNewTool");
    expect(rule).toEqual({ maxLength: 500 });
  });
});
