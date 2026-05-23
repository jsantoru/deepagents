from types import SimpleNamespace

from deepagents_app.services.agent_service import _extract_trace_events


def test_extract_trace_events_builds_agent_timeline() -> None:
    messages = [
        SimpleNamespace(type="human", content="What changed?"),
        SimpleNamespace(type="ai", content="I'll look through recent updates."),
        SimpleNamespace(type="tool", name="internet_search", content='{"query":"recent changes"}'),
        SimpleNamespace(type="ai", content="DeepAgents added delegated workflows."),
    ]

    trace = _extract_trace_events(messages)

    assert [event.type for event in trace] == ["assistant", "tool", "final"]
    assert trace[0].content == "I'll look through recent updates."
    assert trace[1].metadata == {"tool_name": "internet_search"}
    assert trace[2].title == "Final answer"
