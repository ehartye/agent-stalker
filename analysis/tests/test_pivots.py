import json
from agent_stalker_analysis.features.pivots import run_pivots, _score_text


def _add_assistant(db, session_id, text, ts=0):
    db.execute("INSERT INTO events (session_id, hook_event_name, timestamp, data) VALUES (?, 'SubagentStop', ?, ?)",
               (session_id, ts, json.dumps({"last_assistant_message": text})))
    db.commit()


def test_score_text_counts_markers():
    assert _score_text("all good here") == 0.0
    # three distinct markers -> capped at 1.0
    assert _score_text("that didn't work, let me try another approach") == 1.0


def test_run_pivots_writes_signals_for_retry_language(db):
    _add_assistant(db, "s1", "that didn't work, let me try a different approach", ts=10)
    _add_assistant(db, "s1", "everything passed, all done", ts=20)
    n = run_pivots(db)
    assert n == 1
    rows = list(db.execute("SELECT session_id, confidence, evidence, window_start FROM semantic_pivot_signals"))
    assert len(rows) == 1
    assert rows[0]["session_id"] == "s1"
    assert rows[0]["confidence"] > 0
    assert rows[0]["window_start"] == 10
    assert "let me try" in rows[0]["evidence"]
