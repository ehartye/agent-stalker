// --- Utility Functions ---

function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

const NAMED_COLORS = { blue: '#60a5fa', green: '#34d399', yellow: '#fbbf24', red: '#f87171', purple: '#a78bfa', pink: '#f472b6', orange: '#fb923c', cyan: '#38bdf8' };
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
function namedColor(name) {
  if (NAMED_COLORS[name]) return NAMED_COLORS[name];
  if (typeof name === 'string' && HEX_COLOR_RE.test(name)) return name;
  return 'var(--text-dim)';
}
const AGENT_COLORS = ['#a78bfa','#60a5fa','#34d399','#fbbf24','#f87171','#f472b6','#38bdf8','#4ade80','#fb923c','#c084fc'];
function agentColor(name) {
  if (!name || name === '__top_level__') return 'var(--accent-green)';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return AGENT_COLORS[Math.abs(h) % AGENT_COLORS.length];
}

function taskStatusColor(status) {
  switch (status) {
    case 'completed': return 'var(--accent-green)';
    case 'in_progress': return 'var(--accent-blue)';
    case 'blocked': return 'var(--accent-red)';
    default: return 'var(--text-dim)';
  }
}

function formatTime(ts) {
  if (!ts) return '---';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function syntaxHighlight(json) {
  if (typeof json !== 'string') json = JSON.stringify(json, null, 2);
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"([^"\\]*(\\.[^"\\]*)*)"\s*:/g, '<span class="json-key">"$1"</span>:')
    .replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, '<span class="json-string">"$1"</span>')
    .replace(/\b(-?\d+\.?\d*([eE][+-]?\d+)?)\b/g, '<span class="json-number">$1</span>')
    .replace(/\b(true|false)\b/g, '<span class="json-bool">$1</span>')
    .replace(/\bnull\b/g, '<span class="json-null">null</span>');
}

function sessionLabel(s) {
  return s.cwd ? s.cwd.split('/').pop() || s.id.slice(0, 12) : s.id.slice(0, 12);
}

