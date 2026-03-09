# Content Area Redesign — Design Document

## Summary

Replace the sidebar + timeline layout with a full-width layout featuring a horizontal agent chip bar, side-by-side kanban task board and grouped activity list, and a detail modal for deep inspection.

**Approach:** Full rebuild (Approach A) — rewrite render functions and CSS in the single-file SPA (`ui/index.html`), keeping the existing API layer and state management.

## Design Decisions (from Q&A)

| Question | Decision |
|----------|----------|
| Sidebar vs top bar | **B) Collapse sidebar into top bar** — agents become horizontal chip row, session picker moves to header, full width for content |
| Content split | **B) Horizontal split** — kanban left (~38%), activity list right (~62%), both always visible |
| Event grouping | **B) Grouped by tool_use_id** — PreToolUse + PostToolUse collapse into single tool invocation card |
| Modal detail level | **B) Full raw data** — tool name, timestamps, agent attribution, plus full JSON (syntax highlighted, collapsible) |
| Agent chip scope | **A) Session-scoped** — only agents from selected sessions appear in chip bar |
| Kanban columns | **A) Three columns** — Pending, In Progress, Completed (matches DB status values) |

## Layout

```
┌─────────────────────────────────────────────────────┐
│  eye  AGENT-STALKER  [Session ▾]  [search]  [LIVE]  │  header (48px)
├─────────────────────────────────────────────────────┤
│  [Claude] [hook-installer] [schema-migrator] [Edit]  │  chip bar (40px)
├──────────────────┬──────────────────────────────────┤
│  PENDING │ IN P  │  Activity Feed                    │
│  ┌──────┐│ ┌──┐  │  ┌─ Edit ──────────────────────┐ │
│  │task 1││ │  │  │  │ pre → post (collapsed)      │ │  content
│  └──────┘│ └──┘  │  └─────────────────────────────┘ │  (remaining)
│  ┌──────┐│       │  ┌─ Bash ──────────────────────┐ │
│  │task 2││ DONE  │  │ pre → post (collapsed)      │ │
│  └──────┘│ ┌──┐  │  └─────────────────────────────┘ │
│          │ └──┘  │                                   │
├──────────┴───────┴──────────────────────────────────┤
│  sessions: 12  events: 4,231  tools: 18  agents: 8  │  footer (32px)
└─────────────────────────────────────────────────────┘
```

## Section 1: Header Bar (48px)

- **Left:** Brand — green eye icon (mask-based SVG, drop-shadow glow) + "AGENT-STALKER" in Chakra Petch uppercase
- **Center-left:** Session picker dropdown — compact button showing selected count/name, same multi-select dropdown panel with search, active/archived groups, archive/delete/unarchive actions
- **Center:** Search input — mono font, amber focus border
- **Right:** Live indicator toggle + compact stats summary ("4.2k events")

## Section 2: Agent Chip Bar (40px)

Horizontal scrollable row replacing the sidebar accordions.

- **Left group — Agent chips:** "Claude (session)" for top-level (`__top_level__`), plus each deduplicated subagent. Colored dot (DB color or hash fallback) + name.
- **Right group — Tool chips:** Most-used tools as compact pills.
- **Click behavior:** Toggle filter. Active = green border + tinted bg. Multiple filters combine as AND.
- **Clear chip:** Appears at end when any filter is active.
- **Empty state:** "Select a session to begin" when no sessions selected.

## Section 3: Kanban Board (Left, ~38%)

Three columns: **Pending**, **In Progress**, **Completed**.

- **Column headers:** Chakra Petch uppercase, count badge, color-coded left border (amber/blue/green)
- **Task cards:** ID pill (#12), subject line, owner badge (colored dot + name), blocked tag (red if `blocked_by` non-empty), dim mono timestamp
- **Click card:** Opens detail modal with task info + task_events timeline
- **Empty state:** "No tasks" message, column headers still render
- **Filtering:** Agent chip filter narrows to tasks owned by that agent. Tool filter has no effect on kanban.

## Section 4: Activity List (Right, ~62%)

Events grouped by `tool_use_id`. Standalone events for session/agent lifecycle.

### Tool invocation cards
- Left color border using agent's color
- Header: tool name pill, agent badge, relative timestamp
- **Collapsed:** One-line summary — tool name + truncated input hint ("Edit → lib/db.ts") + status icon
- **Expanded (click):** `tool_input` summary + `tool_response` summary. "View full detail" link → modal
- Error events: red left border + error icon

### Standalone event rows
- Icon + event name + agent badge + timestamp
- SubagentStart/Stop show agent name and color

### Behavior
- Chronological order, newest at bottom
- Auto-scroll when live mode is on
- Agent filter: events from that agent (or `__top_level__` for null agent_id)
- Tool filter: events with that tool_name
- Both applied as AND

## Section 5: Detail Modal

Triggered by clicking tool invocation "View full detail" or a task card.

### Chrome
- Overlay: `rgba(0,0,0,0.6)` backdrop + backdrop-filter blur
- Centered panel: max-width 800px, max-height 80vh, scrollable
- Close: backdrop click, Escape key, or X button

### Tool event detail
- Header: tool name, agent badge, full timestamp
- Two collapsible sections: **Input** and **Response** — full JSON, syntax highlighted (strings green, keys amber, numbers blue) in Martian Mono
- Metadata: session ID, tool_use_id, hook_event_name, duration (pre→post)
- Left/right navigation arrows to step through filtered events

### Task detail
- Header: task ID + subject, status badge, owner badge
- Description (if present)
- Task events timeline: event_type pill, field changed, old→new values, timestamp
- Blocks/blocked_by as linked task ID chips

## Existing Assets Preserved

- **Design system:** Chewie palette (CSS variables), Chakra Petch / DM Sans / Martian Mono fonts, grid dot background, backdrop blur, pill badges
- **Green eye logo:** Flat green mask-based SVG with drop-shadow glow, no box
- **API layer:** All `/api/*` endpoints unchanged. State management and `fetchJSON` helper unchanged.
- **Agent color system:** DB colors via `namedColor()`, hash-based fallback via `agentColor()`, `NAMED_COLORS` and `AGENT_COLORS` arrays

## What Gets Removed

- **Sidebar** (`grid-template-columns: 260px 1fr`, `.sidebar`, `.session-dropdown`, `.session-accordions`, `.accordion-*`)
- **Toolbar filter selects** (replaced by chip bar)
- **Flat timeline** (`renderEvents()` row-per-event replaced by grouped cards)
- **Filter chips bar** below toolbar (merged into chip bar)

## API Requirements

No new API endpoints needed. All data already available from:
- `GET /api/sessions` — session list
- `GET /api/agents?session=X` — agents per session
- `GET /api/tasks?session=X` — tasks per session
- `GET /api/events?session=X` — events per session
- `GET /api/events/:id` — single event detail
- `GET /api/tasks/:id` — single task detail
- `GET /api/tasks/:id/events` — task event history
- `GET /api/stats` — global stats
