# UI Sort by Recency Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach).

**Goal:** Sort the session list by most recent activity and flip the events pane so newest appears at the top, with scroll-down to load older events.

**Architecture:** Two independent changes. Backend: one SQL ordering change in the `/api/sessions` handler plus a regression test. Frontend: four coordinated edits in `ui/app.js` that flip sort direction at every call site, flip the infinite-scroll trigger to the bottom, remove LIVE-mode auto-scroll, and move scroll-preservation logic into `renderActivity` so it handles both prepend (poll) and append (load-more) cases.

**Tech Stack:** TypeScript (Bun), SQLite (`bun:sqlite`), vanilla JS for the frontend, `bun:test` for tests.

**Spec:** `docs/superpowers/specs/2026-04-20-ui-sort-recency-design.md`

---

## Task 1: Sort sessions by most recent activity

**Files:**
- Modify: `ui/server.ts` (the `/api/sessions` handler, currently ends with `ORDER BY started_at DESC LIMIT ? OFFSET ?`)
- Test: `ui/server.test.ts` (add one new test case)

**Context:** The sessions table has `started_at` but no `last_event_at`. Events are in a separate `events` table with a `timestamp` column indexed by `session_id` and `timestamp`. We'll use a correlated subquery to compute the latest event timestamp per session, falling back to `started_at` for sessions with no events.

