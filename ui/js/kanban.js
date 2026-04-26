import { state } from './state.js';
import { esc, agentColor, formatTime, getAgentLabel } from './util.js';
import { showTaskModal } from './modal.js';

let _lastKanbanKey = '';

export function renderKanban() {
  const panel = document.getElementById('kanbanPanel');
  const ids = [...state.selectedSessionIds];

  let allTasks = [];
  ids.forEach(sid => { allTasks = allTasks.concat(state.sessionTasks[sid] || []); });

  if (state.agentFilters.size > 0) {
    const labels = new Set([...state.agentFilters].map(id => getAgentLabel(id)));
    allTasks = allTasks.filter(t => labels.has(t.owner || 'Claude (session)'));
  }

  const kanbanKey = JSON.stringify(allTasks.map(t => [t.id, t.session_id, t.status, t.subject, t.owner, t.updated_at, t.blocked_by]));
  if (kanbanKey === _lastKanbanKey) return;
  _lastKanbanKey = kanbanKey;

  // Per-session map of task_id -> status, used to derive whether a task's blockers are still active
  const statusBySession = new Map();
  allTasks.forEach(t => {
    let m = statusBySession.get(t.session_id);
    if (!m) { m = new Map(); statusBySession.set(t.session_id, m); }
    m.set(String(t.id), t.status);
  });
  function hasActiveBlocker(t) {
    if (!t.blocked_by || t.blocked_by === '[]' || t.blocked_by === 'null') return false;
    let ids;
    try { ids = JSON.parse(t.blocked_by); } catch { return false; }
    if (!Array.isArray(ids) || ids.length === 0) return false;
    const sessionMap = statusBySession.get(t.session_id);
    // Unknown blockers (not in our task set) are treated as still blocking
    return ids.some(id => (sessionMap?.get(String(id)) ?? 'pending') !== 'completed');
  }

  // status='blocked' is folded into Pending; the Blocked badge surfaces it visually
  const pending = allTasks.filter(t => t.status === 'pending' || t.status === 'blocked');
  const inProgress = allTasks.filter(t => t.status === 'in_progress');
  const completed = allTasks.filter(t => t.status === 'completed');

  function col(title, tasks, color) {
    const cards = tasks.length === 0
      ? '<div class="kanban-empty">No tasks</div>'
      : tasks.map(t => {
          const hasBlocker = t.status === 'blocked' || hasActiveBlocker(t);
          const ownerDisplay = t.owner || 'Claude';
          const ownerColor = t.owner ? agentColor(t.owner) : agentColor('__top_level__');
          const ts = t.updated_at || t.created_at;
          return `<div class="kanban-card" data-task-id="${esc(t.id)}" data-task-session="${esc(t.session_id)}">
            <div class="kanban-card-header">
              <span class="kanban-card-id">#${esc(t.id)}</span>
              ${hasBlocker ? '<span class="kanban-card-blocked">Blocked</span>' : ''}
              <span class="kanban-card-time">${ts ? formatTime(ts) : ''}</span>
            </div>
            <div class="kanban-card-subject">${esc(t.subject || '(untitled)')}</div>
            <div class="kanban-card-footer">
              <span class="kanban-card-owner" style="color:${ownerColor};border-color:${ownerColor}33;background:${ownerColor}14"><span class="dot" style="background:${ownerColor}"></span>${esc(ownerDisplay)}</span>
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

  const prevScroll = panel.scrollTop;

  panel.innerHTML = `<div class="kanban">
    ${col('Pending', pending, 'var(--amber)')}
    ${col('In Progress', inProgress, 'var(--accent-blue)')}
    ${col('Completed', completed, 'var(--accent-green)')}
  </div>`;

  panel.scrollTop = prevScroll;

  panel.querySelectorAll('[data-task-id]').forEach(card => {
    card.addEventListener('click', () => showTaskModal(card.dataset.taskId, card.dataset.taskSession));
  });
}
