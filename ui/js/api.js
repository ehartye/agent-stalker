import { API, state } from './state.js';
import { renderSessionDropdown } from './session-picker.js';
import { renderChipBar } from './chip-bar.js';
import { renderKanban } from './kanban.js';
import { renderActivity } from './activity.js';

export async function fetchJSON(url) {
  try {
    const res = await fetch(API + url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function loadSessions() {
  const [active, archived] = await Promise.all([
    fetchJSON('/api/sessions?limit=100'),
    fetchJSON('/api/sessions?limit=100&archived=true'),
  ]);
  if (active) state.activeSessions = active;
  if (archived) state.archivedSessions = archived;
  renderSessionDropdown();
}

export async function loadSessionDetails() {
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

export async function loadEvents() {
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
  state.events = allEvents.sort((a, b) => b.timestamp - a.timestamp);
  state.eventsFullyLoaded = allEvents.length < EVENTS_PAGE_SIZE * ids.length;
  if (state.events.length > 0) {
    state.lastTimestamp = Math.max(...state.events.map(e => e.timestamp || 0));
  }
  renderChipBar();
  renderActivity();
}

export async function loadMoreEvents() {
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
      state.events = state.events.concat(deduped).sort((a, b) => b.timestamp - a.timestamp);
      renderChipBar();
      renderActivity();
    }
  }
  state.loadingMore = false;
}

export async function loadTools() {
  const data = await fetchJSON('/api/tools');
  if (data) state.tools = data;
}

export function renderStats() {
  const s = state.stats;
  document.getElementById('statSessions').textContent = s.sessions ?? 0;
  document.getElementById('statEvents').textContent = s.events ?? 0;
  document.getElementById('statTools').textContent = s.tools ?? 0;
  document.getElementById('statAgents').textContent = s.agents ?? 0;
  document.getElementById('statTasks').textContent = s.tasks ?? 0;
}

export async function loadStats() {
  const ids = [...state.selectedSessionIds];
  const url = ids.length > 0 ? `/api/stats?session=${ids.join(',')}` : '/api/stats';
  const data = await fetchJSON(url);
  if (data) {
    state.stats = data;
    renderStats();
  }
}

export async function pollNewEvents() {
  if (!state.isLive || !state.lastTimestamp) return;
  const ids = [...state.selectedSessionIds];
  if (ids.length === 0) return;
  const promises = ids.map(id => fetchJSON(`/api/events?since=${state.lastTimestamp}&limit=200&session=${id}`));
  const results = await Promise.all(promises);
  const newEvents = results.flat().filter(Boolean);
  if (newEvents.length > 0) {
    state.events = state.events.concat(newEvents).sort((a, b) => b.timestamp - a.timestamp);
    state.lastTimestamp = Math.max(...newEvents.map(e => e.timestamp || 0));
    renderActivity();
    loadStats();
  }
}
