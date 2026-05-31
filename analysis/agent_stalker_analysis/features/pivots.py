"""Semantic confirmation of structured pivot windows.

Structured retry signals are computed in TS; here we look for agent messages
that explicitly express retrying / trying another approach, and emit a
confidence signal per session window. Uses keyword heuristics by default so it
needs no model; an LLM upgrade can replace `_score_text` later.
"""
from ..corpus import extract_corpus

PIVOT_MARKERS = [
    "let me try", "try a different", "another approach", "that didn't work",
    "doesn't work", "still failing", "instead", "alternatively", "let's try",
    "didn't work", "not working", "go back", "revert",
]


def _score_text(text: str) -> float:
    low = text.lower()
    hits = sum(1 for m in PIVOT_MARKERS if m in low)
    return min(1.0, hits / 3.0)


def run_pivots(conn) -> int:
    docs = [d for d in extract_corpus(conn) if d["kind"] == "assistant"]
    conn.execute("DELETE FROM semantic_pivot_signals")
    n = 0
    for d in docs:
        conf = _score_text(d["text"])
        if conf <= 0:
            continue
        evidence = [m for m in PIVOT_MARKERS if m in d["text"].lower()]
        conn.execute(
            "INSERT INTO semantic_pivot_signals (session_id, window_start, window_end, confidence, evidence) VALUES (?,?,?,?,?)",
            (d["session_id"], d["timestamp"], d["timestamp"], conf, ", ".join(evidence)),
        )
        n += 1
    conn.commit()
    return n
