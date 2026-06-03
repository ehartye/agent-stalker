import { API, state } from './state.js';
import { esc, sessionRef } from './util.js';

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
  // Tiers 1–2 are the quantitative spine and load together. The semantic lens
  // (Tier 3) is opt-in and loads into its own container so it can refresh
  // independently while a batch runs.
  const [pain, tokens, errors, churn, thrash, triage] = await Promise.all([
    fetchJSON('/api/insights/pain' + qs),
    fetchJSON('/api/insights/tokens' + qs),
    fetchJSON('/api/insights/errors' + qs),
    fetchJSON('/api/insights/churn' + qs),
    fetchJSON('/api/insights/thrash' + qs),
    fetchJSON('/api/insights/semantic/triage'),
  ]);
  const triageBy = new Map((triage || []).map(t => [t.session_id, t]));

  panel.innerHTML = `
    ${tierRail('Pain', 'the verdict & the action')}
    ${renderPain(pain, triageBy)}
    ${tierRail('Signal breakdown', 'what drives the score above', SIGNAL_LEGEND)}
    ${renderErrors(errors)}
    ${renderChurn(churn)}
    ${renderThrash(thrash)}
    ${renderTokens(tokens)}
    <div id="semanticTier"></div>
  `;
  wireTriageButtons();
  panel.querySelectorAll('.insights-table').forEach(makeSortable);
  applyInsightsSearch();
  renderSemanticTier();
}

// --- tier rails: the narrative dividers that turn a flat stack into a story ---
function tierRail(label, sub, trailing) {
  return `<div class="insights-tier-rail">
    <span class="rail-label">${esc(label)}</span>
    ${sub ? `<span class="rail-sub">${esc(sub)}</span>` : ''}
    <span class="rail-rule"></span>
    ${trailing || ''}
  </div>`;
}

// Legend that names the four signal colours; echoed by the leaderboard column
// dots and the Tier-2 section header dots, so the colour IS the through-line.
const SIGNAL_LEGEND = `<span class="signal-legend">
  <span class="lg red">errors</span><span class="lg amber">churn</span><span class="lg purple">thrash</span><span class="lg blue">effort</span>
</span>`;

function bar(frac, colorVar) {
  const pct = Math.round((frac || 0) * 100);
  const color = colorVar ? `;background:var(${colorVar})` : '';
  return `<span class="pain-bar"><span class="pain-bar-fill" style="width:${pct}%${color}"></span></span>`;
}

// --- Tier 1: Pain leaderboard with triage merged into the trailing column ---
function renderPain(pain, triageBy) {
  if (!pain || !pain.length) return section('Pain leaderboard', '<p class="empty">No data yet.</p>');

  const shown = pain.slice(0, 20);
  const shownIds = new Set(shown.map(p => p.session_id));
  const rows = shown.map(p => {
    // Bars render the pre-weight normalized signals (each 0..100% on its own
    // scale) so the four are visually comparable; weighted contributions live in
    // p.breakdown and sum to p.score. Colours match the column + section dots.
    const n = p.normalized || p.breakdown;
    return `
    <tr class="is-drillable" data-drill="session" data-session="${esc(p.session_id)}">
      <td class="mono sess">${esc(sessionRef(p.session_id))}</td>
      <td><span class="pain-score">${p.score.toFixed(3)}</span></td>
      <td data-sort="${n.errorRate}"><span class="pain-cell">${bar(n.errorRate, '--accent-red')}</span></td>
      <td data-sort="${n.churn}"><span class="pain-cell">${bar(n.churn, '--accent-amber')}</span></td>
      <td data-sort="${n.thrash}"><span class="pain-cell">${bar(n.thrash, '--accent-purple')}</span></td>
      <td data-sort="${n.effort}"><span class="pain-cell">${bar(n.effort, '--accent-blue')}</span></td>
      <td class="triage-col">${triageCell(p.session_id, triageBy)}</td>
    </tr>`;
  }).join('');

  // Pending flags become a call-to-action banner on the leaderboard itself, so
  // the prompt to run /stalker-triage sits with the data it refers to.
  const pending = [...triageBy.values()].filter(t => t.status !== 'analyzed').length;
  const hint = pending
    ? `<div class="triage-hint">${pending} session${pending === 1 ? '' : 's'} flagged — run <code>/stalker-triage</code> in Claude Code to analyze</div>`
    : '';

  // Triaged sessions that fell outside the top-20 pain slice still need to be
  // visible (flagging is global), so list them compactly under the leaderboard.
  const overflow = [...triageBy.values()].filter(t => !shownIds.has(t.session_id));
  const overflowBlock = overflow.length ? `
    <div class="triage-overflow">
      <h4>Other triaged sessions</h4>
      <table class="insights-table"><thead><tr><th>Session</th><th>Status</th><th>Pain</th><th>Summary</th><th>Root cause</th></tr></thead>
      <tbody>${overflow.slice(0, 20).map(triageOverflowRow).join('')}</tbody></table>
    </div>` : '';

  return section('Pain leaderboard',
    `${hint}<table class="insights-table"><thead><tr>
       <th>Session</th><th>Score</th>
       <th><span class="sig-dot red"></span>Err</th>
       <th><span class="sig-dot amber"></span>Churn</th>
       <th><span class="sig-dot purple"></span>Thrash</th>
       <th><span class="sig-dot blue"></span>Effort</th>
       <th>Triage</th>
     </tr></thead><tbody>${rows}</tbody></table>${overflowBlock}`);
}

