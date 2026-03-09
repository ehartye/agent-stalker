# Content Area Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use h-superpowers:subagent-driven-development, h-superpowers:team-driven-development, or h-superpowers:executing-plans to implement this plan (ask user which approach).

**Goal:** Replace sidebar+timeline layout with full-width kanban+activity layout, horizontal agent chip bar, and detail modal. Modularize the monolithic `ui/index.html` into separate CSS, JS module, and HTML files.

**Architecture:** Split the current ~1600-line `ui/index.html` into `ui/styles.css`, `ui/app.js`, and a lean `ui/index.html` shell. Then rewrite the render logic: remove sidebar, add chip bar, split content into kanban (left 38%) and grouped activity list (right 62%), add modal overlay. The JS module is organized by concern: state, API, rendering (chip bar, kanban, activity, modal), and init. All existing REST API endpoints are unchanged.

**Tech Stack:** Vanilla HTML/CSS/JS, Bun serve, existing REST API

**File structure after modularization:**
```
ui/
  index.html    — lean HTML shell (~80 lines), loads styles.css + app.js
  styles.css    — all CSS (~400 lines)
  app.js        — all JS (~500 lines), organized by section
  server.ts     — unchanged
```

---

### Task 1: Modularize — Extract CSS and JS into Separate Files

**Files:**
- Modify: `ui/index.html` (strip inline CSS and JS)
- Create: `ui/styles.css` (all CSS)
- Create: `ui/app.js` (all JS)

**Context:** The current `ui/index.html` is ~1600 lines with `<style>` (820 lines), HTML (~100 lines), and `<script>` (680 lines) all inline. Extract CSS and JS into dedicated files. The Bun server already serves static files from `ui/`.

**Step 1: Create `ui/styles.css`**

Extract everything inside `<style>...</style>` (lines 7-820 of current file) into `ui/styles.css`. No changes to the CSS content — just move it. Include the `@import` for Google Fonts at the top.

**Step 2: Create `ui/app.js`**

Extract everything inside `<script>...</script>` (lines 928-1609 of current file) into `ui/app.js`. No changes to the JS content — just move it. The file should be a plain script (not an ES module) since it references DOM elements directly.

**Step 3: Update `ui/index.html`**

Replace the inline `<style>` block with:
```html
<link rel="stylesheet" href="/styles.css">
```

Replace the inline `<script>` block with:
```html
<script src="/app.js"></script>
```

The HTML body stays as-is for now (will be restructured in Task 2).

**Step 4: Verify in browser**

Run: `bun --hot ui/server.ts`
Expected: UI looks and behaves identically to before. CSS loads, JS runs, sessions/events display. No console errors.

**Step 5: Commit**

```bash
git add ui/index.html ui/styles.css ui/app.js
git commit -m "refactor(ui): extract CSS and JS into separate files"
```

---

### Task 2: Layout Grid and Header Restructure

**Files:**
- Modify: `ui/index.html` (HTML structure)
- Modify: `ui/styles.css` (grid layout, remove sidebar CSS, add chip bar and content CSS)

**Context:** The current layout uses a 2-column grid (`260px 1fr`) with sidebar. Remove the sidebar column, move session picker into header, add chip bar row, and create the kanban+activity content split.

**Step 1: Update CSS grid layout in `ui/styles.css`**

Replace the `#app` grid definition:

```css
#app {
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: 48px 40px 1fr 32px;
  grid-template-areas:
    "header"
    "chipbar"
    "content"
    "footer";
  height: 100vh;
  overflow: hidden;
  position: relative;
  z-index: 1;
}
```

**Step 2: Remove sidebar CSS from `ui/styles.css`**

Delete these CSS blocks entirely:
- `.sidebar` and all `.sidebar-*` rules
- `.session-dropdown` through `.session-group-list.collapsed`
- `.session-group-header .count`
- `.session-row` through `.session-action-btn.delete:hover`
- `.session-accordions`
- `.accordion-*` blocks
- `.sidebar-item[data-agent-color]`

**Step 3: Add new CSS for session picker, chip bar, and content split**

Add to `ui/styles.css`:

```css
/* Session picker (in header) */
.session-picker {
  position: relative;
}
.session-picker-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 10px;
  cursor: pointer;
  transition: border-color 0.2s;
  white-space: nowrap;
}
.session-picker-btn:hover { border-color: var(--accent-green); }
.session-picker-btn .chevron { font-size: 10px; color: var(--text-dim); }

.session-dropdown-panel {
  display: none;
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 320px;
  z-index: 200;
  background: var(--bg-panel);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  max-height: 60vh;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
.session-dropdown-panel.open { display: block; }

/* Keep existing session-search, session-group, session-row CSS
   (these are used inside the dropdown panel) */

/* Chip Bar */
.chip-bar {
  grid-area: chipbar;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  background: rgba(12, 15, 21, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  scrollbar-width: none;
  z-index: 10;
}
.chip-bar::-webkit-scrollbar { display: none; }

.chip-bar-divider {
  width: 1px;
  height: 20px;
  background: var(--border);
  flex-shrink: 0;
}

.chip-bar-label {
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  white-space: nowrap;
  flex-shrink: 0;
}

.agent-chip, .tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  font-family: var(--font-mono);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  flex-shrink: 0;
}
.agent-chip:hover, .tool-chip:hover { border-color: var(--border-bright); color: var(--text-primary); }
.agent-chip.active { border-color: var(--accent-green); color: var(--accent-green); background: var(--accent-green-dim); }
.tool-chip.active { border-color: var(--amber); color: var(--amber); background: var(--amber-dim); }

.agent-chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.chip-bar-empty {
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--text-dim);
}

.chip-clear {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 12px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  flex-shrink: 0;
}
.chip-clear:hover { border-color: var(--accent-red); color: var(--accent-red); }

/* Content Area */
.content {
  grid-area: content;
  display: grid;
  grid-template-columns: 38fr 62fr;
  gap: 1px;
  background: var(--border);
  overflow: hidden;
}

.content-panel {
  background: var(--bg-base);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
```

**Step 4: Remove old toolbar and filter CSS from `ui/styles.css`**

Delete `.toolbar`, `.filter-chip`, `.filter-chips-bar`, `.filter-select`, `.toolbar-spacer`, `.event-count` CSS blocks.

**Step 5: Remove old timeline and detail pane CSS from `ui/styles.css`**

Delete `.timeline-container`, `.timeline-empty`, `.event-row` and all related rules, `.detail-pane` and all related rules.

**Step 6: Update HTML structure in `ui/index.html`**

Replace the entire `<div id="app">` contents with:

```html
<div id="app">
  <header class="header">
    <div class="header-brand">
      <span class="icon"></span>
      agent-stalker
    </div>
    <div class="session-picker">
      <button class="session-picker-btn" id="sessionDropdownTrigger">
        <span id="sessionDropdownLabel">No sessions</span>
        <span class="chevron">&#9662;</span>
      </button>
      <div class="session-dropdown-panel" id="sessionDropdownPanel">
        <div class="session-search">
          <input type="text" id="sessionSearchInput" placeholder="Search sessions..." autocomplete="off">
        </div>
        <div class="session-group">
          <div class="session-group-header" id="activeGroupHeader">
            Active <span class="count" id="activeSessionCount">0</span>
          </div>
          <div class="session-group-list" id="activeSessionList"></div>
        </div>
        <div class="session-group">
          <div class="session-group-header collapsible collapsed" id="archivedGroupHeader">
            Archived <span class="count" id="archivedSessionCount">0</span>
            <span class="chevron">&#9662;</span>
          </div>
          <div class="session-group-list collapsed" id="archivedSessionList"></div>
        </div>
      </div>
    </div>
    <div class="header-search">
      <input type="text" id="searchInput" placeholder="Search events..." autocomplete="off">
    </div>
    <div class="header-controls">
      <div class="live-indicator" id="liveToggle" title="Toggle auto-refresh">
        <span class="live-dot"></span>
        <span id="liveLabel">LIVE</span>
      </div>
    </div>
  </header>

  <div class="chip-bar" id="chipBar">
    <span class="chip-bar-empty">Select a session to begin</span>
  </div>

  <div class="content">
    <div class="content-panel" id="kanbanPanel"></div>
    <div class="content-panel" id="activityPanel"></div>
  </div>

  <footer class="footer">
    <div class="footer-stat">Sessions: <span class="val" id="statSessions">0</span></div>
    <div class="footer-stat">Events: <span class="val" id="statEvents">0</span></div>
    <div class="footer-stat">Tools: <span class="val" id="statTools">0</span></div>
    <div class="footer-stat">Agents: <span class="val" id="statAgents">0</span></div>
    <div class="footer-stat">Tasks: <span class="val" id="statTasks">0</span></div>
    <div class="footer-spacer"></div>
    <div class="footer-time" id="footerTime"></div>
  </footer>

  <div class="modal-overlay" id="modalOverlay">
    <div class="modal-panel" id="modalPanel">
      <div class="modal-header">
        <h3 class="modal-title" id="modalTitle">Detail</h3>
        <div class="modal-nav">
          <button class="modal-nav-btn" id="modalPrev" title="Previous">&#8592;</button>
          <button class="modal-nav-btn" id="modalNext" title="Next">&#8594;</button>
        </div>
        <button class="modal-close" id="modalClose">&times;</button>
      </div>
      <div class="modal-body" id="modalBody"></div>
    </div>
  </div>
</div>
```

**Step 7: Verify in browser**

Expected: Header shows brand + session picker + search + live toggle. Chip bar shows empty message. Two blank content panels side by side. Modal overlay hidden. Footer visible. No sidebar.

**Step 8: Commit**

```bash
git add ui/index.html ui/styles.css
git commit -m "feat(ui): restructure layout - remove sidebar, add chip bar and content split"
```

