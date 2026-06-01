"""LLM session triage. Separate opt-in: needs ANTHROPIC_API_KEY, costs tokens."""
import json
import os
import time

from ..db import parse_data

DEFAULT_MODEL = os.environ.get("AGENT_STALKER_TRIAGE_MODEL", "claude-sonnet-4-6")

PROMPT = """You are analyzing one coding-agent session for workflow pain.
Given the session digest below, respond with ONLY a JSON object:
{{"pain_score": <1-5 int>, "summary": "<one sentence>", "root_cause": "<short phrase>"}}

Digest:
{digest}
"""


def build_digest(conn, session_id: str, max_events: int = 120) -> str:
    lines: list[str] = []
    rows = conn.execute(
        "SELECT hook_event_name, tool_name, data FROM events WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?",
        (session_id, max_events),
    )
    for r in rows:
        data = parse_data(r["data"])
        if r["hook_event_name"] == "UserPromptSubmit":
            lines.append(f"USER: {data.get('prompt','')[:300]}")
        elif r["hook_event_name"] == "PostToolUseFailure":
            lines.append(f"ERROR[{r['tool_name']}]: {str(data.get('error',''))[:200]}")
        elif r["hook_event_name"] in ("Stop", "SubagentStop"):
            msg = data.get("last_assistant_message")
            if msg:
                lines.append(f"ASSISTANT: {str(msg)[:300]}")
        elif r["tool_name"]:
            lines.append(f"TOOL: {r['tool_name']}")
    return "\n".join(lines)


def run_triage(conn, session_id: str, client=None, model: str = DEFAULT_MODEL) -> dict:
    digest = build_digest(conn, session_id)
    if client is None:
        import anthropic
        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    message = client.messages.create(
        model=model,
        max_tokens=300,
        messages=[{"role": "user", "content": PROMPT.format(digest=digest)}],
    )
    text = message.content[0].text
    parsed = json.loads(text)
    cost = (getattr(message.usage, "input_tokens", 0) or 0) + (getattr(message.usage, "output_tokens", 0) or 0)

    conn.execute(
        "INSERT INTO semantic_session_triage (session_id, pain_score, summary, root_cause, model, cost_tokens, created_at) "
        "VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET "
        "pain_score=excluded.pain_score, summary=excluded.summary, root_cause=excluded.root_cause, "
        "model=excluded.model, cost_tokens=excluded.cost_tokens, created_at=excluded.created_at",
        (session_id, parsed["pain_score"], parsed["summary"], parsed["root_cause"], model, cost, int(time.time() * 1000)),
    )
    conn.commit()
    return {**parsed, "cost_tokens": cost}
