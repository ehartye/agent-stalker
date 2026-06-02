import { API, state } from './state.js';
import { esc } from './util.js';

async function fetchJSON(url) {
  try { const r = await fetch(API + url); return r.ok ? await r.json() : null; } catch { return null; }
}

// When sessions are selected in the header picker, scope the structured metrics
// to them (empty selection → global across all sessions).
function sessionQS() {
  const ids = [...state.selectedSessionIds];
  return ids.length ? '?session=' + ids.map(encodeURIComponent).join(',') : '';
}

// Client-side filter: hide table rows that don't match the header search box.
export function applyInsightsSearch() {
  const q = (state.searchText || '').toLowerCase();
  document.querySelectorAll('#insightsPanel .insights-table tbody tr').forEach(tr => {
    tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

export async function renderInsights() {
  const panel = document.getElementById('insightsPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="insights-loading">Loading insights…</div>';

  const qs = sessionQS();
  const [pain, tokens, errors, churn, thrash, semantic, triage] = await Promise.all([
    fetchJSON('/api/insights/pain' + qs),
    fetchJSON('/api/insights/tokens' + qs),
    fetchJSON('/api/insights/errors' + qs),
    fetchJSON('/api/insights/churn' + qs),
    fetchJSON('/api/insights/thrash' + qs),
    fetchJSON('/api/insights/semantic/status'),
    fetchJSON('/api/insights/semantic/triage'),
  ]);

  const semanticData = semantic && semantic.available ? await Promise.all([
    fetchJSON('/api/insights/semantic/sentiment'),
    fetchJSON('/api/insights/semantic/topics'),
    fetchJSON('/api/insights/semantic/errors'),
    fetchJSON('/api/insights/semantic/pivots'),
  ]) : [null, null, null, null];
  const [sentiment, topics, errClusters, pivots] = semanticData;

  panel.innerHTML = `
    ${renderPain(pain)}
    ${renderTriage(triage)}
    ${renderTokens(tokens)}
    ${renderChurn(churn)}
    ${renderErrors(errors)}
    ${renderThrash(thrash)}
    ${renderSemanticSection(semantic)}
    ${renderTopics(topics)}
    ${renderErrorClusters(errClusters)}
    ${renderSentiment(sentiment)}
    ${renderPivots(pivots)}
  `;
  wireInsightsButtons();
  panel.querySelectorAll('.insights-table').forEach(makeSortable);
  applyInsightsSearch();
}

function bar(frac, colorVar) {
  const pct = Math.round((frac || 0) * 100);
  const color = colorVar ? `;background:var(${colorVar})` : '';
  return `<span class="pain-bar"><span class="pain-bar-fill" style="width:${pct}%${color}"></span></span>`;
}

function renderPain(pain) {
  if (!pain || !pain.length) return section('Pain leaderboard', '<p class="empty">No data yet.</p>');
  const rows = pain.slice(0, 20).map(p => {
    // Render bars from the pre-weight normalized signals (each fills 0..100% on
    // its own scale) so the four signals are visually comparable; the weighted
    // contributions live in p.breakdown and sum to p.score. Each signal is
    // colour-coded with a system accent.
    const n = p.normalized || p.breakdown;
    return `
    <tr class="is-drillable" data-drill="session" data-session="${esc(p.session_id)}">
      <td class="mono">${esc((p.session_id || '').slice(0, 8))}</td>
      <td><span class="pain-score">${p.score.toFixed(3)}</span></td>
      <td data-sort="${n.errorRate}"><span class="pain-cell">${bar(n.errorRate, '--accent-red')}</span></td>
      <td data-sort="${n.churn}"><span class="pain-cell">${bar(n.churn, '--accent-amber')}</span></td>
      <td data-sort="${n.thrash}"><span class="pain-cell">${bar(n.thrash, '--accent-purple')}</span></td>
      <td data-sort="${n.effort}"><span class="pain-cell">${bar(n.effort, '--accent-blue')}</span></td>
      <td><button class="insights-btn triage-btn" data-session="${esc(p.session_id)}">Flag for triage</button></td>
    </tr>`;
  }).join('');
  return section('Pain leaderboard',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Score</th><th>Err</th><th>Churn</th><th>Thrash</th><th>Effort</th><th></th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderTriage(rows) {
  if (!rows || !rows.length) {
    return section('Triage', '<p class="empty">Flag a session above, then run <code>/stalker-triage</code> in Claude Code to analyze flagged sessions.</p>');
  }
  const pending = rows.filter(t => t.status !== 'analyzed').length;
  const hint = pending
    ? `<div class="triage-hint">${pending} flagged — run <code>/stalker-triage</code> in Claude Code to analyze</div>`
    : '';
  const body = rows.slice(0, 20).map(t => {
    const analyzed = t.status === 'analyzed';
    const badge = analyzed ? `<span class="triage-badge done">analyzed</span>` : `<span class="triage-badge pending">flagged</span>`;
    return `<tr class="is-drillable" data-drill="session" data-session="${esc(t.session_id)}">
      <td class="mono">${esc((t.session_id || '').slice(0, 8))}</td>
      <td>${badge}</td>
      <td>${analyzed && t.pain_score != null ? esc(String(t.pain_score)) + '/5' : '—'}</td>
      <td>${analyzed ? esc(t.summary || '') : ''}</td>
      <td>${analyzed ? esc(t.root_cause || '') : ''}</td>
    </tr>`;
  }).join('');
  return section('Triage',
    `${hint}<table class="insights-table"><thead><tr><th>Session</th><th>Status</th><th>Pain</th><th>Summary</th><th>Root cause</th></tr></thead><tbody>${body}</tbody></table>`);
}

function renderTokens(tokens) {
  if (!tokens || !tokens.length) return section('Token usage', '<p class="empty">Run usage ingest (SessionEnd or `bun run ingest-usage`) to populate.</p>');
  const rows = tokens.slice(0, 20).map(t =>
    `<tr class="is-drillable" data-drill="session" data-session="${esc(t.session_id)}"><td class="mono">${esc((t.session_id || '').slice(0,8))}</td><td>${t.input_tokens}</td><td>${t.output_tokens}</td><td>${t.cache_read_input_tokens}</td></tr>`).join('');
  return section('Token usage',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Input</th><th>Output</th><th>Cache read</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderChurn(churn) {
  if (!churn || !churn.length) return section('File churn', '<p class="empty">No data yet.</p>');
  const rows = churn.slice(0, 20).map(c => `
    <tr class="is-drillable" data-drill="events" data-by="file" data-value="${esc(c.file_path)}" data-drill-title="${esc(c.file_path)}"><td class="mono">${esc(c.file_path)}</td><td>${c.edits}</td><td>${c.sessions}</td><td>${Math.round(c.medianGapMs/1000)}s</td></tr>`).join('');
  return section('File churn',
    `<table class="insights-table"><thead><tr><th>File</th><th>Edits</th><th>Sessions</th><th>Median gap</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderErrors(errors) {
  if (!errors) return section('Errors', '<p class="empty">No data yet.</p>');
  const tool = (errors.byTool || []).slice(0, 10).map(t => `<tr class="is-drillable" data-drill="events" data-by="tool" data-value="${esc(t.tool_name)}" data-errors-only="1" data-drill-title="${esc(t.tool_name)} errors"><td>${esc(t.tool_name)}</td><td>${t.errors}</td></tr>`).join('');
  const sess = (errors.bySession || []).slice(0, 10).map(s => `<tr class="is-drillable" data-drill="session" data-session="${esc(s.session_id)}"><td class="mono">${esc((s.session_id || '').slice(0,8))}</td><td>${s.errors}</td><td>${(s.errorRate*100).toFixed(1)}%</td></tr>`).join('');
  return section('Errors',
    `<div class="insights-cols">
       <div><h4>By tool</h4><table class="insights-table"><thead><tr><th>Tool</th><th>Errors</th></tr></thead><tbody>${tool}</tbody></table></div>
       <div><h4>By session</h4><table class="insights-table"><thead><tr><th>Session</th><th>Errors</th><th>Rate</th></tr></thead><tbody>${sess}</tbody></table></div>
     </div>`);
}

function renderThrash(thrash) {
  if (!thrash) return section('Thrash / pivot-loops', '<p class="empty">No data yet.</p>');
  const chains = (thrash.retryChains || []).slice(0, 15).map(c =>
    `<tr class="is-drillable" data-drill="events" data-by="retry" data-value="${esc(c.target)}" data-tool="${esc(c.tool_name)}" data-retry-session="${esc(c.session_id)}" data-drill-title="retry: ${esc(c.tool_name)}"><td class="mono">${esc((c.session_id||'').slice(0,8))}</td><td>${esc(c.tool_name)}</td><td class="mono">${esc(String(c.target).slice(0,40))}</td><td>${c.chainLength}</td></tr>`).join('');
  const bounces = (thrash.taskBounces || []).slice(0, 15).map(b =>
    `<tr class="is-drillable" data-drill="task" data-task="${esc(b.task_id)}" data-session="${esc(b.session_id)}"><td class="mono">${esc(b.task_id)}</td><td class="mono">${esc((b.session_id||'').slice(0,8))}</td><td>${b.bounces}</td></tr>`).join('');
  const bouncesTable = bounces
    ? `<div><h4>Task bounces</h4><table class="insights-table"><thead><tr><th>Task</th><th>Session</th><th>Bounces</th></tr></thead><tbody>${bounces}</tbody></table></div>`
    : '';
  const chainsTable = `<div><h4>Retry chains</h4><table class="insights-table"><thead><tr><th>Session</th><th>Tool</th><th>Target</th><th>Retry depth</th></tr></thead><tbody>${chains}</tbody></table></div>`;
  return section('Thrash / pivot-loops', `<div class="insights-cols">${chainsTable}${bouncesTable}</div>`);
}

// Generic DOM sort: click a <th> to sort the table's rows by that column.
// Numeric-aware; a cell's data-sort attribute (if present) overrides its rendered
// text for sorting (used by the Pain breakdown bars, which show no number). Skips
// empty / colspan headers; no current table puts a sortable column after a colspan.
function makeSortable(table) {
  if (!table.tHead || !table.tBodies[0]) return;
  const ths = [...table.tHead.rows[0].cells];
  ths.forEach((th, colIndex) => {
    if (!th.textContent.trim() || th.colSpan > 1) return;
    th.classList.add('sortable');
    th.addEventListener('click', () => {
      const tbody = table.tBodies[0];
      const asc = th.dataset.sortDir !== 'asc';
      ths.forEach(h => { h.removeAttribute('data-sort-dir'); h.classList.remove('sort-asc', 'sort-desc'); });
      th.dataset.sortDir = asc ? 'asc' : 'desc';
      th.classList.add(asc ? 'sort-asc' : 'sort-desc');
      const num = (s) => { const f = parseFloat(String(s).replace(/[, ]/g, '')); return isNaN(f) ? null : f; };
      const cellVal = (r) => {
        const c = r.cells[colIndex];
        if (!c) return '';
        return c.dataset.sort !== undefined ? c.dataset.sort : (c.textContent || '').trim();
      };
      [...tbody.rows].sort((ra, rb) => {
        const a = cellVal(ra), b = cellVal(rb);
        const na = num(a), nb = num(b);
        const cmp = (na !== null && nb !== null) ? na - nb : String(a).localeCompare(String(b));
        return asc ? cmp : -cmp;
      }).forEach(r => tbody.appendChild(r));
    });
  });
}

// How each section's data points are derived — shown as a hover tooltip on the
// section header's info marker. Keyed by title so call sites need no change.
const SECTION_TIPS = {
  'Pain leaderboard': 'Composite score per session: error rate, file churn, thrash, and effort are each normalized 0–1 across sessions, weighted, and summed. Higher = more troubled.',
  'Triage': 'Sessions you flagged with "Flag for triage". The /stalker-triage skill (run in Claude Code) scores each one’s pain and writes back a summary + root cause.',
  'Token usage': 'Real input / output / cache token counts parsed from the Claude Code transcript JSONL files, summed per session.',
  'File churn': 'Files ranked by how many times they were edited (Edit/Write/MultiEdit), with the number of sessions that touched each and the median time between successive edits.',
  'Errors': 'Tool calls that failed — a PostToolUseFailure event, or a PostToolUse carrying an error — counted by tool and by session (with each session’s error rate).',
  'Thrash / pivot-loops': 'Retry chains: repeated calls to the same tool+target by one agent within 2 minutes around a failure. Task bounces: tasks that re-entered a status they had already been in.',
  'Semantic features': 'Opt-in Python NLP run over user prompts, assistant messages, task subjects, and error text. Results are cached in the database.',
  'Topics (ranked by pain)': 'BERTopic clusters of the prompt/message/task corpus. "Pain" is the mean session error-rate across a topic’s documents.',
  'Error clusters': 'Error messages embedded with sentence-transformers and grouped with HDBSCAN; ranked by cluster size and how many sessions they span.',
  'Frustration (most negative)': 'VADER sentiment scored over user prompts and assistant messages; the most-negative entries are shown.',
  'Agent pivots (semantic)': 'Assistant messages scored for retry / "that didn’t work, let me try another approach" language. Higher confidence = a stronger pivot signal.',
};

function section(title, inner) {
  const tip = SECTION_TIPS[title];
  const info = tip ? ` <span class="info-tip" data-tip="${esc(tip)}">ⓘ</span>` : '';
  return `<section class="insights-section"><h3>${esc(title)}${info}</h3>${inner}</section>`;
}

// --- semantic (Phase 3) ---
function renderSemanticSection(status) {
  if (!status || !status.available) {
    return section('Semantic features',
      `<p class="empty">Opt-in AI analysis (frustration, topics, error clusters).${status && status.pythonMissing ? ' Python or dependencies not detected.' : ''}</p>
       <div class="insights-btn-row"><button id="enableSemanticBtn" class="insights-btn">Enable semantic features</button></div>
       <pre id="semanticStatusOut" class="semantic-status"></pre>`);
  }
  return section('Semantic features',
    `<p class="empty">Last computed: ${status.lastRun ? new Date(status.lastRun).toLocaleString() : 'never'}.</p>
     <div class="insights-btn-row"><button id="enableSemanticBtn" class="insights-btn">Recompute</button></div>
     <pre id="semanticStatusOut" class="semantic-status"></pre>`);
}

function renderSentiment(rows) {
  if (!rows || !rows.length) return '';
  const neg = rows.filter(r => r.label === 'negative').slice(0, 15).map(r =>
    `<tr class="is-drillable" data-drill="event" data-event="${esc(r.event_id)}"><td class="mono">${esc((r.session_id||'').slice(0,8))}</td><td>${r.score.toFixed(2)}</td><td>${esc(r.source_kind)}</td></tr>`).join('');
  return section('Frustration (most negative)',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Score</th><th>Kind</th></tr></thead><tbody>${neg}</tbody></table>`);
}

function renderTopics(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 20).map(t =>
    `<tr class="is-drillable" data-drill="events" data-by="topic" data-value="${esc(t.topic_id)}" data-drill-title="topic: ${esc(t.label)}"><td>${esc(t.label)}</td><td>${esc(t.keywords || '')}</td><td>${t.size}</td><td>${(t.pain_score||0).toFixed(2)}</td></tr>`).join('');
  return section('Topics (ranked by pain)',
    `<table class="insights-table"><thead><tr><th>Topic</th><th>Keywords</th><th>Docs</th><th>Pain</th></tr></thead><tbody>${body}</tbody></table>`);
}

function renderErrorClusters(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 20).map(c =>
    `<tr class="is-drillable" data-drill="events" data-by="errorCluster" data-value="${esc(c.cluster_id)}" data-drill-title="cluster: ${esc(c.label)}"><td>${esc(c.label)}</td><td>${c.size}</td><td>${c.session_spread}</td><td class="mono">${esc((c.exemplar||'').slice(0,60))}</td></tr>`).join('');
  return section('Error clusters',
    `<table class="insights-table"><thead><tr><th>Label</th><th>Count</th><th>Sessions</th><th>Exemplar</th></tr></thead><tbody>${body}</tbody></table>`);
}

function renderPivots(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 15).map(p =>
    `<tr class="is-drillable" data-drill="session" data-session="${esc(p.session_id)}"><td class="mono">${esc((p.session_id||'').slice(0,8))}</td><td>${(p.confidence||0).toFixed(2)}</td><td>${esc(p.evidence||'')}</td></tr>`).join('');
  return section('Agent pivots (semantic)',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Confidence</th><th>Evidence</th></tr></thead><tbody>${body}</tbody></table>`);
}

function wireInsightsButtons() {
  const btn = document.getElementById('enableSemanticBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      const out = document.getElementById('semanticStatusOut');
      out.textContent = 'Starting semantic batch…';
      const res = await fetch(API + '/api/insights/semantic/run', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      out.textContent = body.message || (res.ok ? 'Started.' : 'Failed to start.');
    });
  }

  document.querySelectorAll('.triage-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const session = btn.dataset.session;
      btn.textContent = 'Flagging…';
      const res = await fetch(API + '/api/insights/semantic/triage?session=' + encodeURIComponent(session), { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        btn.textContent = 'Flagged ✓';
        btn.disabled = true;
      } else {
        btn.textContent = body.message || 'failed';
      }
    });
  });
}