function sessionLastEvent(s) {
  const ts = s.ended_at || s.started_at;
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function getAgentLabel(agentId) {
  if (agentId === '__top_level__') return 'Claude (session)';
  for (const sid of state.selectedSessionIds) {
    const agents = state.sessionAgents[sid] || [];
    const a = agents.find(a => a.id === agentId);
    if (a) return a.agent_type || a.id.slice(0, 12);
  }
  return agentId;
}

// --- State ---

const API = '';
const state = {
  activeSessions: [],
  archivedSessions: [],
  selectedSessionIds: new Set(),
  sessionAgents: {},
  sessionTasks: {},
  events: [],
  tools: [],
  stats: {},
  searchText: '',
  sessionSearchText: '',
  agentFilters: new Set(),
  toolChipFilters: new Set(),
  eventTypeFilters: new Set(),
  isLive: true,
  lastTimestamp: 0,
  eventsFullyLoaded: false,
  loadingMore: false,
};

// --- API ---

async function fetchJSON(url) {
  try {
    const res = await fetch(API + url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function loadSessions() {
  const [active, archived] = await Promise.all([
    fetchJSON('/api/sessions?limit=100'),
    fetchJSON('/api/sessions?limit=100&archived=true'),
  ]);
  if (active) state.activeSessions = active;
  if (archived) state.archivedSessions = archived;
  renderSessionDropdown();
}

async function loadSessionDetails() {
  const ids = [...state.selectedSessionIds];
  const agentPromises = ids.map(id => fetchJSON(`/api/agents?session=${id}`));
  const taskPromises = ids.map(id => fetchJSON(`/api/tasks?session=${id}`));
  const [agentResults, taskResults] = await Promise.all([
    Promise.all(agentPromises),
    Promise.all(taskPromises),
  ]);
  state.sessionAgents = {};
  state.sessionTasks = {};
  ids.forEach((id, i) => {
    state.sessionAgents[id] = agentResults[i] || [];
    state.sessionTasks[id] = taskResults[i] || [];
  });
  renderChipBar();
  renderKanban();
}

const EVENTS_PAGE_SIZE = 500;

async function loadEvents() {
  const ids = [...state.selectedSessionIds];
  if (ids.length === 0) {
    state.events = [];
    state.eventsFullyLoaded = false;
    renderActivity();
    return;
  }
  const promises = ids.map(id => fetchJSON(`/api/events?limit=${EVENTS_PAGE_SIZE}&session=${id}`));
  const results = await Promise.all(promises);
  const allEvents = results.flat().filter(Boolean);
  state.events = allEvents.sort((a, b) => a.timestamp - b.timestamp);
  state.eventsFullyLoaded = allEvents.length < EVENTS_PAGE_SIZE * ids.length;
  if (state.events.length > 0) {
    state.lastTimestamp = Math.max(...state.events.map(e => e.timestamp || 0));
  }
  renderChipBar();
  renderActivity();
}

async function loadMoreEvents() {
  if (state.loadingMore || state.eventsFullyLoaded) return;
  state.loadingMore = true;
  const ids = [...state.selectedSessionIds];
  const currentCount = state.events.length;
  const perSession = Math.ceil(currentCount / Math.max(ids.length, 1));
  const promises = ids.map(id =>
    fetchJSON(`/api/events?limit=${EVENTS_PAGE_SIZE}&offset=${perSession}&session=${id}`)
  );
  const results = await Promise.all(promises);
  const olderEvents = results.flat().filter(Boolean);
  if (olderEvents.length === 0) {
    state.eventsFullyLoaded = true;
  } else {
    const existingIds = new Set(state.events.map(e => e.id));
    const deduped = olderEvents.filter(e => !existingIds.has(e.id));
    if (deduped.length === 0) {
      state.eventsFullyLoaded = true;
    } else {
      const scroll = document.getElementById('activityScroll');
      const prevHeight = scroll ? scroll.scrollHeight : 0;
      const prevTop = scroll ? scroll.scrollTop : 0;
      state.events = state.events.concat(deduped).sort((a, b) => a.timestamp - b.timestamp);
      renderChipBar();
      renderActivity();
      const scrollAfter = document.getElementById('activityScroll');
      if (scrollAfter) scrollAfter.scrollTop = prevTop + (scrollAfter.scrollHeight - prevHeight);
    }
  }
  state.loadingMore = false;
}

async function loadTools() {
  const data = await fetchJSON('/api/tools');
  if (data) {
    state.tools = data;
  }
}

async function loadStats() {
  const data = await fetchJSON('/api/stats');
  if (data) {
    state.stats = data;
    renderStats();
  }
}

async function pollNewEvents() {
  if (!state.isLive || !state.lastTimestamp) return;
  const ids = [...state.selectedSessionIds];
  if (ids.length === 0) return;
  const promises = ids.map(id => {
    const url = `/api/events?since=${state.lastTimestamp}&limit=200&session=${id}`;
    return fetchJSON(url);
  });
  const results = await Promise.all(promises);
  const newEvents = results.flat().filter(Boolean);
  if (newEvents.length > 0) {
    state.events = state.events.concat(newEvents).sort((a, b) => a.timestamp - b.timestamp);
    state.lastTimestamp = Math.max(...newEvents.map(e => e.timestamp || 0));
    renderActivity();
    loadStats();
  }
}

// --- Session Dropdown Rendering ---

function renderSessionDropdown() {
  const count = state.selectedSessionIds.size;
  const label = document.getElementById('sessionDropdownLabel');
  if (count === 0) label.textContent = 'No sessions selected';
  else if (count === 1) {
    const s = [...state.activeSessions, ...state.archivedSessions].find(s => s.id === [...state.selectedSessionIds][0]);
    label.textContent = s ? (s.cwd || '').split('/').pop() || s.id : '1 session';
  } else {
    label.textContent = `${count} sessions`;
  }

  renderSessionList('activeSessionList', state.activeSessions, 'activeSessionCount', false);
  renderSessionList('archivedSessionList', state.archivedSessions, 'archivedSessionCount', true);
}

function renderSessionList(listId, sessions, countId, isArchived) {
  const el = document.getElementById(listId);
  const q = state.sessionSearchText.toLowerCase();
  const filtered = q ? sessions.filter(s => sessionLabel(s).toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) : sessions;
  document.getElementById(countId).textContent = filtered.length;

  el.innerHTML = filtered.map(s => {
    const checked = state.selectedSessionIds.has(s.id) ? 'checked' : '';
    const isActive = !s.ended_at;
    const actionBtn = isArchived
      ? `<button class="session-action-btn delete" data-delete="${esc(s.id)}" title="Delete permanently">&#10005;</button>`
      : `<button class="session-action-btn" data-archive="${esc(s.id)}" title="Archive">&#11015;</button>`;
    return `<div class="session-row">
      <input type="checkbox" data-session="${esc(s.id)}" ${checked}>
      <span class="dot" style="background:${isActive ? 'var(--accent-green)' : 'var(--text-dim)'};width:6px;height:6px;border-radius:50%;flex-shrink:0"></span>
      <div class="session-row-info">
        <div class="session-row-label" title="${esc(s.id)}">${esc(sessionLabel(s))}</div>
        <div class="session-row-subtitle">${esc(sessionLastEvent(s))}</div>
      </div>
      <div class="session-row-actions">${actionBtn}</div>
    </div>`;
  }).join('');

  // Checkbox handlers
  el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const sid = cb.dataset.session;
      if (cb.checked) state.selectedSessionIds.add(sid);
      else state.selectedSessionIds.delete(sid);
      state.agentFilters.clear();
      state.toolChipFilters.clear();
      state.eventTypeFilters.clear();
      state.eventsFullyLoaded = false;
      renderSessionDropdown();
      loadSessionDetails();
      loadEvents();
    });
  });

  // Archive handlers
  el.querySelectorAll('[data-archive]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = btn.dataset.archive;
      const res = await fetch(`/api/sessions/${sid}/archive`, { method: 'POST' });
      if (!res.ok) return;
      state.selectedSessionIds.delete(sid);
      await loadSessions();
      loadSessionDetails();
      loadEvents();
    });
  });

  // Delete handlers
  el.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = btn.dataset.delete;
      if (!confirm('Permanently delete this session and all its data?')) return;
      const res = await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
      if (!res.ok) return;
      state.selectedSessionIds.delete(sid);
      await loadSessions();
      loadSessionDetails();
      loadEvents();
    });
  });
}

