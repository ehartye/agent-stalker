---
name: stalker-ui
description: This skill should be used when the user runs "/stalker-ui" or asks to "start the agent-stalker dashboard", "open the stalker UI", "launch the tracking dashboard", "view tracked sessions in the browser", or "stop the stalker server". Starts (or stops) the agent-stalker web dashboard.
argument-hint: "[stop] [--port <number>]"
allowed-tools: ["Bash"]
---

# Agent Stalker — Dashboard

Start or stop the agent-stalker web dashboard.

## Stop

If the user passes `stop`, terminate any running dashboard server. On a POSIX shell (macOS/Linux, Git Bash):

```
pkill -f "bun.*ui/server.ts" 2>/dev/null && echo "Server stopped" || echo "No server running"
```

On Windows PowerShell, `pkill` is unavailable — stop the process listening on the dashboard port instead (default 3141; substitute the user's `--port` if given):

```
Get-NetTCPConnection -LocalPort 3141 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## Start

Otherwise, start the server **in the background**, passing through any arguments (such as `--port <number>`). On a POSIX shell:

```
bun "${CLAUDE_PLUGIN_ROOT}/ui/server.ts" $ARGUMENTS &
```

On Windows PowerShell, `&` does not background — launch it detached instead:

```
Start-Process bun -ArgumentList "$env:CLAUDE_PLUGIN_ROOT/ui/server.ts",$ARGUMENTS -WindowStyle Hidden
```

The default port is `3141`. After starting, tell the user the URL: `http://localhost:<port>` (use the port from `--port` if provided, otherwise 3141).

## Notes

- The dashboard serves the **Activity** view (session event stream, kanban tasks, filters) and the **Insights** view (pain leaderboard, churn, errors, thrash, token usage, and the opt-in semantic panels). Both are static files served fresh on reload.
- The server reads the same SQLite database the hooks write to; it is read-only for tracked events.