// Trailing leaderboard cell — the single place a session's triage lives. Only
// renders an actionable [Flag] button when flagging would change something;
// otherwise it shows the current state (awaiting analysis, or the verdict).
function triageCell(sessionId, triageBy) {
  const t = triageBy.get(sessionId);
  if (!t) return `<button class="insights-btn triage-btn" data-session="${esc(sessionId)}">Flag for triage</button>`;
  if (t.status === 'analyzed') {
    const score = t.pain_score != null ? esc(String(t.pain_score)) + '/5' : '—';
    // Keep the score in a compact coloured badge; render the root cause as
    // adjacent text that wraps and shows in full (summary stays on hover).
    const rc = t.root_cause ? `<span class="triage-rc" title="${esc(t.summary || '')}">${esc(t.root_cause)}</span>` : '';
    return `<div class="triage-inline"><span class="triage-pill analyzed" title="${esc(t.summary || '')}">⚑ ${score}</span>${rc}</div>`;
  }
  return `<span class="triage-pill pending" title="Run /stalker-triage in Claude Code to analyze this session">⚑ flagged · awaiting</span>`;
}

function triageOverflowRow(t) {
  const analyzed = t.status === 'analyzed';
  const badge = analyzed ? `<span class="triage-badge done">analyzed</span>` : `<span class="triage-badge pending">flagged</span>`;
  return `<tr class="is-drillable" data-drill="session" data-session="${esc(t.session_id)}">
    <td class="mono">${esc(sessionRef(t.session_id))}</td>
    <td>${badge}</td>
    <td>${analyzed && t.pain_score != null ? esc(String(t.pain_score)) + '/5' : '—'}</td>
    <td>${analyzed ? esc(t.summary || '') : ''}</td>
    <td>${analyzed ? esc(t.root_cause || '') : ''}</td>
  </tr>`;
}

// --- Tier 2: signal breakdown (errors, churn, thrash, effort) ---
function renderErrors(errors) {
  if (!errors) return section('Errors', '<p class="empty">No data yet.</p>', { signal: 'red' });
  const tool = (errors.byTool || []).slice(0, 10).map(t => `<tr class="is-drillable" data-drill="events" data-by="tool" data-value="${esc(t.tool_name)}" data-errors-only="1" data-drill-title="${esc(t.tool_name)} errors"><td>${esc(t.tool_name)}</td><td>${t.errors}</td></tr>`).join('');
  const sess = (errors.bySession || []).slice(0, 10).map(s => `<tr class="is-drillable" data-drill="session" data-session="${esc(s.session_id)}"><td class="mono">${esc(sessionRef(s.session_id))}</td><td>${s.errors}</td><td>${(s.errorRate*100).toFixed(1)}%</td></tr>`).join('');
  return section('Errors',
    `<div class="insights-cols">
       <div><h4>By tool</h4><table class="insights-table"><thead><tr><th>Tool</th><th>Errors</th></tr></thead><tbody>${tool}</tbody></table></div>
       <div><h4>By session</h4><table class="insights-table"><thead><tr><th>Session</th><th>Errors</th><th>Rate</th></tr></thead><tbody>${sess}</tbody></table></div>
     </div>`, { signal: 'red' });
}

function renderChurn(churn) {
  if (!churn || !churn.length) return section('File churn', '<p class="empty">No data yet.</p>', { signal: 'amber' });
  const rows = churn.slice(0, 20).map(c => `
    <tr class="is-drillable" data-drill="events" data-by="file" data-value="${esc(c.file_path)}" data-drill-title="${esc(c.file_path)}"><td class="mono">${esc(c.file_path)}</td><td>${c.edits}</td><td>${c.sessions}</td><td>${Math.round(c.medianGapMs/1000)}s</td></tr>`).join('');
  return section('File churn',
    `<table class="insights-table"><thead><tr><th>File</th><th>Edits</th><th>Sessions</th><th>Median gap</th></tr></thead><tbody>${rows}</tbody></table>`, { signal: 'amber' });
}

