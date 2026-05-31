"""Dependency check used by the dashboard's Enable button."""
import importlib

REQUIRED = ["sentence_transformers", "bertopic", "hdbscan", "vaderSentiment"]


def missing_dependencies() -> list[str]:
    missing = []
    for mod in REQUIRED:
        try:
            importlib.import_module(mod)
        except ImportError:
            missing.append(mod)
    return missing


def check() -> dict:
    missing = missing_dependencies()
    return {"ok": len(missing) == 0, "missing": missing}