**Note on existing test style:** The tests in `ui/server.test.ts` exercise SQL directly rather than calling the HTTP handler (the handler isn't exported). This is a pre-existing pattern — follow it. The test should run the exact new ORDER BY clause and assert ordering.

### Step 1: Write the failing test

Add this test to `ui/server.test.ts` inside the existing `describe("server API", ...)` block, after the existing tests:

```ts
  it("GET /api/sessions orders by most recent activity (latest event, falling back to started_at)", () => {
    const db = getDb();
    // beforeEach seeds sess-1 (started_at=1000, one event at 1000) and sess-2 (started_at=2000, no events).
    // Add a late event to sess-1 so its activity timestamp beats sess-2's started_at.
    db.run("INSERT INTO events (session_id, hook_event_name, timestamp) VALUES ('sess-1', 'Notification', 3000)");
    // Add sess-3 with no events, started earliest. Should rank last.
    db.run("INSERT INTO sessions (id, cwd, started_at) VALUES ('sess-3', '/tmp/test3', 500)");

    const rows = db.query(
      "SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY COALESCE((SELECT MAX(timestamp) FROM events WHERE events.session_id = sessions.id), started_at) DESC"
    ).all() as any[];

    // Expected order: sess-1 (latest event 3000) > sess-2 (started_at 2000, no events) > sess-3 (started_at 500, no events)
    expect(rows.map(r => r.id)).toEqual(["sess-1", "sess-2", "sess-3"]);
  });
```

### Step 2: Run the new test and confirm it passes

Run: `bun test ui/server.test.ts -t "orders by most recent activity"`

Expected: PASS (1/1). Because this repo's existing tests inline the SQL they assert against rather than calling the HTTP handler, this is a contract-capturing test, not a strict red-then-green TDD cycle. The test locks in the expected ordering semantics so that if someone later changes the handler query without matching it here, the test will catch it.

### Step 3: Change the handler query

In `ui/server.ts`, locate the `/api/sessions` handler — specifically the line:

```ts
    query += " ORDER BY started_at DESC LIMIT ? OFFSET ?";
```

Replace it with:

```ts
    query += " ORDER BY COALESCE((SELECT MAX(timestamp) FROM events WHERE events.session_id = sessions.id), started_at) DESC LIMIT ? OFFSET ?";
```

No other lines in the handler need to change. The `qParams.push(limit, offset)` call that follows is unchanged.

### Step 4: Run the full server test suite

Run: `bun test ui/server.test.ts`

Expected: all tests pass, including the new `"orders by most recent activity"` test and all existing tests. If an existing test fails, revisit — the ordering change should not affect any other test because the others assert on filters or single-session behavior, not ordering.

### Step 5: Commit

```bash
git add ui/server.ts ui/server.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): sort sessions by most recent activity

Replace ORDER BY started_at with a correlated subquery that returns
the latest event timestamp per session, falling back to started_at
for sessions with no events. Session list now reflects live activity
rather than when a session first opened.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Flip events pane to newest-first with scroll-down for older

**Files:**
- Modify: `ui/app.js`

**Context:** Today the events pane sorts ASC (oldest at top, newest at bottom), infinite-scrolls upward for older events, and auto-scrolls to bottom in LIVE mode. We're flipping all of that. There are four coordinated edits; they must land together because landing any subset leaves the UI in a broken state (e.g., flipping sort but not the scroll trigger creates an infinite loop when the page opens, because the scrollTop will immediately be near 0 which would now trigger load-more... or vice versa).

The loadMoreEvents scroll-preservation logic (currently local to that function) is being moved into `renderActivity`, which needs to handle three cases:
- **Load-more** (`state.loadingMore === true`): older events appended at bottom of DOM, viewport does not shift — preserve `prevScrollTop` unchanged.
- **User at top** (`prevScrollTop === 0`): keep at 0 so incoming new events from poll appear naturally.
- **Anywhere else**: new events prepended at top of DOM (from poll) shift content down — restore by `prevScrollTop + (scrollHeight - prevScrollHeight)`.

### Step 1: Flip the three sort directions

In `ui/app.js`, change `a.timestamp - b.timestamp` to `b.timestamp - a.timestamp` at all three call sites.

Inside `loadEvents`, find:

```js
  state.events = allEvents.sort((a, b) => a.timestamp - b.timestamp);
```

Replace with:

```js
  state.events = allEvents.sort((a, b) => b.timestamp - a.timestamp);
```

Inside `loadMoreEvents`, find:

```js
      state.events = state.events.concat(deduped).sort((a, b) => a.timestamp - b.timestamp);
```

Replace with:

```js
      state.events = state.events.concat(deduped).sort((a, b) => b.timestamp - a.timestamp);
```

Inside `pollNewEvents`, find:

```js
    state.events = state.events.concat(newEvents).sort((a, b) => a.timestamp - b.timestamp);
```

Replace with:

```js
    state.events = state.events.concat(newEvents).sort((a, b) => b.timestamp - a.timestamp);
```

### Step 2: Flip the infinite-scroll trigger to near-bottom

Find the `onActivityScroll` function:

```js
function onActivityScroll() {
  const scroll = document.getElementById('activityScroll');
  if (!scroll) return;
  if (scroll.scrollTop < 100 && !state.eventsFullyLoaded && !state.loadingMore) {
    loadMoreEvents();
  }
}
```

Replace the condition so it triggers near the bottom instead of near the top:

```js
function onActivityScroll() {
  const scroll = document.getElementById('activityScroll');
  if (!scroll) return;
  const distanceFromBottom = scroll.scrollHeight - (scroll.scrollTop + scroll.clientHeight);
  if (distanceFromBottom < 100 && !state.eventsFullyLoaded && !state.loadingMore) {
    loadMoreEvents();
  }
}
```

### Step 3: Strip scroll-preservation from loadMoreEvents

Find the entire `else` branch inside `loadMoreEvents` that handles the non-empty deduped case:

```js
    } else {
      const scroll = document.getElementById('activityScroll');
      const prevHeight = scroll ? scroll.scrollHeight : 0;
      const prevTop = scroll ? scroll.scrollTop : 0;
      state.events = state.events.concat(deduped).sort((a, b) => b.timestamp - a.timestamp);
      renderChipBar();
      renderActivity();
      const scrollAfter = document.getElementById('activityScroll');
      if (scrollAfter) scrollAfter.scrollTop = prevTop + (scrollAfter.scrollHeight - prevHeight);
    }
```

Replace with the simpler version (scroll preservation now lives inside `renderActivity`):

```js
    } else {
      state.events = state.events.concat(deduped).sort((a, b) => b.timestamp - a.timestamp);
      renderChipBar();
      renderActivity();
    }
```

### Step 4: Rewrite the tail of renderActivity — remove auto-scroll, handle three scroll cases

Near the bottom of `renderActivity`, find the block that captures previous scroll state:

```js
  const scroll = document.getElementById('activityScroll');
  const prevScrollTop = scroll ? scroll.scrollTop : 0;
  const prevScrollHeight = scroll ? scroll.scrollHeight : 0;
  const wasAtBottom = scroll ? (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 20) : true;
```

Replace with (drop `wasAtBottom`):

```js
  const scroll = document.getElementById('activityScroll');
  const prevScrollTop = scroll ? scroll.scrollTop : 0;
  const prevScrollHeight = scroll ? scroll.scrollHeight : 0;