function renderThrash(thrash) {
  if (!thrash) return section('Thrash / pivot-loops', '<p class="empty">No data yet.</p>', { signal: 'purple' });
  const chains = (thrash.retryChains || []).slice(0, 15).map(c =>
    `<tr class="is-drillable" data-drill="events" data-by="retry" data-value="${esc(c.target)}" data-tool="${esc(c.tool_name)}" data-retry-session="${esc(c.session_id)}" data-drill-title="retry: ${esc(c.tool_name)}"><td class="mono">${esc(sessionRef(c.session_id))}</td><td>${esc(c.tool_name)}</td><td class="mono">${esc(String(c.target).slice(0,40))}</td><td>${c.chainLength}</td></tr>`).join('');
  const bounces = (thrash.taskBounces || []).slice(0, 15).map(b =>
    `<tr class="is-drillable" data-drill="task" data-task="${esc(b.task_id)}" data-session="${esc(b.session_id)}"><td class="mono">${esc(b.task_id)}</td><td class="mono">${esc(sessionRef(b.session_id))}</td><td>${b.bounces}</td></tr>`).join('');
  const bouncesTable = bounces
    ? `<div><h4>Task bounces</h4><table class="insights-table"><thead><tr><th>Task</th><th>Session</th><th>Bounces</th></tr></thead><tbody>${bounces}</tbody></table></div>`
    : '';
  const chainsTable = `<div><h4>Retry chains</h4><table class="insights-table"><thead><tr><th>Session</th><th>Tool</th><th>Target</th><th>Retry depth</th></tr></thead><tbody>${chains}</tbody></table></div>`;
  return section('Thrash / pivot-loops', `<div class="insights-cols">${chainsTable}${bouncesTable}</div>`, { signal: 'purple' });
}

