# Task Lifecycle Tracking Design

## Problem

Tasks only appear when `TaskCompleted` fires — creation, assignment, and status changes are invisible. The `tasks` table is append-only with no primary key, storing only completion snapshots. Users watching task progression (the core value prop of agent-stalker) can't see tasks until they're done.

## Approach: Ingest-time PostToolUse Parsing

When `PostToolUse` fires for `TaskCreate` or `TaskUpdate` tools, parse `tool_input` to maintain a live `tasks` table (current state) and a `task_events` table (full change history).

## Schema Changes (Migration v2)

### Expanded `tasks` table (replaces current)

```sql
CREATE TABLE tasks_v2 (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  subject TEXT,
  description TEXT,
  status TEXT DEFAULT 'pending',
  owner TEXT,
  team_name TEXT,
  blocks TEXT,       -- JSON array of task IDs this blocks
  blocked_by TEXT,   -- JSON array of task IDs blocking this
  created_at INTEGER,
  updated_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

Migration strategy: Copy existing rows from `tasks` into `tasks_v2` (mapping `teammate_name` -> `owner`, `completed_at` -> `completed_at` + status='completed'), then DROP `tasks`, ALTER TABLE `tasks_v2` RENAME TO `tasks`.

### New `task_events` table (history log)

```sql
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  session_id TEXT,
  event_type TEXT,    -- 'created', 'assigned', 'status_change', 'blocked', 'unblocked', 'completed'
  field_name TEXT,    -- which field changed (null for 'created')
  old_value TEXT,
  new_value TEXT,
  timestamp INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX idx_task_events_task_id ON task_events(task_id);
CREATE INDEX idx_task_events_timestamp ON task_events(timestamp);
```

## Ingest Changes

### `handleToolUse` enhancement

After recording the event, check if `tool_name` is `TaskCreate` or `TaskUpdate`. If so, delegate to task-specific handlers.

### TaskCreate handling

`tool_input` shape: `{ subject, description?, addBlocks?, addBlockedBy? }`
`tool_response` contains the resulting task ID.

1. Parse task ID from `tool_response`
2. INSERT into `tasks` with status='pending', created_at=now, updated_at=now
3. Record a `created` task_event

### TaskUpdate handling

`tool_input` shape: `{ taskId, owner?, status?, addBlocks?, addBlockedBy? }`

1. SELECT current task state
2. For each changed field, record a task_event with old/new values
3. UPDATE `tasks` with new values, set updated_at=now
4. If status='completed', set completed_at=now
5. For addBlocks/addBlockedBy, merge with existing JSON arrays

### `handleTaskCompleted` update

Keep as fallback. If task doesn't exist (created before plugin install), INSERT from hook event data with status='completed'. If it exists, just update status and completed_at.

## API Changes

- `/api/tasks` — add `status` and `owner` query params for filtering. Return expanded fields.
- `/api/tasks/:id` — single task detail with all fields
- `/api/tasks/:id/events` — full change history for a task

## CLI Changes

- `stalker tasks` — add `--status` and `--owner` flags, show status/owner columns in output
- `stalker task <id>` — new subcommand showing task detail + event history

## Web UI Changes

- Task sidebar items show status-colored dot (gray=pending, blue=in_progress, green=completed)
- Task sidebar items show owner badge
- Clicking a task shows detail panel with history timeline
- Tasks sidebar refreshes during polling (not just on initial load)
