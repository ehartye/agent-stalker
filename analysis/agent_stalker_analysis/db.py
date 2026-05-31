import json
import os
import sqlite3
from pathlib import Path


def default_db_path() -> str:
    env = os.environ.get("AGENT_STALKER_DB_PATH")
    if env:
        return env
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""
    return str(Path(home) / ".claude" / "agent-stalker.db")


def connect(db_path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or default_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def parse_data(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
