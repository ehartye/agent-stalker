import time

from .db import connect

FEATURE_VERSION = "1"


def _set_meta(conn, feature, model, corpus_size, status):
    conn.execute(
        "INSERT INTO semantic_meta (feature, version, model, last_run_at, corpus_size, status) VALUES (?,?,?,?,?,?) "
        "ON CONFLICT(feature) DO UPDATE SET version=excluded.version, model=excluded.model, "
        "last_run_at=excluded.last_run_at, corpus_size=excluded.corpus_size, status=excluded.status",
        (feature, FEATURE_VERSION, model, int(time.time() * 1000), corpus_size, status),
    )
    conn.commit()


def run(features: list[str], db_path: str | None = None) -> dict:
    conn = connect(db_path)
    result: dict = {}

    for feature in features:
        feature = feature.strip()
        try:
            if feature == "sentiment":
                from .features.sentiment import run_sentiment, MODEL
                count = run_sentiment(conn)
                _set_meta(conn, "sentiment", MODEL, count, "ok")
                result["sentiment"] = {"count": count}
            elif feature == "topics":
                from .features.topics import run_topics, MODEL
                count = run_topics(conn)
                _set_meta(conn, "topics", MODEL, count, "ok")
                result["topics"] = {"count": count}
            elif feature == "errors":
                from .features.error_clusters import run_error_clusters, MODEL
                count = run_error_clusters(conn)
                _set_meta(conn, "errors", MODEL, count, "ok")
                result["errors"] = {"count": count}
            elif feature == "pivots":
                from .features.pivots import run_pivots
                count = run_pivots(conn)
                _set_meta(conn, "pivots", "keyword-1", count, "ok")
                result["pivots"] = {"count": count}
            elif feature == "triage":
                # triage no longer runs in the Python sidecar — it is handled in
                # Claude Code via the dashboard "Flag for triage" button plus the
                # /stalker-triage skill (no API key, no cost).
                msg = "triage is handled in Claude Code via the dashboard flag + /stalker-triage skill, not the Python sidecar"
                _set_meta(conn, "triage", "", 0, f"skipped: {msg}")
                result["triage"] = {"error": msg}
            else:
                # Write meta even for unknown features, matching the per-feature
                # failure-isolation contract (every requested feature gets a status).
                _set_meta(conn, feature, "", 0, "error: unknown feature")
                result[feature] = {"error": "unknown feature"}
        except Exception as exc:  # per-feature failure, not all-or-nothing
            _set_meta(conn, feature, "", 0, f"error: {exc}")
            result[feature] = {"error": str(exc)}

    return result
