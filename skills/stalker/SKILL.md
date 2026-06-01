---
name: stalker
description: This skill should be used when the user runs "/stalker" or asks to query agent-stalker's tracked data — "list tracked sessions", "show tool usage", "what events happened in session X", "list agents", "show tasks", "agent-stalker stats", or "query the stalker database". Runs the agent-stalker query engine over the captured SQLite database and presents the results.
argument-hint: "<sessions|session|events|event|tools|agents|tasks|task|stats|tokens> [options]"
allowed-tools: ["Bash", "Read"]
---

# Agent Stalker — Query

Run the agent-stalker query engine with the arguments the user provided, then present the output verbatim (it is preformatted as text tables). If no arguments are given, show the help text and the list of subcommands below.

Run:

```
bun "${CLAUDE_PLUGIN_ROOT}/lib/query.ts" $ARGUMENTS
```

## Subcommands

- `sessions [--team <name>]` — list recent sessions
- `session <id>` — one session's detail + per-tool counts
- `events [--session <id>] [--tool <name>] [--agent-id <id>] [--since <Nm|Nh|Nd>]` — events
- `event <id>` — full event detail (includes the captured `data` JSON)
- `tools [--session <id>] [--agent <type>] [--name <tool>]` — tool-use frequency
- `agents [--session <id>]` — spawned subagents
- `tasks [--team <name>] [--status <s>] [--owner <o>]` — tasks
- `task <id> [--session <id>]` — one task's detail + status history
- `stats [--session <id>]` — summary counts
- `tokens [--session <id>] [--since <dur>] [--by session|agent|model]` — captured token usage

## Notes

- Pass the user's words straight through as arguments (e.g. `/stalker events --since 2h`).
- For token usage, the `tokens` subcommand is the primary view; the dedicated `stalker-tokens` skill adds ad-hoc tokenization of arbitrary text.
- The query engine is read-only — it never modifies tracked data.
