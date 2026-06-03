"""Dependency check used by the dashboard's Enable button."""
import importlib.util

REQUIRED = ["sentence_transformers", "bertopic", "hdbscan", "vaderSentiment"]


def missing_dependencies() -> list[str]:
    missing = []
    for mod in REQUIRED:
        # find_spec checks installability without importing the module, so the
        # heavy ML deps (torch/sentence-transformers/bertopic) are never loaded —
        # keeps `check` near-instant for the dashboard's Enable button.
        try:
            found = importlib.util.find_spec(mod) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append(mod)
    return missing


def check() -> dict:
    missing = missing_dependencies()
    return {"ok": len(missing) == 0, "missing": missing}
