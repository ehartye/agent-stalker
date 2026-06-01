---
name: stalker-config
description: This skill should be used when the user runs "/stalker-config" or asks to "configure agent-stalker", "set capture rules", "change what stalker records", "pause tracking for this project", "resume tracking", or "show the stalker config". Manages agent-stalker's content-capture rules and per-path pause state.
argument-hint: "[show | set <tool> <rule> | reset | pause | resume | status]"
allowed-tools: ["Bash", "Read", "Write"]
---

# Agent Stalker — Configuration

Manage agent-stalker configuration at `~/.claude/agent-stalker.config.json`. Interpret the user's argument:

- **`show` (or no argument)** — read and display the current config file. If it does not exist, show the defaults below.
- **`set <tool> <rule>`** — update the config file:
  - `set Bash full` — store full content for Bash
  - `set Read metadata` — metadata only for Read
  - `set Bash maxLength 2000` — truncate Bash at 2000 chars
- **`reset`** — delete the config file to restore defaults.
- **`pause`** — add the current working directory to `pausedPaths`. Print `Paused tracking for <cwd>`.
- **`resume`** — remove the current working directory from `pausedPaths`. Print `Resumed tracking for <cwd>`; if it was not paused, print `Tracking was not paused for <cwd>`.
- **`status`** — report whether the current working directory is in `pausedPaths` (tracking active vs paused for this project).

The current working directory is available from the session context.

## Default content rules

| Tool | Rule |
|------|------|
| Edit, Write | full |
| Read, Glob, Grep | metadata |
| Bash | maxLength 2000 |
| default (everything else) | maxLength 500 |

## Notes

- Content rules control how much of each tool's input/output is stored (full text, metadata only, or truncated to N chars). They do not affect which events are tracked.
- `pausedPaths` suppresses tracking for sessions whose working directory matches a paused path.
