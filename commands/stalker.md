---
description: Query agent-stalker tracking data (sessions, events, tools, agents, tasks, stats)
allowed-tools: ["Bash", "Read"]
---

Run the agent-stalker query engine with the user's arguments.

Run: `bun "${CLAUDE_PLUGIN_ROOT}/lib/query.ts" $ARGUMENTS`

Present the output to the user. If no arguments are provided, show the help text.

Available subcommands:
- `sessions [--team <name>]` — list recent sessions
- `session <id>` — session detail
- `tools [--session <id>] [--agent <type>] [--name <tool>]` — tool use frequency
- `events [--session <id>] [--tool <name>] [--agent-id <id>] [--since <duration>]` — event log
- `event <id>` — full event detail with content
- `agents [--session <id>]` — agents spawned
- `tasks [--team <name>] [--status <status>] [--owner <name>]` — task list with status and owner
- `task <id>` — task detail with full event history
- `stats [--session <id>]` — summary statistics
