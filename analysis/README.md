# agent-stalker semantic analysis sidecar

An **opt-in** Python companion to agent-stalker that adds a semantic layer on top
of the raw events SQLite database. It is intentionally separate from the core
(Bun/TypeScript) plugin: the core captures and stores hook events with zero extra
dependencies, and this sidecar — only if you choose to install it — reads those
events and derives higher-level "where did the agent struggle?" signals.

Nothing here runs unless you install the dependencies and enable it. The core
plugin and dashboard work fine without it.

## What it does

It reads the raw capture tables and writes derived results into `semantic_*`
tables in the same database:

| Feature   | Reads                                  | Writes                                                    |
|-----------|----------------------------------------|-----------------------------------------------------------|
| sentiment | user prompts + assistant messages      | `semantic_sentiment` (per-message frustration score)      |
| topics    | prompts + assistant messages + tasks   | `semantic_topics`, `semantic_topic_assignments`           |
| errors    | `PostToolUseFailure` events            | `semantic_error_clusters`, `semantic_error_assignments`   |
| pivots    | assistant messages                     | `semantic_pivot_signals` (retry / "try another approach") |

Run metadata (model, last run time, corpus size, status) is recorded per feature
in `semantic_meta`.

- **sentiment** uses VADER (fast, no heavy model) so frustration detection works
  even on a minimal install.
- **topics** and **errors** use sentence-transformer embeddings
  (`all-MiniLM-L6-v2`) with BERTopic and HDBSCAN respectively.

> **Triage is not part of this sidecar.** Session triage is handled entirely in
> Claude Code: the dashboard's "Flag for triage" button marks a session
> (`semantic_session_triage`), and the packaged `agent-stalker-triage` skill reads
> the flagged sessions and writes back a pain summary — no API key, no token cost,
> no Python required.

## SQLite contract

The sidecar treats the agent-stalker database as the integration boundary:

- **Reads** the raw tables written by the core plugin: `events` and `tasks`.
- **Writes** only the `semantic_*` tables. It never modifies raw capture data.
- Each feature is an idempotent recompute: it clears its own `semantic_*` rows and
  rewrites them, so re-running is safe and reflects the current corpus.

The `semantic_*` tables are created by the core plugin's migration (they exist,
empty, even before the sidecar is installed), so the sidecar only ever inserts.

## Install

```bash
pip install -r requirements.txt
```

The heavy ML stack (torch via sentence-transformers, BERTopic, HDBSCAN, umap-learn)
is only needed for the `topics` and `errors` features. `sentiment` and `pivots`
need only `vaderSentiment`.

Check what is installed without importing the heavy modules (fast — it uses
`importlib.util.find_spec`, so it never loads torch):

```bash
python -m agent_stalker_analysis check
# -> {"ok": true, "missing": []}        when everything is installed
# -> {"ok": false, "missing": ["bertopic", ...]}   otherwise
```

## Commands

Run from the `analysis/` directory:

```bash
# Dependency check (used by the dashboard's Enable button)
python -m agent_stalker_analysis check

# Compute features (default runs all four non-LLM features)
python -m agent_stalker_analysis run
python -m agent_stalker_analysis run --features sentiment,pivots
python -m agent_stalker_analysis run --db /path/to/agent-stalker.db
```

`run` accepts any comma-separated subset of `sentiment,topics,errors,pivots`.
Failures are isolated per feature: if one feature errors, the others still run and
the failure is recorded in `semantic_meta` with an error status rather than
aborting the whole batch.

## Environment variables

| Variable                | Used by            | Purpose                                                                                  |
|-------------------------|--------------------|------------------------------------------------------------------------------------------|
| `AGENT_STALKER_DB_PATH` | sidecar + core     | Path to the SQLite database. Defaults to `~/.claude/agent-stalker.db` if unset.           |
| `AGENT_STALKER_PYTHON`  | the dashboard      | Python executable the server uses to spawn this sidecar. Defaults to `python` on Windows, `python3` elsewhere. |

## How the dashboard drives it

You normally don't run these commands by hand. The agent-stalker web dashboard's
**Insights** view has an "Enable semantic features" control that:

1. calls `check` to see whether the dependencies are installed (and tells you what
   to `pip install` if not),
2. spawns `run` in the background to compute the features, and
3. reads the resulting `semantic_*` tables to render the semantic panels.

Session **triage** is independent of this sidecar — see the `agent-stalker-triage`
skill (`skills/agent-stalker-triage/`). The dashboard's "Flag for triage" button
marks a session and the skill, run in Claude Code, analyzes it and writes the
result back via `stalker triage-save`.

## Tests

```bash
python -m pytest tests/ -v
```

The `topics` and `errors` tests use `pytest.importorskip`, so they skip cleanly on
a machine without the heavy ML deps installed and run for real when they are
present.
