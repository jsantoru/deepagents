from deepagents_app.services.agent_service import _normalize_message_content


def test_normalize_message_content_returns_plain_string() -> None:
    assert _normalize_message_content("hello") == "hello"


def test_normalize_message_content_flattens_structured_text_blocks() -> None:
    content = [
        {"type": "text", "text": "First paragraph."},
        {"type": "text", "text": "Second paragraph."},
    ]

    assert _normalize_message_content(content) == "First paragraph.\nSecond paragraph."


def test_normalize_message_content_falls_back_to_json() -> None:
    content = [{"type": "tool_result", "payload": {"status": "ok"}}]

    assert _normalize_message_content(content) == (
        '[{"type": "tool_result", "payload": {"status": "ok"}}]'
    )
