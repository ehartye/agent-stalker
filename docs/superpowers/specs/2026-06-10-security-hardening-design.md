# Security Hardening Design (Review Batch A)

**Date:** 2026-06-10
**Source:** `docs/review/TRIAGE.md` items C1, C3, H5, L4
**Status:** Approved by user

## Problem

The web UI server binds all interfaces (`Bun.serve` with no `hostname`), sets
`Access-Control-Allow-Origin: *` on every API response, and has no authentication.
Combined with `Edit`/`Write` capture defaulting to `"full"`, the complete event
database — including file contents, secrets, and bash commands — is readable by
any LAN device and exfiltratable by any website the user visits. API list
parameters are unbounded, enabling full-table extraction in one request.

User constraint: LAN viewing must keep working (laptop → office PC dashboard).

## Decisions

1. **Bind host:** default `127.0.0.1`; persistent opt-in to LAN via config.
2. **Capture defaults:** `Edit` and `Write` flip from `"full"` to `"metadata"`.
3. **CORS:** remove the wildcard header entirely; no replacement.
4. **DNS-rebinding guard:** validate the `Host` header (small allowlist + config escape hatch).
5. **API bounds:** clamp all numeric query params.
6. **Port conflict (ride-along):** clear message + exit 1 on `EADDRINUSE`.

## Design

### 1. Server binding (C1a)

Extend `StalkerConfig` in `lib/config.ts`:

```ts
export interface UiConfig {
  host: string;            // default "127.0.0.1"
  allowedHosts: string[];  // default [] — extra Host-header names, see §2
}

export interface StalkerConfig {
  contentRules: Record<string, ContentRule>;
  pausedPaths: string[];
  ui: UiConfig;
}
```

`DEFAULT_CONFIG.ui = { host: "127.0.0.1", allowedHosts: [] }`. `getConfig()`
merges `parsed.ui` over the default the same way `contentRules` merges today.

`ui/server.ts` resolves the bind host with precedence **`--host` CLI flag →
`config.ui.host` → `"127.0.0.1"`** via a pure, exported function (unit-testable):

```ts
export function resolveHost(argv: string[], config: StalkerConfig): string
```

The result is passed as `hostname` to `Bun.serve`. To enable LAN viewing the
user sets `"ui": { "host": "0.0.0.0" }` once in `agent-stalker.config.json`.

### 2. CORS removal + Host-header guard (C1b)

- Delete `"Access-Control-Allow-Origin": "*"` from `jsonResponse`. Dashboard
  requests (localhost or LAN) are same-origin; nothing breaks. Cross-origin
  pages lose the ability to read API responses.
- Guard against DNS rebinding: before routing, validate the request `Host`
  header (port stripped). Allowed:
  - `localhost`, `127.0.0.1`, `[::1]`
  - any bare IPv4/IPv6 literal (LAN viewing by IP)
  - any name in `config.ui.allowedHosts` (e.g. `"office-pc"` for
    `http://office-pc:3141`)

  Anything else (i.e. a DNS name not allowlisted) → `403` with a one-line JSON
  error naming the `allowedHosts` config key. Implemented as a pure, exported
  predicate `isAllowedHost(hostHeader: string, allowedHosts: string[]): boolean`.

### 3. Capture defaults (C3)

In `DEFAULT_CONFIG.contentRules`: `Edit: "metadata"`, `Write: "metadata"`.
File paths and tool metadata are still captured; content keys are stripped by
the existing `lib/truncate.ts` metadata mode. Users opt back in per-tool with
existing config (`"contentRules": { "Edit": "full" }`).

No DB migration — affects only newly captured events. Documentation:

- README: short "What is captured" note (defaults, where the DB lives, how to
  opt into full capture).
- `skills/stalker-config/SKILL.md`: mention the new defaults and the opt-in.

### 4. API parameter bounds (H5)

Add to `ui/server.ts` (exported for tests):

```ts
export function clampInt(raw: string | null, def: number, min: number, max: number): number
```

Behavior: `null`/non-numeric → `def`; otherwise clamp to `[min, max]`. Apply at
every query-param parse site:

| Param | def | min | max |
|-------|-----|-----|-----|
| `limit` (all list endpoints) | existing per-endpoint default | 1 | 1000 |
| `offset` | 0 | 0 | `Number.MAX_SAFE_INTEGER` |
| `since` | (absent → no filter) | 0 | `Number.MAX_SAFE_INTEGER` |
| path IDs (`/api/events/:id`) | NaN → 404, unchanged semantics | — | — |

NaN never reaches SQL.

### 5. Port-conflict visibility (L4)

Wrap the `Bun.serve` call in try/catch. On `EADDRINUSE` (or message-matched
equivalent), print
`Port <port> already in use — is another stalker UI running? (use --port to change)`
to stderr and exit 1. Other errors rethrow.

## Testing (TDD, additions to existing suites)

`lib/config.test.ts`:
- `DEFAULT_CONFIG` has `Edit`/`Write` = `"metadata"`.
- `getConfig()` merges a partial `ui` section; missing `ui` yields defaults.

`ui/server.test.ts`:
- API responses carry **no** `Access-Control-Allow-Origin` header.
- `resolveHost`: flag beats config beats default.
- `isAllowedHost`: `localhost`/`127.0.0.1`/`[::1]`/IP literals pass; `evil.example`
  fails; `office-pc` fails by default and passes with `allowedHosts: ["office-pc"]`;
  port suffixes stripped.
- Request with disallowed `Host` header → 403.
- `clampInt`: `"99999"` → 1000 (limit), `"-5"` → 0 (offset), `"abc"` → default,
  `null` → default.

Out of scope (deliberate): authentication, HTTPS, encryption at rest, retention
(Batch C), ingest validation (Batch B).
