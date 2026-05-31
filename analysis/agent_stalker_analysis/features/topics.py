"""Topic modeling via BERTopic, with per-topic pain correlation."""
from ..corpus import extract_corpus

MODEL = "all-MiniLM-L6-v2"


def _session_error_rate(conn) -> dict[str, float]:
    rates: dict[str, float] = {}
    rows = conn.execute(
        "SELECT session_id, "
        "SUM(CASE WHEN hook_event_name='PostToolUseFailure' THEN 1 ELSE 0 END) AS errs, "
        "COUNT(*) AS total "
        "FROM events WHERE hook_event_name IN ('PostToolUse','PostToolUseFailure') GROUP BY session_id"
    )
    for r in rows:
        rates[r["session_id"]] = (r["errs"] / r["total"]) if r["total"] else 0.0
    return rates


def run_topics(conn) -> int:
    docs = extract_corpus(conn)
    conn.execute("DELETE FROM semantic_topics")
    conn.execute("DELETE FROM semantic_topic_assignments")
    if len(docs) < 2:
        conn.commit()
        return 0

    from bertopic import BERTopic
    from sentence_transformers import SentenceTransformer

    texts = [d["text"] for d in docs]
    model = BERTopic(embedding_model=SentenceTransformer(MODEL), min_topic_size=2, verbose=False)
    topics, probs = model.fit_transform(texts)

    error_rate = _session_error_rate(conn)

    info = model.get_topic_info()
    # pain per topic = mean session error-rate of its docs
    topic_pain: dict[int, list[float]] = {}
    for d, t in zip(docs, topics):
        topic_pain.setdefault(int(t), []).append(error_rate.get(d["session_id"], 0.0))

    for _, r in info.iterrows():
        tid = int(r["Topic"])
        words = model.get_topic(tid)
        keywords = ", ".join(w for w, _ in words[:8]) if words else ""
        pains = topic_pain.get(tid, [])
        pain = sum(pains) / len(pains) if pains else 0.0
        conn.execute(
            "INSERT INTO semantic_topics (topic_id, label, keywords, size, pain_score) VALUES (?,?,?,?,?)",
            (tid, str(r["Name"]), keywords, int(r["Count"]), pain),
        )

    for d, t, p in zip(docs, topics, probs):
        prob = float(p) if p is not None else 0.0
        conn.execute(
            "INSERT INTO semantic_topic_assignments (doc_id, session_id, topic_id, prob) VALUES (?,?,?,?)",
            (d["doc_id"], d["session_id"], int(t), prob),
        )

    conn.commit()
    return len(docs)
