function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

const NAMED_COLORS = { blue: '#60a5fa', green: '#34d399', yellow: '#fbbf24', red: '#f87171', purple: '#a78bfa', pink: '#f472b6', orange: '#fb923c', cyan: '#38bdf8' };
function namedColor(name) { return NAMED_COLORS[name] || name; }
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
  selectedEvent: null,
  searchText: '',
  sessionSearchText: '',
  toolFilter: '',
  eventTypeFilter: '',
  timeRangeFilter: '',
  agentFilter: null,       // agent id string, or '__top_level__' for session agent
  agentFilterLabel: null,
  agentFilterColor: null,
  isLive: true,
  lastTimestamp: 0,
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
  renderAccordions();
}

async function loadEvents() {
  const ids = [...state.selectedSessionIds];
  if (ids.length === 0) {
    state.events = [];
    renderEvents();
    return;
  }
  const promises = ids.map(id => {
    let url = `/api/events?limit=500&session=${id}`;
    if (state.toolFilter) url += `&tool=${encodeURIComponent(state.toolFilter)}`;
    return fetchJSON(url);
  });
  const results = await Promise.all(promises);
  state.events = results.flat().filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
  if (state.events.length > 0) {
    state.lastTimestamp = Math.max(...state.events.map(e => e.timestamp || 0));
  }
  renderEvents();
}

async function loadTools() {
  const data = await fetchJSON('/api/tools');
  if (data) {
    state.tools = data;
    renderToolFilter();
  }
}

async function loadStats() {
  const data = await fetchJSON('/api/stats');
  if (data) {
    state.stats = data;
    renderStats();
  }
}

async function loadEventDetail(id) {
  const data = await fetchJSON(`/api/events/${id}`);
  if (data) {
    state.selectedEvent = data;
    renderDetail(data);
  }
}

async function pollNewEvents() {
  if (!state.isLive || !state.lastTimestamp) return;
  const ids = [...state.selectedSessionIds];
  if (ids.length === 0) return;
  const promises = ids.map(id => {
    let url = `/api/events?since=${state.lastTimestamp}&limit=200&session=${id}`;
    if (state.toolFilter) url += `&tool=${encodeURIComponent(state.toolFilter)}`;
    return fetchJSON(url);
  });
  const results = await Promise.all(promises);
  const newEvents = results.flat().filter(Boolean);
  if (newEvents.length > 0) {
    state.events = state.events.concat(newEvents).sort((a, b) => a.timestamp - b.timestamp);
    state.lastTimestamp = Math.max(...newEvents.map(e => e.timestamp || 0));
    renderEvents();
    loadStats();
  }
}

// --- Rendering ---

function sessionLabel(s) {
  return s.cwd ? s.cwd.split('/').pop() || s.id.slice(0, 12) : s.id.slice(0, 12);
}

