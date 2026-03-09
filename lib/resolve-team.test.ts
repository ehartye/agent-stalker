import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveTeamContext } from "./resolve-team";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("resolveTeamContext", () => {
  const testDir = join(tmpdir(), `agent-stalker-test-teams-${Date.now()}`);
  const teamsDir = join(testDir, ".claude", "teams");

  beforeEach(() => {
    process.env.AGENT_STALKER_TEAMS_DIR = teamsDir;
    mkdirSync(join(teamsDir, "my-project"), { recursive: true });
    writeFileSync(
      join(teamsDir, "my-project", "config.json"),
      JSON.stringify({
        members: [
          { name: "researcher", agentId: "agent-abc", agentType: "Explore" },
          { name: "implementer", agentId: "agent-def", agentType: "general-purpose" },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.AGENT_STALKER_TEAMS_DIR;
  });

  it("resolves team context by agent_id", () => {
    const result = resolveTeamContext({ agent_id: "agent-abc" });
    expect(result?.team_name).toBe("my-project");
    expect(result?.teammate_name).toBe("researcher");
  });

  it("returns null when no match found", () => {
    const result = resolveTeamContext({ agent_id: "agent-unknown" });
    expect(result).toBeNull();
  });

  it("returns null when no agent_id provided", () => {
    const result = resolveTeamContext({});
    expect(result).toBeNull();
  });

  it("passes through team_name and teammate_name if already present", () => {
    const result = resolveTeamContext({ team_name: "direct-team", teammate_name: "direct-mate" });
    expect(result?.team_name).toBe("direct-team");
    expect(result?.teammate_name).toBe("direct-mate");
  });
});
