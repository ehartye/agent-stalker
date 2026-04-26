import { state } from './state.js';
import { esc, agentColor, formatTime } from './util.js';
import { loadMoreEvents } from './api.js';
import { showEventModal } from './modal.js';

function attributionName(event) {
  if (event.agent_type) return event.agent_type;
  if (event.agent_id) return event.agent_id.slice(0, 12);
  if (event.teammate_name) return event.teammate_name;
  return '';
}

export function getEventSummary(event) {
  if (!event.data) return '';
  let d;
  try { d = JSON.parse(event.data); } catch { return ''; }
  const input = d.tool_input;

  switch (event.tool_name) {
    case 'SendMessage': {
      const to = input?.to, sm = input?.summary;
      if (to && sm) return `→ ${to}: ${sm}`;
      if (sm) return sm;
      if (to) return `→ ${to}`;
      break;
    }
    case 'Skill': return input?.skill || '';
    case 'WebSearch':
    case 'ToolSearch': return input?.query || '';
    case 'WebFetch': return input?.url || '';
    case 'Agent': return input?.description || input?.subagent_type || '';
    case 'TaskCreate': return input?.subject || '';
    case 'TaskUpdate': {
      const id = input?.taskId;
      const parts = [];
      if (input?.status) parts.push(input.status);
      if (input?.owner) parts.push(`owner=${input.owner}`);
      if (input?.subject) parts.push(`"${String(input.subject).slice(0, 40)}"`);
      if (id && parts.length) return `#${id} → ${parts.join(', ')}`;
      if (id) return `#${id}`;
      break;
    }
    case 'TaskGet': return input?.taskId ? `#${input.taskId}` : '';
    case 'TaskOutput':
    case 'TaskStop': return input?.task_id ? `#${input.task_id}` : '';
    case 'TaskList': return '';
    case 'TeamCreate': return input?.team_name || '';
    case 'TodoWrite': {
      const todos = input?.todos;
      if (Array.isArray(todos)) return `${todos.length} todo${todos.length === 1 ? '' : 's'}`;
      break;
    }
    case 'ScheduleWakeup':
      return input?.reason || (input?.delaySeconds ? `wake in ${input.delaySeconds}s` : '');
  }

  if (d.prompt) return String(d.prompt).replace(/\s+/g, ' ').trim();
  if (input?.command) return input.command.slice(0, 80);
  if (input?.file_path) return input.file_path;
  if (input?.pattern) return input.pattern;
  if (d.reason) return d.reason;
  if (d.source) return d.source;
  return '';
}

let _lastActivityKey = '';

export function renderActivity() {
  const panel = document.getElementById('activityPanel');
  let events = [...state.events];

  if (state.agentFilters.size > 0) {
    events = events.filter(e => {
      if (state.agentFilters.has('__top_level__') && !e.agent_id) return true;
      return state.agentFilters.has(e.agent_id);
    });
  }

  if (state.toolChipFilters.size > 0) {
    events = events.filter(e => state.toolChipFilters.has(e.tool_name));
  }

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
      const agentName = attributionName(rep);
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
          <span class="activity-meta">
            <span class="agent-slot">${agentName ? `<span class="tool-card-agent" style="color:${aColor};border-color:${aColor}33;background:${aColor}14"><span class="dot" style="background:${aColor}"></span>${esc(agentName)}</span>` : ''}</span>
            <span class="tool-card-time">${formatTime(rep.timestamp)}</span>
            <span class="tool-card-status" style="color:${statusColor}">${statusIcon}</span>
          </span>
        </div>
        <div class="tool-card-body">
          ${inputSummary ? `<div class="tool-card-section"><div class="tool-card-section-label">Input</div><div class="tool-card-section-value">${esc(inputSummary)}</div></div>` : ''}
          ${responseSummary ? `<div class="tool-card-section"><div class="tool-card-section-label">Response</div><div class="tool-card-section-value">${esc(responseSummary)}</div></div>` : ''}
          <span class="tool-card-detail-link" data-detail-id="${esc(rep.id)}">View full detail &#8594;</span>
        </div>
      </div>`;
    } else {
      const e = group.event;
      const agentName = attributionName(e);
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
            <span class="tool-card-summary" title="${esc(getEventSummary(e))}">${esc(getEventSummary(e))}</span>
            <span class="activity-meta">
              <span class="agent-slot">${agentName ? `<span class="tool-card-agent" style="color:${aColor};border-color:${aColor}33;background:${aColor}14"><span class="dot" style="background:${aColor}"></span>${esc(agentName)}</span>` : ''}</span>
              <span class="tool-card-time">${formatTime(e.timestamp)}</span>
              <span class="tool-card-status"></span>
            </span>
          </div>
          <div class="tool-card-body">
            <div class="tool-card-section"><div class="tool-card-section-label">Data</div><div class="tool-card-section-value">${esc(dataSummary)}</div></div>
            <span class="tool-card-detail-link" data-detail-id="${esc(e.id)}">View full detail &#8594;</span>
          </div>
        </div>`;
      } else {
        html += `<div class="standalone-event">
          <span class="event-type" data-type="${esc(e.hook_event_name)}">${esc(e.hook_event_name)}</span>
          <span style="flex:1"></span>
          <span class="activity-meta">
            <span class="agent-slot">${agentName ? `<span class="tool-card-agent" style="color:${aColor};border-color:${aColor}33;background:${aColor}14"><span class="dot" style="background:${aColor}"></span>${esc(agentName)}</span>` : ''}</span>
            <span class="tool-card-time">${formatTime(e.timestamp)}</span>
            <span class="tool-card-status"></span>
          </span>
        </div>`;
      }
    }
  });

  html += '</div>';

  const activityKey = events.map(e => e.id).join(',');
  if (activityKey === _lastActivityKey) return;
  _lastActivityKey = activityKey;

  // Save accordion expanded states and scroll position before re-render
  const expandedGroups = new Set();
  panel.querySelectorAll('.tool-card.expanded [data-toggle-group]').forEach(h => {
    expandedGroups.add(h.dataset.toggleGroup);
  });
  const scroll = document.getElementById('activityScroll');
  const prevScrollTop = scroll ? scroll.scrollTop : 0;
  const prevScrollHeight = scroll ? scroll.scrollHeight : 0;

  panel.innerHTML = html;

  if (expandedGroups.size > 0) {
    panel.querySelectorAll('[data-toggle-group]').forEach(header => {
      if (expandedGroups.has(header.dataset.toggleGroup)) {
        header.closest('.tool-card').classList.add('expanded');
      }
    });
  }

  panel.querySelectorAll('[data-toggle-group]').forEach(header => {
    header.addEventListener('click', () => header.closest('.tool-card').classList.toggle('expanded'));
  });

  panel.querySelectorAll('[data-detail-id]').forEach(link => {
    link.addEventListener('click', (e) => { e.stopPropagation(); showEventModal(link.dataset.detailId); });
  });

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
}

function onActivityScroll() {
  const scroll = document.getElementById('activityScroll');
  if (!scroll) return;
  const distanceFromBottom = scroll.scrollHeight - (scroll.scrollTop + scroll.clientHeight);
  if (distanceFromBottom < 100 && !state.eventsFullyLoaded && !state.loadingMore) {
    loadMoreEvents();
  }
}
