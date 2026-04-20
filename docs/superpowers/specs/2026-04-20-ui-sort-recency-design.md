# UI Sort by Recency — Design

**Date:** 2026-04-20
**Scope:** `ui/server.ts`, `ui/app.js`

## Problem

Two sorting behaviors in the web UI don't match how users scan for the latest activity:

1. The session list sorts by `started_at` rather than most recent activity. A session that started days ago but just emitted an event sits below a newer, idle session.
2. The activity pane shows oldest events at the top and newest at the bottom, with infinite-scroll upward to load older events. Users reading the latest events have to scroll all the way down on every load, and auto-scroll-to-bottom in LIVE mode can fight with manual scrolling.

## Goals

- Sessions with the most recent activity (any event type) appear first in the list.
- Events appear newest-first; scrolling down loads older events.
- No tracker-side schema changes.

## Non-goals

- No "N new events" pill or indicator. If it's needed later, it can be added without changing this design.
- No denormalized `last_event_at` column. Leave it as a future optimization if query cost becomes a problem.

## Design

### Session list: sort by most recent activity

In `ui/server.ts`, the `/api/sessions` handler currently ends its query with `ORDER BY started_at DESC`. Replace that with:

```sql
ORDER BY COALESCE(
  (SELECT MAX(timestamp) FROM events WHERE events.session_id = sessions.id),
  started_at
) DESC
```

- Sessions that have events sort by their latest event timestamp.
- Sessions with no events fall back to `started_at`.
- Archived and active queries both use this ordering.

The existing indexes `idx_events_session_id` and `idx_events_timestamp` support the correlated subquery. The outer `LIMIT ?` (default 100) bounds the number of subquery evaluations. If this becomes slow at scale, a denormalized `last_event_at` column on `sessions` maintained by the tracker is the follow-up — out of scope for this change.

### Events list: newest on top, scroll down for older

All changes are client-side in `ui/app.js`. Four edits:

**1. Flip sort direction at every call site.** The events array is sorted in three places (`loadEvents`, `loadMoreEvents`, `pollNewEvents`). Change `a.timestamp - b.timestamp` to `b.timestamp - a.timestamp` in each.

**2. Flip the infinite-scroll trigger.** `onActivityScroll` currently triggers `loadMoreEvents` when `scroll.scrollTop < 100` (near top). Change the condition to "near bottom":

```js
scroll.scrollHeight - (scroll.scrollTop + scroll.clientHeight) < 100
```

**3. Simplify `loadMoreEvents` scroll preservation.** Today it measures `scrollHeight`/`scrollTop` before appending older events and restores the view because new content is prepended at the top of the DOM. With newest-first ordering, older events are appended at the bottom of the DOM — the visible viewport doesn't shift. Delete the `prevHeight`/`prevTop` adjustment block entirely and just re-render.

**4. Remove live-mode auto-scroll; preserve scroll position on re-render.** `renderActivity` currently captures `wasAtBottom` and forces `scrollTop = scrollHeight` in LIVE mode to keep the user pinned to the latest event. Remove the `wasAtBottom` calculation and the `if (state.isLive && wasAtBottom && !state.loadingMore)` branch entirely. In its place, preserve the user's scroll position across re-renders:

- If `prevScrollTop === 0` (user is at the very top), leave `scrollTop` at `0` so newly arriving events at the top of the DOM are naturally visible.
- Otherwise, set `scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight)` so the same content stays in view when new events are prepended.

The LIVE toggle UI and the 3-second poll interval are unchanged. Only the display order and scroll mechanics change.

## Data flow

- Session dropdown re-renders whenever `loadSessions()` returns. Response is already sorted by the server.
- Events pane: `state.events` is the single source of truth. All three code paths (initial load, load-more, poll) write into it and then sort DESC. `renderActivity` iterates `state.events` in order and emits DOM nodes top-to-bottom.

## Error handling

- If the subquery returns `NULL` (no events for a session), `COALESCE` falls back to `started_at`. If `started_at` is also `NULL` (shouldn't happen in practice), SQLite treats `NULL` as less than any value in `DESC` — those sessions land at the bottom, which is acceptable.
- No new failure modes in the UI changes; scroll preservation is pure DOM math.

## Testing

- Backend: add/extend a test in `ui/server.test.ts` covering the new session ordering — insert two sessions where the older `started_at` has the newer event; assert it's returned first.
- Frontend: manual verification in the dashboard:
  - Select a session, confirm events render newest-first.
  - Scroll to the bottom, confirm older events load.
  - With LIVE on and user scrolled down, confirm scroll position holds when a new event arrives.
  - With LIVE on and user at `scrollTop === 0`, confirm new events appear without pushing the viewport.
  - Open the session dropdown, confirm sessions with recent events rank above older ones started more recently but since idle.

## Out of scope / future work

- Denormalized `last_event_at` column on `sessions` for query performance at scale.
- "N new events" indicator pill.
- Any change to the LIVE toggle UI or polling cadence.