---

### Task 3: Agent Chip Bar

**Files:**
- Modify: `ui/app.js`

**Context:** Replace `renderAccordions()` with `renderChipBar()` that builds horizontal agent + tool chips. Remove old accordion/sidebar JS.

**Step 1: Add state field**

Add to `state` object:
```javascript
toolChipFilter: '',  // tool_name string for chip-based tool filter
```

Remove from `state`:
```javascript
toolFilter: '',       // replaced by toolChipFilter
eventTypeFilter: '',  // removed (search covers this)
timeRangeFilter: '',  // removed (can re-add later)
```

**Step 2: Delete old functions**

Remove: `renderAccordions()`, `renderToolFilter()`, `renderFilterChips()`, and all event listeners for `toolFilter`, `eventTypeFilter`, `timeRangeFilter` selects.

**Step 3: Write `renderChipBar()` function**

```javascript
function renderChipBar() {
  const bar = document.getElementById('chipBar');
  const ids = [...state.selectedSessionIds];

  if (ids.length === 0) {
    bar.innerHTML = '<span class="chip-bar-empty">Select a session to begin</span>';
    return;
  }

  // Collect all agents across selected sessions (deduplicated)
  const agentMap = new Map();
  ids.forEach(sid => {
    const rawAgents = state.sessionAgents[sid] || [];
    rawAgents.forEach(a => {
      const key = a.agent_type || a.id;
      const existing = agentMap.get(key);
      if (!existing || (a.started_at > existing.started_at)) agentMap.set(key, a);
    });
  });
  const agents = [...agentMap.values()];

  // Collect top tools from loaded events
  const toolCounts = {};
  state.events.forEach(e => {
    if (e.tool_name) toolCounts[e.tool_name] = (toolCounts[e.tool_name] || 0) + 1;
  });
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  let html = '<span class="chip-bar-label">Agents</span>';

  // Top-level Claude chip
  const topActive = state.agentFilter === '__top_level__' ? ' active' : '';
  html += `<div class="agent-chip${topActive}" data-agent-chip="__top_level__" data-agent-label="Claude (session)" data-agent-color="${agentColor('__top_level__')}">
    <span class="dot" style="background:${agentColor('__top_level__')}"></span>Claude
  </div>`;

  // Subagent chips
  agents.forEach(a => {
    const aName = a.agent_type || a.id.slice(0, 12);
    const aColor = a.color ? namedColor(a.color) : agentColor(aName);
    const isActive = state.agentFilter === a.id ? ' active' : '';
    html += `<div class="agent-chip${isActive}" data-agent-chip="${esc(a.id)}" data-agent-label="${esc(aName)}" data-agent-color="${aColor}" style="${isActive ? `border-color:${aColor};color:${aColor};background:${aColor}18` : ''}">
      <span class="dot" style="background:${aColor}"></span>${esc(aName)}
    </div>`;
  });

  html += '<span class="chip-bar-divider"></span>';
  html += '<span class="chip-bar-label">Tools</span>';

  topTools.forEach(t => {
    const isActive = state.toolChipFilter === t.name ? ' active' : '';
    html += `<div class="tool-chip${isActive}" data-tool-chip="${esc(t.name)}">${esc(t.name)} <span style="opacity:0.5">${t.count}</span></div>`;
  });

  if (state.agentFilter || state.toolChipFilter) {
    html += `<div class="chip-clear" id="chipClearAll">Clear</div>`;
  }

  bar.innerHTML = html;

  // Agent chip click handlers
  bar.querySelectorAll('[data-agent-chip]').forEach(chip => {
    chip.addEventListener('click', () => {
      const agentId = chip.dataset.agentChip;
      if (state.agentFilter === agentId) {
        state.agentFilter = null;
        state.agentFilterLabel = null;
        state.agentFilterColor = null;
      } else {
        state.agentFilter = agentId;
        state.agentFilterLabel = chip.dataset.agentLabel || agentId;
        state.agentFilterColor = chip.dataset.agentColor || null;
      }
      renderChipBar();
      renderKanban();
      renderActivity();
    });
  });

  // Tool chip click handlers
  bar.querySelectorAll('[data-tool-chip]').forEach(chip => {
    chip.addEventListener('click', () => {
      const toolName = chip.dataset.toolChip;
      state.toolChipFilter = state.toolChipFilter === toolName ? '' : toolName;
      renderChipBar();
      renderActivity();
    });
  });

  // Clear all handler
  const clearBtn = document.getElementById('chipClearAll');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.agentFilter = null;
      state.agentFilterLabel = null;
      state.agentFilterColor = null;
      state.toolChipFilter = '';
      renderChipBar();
      renderKanban();
      renderActivity();
    });
  }
}
```

**Step 4: Update `loadSessionDetails()` call site**

Replace `renderAccordions()` with:
```javascript
renderChipBar();
renderKanban();
```

**Step 5: Verify in browser**

