import { state } from './state.js';
import {
  loadSessions, loadSessionDetails, loadEvents, loadTools, loadStats, pollNewEvents, fetchJSON,
} from './api.js';
import { renderSessionDropdown } from './session-picker.js';
import { renderChipBar } from './chip-bar.js';
import { renderKanban } from './kanban.js';
import { renderActivity } from './activity.js';
import { closeModal, copyCurrentEvent, modalPrev, modalNext, showEventModal, showTaskModal, showEventListModal } from './modal.js';
import { renderInsights, applyInsightsSearch } from './insights.js';

// Modal handlers
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCopy').addEventListener('click', copyCurrentEvent);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
});
document.getElementById('modalPrev').addEventListener('click', modalPrev);
document.getElementById('modalNext').addEventListener('click', modalNext);

// Search — filters the active view (Activity event stream, or Insights tables)
document.getElementById('searchInput').addEventListener('input', e => {
  state.searchText = e.target.value;
  if (state.currentView === 'insights') applyInsightsSearch();
  else renderActivity();
});

// Live toggle
document.getElementById('liveToggle').addEventListener('click', () => {
  state.isLive = !state.isLive;
  document.getElementById('liveToggle').classList.toggle('paused', !state.isLive);
  document.getElementById('liveLabel').textContent = state.isLive ? 'LIVE' : 'PAUSED';
});

// View toggle (Activity <-> Insights)
function setView(view) {
  const isInsights = view === 'insights';
  state.currentView = view;
  document.getElementById('kanbanPanel').style.display = isInsights ? 'none' : '';
  document.getElementById('activityPanel').style.display = isInsights ? 'none' : '';
  document.getElementById('insightsPanel').style.display = isInsights ? '' : 'none';
  // The chip bar holds Activity-only filters (tools/agents/event types) and just
  // steals vertical space on Insights — hide it there.
  document.getElementById('chipBar').style.display = isInsights ? 'none' : '';
  document.getElementById('viewActivityBtn').classList.toggle('active', !isInsights);
  document.getElementById('viewInsightsBtn').classList.toggle('active', isInsights);
  if (isInsights) renderInsights();
}
document.getElementById('viewActivityBtn').addEventListener('click', () => setView('activity'));
document.getElementById('viewInsightsBtn').addEventListener('click', () => setView('insights'));

// Drill-in: delegated click on Insights rows → context destination
// Note: interactive controls inside a drill row (e.g. the Flag-for-triage button) must call e.stopPropagation() so they don't also trigger this row drill.
document.getElementById('insightsPanel').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-drill]');
  if (!tr) return;
  const d = tr.dataset;
  if (d.drill === 'session') {
    if (!d.session) return;
    state.selectedSessionIds = new Set([d.session]);
    state.agentFilters.clear();
    state.toolChipFilters.clear();
    state.eventTypeFilters.clear();
    state.eventsFullyLoaded = false;
    renderSessionDropdown();
    loadSessionDetails();
    loadEvents();
    loadStats();
    setView('activity');
  } else if (d.drill === 'event') {
    if (d.event) showEventModal(d.event, [d.event]);
  } else if (d.drill === 'task') {
    if (d.task) showTaskModal(d.task, d.session);
  } else if (d.drill === 'events') {
    const p = new URLSearchParams({ by: d.by, value: d.value || '' });
    if (d.tool) p.set('tool', d.tool);
    if (d.retrySession) p.set('retry_session', d.retrySession);
    if (d.errorsOnly) p.set('errorsOnly', '1');
    const scope = [...state.selectedSessionIds];
    if (scope.length) p.set('session', scope.join(','));
    const res = await fetchJSON('/api/insights/events?' + p.toString());
    showEventListModal(d.drillTitle || 'Events', res?.events || [], res?.truncated);
  }
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

// Init
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

// Force immediate poll when tab becomes visible (browsers throttle background tabs)
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && state.isLive && !polling) {
    polling = true;
    try {
      await Promise.all([pollNewEvents(), loadSessionDetails(), loadStats()]);
    } finally { polling = false; }
  }
});
