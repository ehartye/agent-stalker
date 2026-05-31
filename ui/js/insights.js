import { API } from './state.js';
import { esc } from './util.js';

async function fetchJSON(url) {
  try { const r = await fetch(API + url); return r.ok ? await r.json() : null; } catch { return null; }
}

export async function renderInsights() {
  const panel = document.getElementById('insightsPanel');
  if (!panel) return;
  panel.innerHTML = '<div class="insights-loading">Loading insights…</div>';

  const [pain, tokens, errors, churn, thrash, semantic] = await Promise.all([
    fetchJSON('/api/insights/pain'),
    fetchJSON('/api/insights/tokens'),
    fetchJSON('/api/insights/errors'),
    fetchJSON('/api/insights/churn'),
    fetchJSON('/api/insights/thrash'),
    fetchJSON('/api/insights/semantic/status'),
  ]);

  panel.innerHTML = `
    ${renderPain(pain)}
    ${renderTokens(tokens)}
    ${renderChurn(churn)}
    ${renderErrors(errors)}
    ${renderThrash(thrash)}
    ${renderSemanticSection(semantic)}
  `;
  wireSemanticButton();
}

function bar(frac) {
  const pct = Math.round((frac || 0) * 100);
  return `<span class="pain-bar"><span class="pain-bar-fill" style="width:${pct}%"></span></span>`;
}

function renderPain(pain) {
  if (!pain || !pain.length) return section('Pain leaderboard', '<p class="empty">No data yet.</p>');
  const rows = pain.slice(0, 20).map(p => `
    <tr>
      <td class="mono">${esc(p.session_id.slice(0, 8))}</td>
      <td>${p.score.toFixed(3)}</td>
      <td>${bar(p.breakdown.errorRate)} err</td>
      <td>${bar(p.breakdown.churn)} churn</td>
      <td>${bar(p.breakdown.thrash)} thrash</td>
      <td>${bar(p.breakdown.effort)} effort</td>
    </tr>`).join('');
  return section('Pain leaderboard',
    `<table class="insights-table"><thead><tr><th>Session</th><th>Score</th><th colspan="4">Breakdown</th></tr></thead><tbody>${rows}</tbody></table>`);
}

function renderTokens(tokens) {
  if (!tokens || !tokens.length) return section('Token usage', '<p class="empty">Run usage ingest (SessionEnd or `bun run ingest-usage`) to populate.</p>');
  const rows = tokens.slice(0, 20).map(t =>
    `<tr><td class="mono">${esc(t.session_id.slice(0,8))}</td><td>${t.input_tokens}</td><td>${t.output_tokens}</td><td>${t.cache_read_input_tokens}</td></tr>`).join('');
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
  const sess = (errors.bySession || []).slice(0, 10).map(s => `<tr><td class="mono">${esc(s.session_id.slice(0,8))}</td><td>${s.errors}</td><td>${(s.errorRate*100).toFixed(1)}%</td></tr>`).join('');
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
      `<p class="empty">Opt-in AI analysis (frustration, topics, error clusters). ${status && status.pythonMissing ? 'Python or dependencies not detected.' : ''}</p>
       <button id="enableSemanticBtn" class="insights-btn">Enable semantic features</button>
       <pre id="semanticStatusOut" class="semantic-status"></pre>`);
  }
  return section('Semantic features',
    `<p>Last computed: ${status.lastRun ? new Date(status.lastRun).toLocaleString() : 'never'}.</p>
     <button id="enableSemanticBtn" class="insights-btn">Recompute</button>
     <pre id="semanticStatusOut" class="semantic-status"></pre>`);
}

function wireSemanticButton() {
  const btn = document.getElementById('enableSemanticBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const out = document.getElementById('semanticStatusOut');
    out.textContent = 'Starting semantic batch…';
    const res = await fetch(API + '/api/insights/semantic/run', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    out.textContent = body.message || (res.ok ? 'Started.' : 'Failed to start.');
  });
}
