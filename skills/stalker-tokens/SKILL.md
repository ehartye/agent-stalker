---
name: stalker-tokens
description: This skill should be used when the user runs "/stalker-tokens" or asks about token usage — "count tokens", "how many tokens did this session use", "show token usage", "token usage by agent", "tokens by model", "which session burned the most tokens", or "estimate the tokens in this file/text". Reports the real token usage agent-stalker captured, and counts/estimates tokens for arbitrary text or files for the Claude model family.
argument-hint: "[--session <id>] [--since <Nm|Nh|Nd>] [--by session|agent|model]   |   count <file>"
allowed-tools: ["Bash", "Read"]
---

# Agent Stalker — Tokens

Two modes. Pick based on the request.

## Mode 1 — Report captured usage (default)

For questions about how many tokens tracked sessions/agents used, run the query engine's `tokens` subcommand and present its output verbatim:

```
bun "${CLAUDE_PLUGIN_ROOT}/lib/query.ts" tokens $ARGUMENTS
```

Options:
- `--session <id>` — restrict to one session
- `--since <Nm|Nh|Nd>` — a recent window (e.g. `--since 24h`)
- `--by session|agent|model` — group the breakdown (default `session`)

It prints a grand total (input / output / cache-read / cache-write) and a breakdown. These are **real** counts: agent-stalker parses the Claude Code transcript JSONL into a `usage` table when a session ends. If it reports no usage, the relevant sessions may not be ingested yet — run `bun run ingest-usage` from the plugin root (`${CLAUDE_PLUGIN_ROOT}`) to backfill from any transcripts still on disk, then re-run.

## Mode 2 — Tokenize arbitrary text or a file

For "how many tokens is this text / file", use the bundled counter:

```
# a file
bun "${CLAUDE_PLUGIN_ROOT}/skills/stalker-tokens/scripts/count-tokens.ts" <path>

# inline text via stdin
printf '%s' "the text to count" | bun "${CLAUDE_PLUGIN_ROOT}/skills/stalker-tokens/scripts/count-tokens.ts"
```

How it counts (see `scripts/count-tokens.ts`):
- **Exact** when `ANTHROPIC_API_KEY` is set — it calls Anthropic's `count_tokens` API (free; not billed). Override the model with `AGENT_STALKER_TOKEN_MODEL` (default `claude-sonnet-4-6`).
- **Estimate** otherwise — a local ~4-chars/token approximation, clearly labelled `~N`. State plainly that it is an estimate, since Claude's tokenizer is proprietary and has no accurate local equivalent; suggest setting `ANTHROPIC_API_KEY` for an exact count.

## Notes

- Mode 1 needs no API key — it reads already-captured data.
- Do not invent token counts. Use the `tokens` subcommand (captured data) or `count-tokens.ts` (text), and report exactly what they return, including the exact-vs-estimate label.
