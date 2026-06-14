# Round 2: User/Consumer Cross-Pollination

## Reactions to Adversary Perspective

### Binding to 0.0.0.0 amplifies the CORS problem I flagged

I called out the `Access-Control-Allow-Origin: *` header (my Finding 8) as a security concern, but the adversary perspective's Finding 1 reveals I underestimated the scope. I focused on CORS as enabling cross-origin exfiltration from malicious websites, but missed that the server binds to all interfaces by default. Combined, these mean the database is accessible to the entire local network with zero authentication -- not just to websites the user visits. The adversary's point that this turns a monitoring tool into an information disclosure vulnerability is exactly the kind of impact assessment I should have made: my finding noted "any malicious webpage" but the reality is "any device on the network, no webpage needed."

### Sensitive data capture defaults are worse than I realized

The adversary's Finding 3 (Edit/Write stored as "full" by default) has a direct user experience implication I missed. From a user perspective, a developer installing this plugin would reasonably expect that an observability tool captures metadata about what happened -- not the full contents of every file they write or edit. The default config silently captures complete file contents, including `.env` files, credentials, and private code. A first-time user would have no idea this is happening because there's no installation warning, no first-run notice, and the `/stalker-config show` command only shows the config if the user already knows it exists. This is a consent/expectation gap, not just a security issue.

### The synchronous UserPromptSubmit hook is a UX dealbreaker

The adversary's Finding 10 is the single most important user-experience finding across all perspectives, and I completely missed it. Every user prompt submission is blocked by the hook pipeline (stdin read, JSON parse, DB open, migration check, SQL insert, DB close). Even at 200ms best-case, this means every prompt has a perceptible delay. Under the conditions from adversary Finding 5 (SQLite contention in team scenarios), this could balloon to seconds. A user who installs this plugin and immediately notices their prompts feel sluggish will uninstall it before they ever see the dashboard. This should be the highest-priority fix.

### Process-per-event spawning has user-visible cost

The adversary's Finding 9 (process spawning overhead) compounds with Finding 10. Even for async hooks, spawning 11 hook types * N events per tool call means significant CPU/memory overhead on the user's machine. For a tool that's supposed to passively observe, it's surprisingly resource-hungry. From a user perspective, this could show up as battery drain, fan spin-up, or general system sluggishness during heavy Claude Code sessions. The adversary's daemon suggestion is architecturally sound but also represents a significant complexity increase.

---

## Reactions to Data Integrity Perspective

### Missing transactions explain phantom data users would see

Data Integrity's Finding 1 (no transaction wrapping) has a concrete user-facing consequence I can now articulate. If a hook process is killed mid-ingest (say, by the 10-second timeout), a user running `/stalker sessions` could see a session with no events, or `/stalker events` could show events for a session that `/stalker session <id>` says doesn't exist. From the user's perspective, the tool would appear buggy and untrustworthy -- "it says there are 5 events but I can only see 3" type confusion. This is worse than missing data; it's inconsistent data that erodes confidence.

### Duplicate tasks will confuse dashboard users

Data Integrity's Finding 2 (tasks table has no PRIMARY KEY) means the sidebar task list and the `/stalker tasks` command could show the same task multiple times. A user monitoring a team would see "Implement auth" listed twice and wonder whether two people did the same work, or whether the tool is broken. This is a direct usability regression that I should have caught.

### Timestamps being recording-time rather than event-time breaks the mental model

Data Integrity's Finding 7 (Date.now() at storage time vs. event time) has a user experience consequence beyond data accuracy. When a user looks at the event timeline in the dashboard, they expect to see events in the order they happened. If async hooks are delayed (especially during contention), the timeline will show events in processing order, which may differ from causal order. For example, a PostToolUse event for tool A might appear before the PreToolUse event for tool B, even though B actually started first. Users building a mental model of "what happened" from the timeline will be misled.

### The polling gap I found (Finding 5) compounds with Data Integrity's polling duplicate risk

