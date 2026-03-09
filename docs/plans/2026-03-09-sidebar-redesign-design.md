# Sidebar Redesign: Session-Scoped Hierarchy

**Date:** 2026-03-09
**Status:** Approved

## Problem

The current sidebar has four flat, independent sections (Sessions, Agents, Teams, Tasks). Users can select impossible combinations — e.g., a task from one team with another session's events. There is no way to archive or delete old session data.

## Design

### Session Dropdown Panel

A dropdown trigger button at the top of the sidebar replaces the flat session list. Clicking it opens an overlay panel with:

- **Type-ahead search** input at top, filtering both sections
- **Active section:** Sessions without `archived_at`, sorted by last event time descending. Each row has a checkbox, session label (cwd folder name), last event date subtitle, and an archive button.
- **Archived section** (collapsed by default): Archived sessions. Each row has a checkbox, label, date subtitle, and a delete button (with confirmation). Only archived sessions can be deleted.
- Clicking outside the panel closes it.
- Trigger button shows "N sessions" or session names if 1-2 selected.

### Sidebar Hierarchy

Selected sessions become accordion headers in the sidebar body below the dropdown trigger.

Each session accordion contains:
- **Header:** Session label + status dot (green=active, dim=ended) + chevron toggle
- **Agents sub-section:** Agents for that session showing agent_type (or truncated agent_id), status dot, and team badge if part of a team. Clicking an agent filters the timeline to that agent's events.
- **Tasks sub-section:** Tasks for that session showing status dot, subject, and owner badge. Clicking a task opens the task detail pane.

When multiple sessions are selected, each gets its own accordion. Cross-session impossible selections are eliminated by construction.

### API & Data Changes

**DB Migration v3:** Add `archived_at INTEGER` column to `sessions` table.

**API endpoints:**
- `GET /api/sessions` — add `?archived=true` param. Default excludes archived.
- `POST /api/sessions/:id/archive` — sets `archived_at = now`
- `POST /api/sessions/:id/unarchive` — clears `archived_at`
- `DELETE /api/sessions/:id` — hard delete (only if archived). Cascades: deletes events, agents, tasks, and task_events for that session.

### Event Timeline Changes

When multiple sessions are selected, the timeline shows events from all selected sessions. Each event row gets a subtle session indicator so events are distinguishable. Tool filter, event type filter, time range, and search apply across all selected sessions. The agent filter moves from toolbar to sidebar accordion.

### What's Removed

The flat Agents, Teams, and Tasks sidebar sections are removed entirely. Replaced by session-scoped hierarchy inside accordions.
