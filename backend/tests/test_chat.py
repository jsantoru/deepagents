from conftest import StubAgentService


def test_chat_endpoint_returns_answer(client) -> None:
    response = client.post("/api/v1/chat", json={"message": "hello"})

    assert response.status_code == 200
    payload = response.json()

    assert payload["answer"] == "echo: hello"
    assert payload["conversation_id"]
    assert payload["run_id"]
    assert payload["trace"] == [
        {
            "id": "note-1",
            "type": "assistant",
            "title": "Agent note",
            "content": "Searching for relevant information.",
            "metadata": {},
        },
        {
            "id": "tool-1",
            "type": "tool",
            "title": "Tool call: internet_search",
            "content": '{"query":"hello"}',
            "metadata": {"tool_name": "internet_search"},
        },
        {
            "id": "final-1",
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


def test_chat_persists_uploaded_text_attachments_for_audit(client) -> None:
    response = client.post(
        "/api/v1/chat",
        json={
            "message": "Review these notes",
            "attachments": [
                {
                    "id": "att-1",
                    "name": "notes.txt",
                    "mime_type": "text/plain",
                    "size_bytes": 11,
                    "text_content": "hello world",
                }
            ],
        },
    )

    assert response.status_code == 200
    payload = response.json()

    detail_response = client.get(f"/api/v1/conversations/{payload['conversation_id']}")
    assert detail_response.status_code == 200
    detail_payload = detail_response.json()

    assert detail_payload["messages"][0]["role"] == "user"
    assert detail_payload["messages"][0]["attachments"] == [
        {
            "id": detail_payload["messages"][0]["attachments"][0]["id"],
            "name": "notes.txt",
            "mime_type": "text/plain",
            "size_bytes": 11,
            "sha256": "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
            "text_content": "hello world",
            "created_at": detail_payload["messages"][0]["attachments"][0]["created_at"],
        }
    ]


def test_follow_up_turn_replays_prior_messages_and_attachments_to_agent(client) -> None:
    first_response = client.post(
        "/api/v1/chat",
        json={
            "message": "Summarize these notes",
            "attachments": [
                    {
                        "id": "att-1",
                        "name": "poker notes.txt",
                        "mime_type": "text/plain",
                        "size_bytes": 16,
                        "text_content": "tight\naggressive",
                    }
                ],
        },
    ).json()

    client.post(
        "/api/v1/chat",
        json={
            "message": "Now assess them against web sources",
            "conversation_id": first_response["conversation_id"],
        },
    )

    assert len(StubAgentService.invocations) == 2
    assert StubAgentService.invocations[1] == [
        {
            "role": "user",
            "content": (
                "User request:\nSummarize these notes\n\n"
                "Attached files:\n"
                "--- FILE: poker notes.txt (text/plain) ---\n"
                "tight\naggressive\n\n\n"
                "Instructions:\n"
                "Use the attached file contents as primary context for this request. "
                "When referring to attached material, cite the filename."
            ),
        },
        {"role": "assistant", "content": "echo: Summarize these notes"},
        {"role": "user", "content": "Now assess them against web sources"},
    ]
