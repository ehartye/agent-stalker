# agent-stalker Plugin Design

A Claude Code plugin that tracks agent team task assignment, messages, and tool use via hooks. Stores data in SQLite, queryable via slash commands and a web dashboard. Works for both team and non-team sessions.

## Architecture

**Approach:** Single Bun entry point receives all hook events via stdin, routes to handlers, writes to a global SQLite database. Web UI served by a separate Bun server started via slash command.

**Runtime:** Bun
**Storage:** SQLite at `~/.claude/agent-stalker.db` (WAL mode)
**Config:** `~/.claude/agent-stalker.config.json`

## Data Model

### sessions

| Column          | Type    | Description                        |
|-----------------|---------|------------------------------------|
| id              | TEXT PK | session_id from hooks              |
| cwd             | TEXT    | working directory                  |
| permission_mode | TEXT    |                                    |
| model           | TEXT    | from SessionStart                  |
| agent_type      | TEXT    | if --agent was used                |
| team_name       | TEXT    | resolved from team config/events   |
| teammate_name   | TEXT    | resolved from team events          |
| started_at      | INTEGER | epoch ms                           |
| ended_at        | INTEGER | epoch ms, set on SessionEnd        |
| end_reason      | TEXT    | from SessionEnd                    |

### events

| Column          | Type    | Description                                  |
|-----------------|---------|----------------------------------------------|
| id              | INTEGER PK AUTOINCREMENT |                               |
| session_id      | TEXT FK | → sessions                                   |
| hook_event_name | TEXT    | PreToolUse, PostToolUse, etc.                |
| agent_id        | TEXT    | null for main thread                         |
| agent_type      | TEXT    | null for main thread                         |
| team_name       | TEXT    | if available                                 |
| teammate_name   | TEXT    | if available                                 |
| timestamp       | INTEGER | epoch ms                                     |
| tool_name       | TEXT    | null for non-tool events                     |
| tool_use_id     | TEXT    | correlates Pre/Post pairs                    |
| data            | TEXT    | JSON blob, configurable truncation per tool  |

### agents

| Column          | Type    | Description                |
|-----------------|---------|----------------------------|
| id              | TEXT PK | agent_id from SubagentStart|
| session_id      | TEXT FK | → sessions                 |
| agent_type      | TEXT    |                            |
| transcript_path | TEXT    |                            |
| started_at      | INTEGER |                            |
| ended_at        | INTEGER | set on SubagentStop        |

### tasks

| Column        | Type    | Description                  |
|---------------|---------|------------------------------|
| id            | TEXT    | task_id from TaskCompleted   |
| session_id    | TEXT FK | → sessions                   |
| subject       | TEXT    |                              |
| description   | TEXT    |                              |
| teammate_name | TEXT    |                              |
| team_name     | TEXT    |                              |
| completed_at  | INTEGER |                              |

### Indexes

- `events(session_id)`
- `events(hook_event_name)`
- `events(tool_name)`
- `events(agent_id)`
- `events(timestamp)`

## Hook Architecture

### Plugin Structure

```
agent-stalker/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   ├── hooks.json
│   └── tracker.ts          — single Bun entry point
├── commands/
│   ├── stalker.md           — query CLI
│   ├── stalker-ui.md        — start web UI server
│   └── stalker-config.md    — configure content rules
├── lib/
│   ├── db.ts                — SQLite connection, schema, migrations
│   ├── ingest.ts            — event routing, per-type handlers
│   ├── truncate.ts          — content truncation per config rules
│   ├── resolve-team.ts      — scan team config files for context
│   ├── config.ts            — read/write config
│   └── query.ts             — query engine for slash commands
├── ui/
│   ├── server.ts            — Bun.serve() for web dashboard
│   ├── index.html           — SPA shell
│   └── ... (static assets)
├── package.json
└── bunfig.toml
```

### Hook Registration

All events route to the same `tracker.ts`. All hooks are `async: true` except `UserPromptSubmit`.

**Events captured:**
- SessionStart, SessionEnd
- UserPromptSubmit
- PreToolUse, PostToolUse, PostToolUseFailure
- SubagentStart, SubagentStop
- Stop
- TeammateIdle, TaskCompleted

### Identifiers Available Per Event

| Field          | Available on                                  |
|----------------|-----------------------------------------------|
| session_id     | All events                                    |
| agent_id       | SubagentStart/Stop + any hook inside subagent |
| agent_type     | SubagentStart/Stop + --agent sessions         |
| team_name      | TeammateIdle, TaskCompleted                   |
| teammate_name  | TeammateIdle, TaskCompleted                   |

Team context is also resolved by scanning `~/.claude/teams/*/config.json` and matching agent IDs.

### Content Truncation Rules

Config at `~/.claude/agent-stalker.config.json`:

```json
{
  "contentRules": {
    "Edit": "full",
    "Write": "full",
    "Read": "metadata",
    "Glob": "metadata",
    "Grep": "metadata",
    "Bash": { "maxLength": 2000 },
    "default": { "maxLength": 500 }
  }
}
```

- `"full"` — store complete tool_input and tool_response
- `"metadata"` — store tool_name, params keys, timing, but strip content
- `{ "maxLength": N }` — truncate content fields beyond N chars

## Slash Commands

### /stalker — Query CLI

```
/stalker sessions [--team <name>]
/stalker session <id>
/stalker tools [--session <id>] [--agent <type>] [--name <tool>]
/stalker events [--session <id>] [--tool <name>] [--agent-id <id>] [--since <duration>]
/stalker event <id>
/stalker agents [--session <id>]
/stalker tasks [--team <name>]
/stalker stats [--session <id>]
```

Runs `bun ${CLAUDE_PLUGIN_ROOT}/lib/query.ts $ARGUMENTS` and returns formatted output.

### /stalker-ui — Web Dashboard

```
/stalker-ui [--port <port>]   — start on port (default 3141)
/stalker-ui stop              — stop running server
```

### /stalker-config — Configuration

```
/stalker-config show
/stalker-config set <tool> <rule>
/stalker-config reset
```

## Web UI

Vanilla HTML/CSS/JS SPA served by Bun. No build step. **Use `frontend-design` skill during implementation for high-quality UI.**

### API Routes

```
GET /api/sessions              — paginated, filterable
GET /api/sessions/:id          — single session with stats
GET /api/events                — paginated, filterable
GET /api/events/:id            — full event detail with content
GET /api/agents                — filterable by session
GET /api/tasks                 — filterable by team
GET /api/stats                 — aggregate stats
GET /api/tools                 — distinct tools with counts
```

### Layout

- **Left sidebar:** Sessions list, discovered agents, teams — clickable filters
- **Center:** Chronological event timeline with color-coded types and agent badges
- **Detail pane:** Click any event for full content (tool_input/tool_response)
- **Footer:** Aggregate stats bar
- **Auto-refresh:** Poll every 2s for active sessions

## Error Handling

- **Concurrency:** WAL mode + busy_timeout=5000
- **Team resolution caching:** Resolve once per session_id, store in sessions table
- **Pre/Post correlation:** Via tool_use_id
- **Missing events:** Sessions without SessionEnd marked "incomplete"
- **Migrations:** schema_version table, idempotent migrations with IF NOT EXISTS
- **DB size:** No auto-pruning in v1. User owns their data.
