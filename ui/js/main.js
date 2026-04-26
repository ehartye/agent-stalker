import { state } from './state.js';
import {
  loadSessions, loadSessionDetails, loadEvents, loadTools, loadStats, pollNewEvents,
} from './api.js';
import { renderSessionDropdown } from './session-picker.js';
import { renderChipBar } from './chip-bar.js';
import { renderKanban } from './kanban.js';
import { renderActivity } from './activity.js';
import { closeModal, copyCurrentEvent, modalPrev, modalNext } from './modal.js';

// Modal handlers
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCopy').addEventListener('click', copyCurrentEvent);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
});
document.getElementById('modalPrev').addEventListener('click', modalPrev);
document.getElementById('modalNext').addEventListener('click', modalNext);

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
