# Round 1: User/Consumer Perspective Review

## Findings

### 1. Timestamps displayed as raw Unix milliseconds in CLI output

- **What:** The `cmdSession` and `cmdEvents` functions in the query engine display timestamps as raw integer milliseconds (e.g., `1709912345678`) rather than human-readable dates. The `formatTable` function just calls `String(r[k] ?? "")` on every value, so timestamps render as opaque numbers.
- **Where:** `lib/query.ts:9` (formatTable), `lib/query.ts:57-63` (cmdSession), `lib/query.ts:92` (cmdEvents column selection)
- **Why it matters:** A first-time user running `/stalker sessions` or `/stalker events` will see a wall of 13-digit integers for every timestamp column. This makes the CLI output nearly unusable for quick inspection -- the user can't tell when something happened without mentally converting epoch millis. This is the most impactful usability gap in the entire tool.
- **Confidence:** High
- **Suggested alternative:** Add a `formatTimestamp(ts)` helper that converts epoch millis to ISO 8601 or a locale-friendly string (e.g., `2026-03-09 14:30:05`). Apply it in `formatTable` for columns whose names end in `_at` or `timestamp`, or apply it explicitly in each `cmd*` function before passing rows to `formatTable`.

---

### 2. No `--help` flag or usage guidance for any subcommand

- **What:** Running `/stalker events --help` or `/stalker session --help` gets no help text. The only usage message appears when you run `/stalker` with zero arguments. Individual subcommands either silently return "(no results)" or require you to already know the flag names.
- **Where:** `lib/query.ts:172-186` (runQuery switch), `commands/stalker.md:12-21` (documentation lives only in the slash command prompt)
- **Why it matters:** The slash command's `stalker.md` describes the flags, but that text is shown to the LLM, not the user. A developer who discovers the CLI entry point directly (`bun lib/query.ts`) has no way to discover `--session`, `--tool`, `--since`, etc. without reading source code.
- **Confidence:** High
- **Suggested alternative:** Each `cmd*` function should recognize `--help` as the first arg and return a usage string. The top-level help text should list subcommands with one-line descriptions.

---

### 3. Session detail `cmdSession` uses positional arg `args[1]` inconsistently with how other commands use flags

- **What:** `cmdSession(args)` reads the session ID from `args[1]` (positional), while `cmdEvents` uses `getFlag(args, "--session")`. A user who figures out `events --session <id>` will naturally try `session --session <id>` and get "Usage: session <id>" because `args[1]` is `"--session"`, not a valid session ID.
- **Where:** `lib/query.ts:49` (`cmdSession`), `lib/query.ts:95` (`cmdEvent`)
- **Why it matters:** Inconsistent argument conventions confuse users. The positional-vs-flag split creates a mental model mismatch.
- **Confidence:** Medium
- **Suggested alternative:** Either accept both positional and `--id` flag for `session` and `event`, or document the positional convention clearly in help output.

---

### 4. `/stalker-config set` instructions are ambiguous about maxLength syntax

- **What:** The `stalker-config.md` command prompt says to use `set Bash maxLength 2000` but doesn't specify how the LLM should translate that into the JSON config structure. The config file format uses `{ maxLength: number }` objects, but the slash command doesn't instruct the LLM to write JSON -- it leaves parsing to the LLM's discretion.
- **Where:** `commands/stalker-config.md:10-13`
- **Why it matters:** Different LLM invocations may produce inconsistent config files. One run might write `{ "contentRules": { "Bash": { "maxLength": 2000 } } }` while another writes `{ "contentRules": { "Bash": "maxLength 2000" } }` (a string). The config parser would silently fall back to defaults on malformed rules, and the user would never know their config change was ignored.
- **Confidence:** Medium
- **Suggested alternative:** Implement `stalker-config` as a TypeScript CLI that directly manipulates the JSON config file, rather than relying on the LLM to edit JSON. Alternatively, add validation in `getConfig()` that warns when a content rule has an unrecognized shape.

---

### 5. Web UI polling discovers new events but never discovers new sessions or agents