Expected: Selecting a session populates chip bar with Claude + subagent chips + top tools. Clicking chips toggles filters. Clear button resets.

**Step 6: Commit**

```bash
git add ui/app.js
git commit -m "feat(ui): add horizontal agent/tool chip bar replacing sidebar"
```

---

### Task 4: Kanban Board

**Files:**
- Modify: `ui/styles.css` (kanban CSS)
- Modify: `ui/app.js` (renderKanban function)

**Step 1: Add kanban CSS to `ui/styles.css`**

```css
/* Kanban Board */
.kanban {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1px;
  background: var(--border);
  height: 100%;
  overflow: hidden;
}

.kanban-col {
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.kanban-col-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.kanban-col-header .count {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 400;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-card);
  color: var(--text-dim);
}

.kanban-col-header .bar {
  width: 3px;
  height: 14px;
  border-radius: 2px;
  flex-shrink: 0;
}

.kanban-cards {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.kanban-card {
  padding: 8px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s;
}
.kanban-card:hover { border-color: var(--border-bright); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,0.2); }

.kanban-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.kanban-card-id {
  font-family: var(--font-mono);
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 6px;
  background: var(--bg-hover);
  color: var(--text-dim);
}

.kanban-card-blocked {
  font-family: var(--font-mono);
  font-size: 8px;
  padding: 1px 5px;
  border-radius: 6px;
  background: var(--accent-red-dim);
  color: var(--accent-red);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.kanban-card-subject {
  font-size: 11px;
  color: var(--text-primary);
  line-height: 1.4;
  margin-bottom: 4px;
}

.kanban-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.kanban-card-owner {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-dim);
}

.kanban-card-owner .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.kanban-card-time {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.kanban-empty {
  padding: 16px;
  text-align: center;
  font-size: 10px;
  color: var(--text-dim);
}
```

**Step 2: Write `renderKanban()` in `ui/app.js`**

```javascript
function renderKanban() {
  const panel = document.getElementById('kanbanPanel');
  const ids = [...state.selectedSessionIds];

  let allTasks = [];
  ids.forEach(sid => {
    allTasks = allTasks.concat(state.sessionTasks[sid] || []);
  });

  // Filter by agent owner if agent chip active
  if (state.agentFilter && state.agentFilter !== '__top_level__') {
    const label = state.agentFilterLabel || '';
    allTasks = allTasks.filter(t => t.owner === label);
  }

  const pending = allTasks.filter(t => t.status === 'pending');
  const inProgress = allTasks.filter(t => t.status === 'in_progress');
  const completed = allTasks.filter(t => t.status === 'completed');

  function col(title, tasks, color) {
    const cards = tasks.length === 0
      ? '<div class="kanban-empty">No tasks</div>'
      : tasks.map(t => {
          const hasBlocker = t.blocked_by && t.blocked_by !== '[]' && t.blocked_by !== 'null';
          const ownerColor = t.owner ? agentColor(t.owner) : 'var(--text-dim)';
          const ts = t.updated_at || t.created_at;
          return `<div class="kanban-card" data-task-id="${esc(t.id)}">
            <div class="kanban-card-header">
              <span class="kanban-card-id">#${esc(t.id)}</span>
              ${hasBlocker ? '<span class="kanban-card-blocked">Blocked</span>' : ''}
            </div>
            <div class="kanban-card-subject">${esc(t.subject || '(untitled)')}</div>
            <div class="kanban-card-footer">
              ${t.owner ? `<span class="kanban-card-owner"><span class="dot" style="background:${ownerColor}"></span>${esc(t.owner)}</span>` : '<span></span>'}
              <span class="kanban-card-time">${ts ? formatTime(ts) : ''}</span>
            </div>
          </div>`;
        }).join('');

    return `<div class="kanban-col">
      <div class="kanban-col-header">
        <span class="bar" style="background:${color}"></span>
        ${title}
        <span class="count">${tasks.length}</span>
      </div>
      <div class="kanban-cards">${cards}</div>
    </div>`;
  }

  panel.innerHTML = `<div class="kanban">
    ${col('Pending', pending, 'var(--amber)')}
    ${col('In Progress', inProgress, 'var(--accent-blue)')}
    ${col('Completed', completed, 'var(--accent-green)')}
  </div>`;

  // Task card click -> modal
  panel.querySelectorAll('[data-task-id]').forEach(card => {
    card.addEventListener('click', () => showTaskModal(card.dataset.taskId));
  });
}
```

**Step 3: Verify in browser**

Expected: Left panel shows 3-column kanban. Task cards display with ID, subject, owner, timestamp. Blocked tag appears on blocked tasks.

**Step 4: Commit**

```bash
git add ui/styles.css ui/app.js
git commit -m "feat(ui): add kanban task board in left content panel"
```

---

### Task 5: Grouped Activity List

**Files:**
- Modify: `ui/styles.css` (activity list CSS)
- Modify: `ui/app.js` (replace renderEvents with renderActivity)

