import json
import pytest
from agent_stalker_analysis.features.error_clusters import run_error_clusters


def _add_error(db, session_id, text):
    db.execute("INSERT INTO events (session_id, hook_event_name, tool_name, timestamp, data) VALUES (?, 'PostToolUseFailure', 'Bash', 0, ?)",
               (session_id, json.dumps({"error": text})))
    db.commit()


def test_clusters_similar_errors(db):
    pytest.importorskip("sentence_transformers")
    for i in range(4):
        _add_error(db, f"s{i}", "permission denied while writing file")
    for i in range(4):
        _add_error(db, f"t{i}", "module not found: cannot import package")
    n = run_error_clusters(db)
    assert n == 8
    clusters = list(db.execute("SELECT * FROM semantic_error_clusters"))
    assert len(clusters) >= 1
    assignments = list(db.execute("SELECT * FROM semantic_error_assignments"))
    assert len(assignments) == 8
