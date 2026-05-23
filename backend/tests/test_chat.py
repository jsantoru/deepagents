def test_chat_endpoint_returns_answer(client) -> None:
    response = client.post("/api/v1/chat", json={"message": "hello"})

    assert response.status_code == 200
    payload = response.json()

    assert payload["answer"] == "echo: hello"
    assert payload["conversation_id"]
    assert payload["run_id"]
    assert payload["trace"] == [
        {
            "type": "assistant",
            "title": "Agent note",
            "content": "Searching for relevant information.",
            "metadata": {},
        },
        {
            "type": "tool",
            "title": "Tool call: internet_search",
            "content": '{"query":"hello"}',
            "metadata": {"tool_name": "internet_search"},
        },
        {
            "type": "final",
            "title": "Final answer",
            "content": "echo: hello",
            "metadata": {},
        },
    ]
    assert payload["metrics"] == {
        "model_name": "openai:gpt-5-nano",
        "latency_ms": payload["metrics"]["latency_ms"],
        "input_tokens": 11,
        "output_tokens": 7,
        "total_tokens": 18,
        "estimated_cost_usd": 3e-06,
        "search_calls": 1,
    }


def test_chat_endpoint_reuses_conversation(client) -> None:
    first_response = client.post("/api/v1/chat", json={"message": "hello"}).json()
    second_response = client.post(
        "/api/v1/chat",
        json={"message": "follow up", "conversation_id": first_response["conversation_id"]},
    ).json()

    assert second_response["conversation_id"] == first_response["conversation_id"]