**Step 1: Add activity list CSS to `ui/styles.css`**

```css
/* Activity List */
.activity-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.activity-title {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-secondary);
}

.activity-count {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-dim);
}

.activity-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.activity-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--text-dim);
  font-size: 12px;
}

/* Tool invocation card */
.tool-card {
  margin-bottom: 4px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--text-dim);
  transition: all 0.15s;
  overflow: hidden;
}
.tool-card:hover { border-color: var(--border-bright); }
.tool-card.error { border-left-color: var(--accent-red); }

.tool-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.tool-card-header:hover { background: var(--bg-hover); }

.tool-card-tool {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 8px;
  background: var(--accent-blue-dim);
  color: var(--accent-blue);
  flex-shrink: 0;
}

.tool-card-summary {
  flex: 1;
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-card-agent {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.tool-card-agent .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.tool-card-time {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.tool-card-status { font-size: 11px; flex-shrink: 0; }

.tool-card-body {
  display: none;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
}
.tool-card.expanded .tool-card-body { display: block; }

.tool-card-section { margin-bottom: 6px; }

.tool-card-section-label {
  font-family: var(--font-display);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  margin-bottom: 2px;
}

.tool-card-section-value {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 100px;
  overflow: hidden;
}

.tool-card-detail-link {
  display: inline-block;
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--amber);
  cursor: pointer;
}
.tool-card-detail-link:hover { text-decoration: underline; }

/* Standalone event row */
.standalone-event {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  margin-bottom: 2px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--text-secondary);
}
```

**Step 2: Write helper and `renderActivity()` in `ui/app.js`**

Delete `renderEvents()` function. Add:

```javascript
function getEventSummary(event) {
  if (!event.data) return '';
  try {
    const d = JSON.parse(event.data);
    if (d.tool_input?.command) return d.tool_input.command.slice(0, 80);
    if (d.tool_input?.file_path) return d.tool_input.file_path;
    if (d.tool_input?.pattern) return d.tool_input.pattern;
    if (d.reason) return d.reason;
    if (d.source) return d.source;
  } catch {}
  return '';
}

function renderActivity() {
  const panel = document.getElementById('activityPanel');
  let events = [...state.events];

  // Apply agent filter
  if (state.agentFilter) {
    events = state.agentFilter === '__top_level__'
      ? events.filter(e => !e.agent_id)
      : events.filter(e => e.agent_id === state.agentFilter);
  }

  // Apply tool chip filter
  if (state.toolChipFilter) {
    events = events.filter(e => e.tool_name === state.toolChipFilter);
  }

  // Apply text search
  if (state.searchText) {
    const q = state.searchText.toLowerCase();
    events = events.filter(e =>
      (e.hook_event_name || '').toLowerCase().includes(q) ||
      (e.tool_name || '').toLowerCase().includes(q) ||
      (e.agent_id || '').toLowerCase().includes(q) ||
      (e.data || '').toLowerCase().includes(q)
    );
  }

  // Group by tool_use_id
  const groups = [];
  const toolUseMap = new Map();
  events.forEach(e => {
    if (e.tool_use_id) {
      if (toolUseMap.has(e.tool_use_id)) {
        groups[toolUseMap.get(e.tool_use_id)].events.push(e);
      } else {
        toolUseMap.set(e.tool_use_id, groups.length);
        groups.push({ type: 'tool', tool_use_id: e.tool_use_id, events: [e] });
      }
    } else {
      groups.push({ type: 'standalone', event: e });
    }
  });

  if (events.length === 0) {
    panel.innerHTML = `<div class="activity-header">
      <span class="activity-title">Activity</span>
      <span class="activity-count">0 events</span>
    </div>
    <div class="activity-scroll"><div class="activity-empty"><div>No events to show</div></div></div>`;
    return;
  }

  let html = `<div class="activity-header">
    <span class="activity-title">Activity</span>
    <span class="activity-count">${events.length} events, ${groups.length} entries</span>
  </div><div class="activity-scroll" id="activityScroll">`;

  groups.forEach((group, gi) => {
    if (group.type === 'tool') {
      const evts = group.events;
      const post = evts.find(e => e.hook_event_name === 'PostToolUse' || e.hook_event_name === 'PostToolUseFailure');
      const pre = evts.find(e => e.hook_event_name === 'PreToolUse');
      const rep = post || pre || evts[0];
      const isError = evts.some(e => e.hook_event_name === 'PostToolUseFailure');
      const toolName = rep.tool_name || 'Unknown';
      const agentName = rep.agent_type || (rep.agent_id ? rep.agent_id.slice(0, 12) : '');
      const aColor = agentName ? agentColor(agentName) : 'var(--text-dim)';
      const summary = getEventSummary(rep);
      const statusIcon = isError ? '&#10005;' : (post ? '&#10003;' : '&#8943;');
      const statusColor = isError ? 'var(--accent-red)' : (post ? 'var(--accent-green)' : 'var(--text-dim)');

      let inputSummary = '', responseSummary = '';
      if (rep.data) {
        try {
          const d = JSON.parse(rep.data);
          if (d.tool_input) inputSummary = JSON.stringify(d.tool_input, null, 2).slice(0, 500);
          if (d.tool_response) {
            const rs = typeof d.tool_response === 'string' ? d.tool_response : JSON.stringify(d.tool_response, null, 2);
            responseSummary = rs.slice(0, 500);
          }
        } catch {}
      }

      html += `<div class="tool-card${isError ? ' error' : ''}" style="border-left-color:${aColor}">
        <div class="tool-card-header" data-toggle-group="${gi}">
          <span class="tool-card-tool">${esc(toolName)}</span>
          <span class="tool-card-summary" title="${esc(summary)}">${esc(summary) || '&mdash;'}</span>
          ${agentName ? `<span class="tool-card-agent"><span class="dot" style="background:${aColor}"></span>${esc(agentName)}</span>` : ''}
          <span class="tool-card-time">${formatTime(rep.timestamp)}</span>
          <span class="tool-card-status" style="color:${statusColor}">${statusIcon}</span>
        </div>
        <div class="tool-card-body">
          ${inputSummary ? `<div class="tool-card-section"><div class="tool-card-section-label">Input</div><div class="tool-card-section-value">${esc(inputSummary)}</div></div>` : ''}
          ${responseSummary ? `<div class="tool-card-section"><div class="tool-card-section-label">Response</div><div class="tool-card-section-value">${esc(responseSummary)}</div></div>` : ''}
          <span class="tool-card-detail-link" data-detail-id="${esc(rep.id)}">View full detail &#8594;</span>
        </div>
      </div>`;
    } else {
      const e = group.event;
      const agentName = e.agent_type || (e.agent_id ? e.agent_id.slice(0, 12) : '');
      const aColor = agentName ? agentColor(agentName) : 'var(--text-dim)';
      html += `<div class="standalone-event">
        <span class="event-type" data-type="${esc(e.hook_event_name)}">${esc(e.hook_event_name)}</span>
        ${agentName ? `<span class="tool-card-agent"><span class="dot" style="background:${aColor}"></span>${esc(agentName)}</span>` : ''}
        <span style="flex:1"></span>
        <span class="tool-card-time">${formatTime(e.timestamp)}</span>
      </div>`;
    }
  });

  html += '</div>';
  panel.innerHTML = html;

  // Toggle card expand
  panel.querySelectorAll('[data-toggle-group]').forEach(header => {
    header.addEventListener('click', () => header.closest('.tool-card').classList.toggle('expanded'));
  });

  // Detail link click
  panel.querySelectorAll('[data-detail-id]').forEach(link => {
    link.addEventListener('click', (e) => { e.stopPropagation(); showEventModal(link.dataset.detailId); });
  });

  // Auto-scroll if live
  if (state.isLive) {
    const scroll = document.getElementById('activityScroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }
}
```