- **What:** The `pollNewEvents()` function fetches events with `since=<lastTimestamp>`, but `loadSessions()` and `loadAgents()` are only called during `loadAll()` (initial load or explicit session selection). If a new Claude Code session starts while the dashboard is open, its events may appear in the timeline but the session won't appear in the sidebar until the user refreshes the page.
- **Where:** `ui/index.html:791-804` (pollNewEvents), `ui/index.html:1111-1118` (polling interval only calls pollNewEvents + loadStats)
- **Why it matters:** The dashboard advertises itself as "LIVE" with a pulsing indicator, but new sessions and agents are invisible until a full page reload. This breaks the live monitoring promise and will confuse users who see events from unknown sessions.
- **Confidence:** High
- **Suggested alternative:** Include `loadSessions()` and `loadAgents()` in the polling interval (perhaps at a lower frequency, e.g., every 10s vs. 2s for events).

---

### 6. Team filtering in the sidebar only selects the first matching session

- **What:** Clicking a team name in the sidebar runs `state.sessions.find(s => s.team_name === team)` and sets `selectedSession` to that one match. If a team has multiple sessions, the user only sees events from whichever session appears first.
- **Where:** `ui/index.html:849-862` (renderTeams click handler)
- **Why it matters:** For teams with multiple sessions (the common case for a team running multiple conversations), clicking the team name gives a misleading partial view. The user expects to see all activity for that team.
- **Confidence:** High
- **Suggested alternative:** Implement team-level filtering properly: either pass `?team=<name>` to the API and filter server-side across all sessions, or collect all matching session IDs and query events for all of them.

---

### 7. No data retention or cleanup mechanism

- **What:** Events accumulate in SQLite indefinitely. There is no `stalker purge`, `stalker prune`, or config option for max database size or event age.
- **Where:** The entire `lib/` directory -- no retention logic exists anywhere.
- **Why it matters:** The plugin captures 11 different hook event types. During heavy team sessions, this can generate thousands of events per hour. Over weeks, the database will grow without bound. Since the default path is `~/.claude/agent-stalker.db`, users won't notice until disk space runs low. The `LIMIT 50`/`LIMIT 200` caps on queries mask the underlying growth.
- **Confidence:** High
- **Suggested alternative:** Add a `stalker prune --older-than 7d` command and/or a config option like `maxAgeDays: 30` that automatically deletes old events during ingestion. Even a simple "database size: X MB" in `stats` output would help users notice growth.

---

### 8. Web UI `Access-Control-Allow-Origin: *` header on all API responses

- **What:** Every API response includes `Access-Control-Allow-Origin: *`, meaning any website can read the stalker database contents via JavaScript.
- **Where:** `ui/server.ts:10` (jsonResponse function)
- **Why it matters:** The database contains detailed information about what files a user is editing, what commands they run, their working directories, session models, etc. With CORS wide open, any malicious webpage the user visits could silently exfiltrate this data. Since the server runs on localhost, this is a realistic attack vector.
- **Confidence:** High
- **Suggested alternative:** Remove the CORS header entirely (same-origin is sufficient since the UI is served from the same host), or restrict to `http://localhost:3141`.

---

### 9. Search functionality is client-side only and searches raw JSON data blobs

- **What:** The search input filters the already-loaded events array client-side, including searching `e.data` which is a raw JSON string. This means search matches on JSON syntax characters, key names, etc., producing noisy results.
- **Where:** `ui/index.html:930-938` (search filter logic)
- **Why it matters:** A user searching for "Bash" will match any event whose `data` field contains the string "Bash" anywhere in the JSON, including events where "Bash" appears in a file path or error message rather than as the tool name. Also, with a 500-event limit on loaded data, search can't find events outside the current window.
- **Confidence:** Medium
- **Suggested alternative:** Add a server-side search endpoint (e.g., `/api/events?search=<term>`) that searches specific columns. Client-side search should search visible/rendered fields only, not raw JSON.

---

### 10. `/stalker-ui stop` uses `pkill` which doesn't work on Windows

- **What:** The stop command uses `pkill -f "bun.*ui/server.ts"` which is a Unix-only command. The project runs on Windows (MINGW64).
- **Where:** `commands/stalker-ui.md:9`
- **Why it matters:** A user on Windows who starts the server and then runs `/stalker-ui stop` will get an error or no-op. There's no cross-platform server lifecycle management.
- **Confidence:** High
- **Suggested alternative:** Use a PID file approach (write the PID on start, read and kill on stop) or use cross-platform process killing (`taskkill` on Windows, `kill` on Unix). Alternatively, use `process.kill()` from Node/Bun.

