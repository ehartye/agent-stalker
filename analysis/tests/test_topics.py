import json
import pytest
from agent_stalker_analysis.features.topics import run_topics


def _add_prompt(db, session_id, text):
    db.execute("INSERT INTO events (session_id, hook_event_name, timestamp, data) VALUES (?, 'UserPromptSubmit', 0, ?)",
               (session_id, json.dumps({"prompt": text})))
    db.commit()


def test_writes_topics_and_assignments(db):
    pytest.importorskip("bertopic")
    samples = [
        "fix the authentication login bug", "auth token refresh is broken", "login session expired error",
        "improve the css layout styling", "the button color and spacing looks off", "redesign the header layout",
    ] * 3
    for i, s in enumerate(samples):
        _add_prompt(db, f"s{i}", s)
    n = run_topics(db)
    assert n > 0
    topics = list(db.execute("SELECT * FROM semantic_topics"))
    assert len(topics) >= 1
    assignments = list(db.execute("SELECT * FROM semantic_topic_assignments"))
    assert len(assignments) == n