**Step 3: Update all call sites**

Replace every `renderEvents()` call with `renderActivity()`:
- `loadEvents()` — after setting state.events
- `pollNewEvents()` — after appending new events
- Search input handler

**Step 4: Verify in browser**

Expected: Right panel shows grouped tool cards with colored left borders. Click header to expand/collapse. Standalone events render as simple rows. "View full detail" opens modal.

**Step 5: Commit**

```bash
git add ui/styles.css ui/app.js
git commit -m "feat(ui): add grouped activity list replacing flat timeline"
```

---

### Task 6: Detail Modal

**Files:**
- Modify: `ui/styles.css` (modal CSS)
- Modify: `ui/app.js` (modal functions, remove old detail pane code)

**Step 1: Add modal CSS to `ui/styles.css`**

```css
/* Modal */
.modal-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 500;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  align-items: center;
  justify-content: center;
}
.modal-overlay.open { display: flex; }

.modal-panel {
  width: 90%;
  max-width: 800px;
  max-height: 80vh;
  background: var(--bg-panel);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.modal-title {
  flex: 1;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-primary);
}

.modal-nav { display: flex; gap: 4px; }
.modal-nav-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  font-size: 14px;
  transition: all 0.15s;
}
.modal-nav-btn:hover { border-color: var(--border-bright); color: var(--text-primary); }
.modal-nav-btn:disabled { opacity: 0.3; cursor: default; }

.modal-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
  border-radius: var(--radius-sm);
  font-size: 18px;
  transition: all 0.15s;
}
.modal-close:hover { background: var(--bg-hover); color: var(--text-primary); }

.modal-body {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.modal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1px;
  background: var(--border);
}

.modal-field {
  background: var(--bg-panel);
  padding: 8px 10px;
}
.modal-field .label {
  font-family: var(--font-display);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  margin-bottom: 3px;
}
.modal-field .value {
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
  word-break: break-all;
}

.modal-json { padding: 12px 16px; }
.modal-json summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--text-secondary);
  padding: 4px 0;
  user-select: none;
}
.modal-json summary:hover { color: var(--text-primary); }
```

