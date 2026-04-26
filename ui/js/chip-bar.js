import { state } from './state.js';
import { esc, agentColor, namedColor } from './util.js';
import { renderKanban } from './kanban.js';
import { renderActivity } from './activity.js';

let _lastChipBarKey = '';

export function renderChipBar() {
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

  const toolCounts = {};
  state.events.forEach(e => {
    if (e.tool_name) toolCounts[e.tool_name] = (toolCounts[e.tool_name] || 0) + 1;
  });
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const eventTypeCounts = {};
  state.events.forEach(e => {
    if (e.hook_event_name) eventTypeCounts[e.hook_event_name] = (eventTypeCounts[e.hook_event_name] || 0) + 1;
  });
  const eventTypes = Object.entries(eventTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  let html = '<div class="chip-bar-group"><span class="chip-bar-label">Agents</span>';

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

  const chipBarKey = html;
  if (chipBarKey === _lastChipBarKey) return;
  _lastChipBarKey = chipBarKey;

  bar.innerHTML = html;

  bar.querySelectorAll('[data-agent-chip]').forEach(chip => {
    chip.addEventListener('click', () => {
      const agentId = chip.dataset.agentChip;
      if (state.agentFilters.has(agentId)) state.agentFilters.delete(agentId);
      else state.agentFilters.add(agentId);
      renderChipBar(); renderKanban(); renderActivity();
    });
  });

  bar.querySelectorAll('[data-tool-chip]').forEach(chip => {
    chip.addEventListener('click', () => {
      const toolName = chip.dataset.toolChip;
      if (state.toolChipFilters.has(toolName)) state.toolChipFilters.delete(toolName);
      else state.toolChipFilters.add(toolName);
      renderChipBar(); renderActivity();
    });
  });

  bar.querySelectorAll('[data-event-chip]').forEach(chip => {
    chip.addEventListener('click', () => {
      const eventType = chip.dataset.eventChip;
      if (state.eventTypeFilters.has(eventType)) state.eventTypeFilters.delete(eventType);
      else state.eventTypeFilters.add(eventType);
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
