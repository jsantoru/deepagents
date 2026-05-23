from deepagents_app.services.agent_service import (
    ANALYST_SYSTEM_PROMPT,
    _normalize_message_content,
)


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


def test_analyst_system_prompt_requires_verified_citations_and_osir_format() -> None:
    assert "open-source intelligence analyst" in ANALYST_SYSTEM_PROMPT
    assert "Never invent, guess, or hallucinate a citation" in ANALYST_SYSTEM_PROMPT
    assert "Before drafting the final answer, verify every citation" in ANALYST_SYSTEM_PROMPT
    assert "Write the final response in Markdown." in ANALYST_SYSTEM_PROMPT
    assert "OSIR-style open source intelligence report" in ANALYST_SYSTEM_PROMPT
    assert "without any classified markings" in ANALYST_SYSTEM_PROMPT
    assert "End the report with a clearly labeled Sources section" in ANALYST_SYSTEM_PROMPT
