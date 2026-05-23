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