**Step 2: Write modal JS in `ui/app.js`**

Delete `renderDetail()`, `showTaskDetail()`, `closeDetail()`, and old `detailClose` event listener. Add:

```javascript
let modalEventIds = [];
let modalCurrentIndex = -1;

function openModal() { document.getElementById('modalOverlay').classList.add('open'); }

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('modalPrev').style.display = '';
  document.getElementById('modalNext').style.display = '';
  modalEventIds = [];
  modalCurrentIndex = -1;
}

async function showEventModal(eventId) {
  const data = await fetchJSON(`/api/events/${eventId}`);
  if (!data) return;
  modalEventIds = state.events.map(e => String(e.id));
  modalCurrentIndex = modalEventIds.indexOf(String(eventId));
  renderEventModal(data);
  updateModalNav();
  openModal();
}

function renderEventModal(event) {
  document.getElementById('modalTitle').textContent = `Event #${event.id} — ${event.hook_event_name}`;
  let parsed = null;
  try { parsed = event.data ? JSON.parse(event.data) : null; } catch {}

  let html = `<div class="modal-grid">
    <div class="modal-field"><div class="label">ID</div><div class="value">${esc(event.id)}</div></div>
    <div class="modal-field"><div class="label">Type</div><div class="value">${esc(event.hook_event_name)}</div></div>
    <div class="modal-field"><div class="label">Session</div><div class="value">${esc(event.session_id)}</div></div>
    <div class="modal-field"><div class="label">Tool</div><div class="value">${esc(event.tool_name || '(none)')}</div></div>
    <div class="modal-field"><div class="label">Tool Use ID</div><div class="value">${esc(event.tool_use_id || '(none)')}</div></div>
    <div class="modal-field"><div class="label">Agent</div><div class="value">${esc(event.agent_id || '(main thread)')}</div></div>
    <div class="modal-field"><div class="label">Agent Type</div><div class="value">${esc(event.agent_type || '(none)')}</div></div>
    <div class="modal-field"><div class="label">Team</div><div class="value">${esc(event.team_name || '(none)')}</div></div>
    <div class="modal-field"><div class="label">Teammate</div><div class="value">${esc(event.teammate_name || '(none)')}</div></div>
    <div class="modal-field"><div class="label">Timestamp</div><div class="value">${event.timestamp ? new Date(event.timestamp).toISOString() : '(none)'}</div></div>
  </div>`;

  if (parsed) {
    if (parsed.tool_input) {
      html += `<div class="modal-json"><details open><summary>tool_input</summary><div class="json-viewer">${syntaxHighlight(JSON.stringify(parsed.tool_input, null, 2))}</div></details></div>`;
    }
    if (parsed.tool_response) {
      html += `<div class="modal-json"><details open><summary>tool_response</summary><div class="json-viewer">${syntaxHighlight(JSON.stringify(parsed.tool_response, null, 2))}</div></details></div>`;
    }
    const shown = new Set(['tool_input', 'tool_response']);
    const rest = Object.fromEntries(Object.entries(parsed).filter(([k]) => !shown.has(k)));
    if (Object.keys(rest).length > 0) {
      html += `<div class="modal-json"><details><summary>other data</summary><div class="json-viewer">${syntaxHighlight(JSON.stringify(rest, null, 2))}</div></details></div>`;
    }
  }
  document.getElementById('modalBody').innerHTML = html;
}

function updateModalNav() {
  document.getElementById('modalPrev').disabled = modalCurrentIndex <= 0;
  document.getElementById('modalNext').disabled = modalCurrentIndex >= modalEventIds.length - 1;
}

