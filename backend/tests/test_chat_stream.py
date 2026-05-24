import time

from conftest import StubAgentService


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
    assert '"run_id":' in body


def test_chat_stream_run_survives_disconnect_and_can_be_reopened(client) -> None:
    StubAgentService.stream_delay_s = 0.05

    with client.stream("POST", "/api/v1/chat/stream", json={"message": "background"}) as response:
        status_chunk = next(response.iter_text())
        conversation_id = status_chunk.split('"conversation_id": "')[1].split('"', 1)[0]
        run_id = status_chunk.split('"run_id": "')[1].split('"', 1)[0]

    time.sleep(0.15)

    conversation = client.get(f"/api/v1/conversations/{conversation_id}")
    assert conversation.status_code == 200
    payload = conversation.json()
    assert payload["active_run"] is None
    assert payload["messages"][-1]["content"] == "echo: background"

    reconnect = client.get(f"/api/v1/chat/stream/{run_id}")
    reconnect_body = reconnect.text
    assert reconnect.status_code == 200
    assert 'event: status' in reconnect_body
    assert '"state": "completed"' in reconnect_body
    assert 'event: final' in reconnect_body
    assert '"answer": "echo: background"' in reconnect_body


def test_chat_stream_cancel_endpoint_returns_consistent_terminal_state(client) -> None:
    StubAgentService.stream_delay_s = 1.0

    with client.stream("POST", "/api/v1/chat/stream", json={"message": "cancel me"}) as response:
        text_chunks = response.iter_text()
        status_chunk = next(text_chunks)
        conversation_id = status_chunk.split('"conversation_id": "')[1].split('"', 1)[0]
        run_id = status_chunk.split('"run_id": "')[1].split('"', 1)[0]

        time.sleep(0.05)

        cancel_response = client.post(f"/api/v1/chat/stream/{run_id}/cancel")
        assert cancel_response.status_code == 200
        cancelled = cancel_response.json()["cancelled"]
        _ = ''.join(text_chunks)

    conversation = client.get(f"/api/v1/conversations/{conversation_id}")
    assert conversation.status_code == 200
    payload = conversation.json()
    assert payload["active_run"] is None

    reconnect = client.get(f"/api/v1/chat/stream/{run_id}")
    reconnect_body = reconnect.text
    assert reconnect.status_code == 200
    if cancelled:
        assert '"state": "cancelled"' in reconnect_body
        assert 'event: error' in reconnect_body
        assert 'Run cancelled.' in reconnect_body
    else:
        assert '"state": "completed"' in reconnect_body
        assert 'event: final' in reconnect_body
