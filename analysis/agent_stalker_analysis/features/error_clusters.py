"""Cluster recurring failure modes via sentence-transformer embeddings + HDBSCAN."""
from collections import Counter

from ..corpus import extract_errors

MODEL = "all-MiniLM-L6-v2"


def run_error_clusters(conn, min_cluster_size: int = 3) -> int:
    errors = extract_errors(conn)
    conn.execute("DELETE FROM semantic_error_clusters")
    conn.execute("DELETE FROM semantic_error_assignments")
    if not errors:
        conn.commit()
        return 0

    from sentence_transformers import SentenceTransformer
    import hdbscan

    texts = [e["text"] for e in errors]
    embeddings = SentenceTransformer(MODEL).encode(texts)

    if len(texts) >= min_cluster_size:
        labels = hdbscan.HDBSCAN(min_cluster_size=min_cluster_size).fit_predict(embeddings)
    else:
        labels = [0] * len(texts)

    # cluster metadata
    by_cluster: dict[int, list[int]] = {}
    for idx, lab in enumerate(labels):
        by_cluster.setdefault(int(lab), []).append(idx)

    for cluster_id, idxs in by_cluster.items():
        if cluster_id == -1:  # HDBSCAN noise
            label = "misc/uncategorized"
        else:
            # crude label: most common 3 words across the cluster's texts
            words = Counter()
            for i in idxs:
                words.update(w.lower() for w in texts[i].split() if len(w) > 3)
            label = " ".join(w for w, _ in words.most_common(3)) or "cluster"
        sessions = {errors[i]["session_id"] for i in idxs}
        conn.execute(
            "INSERT INTO semantic_error_clusters (cluster_id, label, exemplar, size, session_spread) VALUES (?,?,?,?,?)",
            (cluster_id, label, texts[idxs[0]][:200], len(idxs), len(sessions)),
        )

    for idx, lab in enumerate(labels):
        conn.execute(
            "INSERT INTO semantic_error_assignments (event_id, session_id, cluster_id) VALUES (?,?,?)",
            (errors[idx]["event_id"], errors[idx]["session_id"], int(lab)),
        )

    conn.commit()
    return len(errors)
