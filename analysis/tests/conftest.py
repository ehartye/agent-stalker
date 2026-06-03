import sqlite3
import pytest


SEMANTIC_DDL = [
    "CREATE TABLE semantic_meta (feature TEXT PRIMARY KEY, version TEXT, model TEXT, last_run_at INTEGER, corpus_size INTEGER, status TEXT)",
    "CREATE TABLE semantic_sentiment (id INTEGER PRIMARY KEY AUTOINCREMENT, source_kind TEXT, event_id INTEGER, session_id TEXT, score REAL, label TEXT, timestamp INTEGER)",
    "CREATE TABLE semantic_topics (topic_id INTEGER PRIMARY KEY, label TEXT, keywords TEXT, size INTEGER, pain_score REAL)",
    "CREATE TABLE semantic_topic_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT, session_id TEXT, topic_id INTEGER, prob REAL)",
    "CREATE TABLE semantic_error_clusters (cluster_id INTEGER PRIMARY KEY, label TEXT, exemplar TEXT, size INTEGER, session_spread INTEGER)",
    "CREATE TABLE semantic_error_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, session_id TEXT, cluster_id INTEGER)",
    "CREATE TABLE semantic_pivot_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, window_start INTEGER, window_end INTEGER, confidence REAL, evidence TEXT)",
    "CREATE TABLE semantic_session_triage (session_id TEXT PRIMARY KEY, pain_score REAL, summary TEXT, root_cause TEXT, model TEXT, cost_tokens INTEGER, created_at INTEGER)",
]


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "test.db"
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, hook_event_name TEXT, agent_id TEXT, tool_name TEXT, timestamp INTEGER, data TEXT)")
    conn.execute("CREATE TABLE tasks (id TEXT, session_id TEXT, subject TEXT, description TEXT)")
    for ddl in SEMANTIC_DDL:
        conn.execute(ddl)
    conn.commit()
    yield conn
    conn.close()
