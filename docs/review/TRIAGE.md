# Review Triage — Prioritized Backlog

Status-checked against the codebase on 2026-06-07. Consolidates the ~50 findings in
`synthesis-report.md` into actionable work items, deduped, with current status verified
in code (not taken from the stale review).

## Progress

- **Batch A — Security hardening** (PR #7, merged): C1, C3, H5, plus L4. Localhost-default
  bind + config opt-in, CORS removal + Host-header guard, `Edit`/`Write` default to
  `metadata` (with `old_string`/`new_string` added to the strip set), API param clamps,
  port-conflict message.
- **Batch B — Ingest reliability** (PR #8, merged): C2, H2, H3, H4, H13, plus the
  `isPaused` Windows-separator bug. Async UserPromptSubmit, `isValidEvent` guard,
  whole-event `BEGIN IMMEDIATE` transactions (usage ingest post-commit), `ensureSession`
  in `handleSessionEnd`, per-team scan error isolation.

**Remaining:** Batch C (retention/growth — H1, M1), Batch D (test coverage — H6, H11, H12,
M12–M14, L6), Batch E (UX/CLI — H8, H9, H10, H14, H15, M5–M11), plus the Low/Hardening and
deferred-architectural items. See the sections below; the per-item tables are NOT updated
with checkmarks — use this Progress block as the source of truth for what shipped.

## ✅ Already fixed since the review ran

| Item | Evidence |
|------|----------|
| `tasks` composite PK (was: no PK, DI#2) | `lib/ingest.ts` uses `(id, session_id)`; PR #4 |
| Atomic + concurrency-safe migrations; `schema_version` single-row (DI#5, New#5) | `lib/db.ts` BEGIN IMMEDIATE wrapper + dedup; commit `7acd28b` |
| Test-DB cleanup collision via `Date.now()` paths (Test#10) | per-test random-suffix paths; commit `74b925d` |
| Residual XSS in tool-filter render (UC#14) | UI refactored to `ui/js/`; `esc()` invariant applied, no `renderToolFilter` remains |
| Metadata strip set too small (part of Adv#3/Test#8) | `lib/truncate.ts` now strips 8 keys (content, data, output, text, body, result, stdout, stderr) |
| Server API has zero tests (Test#2) | `ui/server.test.ts` now exists |
| `/api/events/:id` returns 404 when missing (part of SPA#5) | `ui/server.ts:106` |

---

## 🔴 Critical — security/contract, design before touching

| ID | Finding | Where | Notes |
|----|---------|-------|-------|
| C1 | CORS `*` + binds `0.0.0.0`, no auth → full event DB readable by any site/LAN device | `ui/server.ts:17`, bind | Bind `127.0.0.1`, drop wildcard CORS |
| C2 | `UserPromptSubmit` hook is **synchronous** → blocks the user on every prompt | `hooks/hooks.json:28` | Add `"async": true` (all four perspectives' top UX fix) |
| C3 | `Edit`/`Write` capture defaults to `"full"` → full file contents (creds, private code) in plaintext | `lib/config.ts:13-14` | Default to `metadata`, opt-in for full + first-run notice |

---

## 🟠 High

**Ingest-path integrity (hot path, do as one batch):**
| ID | Finding | Where |
|----|---------|-------|
| H2 | No input validation — NULL `session_id`/`hook_event_name` inserted silently | `hooks/tracker.ts`, `lib/ingest.ts` |
| H3 | Multi-statement ingest handlers not wrapped in transactions (partial-write hazard) | `lib/ingest.ts` (task/usage handlers) |
| H4 | `handleSessionEnd` never calls `ensureSession` → orphaned events | `lib/ingest.ts:56-63` (confirmed open) |
| H13 | One malformed team `config.json` aborts scanning ALL teams → permanent team-attribution loss | `lib/resolve-team.ts` |

**Growth/limits:**
| ID | Finding | Where |
|----|---------|-------|
| H1 | No retention/prune/TTL/vacuum — unbounded DB growth | `lib/ingest.ts`, `lib/db.ts` |
| H5 | API `limit`/`offset`/`since` unbounded → full-table extraction / OOM | `ui/server.ts:29-30,88-96` |

**Tests:**
| ID | Finding | Where |
|----|---------|-------|
| H6 | No tests for `tracker.ts` entry point (stdin/JSON parsing) | `hooks/tracker.ts` |
| H11 | Loose query assertions (`toContain("1")`) catch nothing | `lib/query.test.ts:54` |
| H12 | No tests for SubagentStop / TeammateIdle / PostToolUse / generic handlers | `lib/ingest.ts` handlers |

**UX/CLI:**
| ID | Finding | Where |
|----|---------|-------|
| H8 | UI polling never refreshes sessions/agents → breaks "LIVE" promise | `ui/js/` poll loop |
| H9 | Team filtering selects only first matching session | query/UI |
| H10 | `/stalker-ui stop` uses `pkill` — broken on Windows | `skills/stalker-ui/SKILL.md` |
| H14 | CLI prints raw Unix-ms timestamps | `lib/query.ts` |
| H15 | No `--help` for any subcommand | `lib/query.ts` |

---

## 🟡 Medium

| ID | Finding |
|----|---------|
| M1 | `data` column has no size limit (esp. `handleGeneric` catch-all) — DI#9, New#3 |
| M2 | Poll cursor uses `timestamp` not `id` → duplicate/missed events at boundaries — DI#8 |
| M3 | Timestamps recorded with `Date.now()` not event-occurrence time — DI#7 |
| M4 | `ensureSession` writes incomplete row; `handleSessionStart` overwrites `started_at` — DI#10 |
| M5 | SPA fallback returns 200+HTML for all unknown non-API paths (never 404) — Consensus#5 |
| M6 | `parseDuration` silently returns 0 on unrecognized format — UC#11 |
| M7 | `since` semantics differ: CLI relative duration vs API absolute timestamp — UC#13 |
| M8 | Search is client-side only over raw JSON of loaded events — UC#9 |
| M9 | `/stalker-config set` syntax ambiguous in docs — UC#4 |
| M10 | `cmdSession` positional arg inconsistent with flag-based `cmdEvents` — UC#3 |
| M11 | No DB lock/corruption handling in web server — UC#15 |
| M12 | Config tests don't cover merge edge cases / malformed config — Test#6 |
| M13 | `resolveTeamContext` filesystem-error path untested — Test#9 |
| M14 | Truncate-metadata test coverage lags the 8-key strip set — Test#8 |

---

## 🔵 Low / Hardening / Deferred

| ID | Finding |
|----|---------|
| L1 | `syntaxHighlight` regex ReDoS on pathological JSON — Adv#11 |
| L2 | Path-traversal check needs Windows separator normalization (backslash) — Adv#4 |
| L3 | Add `/api/health` or capture-rate metric for error visibility — New#2 |
| L4 | Port-conflict detection / preemptive-bind risk on 3141 — New#7 |
| L5 | `parseDuration` support `s`/`w`, FK `PRAGMA foreign_keys` decision (enable or drop decls) — UC-alt#24, DI#4 |
| L6 | Control/inject clock in tests for deterministic timestamps — Test#5 |
| D1 | **Deferred (architectural):** per-event process spawning overhead — Adv#9 |
| D2 | **Deferred (architectural):** SQLite write contention / daemon model — Adv#5 |

---

## Proposed execution batches

1. **Batch A — Security hardening** (C1, C3, H5; ride-along L4). *Design-gated* (network exposure + capture defaults are behavior/contract changes). Brainstorm → plan → implement.
2. **Batch B — Hook & ingest reliability** (C2, H2, H3, H4, H13). Hot-path data integrity. Mostly surgical + test-first.
3. **Batch C — Retention & growth** (H1, M1). New `prune` command + `maxAgeDays` config; *design-gated* (deletes data).
4. **Batch D — Test coverage** (H6, H11, H12, M12, M13, M14, L6). Pure additive, low risk.
5. **Batch E — UX/CLI** (H8, H9, H10, H14, H15, M5–M11). Surgical, user-visible.

**Recommended order:** A → B → D → C → E (security first, integrity second, lock it in with tests, then retention, then polish). Batches A and C touch irreversible behavior and get a design pass; B/D/E are TDD-surgical.
