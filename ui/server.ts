import { getDb, closeDb } from "../lib/db";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { painLeaderboard } from "../lib/analytics/pain";
import { sessionErrorStats, errorsByTool } from "../lib/analytics/errors";
import { fileChurn } from "../lib/analytics/churn";
import { errorRetryChains, taskBounces } from "../lib/analytics/thrash";

const port = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") ?? "3141");

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function handleApi(url: URL, method: string): Response {
  const db = getDb();
  const path = url.pathname;
  const params = url.searchParams;

  if (path === "/api/sessions") {
    const team = params.get("team");
    const archived = params.get("archived");
    const limit = parseInt(params.get("limit") ?? "50");
    const offset = parseInt(params.get("offset") ?? "0");
    let query = "SELECT * FROM sessions WHERE 1=1";
    const qParams: any[] = [];
    if (archived === "true") {
      query += " AND archived_at IS NOT NULL";
    } else {
      query += " AND archived_at IS NULL";
    }
    if (team) { query += " AND team_name = ?"; qParams.push(team); }
    query += " ORDER BY COALESCE((SELECT MAX(timestamp) FROM events WHERE events.session_id = sessions.id), started_at) DESC LIMIT ? OFFSET ?";
    qParams.push(limit, offset);
    return jsonResponse(db.query(query).all(...qParams));
  }

  // POST /api/sessions/:id/archive
  if (path.match(/^\/api\/sessions\/[^/]+\/archive$/) && method === "POST") {
    const id = path.split("/")[3];
    const session = db.query("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!session) return jsonResponse({ error: "Not found" }, 404);
    db.run("UPDATE sessions SET archived_at = ? WHERE id = ?", [Date.now(), id]);
    return jsonResponse({ ok: true });
  }

  // POST /api/sessions/:id/unarchive
  if (path.match(/^\/api\/sessions\/[^/]+\/unarchive$/) && method === "POST") {
    const id = path.split("/")[3];
    db.run("UPDATE sessions SET archived_at = NULL WHERE id = ?", [id]);
    return jsonResponse({ ok: true });
  }

  // DELETE /api/sessions/:id
  if (path.match(/^\/api\/sessions\/[^/]+$/) && method === "DELETE") {
    const id = path.split("/")[3];
    const session = db.query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    if (!session) return jsonResponse({ error: "Not found" }, 404);
    if (!session.archived_at) return jsonResponse({ error: "Must archive before deleting" }, 400);
    db.run("DELETE FROM task_events WHERE session_id = ?", [id]);
    db.run("DELETE FROM tasks WHERE session_id = ?", [id]);
    db.run("DELETE FROM agents WHERE session_id = ?", [id]);
    db.run("DELETE FROM events WHERE session_id = ?", [id]);
    db.run("DELETE FROM sessions WHERE id = ?", [id]);
    return jsonResponse({ ok: true });
  }

  if (path.startsWith("/api/sessions/")) {
    const id = path.split("/api/sessions/")[1];
    const session = db.query("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!session) return jsonResponse({ error: "Not found" }, 404);
    const eventCount = db.query("SELECT COUNT(*) as count FROM events WHERE session_id = ?").get(id);
    const toolCounts = db.query("SELECT tool_name, COUNT(*) as count FROM events WHERE session_id = ? AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC").all(id);
    return jsonResponse({ session, eventCount, toolCounts });
  }

  if (path === "/api/events") {
    const sessionId = params.get("session");
    const toolName = params.get("tool");
    const agentId = params.get("agent_id");
    const since = params.get("since");
    const limit = parseInt(params.get("limit") ?? "200");
    const offset = parseInt(params.get("offset") ?? "0");

    let query = "SELECT * FROM events WHERE 1=1";
    const qParams: any[] = [];
    if (sessionId) { query += " AND session_id = ?"; qParams.push(sessionId); }
    if (toolName) { query += " AND tool_name = ?"; qParams.push(toolName); }
    if (agentId) { query += " AND agent_id = ?"; qParams.push(agentId); }
    if (since) { query += " AND timestamp > ?"; qParams.push(parseInt(since)); }
    const order = since ? "ASC" : "DESC";
    query += ` ORDER BY timestamp ${order} LIMIT ? OFFSET ?`;
    qParams.push(limit, offset);
    return jsonResponse(db.query(query).all(...qParams));
  }

  if (path.startsWith("/api/events/")) {
    const id = parseInt(path.split("/api/events/")[1]);
    const event = db.query("SELECT * FROM events WHERE id = ?").get(id);
    if (!event) return jsonResponse({ error: "Not found" }, 404);
    return jsonResponse(event);
  }

  if (path === "/api/agents") {
    const sessionId = params.get("session");
    let query = "SELECT * FROM agents";
    const qParams: any[] = [];
    if (sessionId) { query += " WHERE session_id = ?"; qParams.push(sessionId); }
    query += " ORDER BY started_at DESC LIMIT 50";
    return jsonResponse(db.query(query).all(...qParams));
  }

  if (path === "/api/tasks") {
    const team = params.get("team");
    const status = params.get("status");
    const owner = params.get("owner");
    const session = params.get("session");
    let query = "SELECT * FROM tasks WHERE 1=1";
    const qParams: any[] = [];
    if (team) { query += " AND team_name = ?"; qParams.push(team); }
    if (status) { query += " AND status = ?"; qParams.push(status); }
    if (owner) { query += " AND owner = ?"; qParams.push(owner); }
    if (session) { query += " AND session_id = ?"; qParams.push(session); }
    query += " ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50";
    return jsonResponse(db.query(query).all(...qParams));
  }

  if (path.startsWith("/api/tasks/")) {
    const rest = path.slice("/api/tasks/".length);
    const parts = rest.split("/");
    const taskId = parts[0];
    const session = params.get("session");

    if (parts[1] === "events") {
      if (session) {
        const events = db.query("SELECT * FROM task_events WHERE task_id = ? AND session_id = ? ORDER BY timestamp ASC").all(taskId, session);
        return jsonResponse(events);
      }
      const events = db.query("SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp ASC").all(taskId);
      return jsonResponse(events);
    }

    if (session) {
      const task = db.query("SELECT * FROM tasks WHERE id = ? AND session_id = ?").get(taskId, session);
      if (!task) return jsonResponse({ error: "Not found" }, 404);
      return jsonResponse(task);
    }
    const task = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) return jsonResponse({ error: "Not found" }, 404);
    return jsonResponse(task);
  }

  if (path === "/api/stats") {
    const sessionParam = params.get("session");
    const sessionIds = sessionParam ? sessionParam.split(",").filter(Boolean) : [];
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => "?").join(",");
      const events = db.query(`SELECT COUNT(*) as count FROM events WHERE session_id IN (${placeholders})`).get(...sessionIds) as { count: number };
      const tools = db.query(`SELECT COUNT(DISTINCT tool_name) as count FROM events WHERE tool_name IS NOT NULL AND session_id IN (${placeholders})`).get(...sessionIds) as { count: number };
      const agents = db.query(`SELECT COUNT(*) as count FROM agents WHERE session_id IN (${placeholders})`).get(...sessionIds) as { count: number };
      const tasks = db.query(`SELECT COUNT(*) as count FROM tasks WHERE session_id IN (${placeholders})`).get(...sessionIds) as { count: number };
      return jsonResponse({ sessions: sessionIds.length, events: events.count, tools: tools.count, agents: agents.count, tasks: tasks.count, scoped: true });
    }
    const sessions = db.query("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
    const events = db.query("SELECT COUNT(*) as count FROM events").get() as { count: number };
    const tools = db.query("SELECT COUNT(DISTINCT tool_name) as count FROM events WHERE tool_name IS NOT NULL").get() as { count: number };
    const agents = db.query("SELECT COUNT(*) as count FROM agents").get() as { count: number };
    const tasks = db.query("SELECT COUNT(*) as count FROM tasks").get() as { count: number };
    return jsonResponse({ sessions: sessions.count, events: events.count, tools: tools.count, agents: agents.count, tasks: tasks.count, scoped: false });
  }

  if (path === "/api/tools") {
    const rows = db.query("SELECT tool_name, COUNT(*) as count, COUNT(DISTINCT session_id) as sessions FROM events WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC").all();
    return jsonResponse(rows);
  }

  if (path === "/api/insights/pain") {
    return jsonResponse(painLeaderboard(db));
  }
  if (path === "/api/insights/errors") {
    return jsonResponse({ bySession: sessionErrorStats(db), byTool: errorsByTool(db) });
  }
  if (path === "/api/insights/churn") {
    return jsonResponse(fileChurn(db));
  }
  if (path === "/api/insights/thrash") {
    return jsonResponse({ retryChains: errorRetryChains(db), taskBounces: taskBounces(db) });
  }
  if (path === "/api/insights/tokens") {
    const rows = db.query(
      `SELECT session_id,
              SUM(COALESCE(input_tokens,0)) AS input_tokens,
              SUM(COALESCE(output_tokens,0)) AS output_tokens,
              SUM(COALESCE(cache_creation_input_tokens,0)) AS cache_creation_input_tokens,
              SUM(COALESCE(cache_read_input_tokens,0)) AS cache_read_input_tokens
       FROM usage GROUP BY session_id
       ORDER BY (SUM(COALESCE(input_tokens,0))+SUM(COALESCE(output_tokens,0))) DESC`,
    ).all();
    return jsonResponse(rows);
  }

  if (path === "/api/insights/semantic/status") {
    const meta = db.query("SELECT feature, last_run_at, model, status, corpus_size FROM semantic_meta ORDER BY last_run_at DESC").all() as any[];
    const lastRun = meta.length ? Math.max(...meta.map((m) => m.last_run_at ?? 0)) : null;
    return jsonResponse({ available: meta.length > 0, lastRun, features: meta });
  }
  if (path === "/api/insights/semantic/sentiment") {
    return jsonResponse(db.query("SELECT * FROM semantic_sentiment ORDER BY score ASC LIMIT 200").all());
  }
  if (path === "/api/insights/semantic/topics") {
    return jsonResponse(db.query("SELECT * FROM semantic_topics ORDER BY pain_score DESC").all());
  }
  if (path === "/api/insights/semantic/errors") {
    return jsonResponse(db.query("SELECT * FROM semantic_error_clusters ORDER BY size DESC").all());
  }
  if (path === "/api/insights/semantic/pivots") {
    return jsonResponse(db.query("SELECT * FROM semantic_pivot_signals ORDER BY confidence DESC LIMIT 200").all());
  }

  return jsonResponse({ error: "Not found" }, 404);
}

