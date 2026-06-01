import { API } from './state.js';
import { esc } from './util.js';

async function fetchJSON(url) {
  try { const r = await fetch(API + url); return r.ok ? await r.json() : null; } catch { return null; }
}

export async function renderInsights() {
  const panel = document.getElementById('insightsPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="insights-loading">Loading insights…</div>';

  const [pain, tokens, errors, churn, thrash, semantic, triage] = await Promise.all([
    fetchJSON('/api/insights/pain'),
    fetchJSON('/api/insights/tokens'),
    fetchJSON('/api/insights/errors'),
    fetchJSON('/api/insights/churn'),
    fetchJSON('/api/insights/thrash'),
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
    <tr>
      <td class="mono">${esc((p.session_id || '').slice(0, 8))}</td>
      <td><span class="pain-score">${p.score.toFixed(3)}</span></td>
      <td><span class="pain-cell">${bar(n.errorRate, '--accent-red')} err</span></td>
      <td><span class="pain-cell">${bar(n.churn, '--accent-amber')} churn</span></td>
      <td><span class="pain-cell">${bar(n.thrash, '--accent-purple')} thrash</span></td>
      <td><span class="pain-cell">${bar(n.effort, '--accent-blue')} effort</span></td>
      <td><button class="insights-btn triage-btn" data-session="${esc(p.session_id)}">Flag for triage</button></td>
    </tr>`;
  }).join('');
  return section('Pain leaderboard',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Score</th><th colspan="4">Breakdown</th><th></th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderTriage(rows) {
  if (!rows || !rows.length) {
    return section('Triage', '<p class="empty">Flag a session above, then run <code>/agent-stalker-triage</code> in Claude Code to analyze flagged sessions.</p>');
  }
  const pending = rows.filter(t => t.status !== 'analyzed').length;
  const hint = pending
    ? `<div class="triage-hint">${pending} flagged — run <code>/agent-stalker-triage</code> in Claude Code to analyze</div>`
    : '';
  const body = rows.slice(0, 20).map(t => {
    const analyzed = t.status === 'analyzed';
    const badge = analyzed ? `<span class="triage-badge done">analyzed</span>` : `<span class="triage-badge pending">flagged</span>`;
    return `<tr>
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
    `<tr><td class="mono">${esc((t.session_id || '').slice(0,8))}</td><td>${t.input_tokens}</td><td>${t.output_tokens}</td><td>${t.cache_read_input_tokens}</td></tr>`).join('');
  return section('Token usage',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Input</th><th>Output</th><th>Cache read</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderChurn(churn) {
  if (!churn || !churn.length) return section('File churn', '<p class="empty">No data yet.</p>');
  const rows = churn.slice(0, 20).map(c => `
    <tr><td class="mono">${esc(c.file_path)}</td><td>${c.edits}</td><td>${c.sessions}</td><td>${Math.round(c.medianGapMs/1000)}s</td></tr>`).join('');
  return section('File churn',
    `<table class="insights-table"><thead><tr><th>File</th><th>Edits</th><th>Sessions</th><th>Median gap</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderErrors(errors) {
  if (!errors) return section('Errors', '<p class="empty">No data yet.</p>');
  const tool = (errors.byTool || []).slice(0, 10).map(t => `<tr><td>${esc(t.tool_name)}</td><td>${t.errors}</td></tr>`).join('');
  const sess = (errors.bySession || []).slice(0, 10).map(s => `<tr><td class="mono">${esc((s.session_id || '').slice(0,8))}</td><td>${s.errors}</td><td>${(s.errorRate*100).toFixed(1)}%</td></tr>`).join('');
  return section('Errors',
    `<div class="insights-cols">
       <div><h4>By tool</h4><table class="insights-table"><tbody>${tool}</tbody></table></div>
       <div><h4>By session</h4><table class="insights-table"><tbody>${sess}</tbody></table></div>
     </div>`);
}

function renderThrash(thrash) {
  if (!thrash) return section('Thrash / pivot-loops', '<p class="empty">No data yet.</p>');
  const chains = (thrash.retryChains || []).slice(0, 15).map(c =>
    `<tr><td class="mono">${esc(c.session_id.slice(0,8))}</td><td>${esc(c.tool_name)}</td><td class="mono">${esc(String(c.target).slice(0,40))}</td><td>${c.chainLength}</td></tr>`).join('');
  return section('Thrash / pivot-loops',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Tool</th><th>Target</th><th>Retry depth</th></tr></thead><tbody>${chains}</tbody></table>`);
}

function section(title, inner) {
  return `<section class="insights-section"><h3>${esc(title)}</h3>${inner}</section>`;
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
    `<tr><td class="mono">${esc((r.session_id||'').slice(0,8))}</td><td>${r.score.toFixed(2)}</td><td>${esc(r.source_kind)}</td></tr>`).join('');
  return section('Frustration (most negative)',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Score</th><th>Kind</th></tr></thead><tbody>${neg}</tbody></table>`);
}

function renderTopics(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 20).map(t =>
    `<tr><td>${esc(t.label)}</td><td>${esc(t.keywords || '')}</td><td>${t.size}</td><td>${(t.pain_score||0).toFixed(2)}</td></tr>`).join('');
  return section('Topics (ranked by pain)',
    `<table class="insights-table"><thead><tr><th>Topic</th><th>Keywords</th><th>Docs</th><th>Pain</th></tr></thead><tbody>${body}</tbody></table>`);
}

function renderErrorClusters(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 20).map(c =>
    `<tr><td>${esc(c.label)}</td><td>${c.size}</td><td>${c.session_spread}</td><td class="mono">${esc((c.exemplar||'').slice(0,60))}</td></tr>`).join('');
  return section('Error clusters',
    `<table class="insights-table"><thead><tr><th>Label</th><th>Count</th><th>Sessions</th><th>Exemplar</th></tr></thead><tbody>${body}</tbody></table>`);
}

function renderPivots(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.slice(0, 15).map(p =>
    `<tr><td class="mono">${esc((p.session_id||'').slice(0,8))}</td><td>${(p.confidence||0).toFixed(2)}</td><td>${esc(p.evidence||'')}</td></tr>`).join('');
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
    btn.addEventListener('click', async () => {
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
