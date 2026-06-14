import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getConfig, getContentRule, DEFAULT_CONFIG, isPaused } from "./config";
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
    expect(rule).toBe("metadata");
  });

  it("defaults Write capture to metadata", () => {
    const rule = getContentRule("Write");
    expect(rule).toBe("metadata");
  });

  it("returns default rule for unknown tool", () => {
    const rule = getContentRule("SomeNewTool");
    expect(rule).toEqual({ maxLength: 500 });
  });

  it("defaults ui to host 127.0.0.1 with no allowedHosts", () => {
    const config = getConfig();
    expect(config.ui).toEqual({ host: "127.0.0.1", allowedHosts: [] });
  });

  it("merges a partial ui section over defaults", () => {
    writeFileSync(testConfigPath, JSON.stringify({ ui: { host: "0.0.0.0" } }));
    const config = getConfig();
    expect(config.ui.host).toBe("0.0.0.0");
    expect(config.ui.allowedHosts).toEqual([]);
  });

  it("falls back to default ui when ui field is not an object", () => {
    writeFileSync(testConfigPath, JSON.stringify({ ui: "127.0.0.1" }));
    const config = getConfig();
    expect(config.ui).toEqual({ host: "127.0.0.1", allowedHosts: [] });
  });

  it("isPaused matches a backslash cwd against a forward-slash paused path", () => {
    writeFileSync(testConfigPath, JSON.stringify({ pausedPaths: ["C:/repos/proj"] }));
    expect(isPaused("C:\\repos\\proj")).toBe(true);
    expect(isPaused("C:\\repos\\proj\\sub")).toBe(true);
  });

  it("isPaused matches a forward-slash cwd against a backslash paused path", () => {
    writeFileSync(testConfigPath, JSON.stringify({ pausedPaths: ["C:\\repos\\proj"] }));
    expect(isPaused("C:/repos/proj")).toBe(true);
  });

  it("isPaused does not match a sibling directory sharing a prefix", () => {
    writeFileSync(testConfigPath, JSON.stringify({ pausedPaths: ["C:/repos/proj"] }));
    expect(isPaused("C:\\repos\\proj2")).toBe(false);
  });
});
