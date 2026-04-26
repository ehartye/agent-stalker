import { state } from './state.js';
import { esc, sessionLabel, sessionLastEvent } from './util.js';
import { loadSessions, loadSessionDetails, loadEvents, loadStats } from './api.js';

export function renderSessionDropdown() {
  const count = state.selectedSessionIds.size;
  const label = document.getElementById('sessionDropdownLabel');
  if (count === 0) label.textContent = 'No sessions selected';
  else if (count === 1) {
    const s = [...state.activeSessions, ...state.archivedSessions].find(s => s.id === [...state.selectedSessionIds][0]);
    label.textContent = s ? sessionLabel(s) : '1 session';
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
        <div class="session-row-subtitle session-row-path" title="${esc(s.cwd || '')}">${esc(s.cwd || '(no path)')}</div>
        <div class="session-row-subtitle">${esc(sessionLastEvent(s) || '?')} &middot; ${esc(s.id.slice(0, 8))}</div>
      </div>
      <div class="session-row-actions">${actionBtn}</div>
    </div>`;
  }).join('');

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
      loadStats();
    });
  });

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
      loadStats();
    });
  });

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
      loadStats();
    });
  });
}