function sessionLastEvent(s) {
  const ts = s.ended_at || s.started_at;
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

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
      state.agentFilter = null;
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

function renderAccordions() {
  const el = document.getElementById('sessionAccordions');
  const ids = [...state.selectedSessionIds];
  const allSessions = [...state.activeSessions, ...state.archivedSessions];

  if (ids.length === 0) {
    el.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:11px;text-align:center">Select sessions above to view agents and tasks</div>';
    return;
  }

  el.innerHTML = ids.map(sid => {
    const session = allSessions.find(s => s.id === sid);
    if (!session) return '';
    const rawAgents = state.sessionAgents[sid] || [];
    // Deduplicate agents by agent_type, keeping the most recent entry
    const agentMap = new Map();
    rawAgents.forEach(a => {
      const key = a.agent_type || a.id;
      const existing = agentMap.get(key);
      if (!existing || (a.started_at > existing.started_at)) agentMap.set(key, a);
    });
    const agents = [...agentMap.values()];
    const tasks = state.sessionTasks[sid] || [];
    const isActive = !session.ended_at;
    const dotColor = isActive ? 'var(--accent-green)' : 'var(--text-dim)';

    return `<div class="accordion-item">
      <div class="accordion-header" data-accordion="${esc(sid)}">
        <span class="chevron">&#9662;</span>
        <span class="dot" style="background:${dotColor};width:6px;height:6px;border-radius:50%;flex-shrink:0"></span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sessionLabel(session))}</span>
        <span class="badge" style="font-size:10px;padding:1px 5px;border-radius:10px;background:var(--bg-card);color:var(--text-dim)">${agents.length}A ${tasks.length}T</span>
      </div>
      <div class="accordion-body">
        <div class="accordion-sub-header">Agents (${agents.length + 1})</div>
        <div class="sidebar-item" data-agent-filter="__top_level__" data-agent-label="Claude (session)" data-agent-color="${agentColor('__top_level__')}" data-session-scope="${esc(sid)}">
          <span class="dot" style="background:${isActive ? agentColor('__top_level__') : 'var(--text-dim)'}"></span>
          <span class="label">Claude (session)</span>
        </div>
        ${agents.map(a => {
            const isRunning = !a.ended_at;
            const aName = a.agent_type || a.id.slice(0, 12);
            const aColor = a.color ? namedColor(a.color) : agentColor(aName);
            return `<div class="sidebar-item" data-agent-filter="${esc(a.id)}" data-agent-label="${esc(aName)}" data-agent-color="${aColor}" data-session-scope="${esc(sid)}">
              <span class="dot" style="background:${isRunning ? aColor : 'var(--text-dim)'}"></span>
              <span class="label" title="${esc(a.id)}">${esc(aName)}</span>
              ${a.team_name ? `<span class="badge">${esc(a.team_name)}</span>` : ''}
            </div>`;
          }).join('')}
        <div class="accordion-sub-header" style="margin-top:4px">Tasks (${tasks.length})</div>
        ${tasks.length === 0 ? '<div style="padding:4px 8px;color:var(--text-dim);font-size:10px">(none)</div>' :
          tasks.map(t =>
            `<div class="sidebar-item" data-task-detail="${esc(t.id)}">
              <span class="dot" style="background:${taskStatusColor(t.status)}"></span>
              <span class="label">${esc(t.subject || t.id)}</span>
              ${t.owner ? `<span class="badge">${esc(t.owner)}</span>` : ''}
            </div>`
          ).join('')}
      </div>
    </div>`;
  }).join('');

  // Accordion toggle
  el.querySelectorAll('.accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      header.classList.toggle('collapsed');
    });
  });

  // Agent click -> filter events to that agent
  el.querySelectorAll('[data-agent-filter]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const agentId = item.dataset.agentFilter;
      const agentLabel = item.dataset.agentLabel || agentId;
      const aColor = item.dataset.agentColor || null;
      const wasActive = item.classList.contains('active');
      el.querySelectorAll('[data-agent-filter]').forEach(i => i.classList.remove('active'));
      if (wasActive) {
        state.agentFilter = null;
        state.agentFilterLabel = null;
        state.agentFilterColor = null;
      } else {
        item.classList.add('active');
        state.agentFilter = agentId;
        state.agentFilterLabel = agentLabel;
        state.agentFilterColor = aColor;
      }
      renderEvents();
    });
  });

  // Task click -> show detail
  el.querySelectorAll('[data-task-detail]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      showTaskDetail(item.dataset.taskDetail);
    });
  });
}

function renderToolFilter() {
  const el = document.getElementById('toolFilter');
  const current = el.value;
  el.innerHTML = '<option value="">All tools</option>' +
    state.tools.map(t => `<option value="${t.tool_name}">${t.tool_name} (${t.count})</option>`).join('');
  el.value = current;
}