---

### 11. `parseDuration` in query.ts silently returns 0 for unrecognized formats

- **What:** If a user passes `--since 1w` (one week) or `--since 30s` (30 seconds) or `--since 2hours`, `parseDuration` returns 0, which means the `since` filter is silently skipped and the user gets unfiltered results.
- **Where:** `lib/query.ts:18-19` (parseDuration regex and fallback)
- **Why it matters:** The user thinks they're filtering by time but actually gets all events. No error message indicates the duration format was invalid.
- **Confidence:** Medium
- **Suggested alternative:** Return an error message when the duration format is unrecognized, or support additional common formats (`s`, `w`). At minimum, log a warning.

---

### 12. Web UI SPA fallback serves `index.html` for all non-API, non-file paths including typos

- **What:** If `fullPath` doesn't exist or fails the path traversal check, the server falls back to serving `index.html`. This means a request to `/api/typo` returns a 404 JSON, but `/not-api-typo` returns the full HTML dashboard with 200 OK.
- **Where:** `ui/server.ts:121` (SPA fallback)
- **Why it matters:** This isn't a serious issue for a local dev tool, but it means HTTP clients or monitoring tools can't distinguish between a valid page and a 404 -- everything looks like a success. It also means if the frontend JS has a bug fetching a resource, it silently gets HTML instead of a proper 404.
- **Confidence:** Low
- **Suggested alternative:** Only fall back to `index.html` for known SPA routes (or at least paths without file extensions), and return 404 for other paths.

---

### 13. The `since` parameter semantics differ between CLI and Web API

- **What:** The CLI `events --since 1h` uses `parseDuration` to compute a relative cutoff from `Date.now()`. The web API `events?since=<value>` expects a raw timestamp integer. A user who learns the CLI `--since 1h` convention will be surprised that the API requires an absolute millisecond timestamp.
- **Where:** `lib/query.ts:85-88` (CLI: relative), `ui/server.ts:53` (API: `parseInt(since)`)
- **Why it matters:** This inconsistency means the web UI time range filter must compute the absolute timestamp client-side, and any external API consumer must know this undocumented difference.
- **Confidence:** Medium
- **Suggested alternative:** Have the API also accept duration strings like `1h`, `6h`, etc., and parse them server-side. This makes the API self-consistent with the CLI.

---

### 14. `renderToolFilter` doesn't escape HTML in tool names

- **What:** The `renderToolFilter` function builds `<option>` elements using string interpolation without the `esc()` helper: `` `<option value="${t.tool_name}">${t.tool_name} (${t.count})</option>` ``.
- **Where:** `ui/index.html:903`
- **Why it matters:** If a tool name contained HTML special characters (unlikely but possible with MCP tool names like `mcp__plugin<foo>`), it would break the dropdown rendering. This is a minor XSS vector since tool names come from the database.
- **Confidence:** Medium
- **Suggested alternative:** Use `esc(t.tool_name)` in both the `value` attribute and the display text, consistent with how the rest of the UI uses the `esc()` helper.

---

### 15. No graceful handling of database lock/corruption errors visible to user

- **What:** If the SQLite database is locked (e.g., another process has it open with an exclusive lock) or corrupted, `getDb()` will throw an unhandled error. In the hook context (`tracker.ts`), this is caught by the try/catch and logged to stderr, but in the web server context, it will crash the server.
- **Where:** `lib/db.ts:98` (getDb), `ui/server.ts:15` (handleApi calls getDb without try/catch)
- **Why it matters:** The web UI server will crash on the first API request if the database can't be opened. The user sees a connection error in their browser with no useful diagnostic.
- **Confidence:** Medium
- **Suggested alternative:** Wrap `handleApi` in a try/catch that returns a 500 JSON response with a diagnostic message (e.g., "Database locked" or "Database file not found").

---

## Summary

The plugin has a solid foundation -- the schema design, hook coverage, and event ingestion pipeline are well-structured. However, the user-facing surfaces have significant usability gaps: **raw timestamps in CLI output make it nearly unreadable**, **the "LIVE" dashboard doesn't actually refresh sessions/agents**, **team filtering is broken for multi-session teams**, and **there's no data retention story**. The CORS `*` header on the API server is a security concern that should be addressed before any production use. Fixing the timestamp formatting and the polling gaps would make the biggest immediate difference in first-use experience.