// --- Chip Bar ---

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

  // Collect event types from loaded events
  const eventTypeCounts = {};
  state.events.forEach(e => {
    if (e.hook_event_name) eventTypeCounts[e.hook_event_name] = (eventTypeCounts[e.hook_event_name] || 0) + 1;
  });
  const eventTypes = Object.entries(eventTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  let html = '<div class="chip-bar-group"><span class="chip-bar-label">Agents</span>';

  // Top-level Claude chip
  const topActive = state.agentFilters.has('__top_level__') ? ' active' : '';
  html += `<div class="agent-chip${topActive}" data-agent-chip="__top_level__" data-agent-label="Claude (session)" data-agent-color="${agentColor('__top_level__')}">
    <span class="dot" style="background:${agentColor('__top_level__')}"></span>Claude
  </div>`;

  agents.forEach(a => {
    const aName = a.agent_type || a.id.slice(0, 12);
    const aColor = a.color ? namedColor(a.color) : agentColor(aName);
    const isActive = state.agentFilters.has(a.id) ? ' active' : '';
    html += `<div class="agent-chip${isActive}" data-agent-chip="${esc(a.id)}" data-agent-label="${esc(aName)}" data-agent-color="${aColor}" style="${isActive ? `border-color:${aColor};color:${aColor};background:${aColor}18` : ''}">
      <span class="dot" style="background:${aColor}"></span>${esc(aName)}
    </div>`;
  });

  html += '</div><span class="chip-bar-divider"></span>';
  html += '<div class="chip-bar-group"><span class="chip-bar-label">Tools</span>';

  topTools.forEach(t => {
    const isActive = state.toolChipFilters.has(t.name) ? ' active' : '';
    html += `<div class="tool-chip${isActive}" data-tool-chip="${esc(t.name)}">${esc(t.name)} <span style="opacity:0.5">${t.count}</span></div>`;
  });

  html += '</div><span class="chip-bar-divider"></span>';
  html += '<div class="chip-bar-group"><span class="chip-bar-label">Events</span>';

  eventTypes.forEach(t => {
    const isActive = state.eventTypeFilters.has(t.name) ? ' active' : '';
    html += `<div class="event-chip${isActive}" data-event-chip="${esc(t.name)}">${esc(t.name)} <span style="opacity:0.5">${t.count}</span></div>`;
  });

  html += '</div>';

  const hasFilters = state.agentFilters.size > 0 || state.toolChipFilters.size > 0 || state.eventTypeFilters.size > 0;
  if (hasFilters) {
    html += `<div class="chip-clear" id="chipClearAll">Clear</div>`;
  }

  bar.innerHTML = html;

  // Agent chip click — toggle in set
  bar.querySelectorAll('[data-agent-chip]').forEach(chip => {
    chip.addEventListener('click', () => {
      const agentId = chip.dataset.agentChip;
      if (state.agentFilters.has(agentId)) {
        state.agentFilters.delete(agentId);
      } else {
        state.agentFilters.add(agentId);
      }
      renderChipBar(); renderKanban(); renderActivity();
    });
  });

  // Tool chip click — toggle in set
  bar.querySelectorAll('[data-tool-chip]').forEach(chip => {
    chip.addEventListener('click', () => {
      const toolName = chip.dataset.toolChip;
      if (state.toolChipFilters.has(toolName)) {
        state.toolChipFilters.delete(toolName);
      } else {
        state.toolChipFilters.add(toolName);
      }
      renderChipBar(); renderActivity();
    });
  });

  // Event type chip click — toggle in set
  bar.querySelectorAll('[data-event-chip]').forEach(chip => {
    chip.addEventListener('click', () => {
      const eventType = chip.dataset.eventChip;
      if (state.eventTypeFilters.has(eventType)) {
        state.eventTypeFilters.delete(eventType);
      } else {
        state.eventTypeFilters.add(eventType);
      }
      renderChipBar(); renderActivity();
    });
  });

  const clearBtn = document.getElementById('chipClearAll');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      state.agentFilters.clear();
      state.toolChipFilters.clear();
      state.eventTypeFilters.clear();
      renderChipBar(); renderKanban(); renderActivity();
    });
  }
}