function formatTime(ts) {
  if (!ts) return '---';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderFilterChips() {
  const bar = document.getElementById('filterChipsBar');
  const chips = [];
  if (state.agentFilter) {
    chips.push({ label: `Agent: ${state.agentFilterLabel || state.agentFilter}`, key: 'agent', color: state.agentFilterColor });
  }
  if (state.toolFilter) {
    chips.push({ label: `Tool: ${state.toolFilter}`, key: 'tool' });
  }
  if (state.eventTypeFilter) {
    chips.push({ label: `Event: ${state.eventTypeFilter}`, key: 'eventType' });
  }
  if (state.timeRangeFilter) {
    const labels = { '5m': '5 min', '15m': '15 min', '1h': '1 hour', '6h': '6 hours', '1d': '24 hours' };
    chips.push({ label: `Time: Last ${labels[state.timeRangeFilter] || state.timeRangeFilter}`, key: 'timeRange' });
  }
  if (state.searchText) {
    chips.push({ label: `Search: "${state.searchText}"`, key: 'search' });
  }
  bar.classList.toggle('has-chips', chips.length > 0);
  if (chips.length === 0) { bar.innerHTML = ''; return; }
  bar.innerHTML = chips.map(c => {
    const colorStyle = c.color ? `border-color:${c.color};color:${c.color};background:${c.color}18` : '';
    return `<span class="filter-chip active" data-chip-key="${c.key}" style="${colorStyle}"><span>${esc(c.label)}</span><span class="remove">×</span></span>`;
  }).join('') + (chips.length > 1 ? '<span class="filter-chip" data-chip-key="__all__"><span>Clear all</span></span>' : '');
  bar.querySelectorAll('[data-chip-key]').forEach(chip => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.chipKey;
      if (key === '__all__' || key === 'agent') { state.agentFilter = null; state.agentFilterLabel = null; state.agentFilterColor = null; }
      if (key === '__all__' || key === 'tool') { state.toolFilter = ''; document.getElementById('toolFilter').value = ''; }
      if (key === '__all__' || key === 'eventType') { state.eventTypeFilter = ''; document.getElementById('eventTypeFilter').value = ''; }
      if (key === '__all__' || key === 'timeRange') { state.timeRangeFilter = ''; document.getElementById('timeRangeFilter').value = ''; }
      if (key === '__all__' || key === 'search') { state.searchText = ''; document.getElementById('searchInput').value = ''; }
      if (key === 'tool' || key === '__all__') { state.lastTimestamp = 0; loadEvents(); } else { renderEvents(); }
    });
  });
}

