import sys

import agent_stalker_analysis.check as check_mod
from agent_stalker_analysis.check import missing_dependencies, check


def test_present_module_not_reported_and_fake_reported(monkeypatch):
    # "json" is always importable; the fake name never is.
    monkeypatch.setattr(check_mod, "REQUIRED", ["json", "definitely_not_a_real_module_xyz"])
    missing = missing_dependencies()
    assert missing == ["definitely_not_a_real_module_xyz"]


def test_check_shape(monkeypatch):
    monkeypatch.setattr(check_mod, "REQUIRED", ["json"])
    assert check() == {"ok": True, "missing": []}

    monkeypatch.setattr(check_mod, "REQUIRED", ["definitely_not_a_real_module_xyz"])
    result = check()
    assert result == {"ok": False, "missing": ["definitely_not_a_real_module_xyz"]}


def test_does_not_import_the_checked_module(monkeypatch):
    # find_spec must detect availability WITHOUT importing the module,
    # so checking a not-yet-imported present module leaves it unimported.
    sys.modules.pop("html.parser", None)
    monkeypatch.setattr(check_mod, "REQUIRED", ["html.parser"])
    assert missing_dependencies() == []
    assert "html.parser" not in sys.modules