function renderTokens(tokens) {
  if (!tokens || !tokens.length) return section('Effort (token usage)', '<p class="empty">Run usage ingest (SessionEnd or `bun run ingest-usage`) to populate.</p>', { signal: 'blue' });
  const rows = tokens.slice(0, 20).map(t =>
    `<tr class="is-drillable" data-drill="session" data-session="${esc(t.session_id)}"><td class="mono">${esc(sessionRef(t.session_id))}</td><td>${t.input_tokens}</td><td>${t.output_tokens}</td><td>${t.cache_read_input_tokens}</td></tr>`).join('');
  return section('Effort (token usage)',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Input</th><th>Output</th><th>Cache read</th></tr></thead><tbody>${rows}</tbody></table>`, { signal: 'blue' });
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
  'Pain leaderboard': 'Composite score per session: error rate, file churn, thrash, and effort are each normalized 0–1 across sessions, weighted, and summed. Higher = more troubled. The Triage column shows sessions you flagged and the verdict /stalker-triage wrote back.',
  'Errors': 'Tool calls that failed — a PostToolUseFailure event, or a PostToolUse carrying an error — counted by tool and by session (with each session’s error rate). Feeds the red “Err” signal in the leaderboard.',
  'File churn': 'Files ranked by how many times they were edited (Edit/Write/MultiEdit), with the number of sessions that touched each and the median time between successive edits. Feeds the amber “Churn” signal.',
  'Thrash / pivot-loops': 'Retry chains: repeated calls to the same tool+target by one agent within 2 minutes around a failure. Task bounces: tasks that re-entered a status they had already been in. Feeds the purple “Thrash” signal.',
  'Effort (token usage)': 'Real input / output / cache token counts parsed from the Claude Code transcript JSONL files, summed per session. Feeds the blue “Effort” signal.',
  'Topics (ranked by pain)': 'BERTopic clusters of the prompt/message/task corpus. "Pain" is the mean session error-rate across a topic’s documents.',
  'Error clusters': 'Error messages embedded with sentence-transformers and grouped with HDBSCAN; ranked by cluster size and how many sessions they span.',
  'Frustration (most negative)': 'VADER sentiment scored over user prompts and assistant messages; the most-negative entries are shown.',
  'Agent pivots (semantic)': 'Assistant messages scored for retry / "that didn’t work, let me try another approach" language. Higher confidence = a stronger pivot signal.',
};

function section(title, inner, opts = {}) {
  const tip = SECTION_TIPS[title];
  const info = tip ? ` <span class="info-tip" data-tip="${esc(tip)}">ⓘ</span>` : '';
  const cls = ['insights-section'];
  if (opts.signal) cls.push('sig-' + opts.signal);
  if (opts.ghost) cls.push('ghost');
  return `<section class="${cls.join(' ')}"><h3>${esc(title)}${info}</h3>${inner}</section>`;
}

// --- Tier 3: the semantic lens (opt-in NLP) — control bar + its own children ---
const SEMANTIC_TITLES = ['Topics (ranked by pain)', 'Error clusters', 'Frustration (most negative)', 'Agent pivots (semantic)'];

// Polling state for a running batch. Module-level so it survives the Tier-3
// subtree being re-rendered while the batch is in flight.
const semanticState = { polling: false, timer: null, baseline: 0, attempts: 0 };

async function renderSemanticTier() {
  const host = document.getElementById('semanticTier');
  if (!host) return;
  const status = await fetchJSON('/api/insights/semantic/status');
  const available = !!(status && status.available);

  let children;
  if (available) {
    const [sentiment, topics, errClusters, pivots] = await Promise.all([
      fetchJSON('/api/insights/semantic/sentiment'),
      fetchJSON('/api/insights/semantic/topics'),
      fetchJSON('/api/insights/semantic/errors'),
      fetchJSON('/api/insights/semantic/pivots'),
    ]);
    children = renderTopics(topics) + renderErrorClusters(errClusters) + renderSentiment(sentiment) + renderPivots(pivots);
  } else {
    // Ghosted placeholders so it's obvious what enabling the lens produces.
    children = SEMANTIC_TITLES.map(t => section(t, '<p class="empty">Enable the semantic lens to populate.</p>', { signal: 'teal', ghost: true })).join('');
  }

  host.innerHTML = `
    ${semanticLensBar(status, available)}
    <div class="semantic-children${available ? '' : ' ghosted'}">${children}</div>`;
  host.querySelectorAll('.insights-table').forEach(makeSortable);
  wireSemanticButton(status);
  applyInsightsSearch();
}

function semanticLensBar(status, available) {
  const running = semanticState.polling;
  const last = status && status.lastRun ? new Date(status.lastRun).toLocaleString() : null;
  let stateLine;
  if (running) stateLine = 'Running… results land in the sections below';
  else if (available) stateLine = last ? `Done · last computed ${esc(last)}` : 'Ready';
  else stateLine = 'Off — enable to surface topics, frustration, error clusters & pivots';
  const spinner = running ? '<span class="lens-spinner">◴</span>' : '';
  const ticks = available && status.features ? featureTicks(status.features) : '';
  const btnLabel = available ? 'Recompute' : 'Enable';
  return `<div class="semantic-lens-bar${running ? ' running' : ''}">
    <div class="lens-head">
      <span class="lens-dot"></span>
      <span class="lens-title">Semantic lens</span>
      <span class="lens-kicker">opt-in NLP</span>
    </div>
    <div class="lens-state">${spinner}<span class="lens-state-msg">${stateLine}</span>${ticks}</div>
    <button id="enableSemanticBtn" class="insights-btn"${running ? ' disabled' : ''}>${btnLabel}</button>
  </div>`;
}

const FEAT_LABEL = { sentiment: 'frustration', topics: 'topics', errors: 'clusters', pivots: 'pivots' };
function featureTicks(features) {
  const sym = s => s === 'ok' ? '✓' : (s && String(s).startsWith('skipped')) ? '⊘' : '✕';
  const items = features
    .filter(f => f.feature !== 'triage') // triage is handled in Claude Code, not the sidecar
    .map(f => `<span class="tick ${f.status === 'ok' ? 'ok' : 'bad'}" data-tip="${esc(f.feature + ': ' + f.status)}">${esc(FEAT_LABEL[f.feature] || f.feature)} ${sym(f.status)}</span>`)
    .join('');
  return items ? `<span class="lens-ticks">${items}</span>` : '';
}

function renderSentiment(rows) {
  if (!rows || !rows.length) return section('Frustration (most negative)', '<p class="empty">No results.</p>', { signal: 'teal' });
  const neg = rows.filter(r => r.label === 'negative').slice(0, 15).map(r =>
    `<tr class="is-drillable" data-drill="event" data-event="${esc(r.event_id)}"><td class="mono">${esc(sessionRef(r.session_id))}</td><td>${r.score.toFixed(2)}</td><td>${esc(r.source_kind)}</td></tr>`).join('');
  if (!neg) return section('Frustration (most negative)', '<p class="empty">No negative entries.</p>', { signal: 'teal' });
  return section('Frustration (most negative)',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Score</th><th>Kind</th></tr></thead><tbody>${neg}</tbody></table>`, { signal: 'teal' });
}

