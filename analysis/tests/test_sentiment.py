import json
from agent_stalker_analysis.features.sentiment import run_sentiment


def _add_prompt(db, session_id, text, eid=None):
    db.execute("INSERT INTO events (session_id, hook_event_name, timestamp, data) VALUES (?, 'UserPromptSubmit', 0, ?)",
               (session_id, json.dumps({"prompt": text})))
    db.commit()


def test_writes_sentiment_rows_with_scores(db):
    _add_prompt(db, "s1", "this is broken and I am so frustrated, nothing works")
    _add_prompt(db, "s1", "great, thanks, that worked perfectly")
    n = run_sentiment(db)
    assert n == 2
    rows = list(db.execute("SELECT score, label, session_id FROM semantic_sentiment ORDER BY score ASC"))
    assert len(rows) == 2
    # most negative first
    assert rows[0]["score"] < rows[-1]["score"]
    assert rows[0]["label"] in ("negative", "neutral", "positive")