function renderEvents() {
  const container = document.getElementById('timeline');
  let events = state.events;

  // Apply event type filter
  if (state.eventTypeFilter) {
    events = events.filter(e => e.hook_event_name === state.eventTypeFilter);
  }

  // Apply agent filter
  if (state.agentFilter) {
    if (state.agentFilter === '__top_level__') {
      events = events.filter(e => !e.agent_id);
    } else {
      events = events.filter(e => e.agent_id === state.agentFilter);
    }
  }

  // Apply time range filter
  if (state.timeRangeFilter) {
    const durations = { '5m': 5*60*1000, '15m': 15*60*1000, '1h': 60*60*1000, '6h': 6*60*60*1000, '1d': 24*60*60*1000 };
    const cutoff = Date.now() - (durations[state.timeRangeFilter] || 0);
    events = events.filter(e => e.timestamp && e.timestamp > cutoff);
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

  document.getElementById('eventCountLabel').textContent = `${events.length} event${events.length !== 1 ? 's' : ''}`;
  renderFilterChips();

  if (events.length === 0) {
    container.innerHTML = `<div class="timeline-empty">
      <div class="icon"></div>
      <div>No events captured yet</div>
      <div style="font-size:11px;color:var(--text-dim)">Events will appear here as Claude Code runs</div>
    </div>`;
    return;
  }

  container.innerHTML = events.map(e => {
    const tool = e.tool_name || '';
    const agent = e.agent_id ? (e.agent_type || e.agent_id.slice(0, 12)) : '';
    let summary = '';
    if (e.data) {
      try {
        const d = JSON.parse(e.data);
        if (d.tool_input?.command) summary = d.tool_input.command;
        else if (d.tool_input?.file_path) summary = d.tool_input.file_path;
        else if (d.tool_input?.pattern) summary = d.tool_input.pattern;
        else if (d.reason) summary = d.reason;
        else if (d.source) summary = d.source;
      } catch {}
    }
    const sessionShort = esc((e.session_id || '').slice(0, 8));
    return `<div class="event-row" data-id="${esc(e.id)}">
      <span class="time">${formatTime(e.timestamp)}</span>
      <span class="session-indicator" title="${esc(e.session_id)}" style="font-size:10px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sessionShort}</span>
      <span class="event-type" data-type="${esc(e.hook_event_name)}">${esc(e.hook_event_name)}</span>
      <span class="tool">${esc(tool)}</span>
      <span class="agent-badge">${esc(agent) || '&mdash;'}</span>
      <span class="summary" title="${esc(summary)}">${esc(summary)}</span>
    </div>`;
  }).join('');

  container.querySelectorAll('.event-row').forEach(row => {
    row.addEventListener('click', () => {
      container.querySelectorAll('.event-row.selected').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      loadEventDetail(row.dataset.id);
    });
  });

  // Auto-scroll to bottom if live
  if (state.isLive) {
    container.scrollTop = container.scrollHeight;
  }
}

function renderStats() {
  const s = state.stats;
  document.getElementById('statSessions').textContent = s.sessions ?? 0;
  document.getElementById('statEvents').textContent = s.events ?? 0;
  document.getElementById('statTools').textContent = s.tools ?? 0;
  document.getElementById('statAgents').textContent = s.agents ?? 0;
  document.getElementById('statTasks').textContent = s.tasks ?? 0;
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

function renderDetail(event) {
  const pane = document.getElementById('detailPane');
  const content = document.getElementById('detailContent');
  const title = document.getElementById('detailTitle');

  pane.classList.add('open');
  title.textContent = `Event #${event.id} — ${event.hook_event_name}`;

  let data = null;
  try { data = event.data ? JSON.parse(event.data) : null; } catch {}

  let html = `<div class="detail-grid">
    <div class="detail-field"><div class="label">ID</div><div class="value">${esc(event.id)}</div></div>
    <div class="detail-field"><div class="label">Type</div><div class="value">${esc(event.hook_event_name)}</div></div>
    <div class="detail-field"><div class="label">Session</div><div class="value">${esc(event.session_id)}</div></div>
    <div class="detail-field"><div class="label">Tool</div><div class="value">${esc(event.tool_name || '(none)')}</div></div>
    <div class="detail-field"><div class="label">Tool Use ID</div><div class="value">${esc(event.tool_use_id || '(none)')}</div></div>
    <div class="detail-field"><div class="label">Agent</div><div class="value">${esc(event.agent_id || '(main thread)')}</div></div>
    <div class="detail-field"><div class="label">Agent Type</div><div class="value">${esc(event.agent_type || '(none)')}</div></div>
    <div class="detail-field"><div class="label">Team</div><div class="value">${esc(event.team_name || '(none)')}</div></div>
    <div class="detail-field"><div class="label">Teammate</div><div class="value">${esc(event.teammate_name || '(none)')}</div></div>
    <div class="detail-field"><div class="label">Timestamp</div><div class="value">${event.timestamp ? new Date(event.timestamp).toISOString() : '(none)'}</div></div>
  </div>`;

  if (data) {
    if (data.tool_input) {
      html += `<div class="detail-json"><details open><summary>tool_input</summary>
        <div class="json-viewer">${syntaxHighlight(JSON.stringify(data.tool_input, null, 2))}</div>
      </details></div>`;
    }
    if (data.tool_response) {
      html += `<div class="detail-json"><details open><summary>tool_response</summary>
        <div class="json-viewer">${syntaxHighlight(JSON.stringify(data.tool_response, null, 2))}</div>
      </details></div>`;
    }
    // Show remaining data keys
    const shown = new Set(['tool_input', 'tool_response']);
    const remaining = Object.fromEntries(Object.entries(data).filter(([k]) => !shown.has(k)));
    if (Object.keys(remaining).length > 0) {
      html += `<div class="detail-json"><details><summary>other data</summary>
        <div class="json-viewer">${syntaxHighlight(JSON.stringify(remaining, null, 2))}</div>
      </details></div>`;
    }
  }

  content.innerHTML = html;
}

async function showTaskDetail(taskId) {
  const task = await fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}`);
  if (!task) return;
  const events = await fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}/events`) || [];

  const pane = document.getElementById('detailPane');
  const content = document.getElementById('detailContent');
  const title = document.getElementById('detailTitle');

  pane.classList.add('open');
  title.textContent = `Task: ${task.subject || task.id}`;

  let html = `<div class="detail-grid">
    <div class="detail-field"><div class="label">ID</div><div class="value">${esc(task.id)}</div></div>
    <div class="detail-field"><div class="label">Status</div><div class="value">${esc(task.status)}</div></div>
    <div class="detail-field"><div class="label">Owner</div><div class="value">${esc(task.owner || '(none)')}</div></div>
    <div class="detail-field"><div class="label">Team</div><div class="value">${esc(task.team_name || '(none)')}</div></div>
    <div class="detail-field"><div class="label">Description</div><div class="value">${esc(task.description || '(none)')}</div></div>
    <div class="detail-field"><div class="label">Blocks</div><div class="value">${esc(task.blocks || '(none)')}</div></div>
    <div class="detail-field"><div class="label">Blocked By</div><div class="value">${esc(task.blocked_by || '(none)')}</div></div>
    <div class="detail-field"><div class="label">Created</div><div class="value">${task.created_at ? new Date(task.created_at).toISOString() : '(none)'}</div></div>
    <div class="detail-field"><div class="label">Updated</div><div class="value">${task.updated_at ? new Date(task.updated_at).toISOString() : '(none)'}</div></div>
    <div class="detail-field"><div class="label">Completed</div><div class="value">${task.completed_at ? new Date(task.completed_at).toISOString() : '(none)'}</div></div>
  </div>`;

  if (events.length > 0) {
    html += `<div class="detail-json"><details open><summary>History (${events.length} events)</summary>
      <div class="json-viewer">${events.map(ev =>
        `${esc(new Date(ev.timestamp).toISOString())}  ${esc(ev.event_type)}${ev.field_name ? '  ' + esc(ev.field_name) + ': ' + esc(ev.old_value) + ' -> ' + esc(ev.new_value) : ''}`
      ).join('\n')}</div>
    </details></div>`;
  }

  content.innerHTML = html;
}

