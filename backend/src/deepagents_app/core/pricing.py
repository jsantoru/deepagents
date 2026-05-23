MODEL_PRICING_USD_PER_MILLION_TOKENS: dict[str, tuple[float, float]] = {
    "openai:gpt-5-nano": (0.05, 0.4),
    "gpt-5-nano": (0.05, 0.4),
    "openai:gpt-4.1-nano": (0.1, 0.4),
    "gpt-4.1-nano": (0.1, 0.4),
    "openai:gpt-4.1-mini": (0.4, 1.6),
    "gpt-4.1-mini": (0.4, 1.6),
}


def estimate_cost_usd(model_name: str, input_tokens: int, output_tokens: int) -> float:
    normalized_model_name = normalize_model_name(model_name)
    input_rate, output_rate = MODEL_PRICING_USD_PER_MILLION_TOKENS.get(
        normalized_model_name,
        (0.0, 0.0),
    )
    input_cost = (input_tokens / 1_000_000) * input_rate
    output_cost = (output_tokens / 1_000_000) * output_rate
    return round(input_cost + output_cost, 6)


def normalize_model_name(model_name: str) -> str:
    normalized = model_name.strip()

    if normalized.startswith("openai:"):
        provider, raw_name = normalized.split(":", 1)
        return f"{provider}:{_strip_version_suffix(raw_name)}"

    return _strip_version_suffix(normalized)


def _strip_version_suffix(model_name: str) -> str:
    parts = model_name.split("-")
    if len(parts) >= 4 and all(part.isdigit() for part in parts[-3:]):
        return "-".join(parts[:-3])
    return model_name
