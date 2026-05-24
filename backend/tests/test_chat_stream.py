def test_chat_stream_endpoint_emits_trace_and_final_response(client) -> None:
    with client.stream("POST", "/api/v1/chat/stream", json={"message": "hello"}) as response:
        body = response.read().decode()

    assert response.status_code == 200
    assert "event: status" in body
    assert '"conversation_id":' in body
    assert "event: trace" in body
    assert "Tool call: internet_search" in body
    assert "event: final" in body
    assert '"answer": "echo: hello"' in body
