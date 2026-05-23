def test_admin_overview_returns_aggregates(client) -> None:
    client.post("/api/v1/chat", json={"message": "hello"})
    client.post("/api/v1/chat", json={"message": "world"})

    response = client.get("/api/v1/admin/overview")

    assert response.status_code == 200
    assert response.json() == {
        "conversation_count": 2,
        "run_count": 2,
        "total_tokens": 36,
        "total_estimated_cost_usd": 6e-06,
        "average_latency_ms": response.json()["average_latency_ms"],
    }


def test_admin_runs_lists_recent_runs(client) -> None:
    client.post("/api/v1/chat", json={"message": "hello"})

    response = client.get("/api/v1/admin/runs")

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["runs"]) == 1
    assert payload["runs"][0]["answer_preview"] == "echo: hello"
    assert payload["runs"][0]["metrics"]["total_tokens"] == 18


def test_conversations_lists_recent_history(client) -> None:
    first = client.post("/api/v1/chat", json={"message": "hello"}).json()
    client.post(
        "/api/v1/chat",
        json={"message": "follow up", "conversation_id": first["conversation_id"]},
    )

    response = client.get("/api/v1/conversations")

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["conversations"]) == 1
    assert payload["conversations"][0]["conversation_id"] == first["conversation_id"]
    assert payload["conversations"][0]["title"] == "hello"
    assert payload["conversations"][0]["preview"] == "echo: follow up"
    assert payload["conversations"][0]["message_count"] == 4


def test_conversation_detail_returns_messages_and_metrics(client) -> None:
    first = client.post("/api/v1/chat", json={"message": "hello"}).json()

    response = client.get(f"/api/v1/conversations/{first['conversation_id']}")

    assert response.status_code == 200
    payload = response.json()
    assert payload["conversation_id"] == first["conversation_id"]
    assert payload["title"] == "hello"
    assert [message["role"] for message in payload["messages"]] == ["user", "assistant"]
    assert payload["messages"][1]["metrics"]["total_tokens"] == 18