function renderTopics(rows) {
  if (!rows || !rows.length) return section('Topics (ranked by pain)', '<p class="empty">No results.</p>', { signal: 'teal' });
  const body = rows.slice(0, 20).map(t =>
    `<tr class="is-drillable" data-drill="events" data-by="topic" data-value="${esc(t.topic_id)}" data-drill-title="topic: ${esc(t.label)}"><td>${esc(t.label)}</td><td>${esc(t.keywords || '')}</td><td>${t.size}</td><td>${(t.pain_score||0).toFixed(2)}</td></tr>`).join('');
  return section('Topics (ranked by pain)',
    `<table class="insights-table"><thead><tr><th>Topic</th><th>Keywords</th><th>Docs</th><th>Pain</th></tr></thead><tbody>${body}</tbody></table>`, { signal: 'teal' });
}

function renderErrorClusters(rows) {
  if (!rows || !rows.length) return section('Error clusters', '<p class="empty">No results.</p>', { signal: 'teal' });
  const body = rows.slice(0, 20).map(c =>
    `<tr class="is-drillable" data-drill="events" data-by="errorCluster" data-value="${esc(c.cluster_id)}" data-drill-title="cluster: ${esc(c.label)}"><td>${esc(c.label)}</td><td>${c.size}</td><td>${c.session_spread}</td><td class="mono">${esc((c.exemplar||'').slice(0,60))}</td></tr>`).join('');
  return section('Error clusters',
    `<table class="insights-table"><thead><tr><th>Label</th><th>Count</th><th>Sessions</th><th>Exemplar</th></tr></thead><tbody>${body}</tbody></table>`, { signal: 'teal' });
}

function renderPivots(rows) {
  if (!rows || !rows.length) return section('Agent pivots (semantic)', '<p class="empty">No results.</p>', { signal: 'teal' });
  const body = rows.slice(0, 15).map(p =>
    `<tr class="is-drillable" data-drill="session" data-session="${esc(p.session_id)}"><td class="mono">${esc(sessionRef(p.session_id))}</td><td>${(p.confidence||0).toFixed(2)}</td><td>${esc(p.evidence||'')}</td></tr>`).join('');
  return section('Agent pivots (semantic)',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Confidence</th><th>Evidence</th></tr></thead><tbody>${body}</tbody></table>`, { signal: 'teal' });
}

function wireSemanticButton(status) {
  const btn = document.getElementById('enableSemanticBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    semanticState.baseline = status && status.lastRun ? status.lastRun : 0;
    const msg = document.querySelector('.semantic-lens-bar .lens-state-msg');
    if (msg) msg.textContent = 'Starting…';
    const res = await fetch(API + '/api/insights/semantic/run', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) {
      // Dependency missing or failed to start — surface it in place, don't poll.
      if (msg) msg.textContent = body.message || 'Failed to start.';
      return;
    }
    startSemanticPolling();
  });
}

// The batch is a detached process; poll status until lastRun advances past the
// pre-run baseline (real completion), then refresh the lens. Cap attempts so a
// stuck batch can't poll forever.
function startSemanticPolling() {
  semanticState.polling = true;
  semanticState.attempts = 0;
  clearInterval(semanticState.timer);
  renderSemanticTier(); // reflect "Running…" immediately
  semanticState.timer = setInterval(async () => {
    semanticState.attempts++;
    const s = await fetchJSON('/api/insights/semantic/status');
    const done = s && s.lastRun && s.lastRun > semanticState.baseline;
    if (done || semanticState.attempts >= 30) {
      clearInterval(semanticState.timer);
      semanticState.polling = false;
      renderSemanticTier();
    }
  }, 4000);
}

function wireTriageButtons() {
  document.querySelectorAll('.triage-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const session = btn.dataset.session;
      btn.textContent = 'Flagging…';
      const res = await fetch(API + '/api/insights/semantic/triage?session=' + encodeURIComponent(session), { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        // Replace the [Flag] button in place with the pending-state pill, so the
        // row reflects the merged triage model without a full re-render.
        const cell = btn.closest('td');
        if (cell) cell.innerHTML = `<span class="triage-pill pending" title="Run /stalker-triage in Claude Code to analyze this session">⚑ flagged · awaiting</span>`;
      } else {
        btn.textContent = body.message || 'failed';
      }
    });
  });
}