Data Integrity's Finding 8 (pollNewEvents can duplicate events at timestamp boundaries) and my Finding 5 (polling never refreshes sessions/agents) together mean the live dashboard has two compounding issues: it both misses new entities and potentially duplicates existing events. The data integrity suggestion to use `since_id` instead of timestamps as the poll cursor would fix the duplicate issue and is strictly better from a user experience standpoint -- event IDs are monotonic and gap-free.

---

## Reactions to Testing Strategy Perspective

### Loose query assertions explain why timestamp formatting would never be caught

Testing Strategy's Finding 4 (assertions too loose in query.test.ts) directly relates to my Finding 1 (timestamps as raw unix millis). Even if someone tried to fix the timestamp formatting and introduced a regression, the existing tests would not catch it because they only assert `toContain("s1")` or `toContain("1")`. The test suite provides false confidence that the CLI output is correct when in fact the output format has never been validated. From a user perspective, this means the most visible surface (CLI output) has the weakest test coverage.

### Uncontrolled Date.now() in tests means the time filter UX is untested

Testing Strategy's Finding 5 (no clock control) means my Finding 11 (parseDuration silently returns 0 for unrecognized formats) and Finding 13 (since parameter semantics differ between CLI and API) are both in entirely untested territory. The time-range filtering that users rely on in both the CLI (`--since 1h`) and the web UI (time range dropdown) has zero verified behavior. A bug in `parseDuration` would be invisible.

### No server tests means the security fixes I flagged are unverified

Testing Strategy's Finding 2 (no tests for ui/server.ts) is particularly relevant given my Findings 8 (CORS), 12 (SPA fallback), and 13 (API since parameter). Every API behavior I flagged as a user-experience issue is also completely untested. The path traversal fix that was already applied (per the git history commit `3453784`) has zero test coverage -- so while the adversary flagged potential bypasses, there's not even a basic test proving the fix works for the intended case.

### The missing tracker.ts tests are a first-use reliability gap

Testing Strategy's Finding 1 (no tests for hooks/tracker.ts) means the user's very first interaction with the plugin -- installing it and having hooks fire -- is the least tested path. If Bun's stdin stream behavior changes, or if Claude Code changes the hook payload format, the plugin silently fails. From a user perspective, they would install the plugin, start a session, open the dashboard, and see... nothing. No events. No error message. No diagnostic. They'd have no way to tell whether the plugin is working.

---

## New Insights (not in my Round 1)

### 1. The consent/transparency gap is a first-order user experience problem

Synthesizing adversary Finding 3 (sensitive data capture), data integrity Finding 6 (no input validation), and testing Finding 1 (no entry point tests): a user who installs this plugin has no way to know (a) what data is being captured, (b) that full file contents are stored by default, (c) that the data is accessible on the network. There is no `--dry-run` mode, no first-run output saying "capturing events to ~/.claude/agent-stalker.db", no opt-in for full content capture. The plugin should at minimum print a one-time notice on first hook execution explaining what it captures and where the data goes.

### 2. The `handleGeneric` catch-all creates an unpredictable user experience

Data Integrity's Finding 9 (data column unbounded) and Finding 6 (no input validation), combined with the adversary's Finding 6 (no validation), together expose a user-facing problem I missed: the `handleGeneric` default handler stores the entire event payload minus a few destructured keys. This means any new hook event type Claude Code introduces will be silently captured with all its data. From a user's perspective, the amount of data captured and the storage consumed is unpredictable and may increase without any action on their part. A future Claude Code update adding new hook events could suddenly balloon the database.

### 3. Error cascades are invisible to the user

Across all perspectives: errors in hook processing (adversary Finding 9), database contention (adversary Finding 5), partial writes (data integrity Finding 1), and malformed events (data integrity Finding 6) all fail silently. The only error output goes to stderr of the hook process, which the user never sees. There is no error counter in stats, no "last error" indicator in the dashboard, no health check endpoint. A user whose plugin is silently failing 50% of events would have no way to know until they notice gaps in the timeline. Adding an `/api/health` endpoint or a "capture rate" metric in the footer would make failures visible.
