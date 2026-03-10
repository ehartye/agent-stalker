# Pause/Resume Project Tracking

## Problem

Users need to temporarily stop agent-stalker from recording events for specific projects without uninstalling the plugin or modifying hook registrations.

## Solution

Add a `pausedPaths` array to the existing config file (`~/.claude/agent-stalker.config.json`). The tracker short-circuits before ingestion when the event's CWD matches a paused path.

## Config Schema

```json
{
  "contentRules": { ... },
  "pausedPaths": ["/Users/you/projects/acme-api"]
}
```

`pausedPaths` defaults to `[]`. Matching is prefix-based — pausing `/foo/bar` also pauses `/foo/bar/subdir`.

## Changes

### `lib/config.ts`

- Add `pausedPaths: string[]` to `StalkerConfig` interface (default `[]`).
- Add `isPaused(cwd: string): boolean` — returns true if `cwd` starts with any entry in `pausedPaths`.
- Add `addPausedPath(path: string)` and `removePausedPath(path: string)` — read/modify/write the config file.

### `hooks/tracker.ts`

- After parsing the event JSON, extract the CWD from the hook payload.
- Call `isPaused(cwd)`. If true, `process.exit(0)` before `ingestEvent()`.

### `commands/stalker-config.md`

- Document `pause` and `resume` subcommands.
- `pause` adds the current session's CWD to `pausedPaths`.
- `resume` removes it.
- `show` displays paused paths alongside content rules.

## Out of Scope

- UI indicator for paused state
- Wildcard/glob matching
- Pause history or timestamps
