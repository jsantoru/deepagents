def test_chat_endpoint_returns_answer(client) -> None:
    response = client.post("/api/v1/chat", json={"message": "hello"})

    assert response.status_code == 200
    assert response.json() == {"answer": "echo: hello"}
