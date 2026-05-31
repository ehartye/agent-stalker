import json
from agent_stalker_analysis.corpus import extract_corpus, extract_errors


def _add_event(db, **kw):
    db.execute(
        "INSERT INTO events (session_id, hook_event_name, tool_name, timestamp, data) VALUES (?,?,?,?,?)",
        (kw.get("session_id"), kw.get("hook_event_name"), kw.get("tool_name"), kw.get("timestamp", 0), kw.get("data")),
    )
    db.commit()


def test_extracts_prompts_and_messages(db):
    _add_event(db, session_id="s1", hook_event_name="UserPromptSubmit", data=json.dumps({"prompt": "fix the bug"}))
    _add_event(db, session_id="s1", hook_event_name="SubagentStop", data=json.dumps({"last_assistant_message": "done"}))
    db.execute("INSERT INTO tasks (id, session_id, subject, description) VALUES ('1','s1','Add auth','desc')")
    db.commit()

    docs = extract_corpus(db)
    kinds = {d["kind"] for d in docs}
    assert "prompt" in kinds
    assert "assistant" in kinds
    assert "task" in kinds
    prompt_doc = next(d for d in docs if d["kind"] == "prompt")
    assert prompt_doc["text"] == "fix the bug"
    assert prompt_doc["session_id"] == "s1"


def test_extracts_error_messages(db):
    _add_event(db, session_id="s1", hook_event_name="PostToolUseFailure", tool_name="Bash",
               data=json.dumps({"error": "permission denied"}))
    errs = extract_errors(db)
    assert len(errs) == 1
    assert "permission denied" in errs[0]["text"]
