---
description: Configure agent-stalker content capture rules
allowed-tools: ["Bash", "Read", "Write"]
---

Manage agent-stalker configuration at `~/.claude/agent-stalker.config.json`.

If the user passes "show" or no arguments, read and display the current config file. If it doesn't exist, show the defaults.

If the user passes "set <tool> <rule>", update the config file:
- `set Bash full` — store full content for Bash
- `set Read metadata` — metadata only for Read
- `set Bash maxLength 2000` — truncate Bash at 2000 chars

If the user passes "reset", delete the config file to restore defaults.

Default content rules:
- Edit, Write: full
- Read, Glob, Grep: metadata
- Bash: maxLength 2000
- default: maxLength 500
