---
description: Start the agent-stalker web dashboard for browsing tracked sessions, events, and tool use
allowed-tools: ["Bash"]
---

Start the agent-stalker web UI server.

If the user passes "stop" as an argument, kill any running stalker-ui server:
Run: `pkill -f "bun.*ui/server.ts" 2>/dev/null && echo "Server stopped" || echo "No server running"`

Otherwise, start the server:
Run: `bun "${CLAUDE_PLUGIN_ROOT}/ui/server.ts" $ARGUMENTS &`

Default port is 3141. User can pass `--port <number>` to change it.

After starting, tell the user the URL: `http://localhost:<port>`
