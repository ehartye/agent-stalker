# Pause/Resume Project Tracking — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach).

**Goal:** Allow users to pause and resume agent-stalker tracking per project via CWD-based config.

**Architecture:** Add `pausedPaths: string[]` to the existing `StalkerConfig` in `~/.claude/agent-stalker.config.json`. The tracker reads the config early and short-circuits if the event's CWD matches a paused path. The `/stalker-config` skill gains `pause` and `resume` subcommands.

**Tech Stack:** TypeScript, Bun, existing config system

---

### Task 1: Add `pausedPaths` to config interface and helpers

**Files:**
- Modify: `lib/config.ts`

**Step 1: Add `pausedPaths` to `StalkerConfig` and `DEFAULT_CONFIG`**

Add to the interface:
```typescript
export interface StalkerConfig {
  contentRules: Record<string, ContentRule>;
  pausedPaths: string[];
}
```

Update the default:
```typescript
export const DEFAULT_CONFIG: StalkerConfig = {
  contentRules: { ... },  // unchanged
  pausedPaths: [],
};
```

Update `getConfig()` to merge `pausedPaths`:
```typescript
return {
  contentRules: { ...DEFAULT_CONFIG.contentRules, ...parsed.contentRules },
  pausedPaths: parsed.pausedPaths ?? [],
};
```

**Step 2: Add `isPaused`, `addPausedPath`, `removePausedPath`**

```typescript
import { writeFileSync } from "fs";

export function isPaused(cwd: string): boolean {
  const config = getConfig();
  return config.pausedPaths.some((p) => cwd === p || cwd.startsWith(p + "/"));
}

function writeConfig(config: StalkerConfig): void {
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function addPausedPath(path: string): void {
  const config = getConfig();
  if (!config.pausedPaths.includes(path)) {
    config.pausedPaths.push(path);
    writeConfig(config);
  }
}

export function removePausedPath(path: string): void {
  const config = getConfig();
  config.pausedPaths = config.pausedPaths.filter((p) => p !== path);
  writeConfig(config);
}
```

**Step 3: Run to verify no syntax errors**

Run: `bun build lib/config.ts --no-bundle --outdir /tmp/stalker-check`
Expected: Compiles without errors

**Step 4: Commit**

```bash
git add lib/config.ts
git commit -m "feat(config): add pausedPaths support with isPaused/add/remove helpers"
```

---

### Task 2: Short-circuit tracker for paused projects

**Files:**
- Modify: `hooks/tracker.ts`

**Step 1: Add pause check after parsing the event**

```typescript
import { ingestEvent } from "../lib/ingest";
import { closeDb } from "../lib/db";
import { isPaused } from "../lib/config";

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    process.exit(0);
  }

  try {
    const event = JSON.parse(raw);

    if (event.cwd && isPaused(event.cwd)) {
      process.exit(0);
    }

    ingestEvent(event);
  } catch (err) {
    console.error(`agent-stalker: failed to ingest event: ${err}`);
  } finally {
    closeDb();
  }
}

main();
```

Key points:
- The pause check happens BEFORE `ingestEvent()` and BEFORE any DB access
- If `event.cwd` is missing (shouldn't happen, but defensive), we proceed normally
- `process.exit(0)` skips `closeDb()` intentionally — no DB was opened

**Step 2: Verify the tracker still compiles**

Run: `bun build hooks/tracker.ts --no-bundle --outdir /tmp/stalker-check`
Expected: Compiles without errors

**Step 3: Commit**

```bash
git add hooks/tracker.ts
git commit -m "feat(tracker): short-circuit event ingestion for paused projects"
```

---

### Task 3: Update `/stalker-config` skill to support pause/resume

**Files:**
- Modify: `commands/stalker-config.md`

**Step 1: Add pause/resume documentation to the skill**

Replace the full content of `commands/stalker-config.md` with:

```markdown
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

If the user passes "pause", add the current working directory to `pausedPaths` in the config file. Print confirmation: "Paused tracking for <cwd>". The current working directory is available from the session context.

If the user passes "resume", remove the current working directory from `pausedPaths` in the config file. Print confirmation: "Resumed tracking for <cwd>". If the path wasn't paused, print "Tracking was not paused for <cwd>".

If the user passes "status", check if the current working directory is in `pausedPaths` and report whether tracking is active or paused for this project.

Default content rules:
- Edit, Write: full
- Read, Glob, Grep: metadata
- Bash: maxLength 2000
- default: maxLength 500
```

**Step 2: Commit**

```bash
git add commands/stalker-config.md
git commit -m "feat(config): add pause/resume/status subcommands to stalker-config skill"
```

---

### Task 4: Manual smoke test

**Step 1: Verify pause**

Run `/stalker-config pause` in a project directory. Check that `~/.claude/agent-stalker.config.json` now contains the CWD in `pausedPaths`.

**Step 2: Verify tracking stops**

Run a few tool calls and check `/stalker events --since 1m` — should show no new events from the paused project.

**Step 3: Verify resume**

Run `/stalker-config resume`. Check that `pausedPaths` no longer contains the CWD. Run tool calls and verify events appear again.

**Step 4: Verify status**

Run `/stalker-config status` when paused and when active — should report correctly.

**Step 5: Final commit (bump version)**

Update `package.json` and `.claude-plugin/plugin.json` version to `0.4.0` and commit:
```bash
git add package.json .claude-plugin/plugin.json
git commit -m "chore: bump to 0.4.0 for pause/resume feature"
```
