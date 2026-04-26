import { state } from './state.js';

export function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

const NAMED_COLORS = { blue: '#60a5fa', green: '#34d399', yellow: '#fbbf24', red: '#f87171', purple: '#a78bfa', pink: '#f472b6', orange: '#fb923c', cyan: '#38bdf8' };
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export function namedColor(name) {
  if (NAMED_COLORS[name]) return NAMED_COLORS[name];
  if (typeof name === 'string' && HEX_COLOR_RE.test(name)) return name;
  return 'var(--text-dim)';
}

const AGENT_COLORS = ['#a78bfa','#60a5fa','#34d399','#fbbf24','#f87171','#f472b6','#38bdf8','#4ade80','#fb923c','#c084fc'];

export function agentColor(name) {
  if (!name || name === '__top_level__') return 'var(--accent-green)';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return AGENT_COLORS[Math.abs(h) % AGENT_COLORS.length];
}

export function taskStatusColor(status) {
  switch (status) {
    case 'completed': return 'var(--accent-green)';
    case 'in_progress': return 'var(--accent-blue)';
    case 'blocked': return 'var(--accent-red)';
    default: return 'var(--text-dim)';
  }
}

export function formatTime(ts) {
  if (!ts) return '---';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function syntaxHighlight(json) {
  if (typeof json !== 'string') json = JSON.stringify(json, null, 2);
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Single-pass tokenizer: every JSON token is matched once, so the class
  // attributes we emit can't be re-scanned by a later .replace() call.
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = 'json-number';
      if (/^"/.test(m)) cls = /:$/.test(m) ? 'json-key' : 'json-string';
      else if (/true|false/.test(m)) cls = 'json-bool';
      else if (/null/.test(m)) cls = 'json-null';
      return `<span class="${cls}">${m}</span>`;
    }
  );
}

export function sessionLabel(s) {
  if (!s.cwd) return s.id.slice(0, 12);
  const parts = s.cwd.split(/[\\/]/).filter(Boolean);
  return parts.pop() || s.id.slice(0, 12);
}

export function sessionLastEvent(s) {
  const ts = s.ended_at || s.started_at;
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export function getAgentLabel(agentId) {
  if (agentId === '__top_level__') return 'Claude (session)';
  for (const sid of state.selectedSessionIds) {
    const agents = state.sessionAgents[sid] || [];
    const a = agents.find(a => a.id === agentId);
    if (a) return a.agent_type || a.id.slice(0, 12);
  }
  return agentId;
}