/** Test wrapper: invoke the API router without starting a server. */
export function handleApiForTest(url: URL, method: string): Response {
  return handleApi(url, method);
}

function pythonCmd(): string {
  return process.env.AGENT_STALKER_PYTHON ?? "python";
}

async function runSemanticBatch(): Promise<Response> {
  const analysisDir = resolve(join(import.meta.dir, "..", "analysis"));
  // 1. dependency check
  const check = await new Promise<{ ok: boolean; missing: string[] }>((res) => {
    const p = spawn(pythonCmd(), ["-m", "agent_stalker_analysis", "check"], { cwd: analysisDir });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => res({ ok: false, missing: ["python"] }));
    p.on("close", () => {
      try { res(JSON.parse(out)); } catch { res({ ok: false, missing: ["python"] }); }
    });
  });
  if (!check.ok) {
    return jsonResponse({
      ok: false,
      message: `Missing: ${check.missing.join(", ")}. Install with: pip install -r analysis/requirements.txt`,
    }, 200);
  }
  // 2. fire-and-forget the batch (results land in semantic_* tables)
  const env = { ...process.env };
  const p = spawn(pythonCmd(), ["-m", "agent_stalker_analysis", "run"], { cwd: analysisDir, env, detached: true, stdio: "ignore" });
  p.unref();
  return jsonResponse({ ok: true, message: "Semantic batch started. Refresh in a minute to see results." });
}

if (import.meta.main) {
  const server = Bun.serve({
    port,
    // The semantic /run route awaits a Python dependency check that imports
    // heavy ML modules (can take >10s cold). Raise the default 10s idleTimeout
    // so the POST response isn't cut off before runSemanticBatch resolves.
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/insights/semantic/run" && req.method === "POST") {
        return runSemanticBatch();
      }

      if (url.pathname.startsWith("/api/")) {
        return handleApi(url, req.method);
      }

      // Serve static files from ui/ directory
      const pluginRoot = import.meta.dir;
      let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const fullPath = resolve(join(pluginRoot, filePath));

      // Prevent path traversal outside the ui/ directory
      if (fullPath.startsWith(pluginRoot) && existsSync(fullPath)) {
        return new Response(Bun.file(fullPath));
      }

      // Fallback to index.html for SPA routing
      return new Response(Bun.file(join(pluginRoot, "index.html")));
    },
  });

  console.log(`agent-stalker UI running at http://localhost:${server.port}`);

  process.on("SIGINT", () => {
    closeDb();
    process.exit(0);
  });
}
