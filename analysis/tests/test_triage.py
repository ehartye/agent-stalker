import json
from agent_stalker_analysis.features.triage import build_digest, run_triage


def _add_event(db, session_id, name, tool=None, data=None):
    db.execute("INSERT INTO events (session_id, hook_event_name, tool_name, timestamp, data) VALUES (?,?,?,0,?)",
               (session_id, name, tool, data))
    db.commit()


def test_build_digest_summarizes_session(db):
    _add_event(db, "s1", "UserPromptSubmit", data=json.dumps({"prompt": "add login"}))
    _add_event(db, "s1", "PostToolUseFailure", "Bash", json.dumps({"error": "denied"}))
    digest = build_digest(db, "s1")
    assert "add login" in digest
    assert "denied" in digest


def test_run_triage_uses_injected_client(db):
    _add_event(db, "s1", "UserPromptSubmit", data=json.dumps({"prompt": "add login"}))

    class FakeMessage:
        content = [type("B", (), {"text": json.dumps({"pain_score": 4, "summary": "rough", "root_cause": "perms"})})()]
        usage = type("U", (), {"input_tokens": 100, "output_tokens": 20})()

    class FakeClient:
        class messages:
            @staticmethod
            def create(**kwargs):
                return FakeMessage()

    result = run_triage(db, "s1", client=FakeClient(), model="claude-test")
    assert result["pain_score"] == 4
    row = list(db.execute("SELECT * FROM semantic_session_triage WHERE session_id='s1'"))[0]
    assert row["root_cause"] == "perms"
    assert row["cost_tokens"] == 120