// --- Kanban ---

function renderKanban() {
  const panel = document.getElementById('kanbanPanel');
  const ids = [...state.selectedSessionIds];

  let allTasks = [];
  ids.forEach(sid => { allTasks = allTasks.concat(state.sessionTasks[sid] || []); });

  if (state.agentFilters.size > 0) {
    const labels = new Set([...state.agentFilters].map(id => getAgentLabel(id)));
    allTasks = allTasks.filter(t => labels.has(t.owner || 'Claude (session)'));
  }

  const pending = allTasks.filter(t => t.status === 'pending');
  const inProgress = allTasks.filter(t => t.status === 'in_progress');
  const completed = allTasks.filter(t => t.status === 'completed');

  function col(title, tasks, color) {
    const cards = tasks.length === 0
      ? '<div class="kanban-empty">No tasks</div>'
      : tasks.map(t => {
          const hasBlocker = t.blocked_by && t.blocked_by !== '[]' && t.blocked_by !== 'null';
          const ownerDisplay = t.owner || 'Claude';
          const ownerColor = t.owner ? agentColor(t.owner) : agentColor('__top_level__');
          const ts = t.updated_at || t.created_at;
          return `<div class="kanban-card" data-task-id="${esc(t.id)}">
            <div class="kanban-card-header">
              <span class="kanban-card-id">#${esc(t.id)}</span>
              ${hasBlocker ? '<span class="kanban-card-blocked">Blocked</span>' : ''}
            </div>
            <div class="kanban-card-subject">${esc(t.subject || '(untitled)')}</div>
            <div class="kanban-card-footer">
              <span class="kanban-card-owner"><span class="dot" style="background:${ownerColor}"></span>${esc(ownerDisplay)}</span>
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

  panel.querySelectorAll('[data-task-id]').forEach(card => {
    card.addEventListener('click', () => showTaskModal(card.dataset.taskId));
  });
}

// --- Activity ---

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

  // Agent filter (OR within selected agents)
  if (state.agentFilters.size > 0) {
    events = events.filter(e => {
      if (state.agentFilters.has('__top_level__') && !e.agent_id) return true;
      return state.agentFilters.has(e.agent_id);
    });
  }

  // Tool filter (OR within selected tools)
  if (state.toolChipFilters.size > 0) {
    events = events.filter(e => state.toolChipFilters.has(e.tool_name));
  }

  // Event type filter (OR within selected types)
  if (state.eventTypeFilters.size > 0) {
    events = events.filter(e => state.eventTypeFilters.has(e.hook_event_name));
  }

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
      let dataSummary = '';
      let hasData = false;
      if (e.data) {
        try {
          const d = JSON.parse(e.data);
          if (d && typeof d === 'object' && Object.keys(d).length > 0) {
            hasData = true;
            dataSummary = JSON.stringify(d, null, 2).slice(0, 500);
          }
        } catch {}
      }
      if (hasData) {
        html += `<div class="tool-card" style="border-left-color:${aColor}">
          <div class="tool-card-header" data-toggle-group="${gi}">
            <span class="event-type" data-type="${esc(e.hook_event_name)}">${esc(e.hook_event_name)}</span>
            <span class="tool-card-summary">${esc(getEventSummary(e))}</span>
            ${agentName ? `<span class="tool-card-agent"><span class="dot" style="background:${aColor}"></span>${esc(agentName)}</span>` : ''}
            <span style="flex:1"></span>
            <span class="tool-card-time">${formatTime(e.timestamp)}</span>
          </div>
          <div class="tool-card-body">
            <div class="tool-card-section"><div class="tool-card-section-label">Data</div><div class="tool-card-section-value">${esc(dataSummary)}</div></div>
            <span class="tool-card-detail-link" data-detail-id="${esc(e.id)}">View full detail &#8594;</span>
          </div>
        </div>`;
      } else {
        html += `<div class="standalone-event">
          <span class="event-type" data-type="${esc(e.hook_event_name)}">${esc(e.hook_event_name)}</span>
          ${agentName ? `<span class="tool-card-agent"><span class="dot" style="background:${aColor}"></span>${esc(agentName)}</span>` : ''}
          <span style="flex:1"></span>
          <span class="tool-card-time">${formatTime(e.timestamp)}</span>
        </div>`;
      }
    }
  });

  html += '</div>';
  panel.innerHTML = html;

  panel.querySelectorAll('[data-toggle-group]').forEach(header => {
    header.addEventListener('click', () => header.closest('.tool-card').classList.toggle('expanded'));
  });

  panel.querySelectorAll('[data-detail-id]').forEach(link => {
    link.addEventListener('click', (e) => { e.stopPropagation(); showEventModal(link.dataset.detailId); });
  });

  // Scroll to bottom in live mode (skip if loading older events), attach lazy-load listener
  const scroll = document.getElementById('activityScroll');
  if (scroll) {
    if (state.isLive && !state.loadingMore) scroll.scrollTop = scroll.scrollHeight;
    scroll.addEventListener('scroll', onActivityScroll);
  }
}

function onActivityScroll() {
  const scroll = document.getElementById('activityScroll');
  if (!scroll) return;
  if (scroll.scrollTop < 100 && !state.eventsFullyLoaded && !state.loadingMore) {
    loadMoreEvents();
  }
}

// --- Modal ---

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
  document.getElementById('modalTitle').textContent = `Event #${event.id} \u2014 ${event.hook_event_name}`;
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
    const rest = Object.entries(parsed).filter(([k]) => !shown.has(k));
    rest.forEach(([key, value]) => {
      const display = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      html += `<div class="modal-json"><details open><summary>${esc(key)}</summary><div class="json-viewer">${syntaxHighlight(display)}</div></details></div>`;
    });
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
    html += `<div style="padding:12px 16px;font-size:15px;color:var(--text-secondary);border-bottom:1px solid var(--border)">${esc(task.description)}</div>`;
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

// --- Stats ---

function renderStats() {
  const s = state.stats;
  document.getElementById('statSessions').textContent = s.sessions ?? 0;
  document.getElementById('statEvents').textContent = s.events ?? 0;
  document.getElementById('statTools').textContent = s.tools ?? 0;
  document.getElementById('statAgents').textContent = s.agents ?? 0;
  document.getElementById('statTasks').textContent = s.tasks ?? 0;
}

// --- Event Handlers ---

// Modal handlers
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

// Search
document.getElementById('searchInput').addEventListener('input', e => {
  state.searchText = e.target.value;
  renderActivity();
});

// Live toggle
document.getElementById('liveToggle').addEventListener('click', () => {
  state.isLive = !state.isLive;
  document.getElementById('liveToggle').classList.toggle('paused', !state.isLive);
  document.getElementById('liveLabel').textContent = state.isLive ? 'LIVE' : 'PAUSED';
});

// Session dropdown
document.getElementById('sessionDropdownTrigger').addEventListener('click', () => {
  document.getElementById('sessionDropdownPanel').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  const panel = document.getElementById('sessionDropdownPanel');
  const trigger = document.getElementById('sessionDropdownTrigger');
  if (!panel.contains(e.target) && !trigger.contains(e.target)) {
    panel.classList.remove('open');
  }
});
document.getElementById('sessionSearchInput').addEventListener('input', (e) => {
  state.sessionSearchText = e.target.value;
  renderSessionDropdown();
});
document.getElementById('archivedGroupHeader').addEventListener('click', () => {
  document.getElementById('archivedGroupHeader').classList.toggle('collapsed');
  document.getElementById('archivedSessionList').classList.toggle('collapsed');
});

// Keyboard
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

// --- Init ---

async function loadAll() {
  await Promise.all([loadSessions(), loadEvents(), loadTools(), loadStats()]);
  await loadSessionDetails();
  renderChipBar();
  renderKanban();
  renderActivity();
}

let polling = false;
function startPolling() {
  setInterval(async () => {
    document.getElementById('footerTime').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
    if (!state.isLive || polling) return;
    polling = true;
    try {
      await Promise.all([pollNewEvents(), loadSessionDetails(), loadStats()]);
    } finally { polling = false; }
  }, 3000);
}

loadAll().then(startPolling);
document.getElementById('footerTime').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
