from .db import parse_data


def extract_corpus(conn) -> list[dict]:
    """Natural-language docs for sentiment + topic modeling."""
    docs: list[dict] = []

    for row in conn.execute("SELECT id, session_id, timestamp, data FROM events WHERE hook_event_name = 'UserPromptSubmit'"):
        text = parse_data(row["data"]).get("prompt")
        if text:
            docs.append({"kind": "prompt", "doc_id": f"prompt-{row['id']}", "event_id": row["id"],
                         "session_id": row["session_id"], "timestamp": row["timestamp"], "text": text})

    for row in conn.execute("SELECT id, session_id, timestamp, data FROM events WHERE hook_event_name IN ('Stop','SubagentStop')"):
        text = parse_data(row["data"]).get("last_assistant_message")
        if text:
            docs.append({"kind": "assistant", "doc_id": f"assistant-{row['id']}", "event_id": row["id"],
                         "session_id": row["session_id"], "timestamp": row["timestamp"], "text": text})

    for row in conn.execute("SELECT id, session_id, subject, description FROM tasks"):
        parts = [p for p in (row["subject"], row["description"]) if p]
        if parts:
            docs.append({"kind": "task", "doc_id": f"task-{row['id']}-{row['session_id']}", "event_id": None,
                         "session_id": row["session_id"], "timestamp": None, "text": " — ".join(parts)})

    return docs


def extract_errors(conn) -> list[dict]:
    """Error message docs for clustering."""
    errs: list[dict] = []
    for row in conn.execute("SELECT id, session_id, tool_name, data FROM events WHERE hook_event_name = 'PostToolUseFailure'"):
        data = parse_data(row["data"])
        text = data.get("error")
        if not text and isinstance(data.get("tool_response"), dict):
            text = data["tool_response"].get("error") or data["tool_response"].get("stderr")
        if text:
            errs.append({"event_id": row["id"], "session_id": row["session_id"],
                         "tool_name": row["tool_name"], "text": str(text)})
    return errs
