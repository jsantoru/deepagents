from deepagents_app.core.pricing import estimate_cost_usd, normalize_model_name


def test_normalize_model_name_strips_openai_version_suffix() -> None:
    assert normalize_model_name("openai:gpt-5-nano-2025-08-07") == "openai:gpt-5-nano"


def test_normalize_model_name_strips_plain_version_suffix() -> None:
    assert normalize_model_name("gpt-4.1-mini-2025-04-14") == "gpt-4.1-mini"


def test_estimate_cost_uses_versioned_model_names() -> None:
    assert estimate_cost_usd("gpt-5-nano-2025-08-07", 13_095, 3_234) == 0.001948
