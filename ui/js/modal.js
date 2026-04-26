import { state } from './state.js';
import { esc, syntaxHighlight, taskStatusColor } from './util.js';
import { fetchJSON } from './api.js';

let modalEventIds = [];
let modalCurrentIndex = -1;
let modalCurrentEvent = null;

export function openModal() { document.getElementById('modalOverlay').classList.add('open'); }

export function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.getElementById('modalPrev').style.display = '';
  document.getElementById('modalNext').style.display = '';
  document.getElementById('modalCopy').style.display = '';
  modalEventIds = [];
  modalCurrentIndex = -1;
  modalCurrentEvent = null;
}

function fencedBlock(content, lang = '') {
  // Pick a fence longer than the longest run of backticks in the content
  let max = 0, cur = 0;
  for (const ch of content) {
    if (ch === '`') { cur++; if (cur > max) max = cur; } else { cur = 0; }
  }
  const fence = '`'.repeat(Math.max(3, max + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

function formatEventForCopy(event) {
  const lines = [`# Event #${event.id} — ${event.hook_event_name}`, ''];
  const meta = [
    ['Session', event.session_id],
    ['Tool', event.tool_name],
    ['Tool Use ID', event.tool_use_id],
    ['Agent', event.agent_id],
    ['Agent Type', event.agent_type],
    ['Team', event.team_name],
    ['Teammate', event.teammate_name],
    ['Timestamp', event.timestamp ? new Date(event.timestamp).toISOString() : null],
  ];
  for (const [k, v] of meta) {
    if (v != null && v !== '') lines.push(`- **${k}**: ${v}`);
  }

  let parsed = null;
  try { parsed = event.data ? JSON.parse(event.data) : null; } catch {}
  if (parsed) {
    if (parsed.tool_input !== undefined) {
      lines.push('', '## tool_input', fencedBlock(JSON.stringify(parsed.tool_input, null, 2), 'json'));
    }
    if (parsed.tool_response !== undefined) {
      lines.push('', '## tool_response', fencedBlock(JSON.stringify(parsed.tool_response, null, 2), 'json'));
    }
    const skip = new Set(['tool_input', 'tool_response']);
    for (const [k, v] of Object.entries(parsed)) {
      if (skip.has(k)) continue;
      const display = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      lines.push('', `## ${k}`, fencedBlock(display));
    }
  }
  return lines.join('\n');
}

function fallbackCopy(text) {
  // Workaround for restricted/insecure contexts where navigator.clipboard is unavailable.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
  return ok;
}

export async function copyCurrentEvent() {
  if (!modalCurrentEvent) return;
  const btn = document.getElementById('modalCopy');
  const text = formatEventForCopy(modalCurrentEvent);

  const succeed = () => {
    btn.classList.add('copied');
    btn.textContent = 'Copied';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = 'Copy'; }, 1500);
  };
  const fail = (err) => {
    console.error('[copy] failed', err);
    btn.textContent = 'Failed';
    btn.title = err ? `Copy failed: ${err.message || err}` : 'Copy failed';
    setTimeout(() => { btn.textContent = 'Copy'; btn.title = 'Copy details to clipboard'; }, 2000);
  };

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      succeed();
      return;
    } catch (e) {
      if (fallbackCopy(text)) { succeed(); return; }
      fail(e);
      return;
    }
  }
  if (fallbackCopy(text)) succeed();
  else fail(new Error('clipboard unavailable'));
}

export async function showEventModal(eventId) {
  const data = await fetchJSON(`/api/events/${eventId}`);
  if (!data) return;
  modalEventIds = state.events.map(e => String(e.id));
  modalCurrentIndex = modalEventIds.indexOf(String(eventId));
  renderEventModal(data);
  updateModalNav();
  openModal();
}

export function renderEventModal(event) {
  modalCurrentEvent = event;
  const copyBtn = document.getElementById('modalCopy');
  copyBtn.style.display = '';
  copyBtn.textContent = 'Copy';
  copyBtn.classList.remove('copied');
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
    const rest = Object.entries(parsed).filter(([k]) => !shown.has(k));
    rest.forEach(([key, value]) => {
      const display = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      html += `<div class="modal-json"><details open><summary>${esc(key)}</summary><div class="json-viewer">${syntaxHighlight(display)}</div></details></div>`;
    });
  }
  document.getElementById('modalBody').innerHTML = html;
}

export function updateModalNav() {
  document.getElementById('modalPrev').disabled = modalCurrentIndex <= 0;
  document.getElementById('modalNext').disabled = modalCurrentIndex >= modalEventIds.length - 1;
}

export async function modalPrev() {
  if (modalCurrentIndex > 0) {
    modalCurrentIndex--;
    const data = await fetchJSON(`/api/events/${modalEventIds[modalCurrentIndex]}`);
    if (data) { renderEventModal(data); updateModalNav(); }
  }
}

export async function modalNext() {
  if (modalCurrentIndex < modalEventIds.length - 1) {
    modalCurrentIndex++;
    const data = await fetchJSON(`/api/events/${modalEventIds[modalCurrentIndex]}`);
    if (data) { renderEventModal(data); updateModalNav(); }
  }
}

export async function showTaskModal(taskId, sessionId) {
  const sessionParam = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  const task = await fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}${sessionParam}`);
  if (!task) return;
  const events = await fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}/events${sessionParam}`) || [];

  document.getElementById('modalPrev').style.display = 'none';
  document.getElementById('modalNext').style.display = 'none';
  document.getElementById('modalCopy').style.display = 'none';
  modalCurrentEvent = null;
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
