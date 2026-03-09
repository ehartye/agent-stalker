import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

interface TeamContext {
  team_name: string;
  teammate_name: string;
}

interface TeamMember {
  name: string;
  agentId: string;
  agentType: string;
}

interface TeamConfig {
  members: TeamMember[];
}

function getTeamsDir(): string {
  if (process.env.AGENT_STALKER_TEAMS_DIR) {
    return process.env.AGENT_STALKER_TEAMS_DIR;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".claude", "teams");
}

export function resolveTeamContext(event: Record<string, any>): TeamContext | null {
  if (event.team_name && event.teammate_name) {
    return { team_name: event.team_name, teammate_name: event.teammate_name };
  }

  const agentId = event.agent_id;
  if (!agentId) return null;

  const teamsDir = getTeamsDir();
  if (!existsSync(teamsDir)) return null;

  try {
    const teamDirs = readdirSync(teamsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const teamName of teamDirs) {
      const configPath = join(teamsDir, teamName, "config.json");
      if (!existsSync(configPath)) continue;

      const raw = readFileSync(configPath, "utf-8");
      const config: TeamConfig = JSON.parse(raw);
      const member = config.members?.find((m) => m.agentId === agentId);
      if (member) {
        return { team_name: teamName, teammate_name: member.name };
      }
    }
  } catch {
    // Scan failed, return null
  }

  return null;
}
