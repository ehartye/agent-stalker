import json
from agent_stalker_analysis.run import run


def _add_prompt(db, session_id, text):
    db.execute("INSERT INTO events (session_id, hook_event_name, timestamp, data) VALUES (?, 'UserPromptSubmit', 0, ?)",
               (session_id, json.dumps({"prompt": text})))
    db.commit()


def test_run_sentiment_only_updates_meta(db, monkeypatch):
    # point the run() at our in-memory test db by patching connect
    import agent_stalker_analysis.run as run_mod
    monkeypatch.setattr(run_mod, "connect", lambda _p=None: db)

    _add_prompt(db, "s1", "totally broken, hate this")
    result = run(["sentiment"], db_path="ignored")
    assert result["sentiment"]["count"] == 1
    meta = list(db.execute("SELECT feature, status FROM semantic_meta WHERE feature='sentiment'"))
    assert meta[0]["status"] == "ok"
