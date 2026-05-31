"""Frustration detection via VADER (no torch dependency for this feature)."""
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from ..corpus import extract_corpus

MODEL = "vaderSentiment-3.3"


def _label(compound: float) -> str:
    if compound <= -0.25:
        return "negative"
    if compound >= 0.25:
        return "positive"
    return "neutral"


def run_sentiment(conn) -> int:
    analyzer = SentimentIntensityAnalyzer()
    docs = [d for d in extract_corpus(conn) if d["kind"] in ("prompt", "assistant")]

    conn.execute("DELETE FROM semantic_sentiment")
    n = 0
    for d in docs:
        compound = analyzer.polarity_scores(d["text"])["compound"]
        conn.execute(
            "INSERT INTO semantic_sentiment (source_kind, event_id, session_id, score, label, timestamp) VALUES (?,?,?,?,?,?)",
            (d["kind"], d["event_id"], d["session_id"], compound, _label(compound), d["timestamp"]),
        )
        n += 1
    conn.commit()
    return n