async function showTaskModal(taskId) {
  const task = await fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}`);
  if (!task) return;
  const events = await fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}/events`) || [];

  document.getElementById('modalPrev').style.display = 'none';
  document.getElementById('modalNext').style.display = 'none';
  document.getElementById('modalTitle').textContent = `Task: ${task.subject || task.id}`;

  let html = `<div class="modal-grid">
    <div class="modal-field"><div class="label">ID</div><div class="value">${esc(task.id)}</div></div>
    <div class="modal-field"><div class="label">Status</div><div class="value" style="color:${taskStatusColor(task.status)}">${esc(task.status)}</div></div>
    <div class="modal-field"><div class="label">Owner</div><div class="value">${esc(task.owner || '(none)')}</div></div>
    <div class="modal-field"><div class="label">Team</div><div class="value">${esc(task.team_name || '(none)')}</div></div>
    <div class="modal-field"><div class="label">Created</div><div class="value">${task.created_at ? new Date(task.created_at).toISOString() : '(none)'}</div></div>
    <div class="modal-field"><div class="label">Updated</div><div class="value">${task.updated_at ? new Date(task.updated_at).toISOString() : '(none)'}</div></div>
    <div class="modal-field"><div class="label">Completed</div><div class="value">${task.completed_at ? new Date(task.completed_at).toISOString() : '(none)'}</div></div>
  </div>`;

  if (task.description) {
    html += `<div style="padding:12px 16px;font-size:12px;color:var(--text-secondary);border-bottom:1px solid var(--border)">${esc(task.description)}</div>`;
  }
  if (task.blocks && task.blocks !== '[]') {
    html += `<div class="modal-json"><details open><summary>Blocks</summary><div class="json-viewer">${syntaxHighlight(task.blocks)}</div></details></div>`;
  }
  if (task.blocked_by && task.blocked_by !== '[]') {
    html += `<div class="modal-json"><details open><summary>Blocked By</summary><div class="json-viewer">${syntaxHighlight(task.blocked_by)}</div></details></div>`;
  }
  if (events.length > 0) {
    html += `<div class="modal-json"><details open><summary>History (${events.length} events)</summary><div class="json-viewer">${events.map(ev =>
      `${esc(new Date(ev.timestamp).toISOString())}  <span class="json-key">${esc(ev.event_type)}</span>${ev.field_name ? '  ' + esc(ev.field_name) + ': <span class="json-null">' + esc(ev.old_value) + '</span> &#8594; <span class="json-string">' + esc(ev.new_value) + '</span>' : ''}`
    ).join('\n')}</div></details></div>`;
  }

  document.getElementById('modalBody').innerHTML = html;
  openModal();
}
```

**Step 3: Wire modal event handlers in `ui/app.js`**

Replace old detail-close and keyboard handlers:

```javascript
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
});
document.getElementById('modalPrev').addEventListener('click', async () => {
  if (modalCurrentIndex > 0) {
    modalCurrentIndex--;
    const data = await fetchJSON(`/api/events/${modalEventIds[modalCurrentIndex]}`);
    if (data) { renderEventModal(data); updateModalNav(); }
  }
});
document.getElementById('modalNext').addEventListener('click', async () => {
  if (modalCurrentIndex < modalEventIds.length - 1) {
    modalCurrentIndex++;
    const data = await fetchJSON(`/api/events/${modalEventIds[modalCurrentIndex]}`);
    if (data) { renderEventModal(data); updateModalNav(); }
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (document.getElementById('modalOverlay').classList.contains('open')) {
    if (e.key === 'ArrowLeft') document.getElementById('modalPrev').click();
    if (e.key === 'ArrowRight') document.getElementById('modalNext').click();
  }
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    document.getElementById('searchInput').focus();
  }
});
```

**Step 4: Verify in browser**

Expected: "View full detail" opens centered modal with full JSON. Arrow keys navigate events. Task card click opens task modal. Escape/backdrop closes.

**Step 5: Commit**

```bash
git add ui/styles.css ui/app.js
git commit -m "feat(ui): add detail modal replacing bottom detail pane"
```

---

### Task 7: Integration, Cleanup, and Verification

**Files:**
- Modify: `ui/app.js` (update loadAll, polling, remove dead code)
- Modify: `ui/styles.css` (remove dead CSS)

**Step 1: Update loadAll and polling in `ui/app.js`**

```javascript
async function loadAll() {
  await Promise.all([loadSessions(), loadEvents(), loadTools(), loadStats()]);
  await loadSessionDetails();
  renderKanban();
  renderActivity();
}
```

Update `pollNewEvents()` to call `renderActivity()` instead of `renderEvents()`.

Update search handler:
```javascript
document.getElementById('searchInput').addEventListener('input', e => {
  state.searchText = e.target.value;
  renderActivity();
});
```

**Step 2: Remove all dead code from `ui/app.js`**

Delete: `renderToolFilter`, `renderFilterChips`, `renderEvents`, `renderAccordions`, `renderDetail`, `showTaskDetail`, `closeDetail`, old filter select event listeners.

Remove dead state fields: `toolFilter`, `eventTypeFilter`, `timeRangeFilter`.

**Step 3: Remove dead CSS from `ui/styles.css`**

Delete: `.event-row`, `.timeline-*`, `.toolbar`, `.filter-chip`, `.filter-chips-bar`, `.filter-select`, `.detail-pane`, `.detail-*` (all replaced by new components).

**Step 4: Run backend tests**

Run: `bun test`
Expected: All tests pass. UI changes don't affect backend.

**Step 5: Full visual verification**

1. Page loads → header + empty chip bar + two panels + footer
2. Select session → chip bar populates, kanban shows tasks, activity shows grouped events
3. Click agent chip → both panels filter
4. Click tool chip → activity filters
5. Clear → resets
6. Expand tool card → shows preview
7. "View full detail" → modal with full JSON
8. Arrow keys navigate in modal
9. Kanban card click → task modal
10. Escape closes modal
11. Search filters activity
12. Live mode polls and auto-scrolls
13. No console errors

**Step 6: Commit final cleanup**

```bash
git add ui/index.html ui/styles.css ui/app.js
git commit -m "chore(ui): remove dead code and finalize content area redesign"
```
