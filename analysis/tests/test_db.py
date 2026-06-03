from agent_stalker_analysis.db import parse_data


def test_parse_data_handles_garbage():
    assert parse_data(None) == {}
    assert parse_data("not json") == {}
    assert parse_data('{"a": 1}') == {"a": 1}
