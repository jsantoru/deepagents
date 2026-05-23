MODEL_PRICING_USD_PER_MILLION_TOKENS: dict[str, tuple[float, float]] = {
    "openai:gpt-5-nano": (0.05, 0.4),
    "openai:gpt-4.1-nano": (0.1, 0.4),
    "openai:gpt-4.1-mini": (0.4, 1.6),
}


def estimate_cost_usd(model_name: str, input_tokens: int, output_tokens: int) -> float:
    input_rate, output_rate = MODEL_PRICING_USD_PER_MILLION_TOKENS.get(model_name, (0.0, 0.0))
    input_cost = (input_tokens / 1_000_000) * input_rate
    output_cost = (output_tokens / 1_000_000) * output_rate
    return round(input_cost + output_cost, 6)
