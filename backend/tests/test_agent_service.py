from deepagents_app.services.agent_service import (
    ANALYST_SYSTEM_PROMPT,
    LIGHT_RESEARCH_ADDENDUM,
    STANDARD_RESEARCH_ADDENDUM,
    _normalize_message_content,
    build_system_prompt,
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
    assert "proceed directly instead of asking unnecessary clarifying questions" in ANALYST_SYSTEM_PROMPT
    assert "choose reasonable default scope" in ANALYST_SYSTEM_PROMPT
    assert 'If the user gives a short follow-up like "general"' in ANALYST_SYSTEM_PROMPT
    assert "Before drafting the final answer, verify every citation" in ANALYST_SYSTEM_PROMPT
    assert "Write the final response in Markdown." in ANALYST_SYSTEM_PROMPT
    assert "Use headings, bullet lists, numbered lists, and tables" in ANALYST_SYSTEM_PROMPT
    assert "Do not force tables everywhere" in ANALYST_SYSTEM_PROMPT
    assert "OSIR-style open source intelligence report" in ANALYST_SYSTEM_PROMPT
    assert "without any classified markings" in ANALYST_SYSTEM_PROMPT
    assert "End the report with a clearly labeled Sources section" in ANALYST_SYSTEM_PROMPT


def test_build_system_prompt_uses_light_research_constraints() -> None:
    prompt = build_system_prompt("light")

    assert "finish in under 1 minute" in prompt
    assert LIGHT_RESEARCH_ADDENDUM in prompt
    assert STANDARD_RESEARCH_ADDENDUM not in prompt


def test_build_system_prompt_uses_standard_research_constraints() -> None:
    prompt = build_system_prompt("standard")

    assert "up to 5 minutes" in prompt
    assert STANDARD_RESEARCH_ADDENDUM in prompt
    assert LIGHT_RESEARCH_ADDENDUM not in prompt