function closeDetail() {
  document.getElementById('detailPane').classList.remove('open');
  document.querySelectorAll('.event-row.selected').forEach(r => r.classList.remove('selected'));
  state.selectedEvent = null;
}

// --- Events ---

document.getElementById('detailClose').addEventListener('click', closeDetail);

document.getElementById('searchInput').addEventListener('input', e => {
  state.searchText = e.target.value;
  renderEvents();
});

document.getElementById('toolFilter').addEventListener('change', e => {
  state.toolFilter = e.target.value;
  state.lastTimestamp = 0;
  loadEvents();
});

document.getElementById('eventTypeFilter').addEventListener('change', e => {
  state.eventTypeFilter = e.target.value;
  renderEvents();
});

document.getElementById('timeRangeFilter').addEventListener('change', e => {
  state.timeRangeFilter = e.target.value;
  renderEvents();
});

document.getElementById('liveToggle').addEventListener('click', () => {
  state.isLive = !state.isLive;
  const el = document.getElementById('liveToggle');
  const label = document.getElementById('liveLabel');
  el.classList.toggle('paused', !state.isLive);
  label.textContent = state.isLive ? 'LIVE' : 'PAUSED';
});

// --- Session Dropdown ---

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

// --- Keyboard ---

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDetail();
  if (e.key === '/' && document.activeElement !== document.getElementById('searchInput')) {
    e.preventDefault();
    document.getElementById('searchInput').focus();
  }
});

// --- Init ---

async function loadAll() {
  await Promise.all([loadSessions(), loadEvents(), loadTools(), loadStats()]);
  await loadSessionDetails();
}

function startPolling() {
  setInterval(() => {
    if (state.isLive) {
      pollNewEvents();
      loadSessionDetails();
      loadStats();
    }
    document.getElementById('footerTime').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }, 2000);
}

loadAll().then(startPolling);
document.getElementById('footerTime').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
