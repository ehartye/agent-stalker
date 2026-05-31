# Token-capture spike — decision note

**Date:** 2026-05-31
**Status:** Decided
**Related plan:** `docs/superpowers/plans/2026-05-31-meta-analysis.md` (Tasks 1–2, 13–15)

## Problem

The hook stream does not carry token counts. To attribute real token usage
(input / output / cache) to sessions and subagents we must read the Claude Code
transcript JSONL files, which *do* record per-message `usage`. This note records
what the transcript format actually looks like and the decision for how/when to
ingest it into the `usage` table (added in migration v6, Task 1).

## Observed transcript format

Transcripts live at `~/.claude/projects/<project-slug>/<uuid>.jsonl` — one JSON
object per line (JSONL). Observed against a real local transcript on 2026-05-31:

- The file is **not** uniformly shaped: the first lines are session-meta records
  (`type` = summary/meta with keys like `leafUuid`, `permissionMode`), and some
  lines are not parseable as a single JSON object. Parsing must be defensive,
  line by line, skipping anything that does not parse or does not match.
- A user/assistant turn line carries these top-level keys (observed):
  `parentUuid, isSidechain, message, requestId, type, uuid, timestamp,
  userType, entrypoint, cwd, sessionId, version, gitBranch`.
- The fields we rely on:
  - `uuid` — a stable per-line UUID string. Used as the dedupe key.
  - `sessionId` — the Claude Code session id (the transcript file is per-session).
  - `timestamp` — ISO-8601 string (e.g. `2026-05-26T17:27:42.379Z`).
  - `type` — `user` / `assistant` (used as `role`).
  - `message.usage` — present on assistant lines that consumed tokens.
- The `message.usage` object (observed keys):
  `input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
  output_tokens, server_tool_use, service_tier, cache_creation, inference_geo,
  iterations, speed`. We read only the four token counts; all other keys
  (e.g. `server_tool_use`, `service_tier`) are ignored.
- Lines without `message.usage` (e.g. user lines, tool-result lines, meta lines)
  carry no token counts and are skipped.

## Transcript path source

- **Main session:** `sessions.transcript_path`, captured at `SessionStart`
  (Task 2 — the hook event carries `transcript_path`).
- **Subagents:** `agents.transcript_path`, already captured for subagent
  transcripts. A subagent transcript is ingested with its `agent_id` attributed;
  the main transcript is ingested with `agent_id = null`.

## Mapping rule (transcript line → `usage` row)

| `usage` column                  | Source                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| `message_uuid` (PK)             | line `uuid`                                                   |
| `session_id`                    | our session id (the file is per-session; not the line's `sessionId`, which we already know from the row we read the path from) |
| `agent_id`                      | the subagent's `agents.id` when reading a subagent transcript, else `null` |
| `role`                          | line `type` (`assistant` / `user`), fallback `message.role`   |
| `input_tokens`                  | `message.usage.input_tokens`                                  |
| `cache_creation_input_tokens`   | `message.usage.cache_creation_input_tokens`                   |
| `cache_read_input_tokens`       | `message.usage.cache_read_input_tokens`                       |
| `output_tokens`                 | `message.usage.output_tokens`                                 |
| `timestamp`                     | `Date.parse(line.timestamp)` (ISO → epoch ms), fallback `Date.now()` |

## Idempotency

`usage.message_uuid` is the primary key. Ingest uses `INSERT OR IGNORE`, so
re-ingesting the same transcript (e.g. SessionEnd fires, then a manual re-run)
inserts no duplicates. The ingest function returns the count of rows actually
inserted (`changes > 0`) so callers can report new vs. already-seen.

## Format-drift handling

The parser is intentionally tolerant so a Claude Code format change degrades to
"no/partial token data" rather than a crash:

- Skip empty lines and any line that does not `JSON.parse`.
- Skip lines without `message.usage` or where `usage.input_tokens` is not a
  number.
- Skip lines without a `uuid` (no safe dedupe key).
- Each token field defaults to `0` when absent; unknown `usage` keys are ignored.

## Decision: when to ingest

**Parse on `SessionEnd` + a manual `bun run ingest-usage` command. No daemon.**

- On `SessionEnd`, `handleSessionEnd` triggers usage ingest for that session
  (best-effort; failures are swallowed so they never block hook processing).
- A manual command re-ingests on demand (idempotent), covering sessions that
  ended before this feature existed or whose transcript grew after SessionEnd.
- Rejected: a background watcher/daemon — unnecessary complexity for a
  local, single-user tool; SessionEnd + manual re-run covers the cases.

## Consequences

- `usage` rows appear only after a session ends (or a manual run), so live
  in-progress sessions show the byte-based effort proxy until then; the effort
  metric already prefers `realTokens` when present and falls back to `bytes`
  (Task 8). The insights/effort path lights up real tokens once ingested
  (Task 15).
- Because dedupe is by `message_uuid`, repeated SessionEnd events or overlapping
  main+subagent reads are safe.