```

Then a bit further down, find the scroll-restore block after `panel.innerHTML = html`:

```js
  // Restore scroll position: scroll to bottom only if was already at bottom in live mode
  const scrollAfter = document.getElementById('activityScroll');
  if (scrollAfter) {
    if (state.isLive && wasAtBottom && !state.loadingMore) {
      scrollAfter.scrollTop = scrollAfter.scrollHeight;
    } else {
      scrollAfter.scrollTop = prevScrollTop;
    }
    scrollAfter.addEventListener('scroll', onActivityScroll);
  }
```

Replace with the three-case preservation logic:

```js
  // Scroll position: pin to current content across re-renders.
  // - Load-more: older events appended at bottom, viewport does not shift.
  // - At top: stay at 0 so newly polled events are visible.
  // - Otherwise: new events prepended at top; shift by height delta to keep current content in view.
  const scrollAfter = document.getElementById('activityScroll');
  if (scrollAfter) {
    if (state.loadingMore) {
      scrollAfter.scrollTop = prevScrollTop;
    } else if (prevScrollTop === 0) {
      scrollAfter.scrollTop = 0;
    } else {
      scrollAfter.scrollTop = prevScrollTop + (scrollAfter.scrollHeight - prevScrollHeight);
    }
    scrollAfter.addEventListener('scroll', onActivityScroll);
  }
```

### Step 5: Manual verification

There are no frontend unit tests for `ui/app.js` and introducing jsdom infrastructure is out of scope. Verify manually by running the UI and exercising each scenario.

Start the dashboard:

```bash
bun run ui/server.ts --port 3141
```

Open `http://localhost:3141` in a browser. Select a session with many events (any active session or a recently archived one with > 20 events). Then confirm each of the following:

- **Order:** The most recent event is at the top of the Activity pane; scrolling down reveals progressively older events.
- **Load older:** Scroll to the bottom of the Activity pane. Older events load in when within ~100px of the bottom, and the viewport does not jump.
- **LIVE pin (mid-scroll):** Enable LIVE. Scroll down into older events and wait for a new event to arrive (or trigger one from any Claude session in the same environment). The event should appear at the top of the list; the viewport should stay pinned to the event you were reading — no jump up to the new event.
- **LIVE top (at top):** Enable LIVE and scroll back to the very top. When new events arrive, they should appear at position 0 naturally; the viewport stays at the top.
- **Session list:** Open the session dropdown. A session that started earlier but had an event in the last minute should rank above a session started more recently but idle.
- **Kanban + filters unaffected:** Click any agent/tool/event chip and confirm filtering still works. Click a task card and confirm the task modal still opens.

If all six checks pass, the change is verified. If any fail, stop and debug before committing.

### Step 6: Commit

```bash
git add ui/app.js
git commit -m "$(cat <<'EOF'
feat(ui): flip events pane to newest-first, scroll down for older

Event list now shows the newest event at the top and infinite-scrolls
downward to load older events. LIVE-mode auto-scroll is removed;
scroll position is preserved across re-renders, with new events
appearing at the top when the user is already there and the viewport
staying pinned to current content otherwise. Scroll preservation
logic moves from loadMoreEvents into renderActivity so it handles
both load-more (append below) and poll (prepend above) cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Bump plugin version to 0.4.1

**Files:**
- Modify: `.claude-plugin/plugin.json` (the `version` field)

**Context:** Recent commits bump the version when user-visible behavior changes (`chore: bump to 0.4.0 for pause/resume feature`). This change alters sort order in two user-facing places — a minor UX change, so patch-level bump to 0.4.1.

### Step 1: Edit version field

In `.claude-plugin/plugin.json`, change:

```json
  "version": "0.4.0",
```

to:

```json
  "version": "0.4.1",
```

### Step 2: Commit

```bash
git add .claude-plugin/plugin.json
git commit -m "$(cat <<'EOF'
chore: bump to 0.4.1 for sort-by-recency UI tweaks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (for the implementer)

Before considering the plan done:

- All three commits land cleanly; `git log --oneline` shows them in order.
- `bun test ui/server.test.ts` passes (including the new ordering test).
- `bun test` (full suite) passes — no unrelated breakage.
- Manual verification in Task 2 Step 5 completed and all six checks passed.
- `ui/app.js` no longer contains the `wasAtBottom` variable (a quick `grep wasAtBottom ui/app.js` should return nothing).
- `ui/server.ts`'s `/api/sessions` handler uses the COALESCE subquery (a quick `grep -n "COALESCE" ui/server.ts` confirms).
