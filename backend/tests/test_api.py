import json


def _parse_sse(body: str) -> list[dict]:
    events = []
    for block in body.strip().split("\n\n"):
        lines = block.split("\n")
        data = next((line[6:] for line in lines if line.startswith("data: ")), None)
        if data:
            events.append(json.loads(data))
    return events


async def test_health(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200


async def test_chat_stream_full_turn(client, fake_agent):
    resp = await client.post(
        "/api/chat/stream", json={"message": "Tell me about Anthropic"}
    )
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    types = [e.get("type") for e in events if e]

    assert "note" in types
    assert "tool" in types and "tool_result" in types
    assert "final" in types
    assert "memory" in types

    final = next(e for e in events if e.get("type") == "final")
    assert "Anthropic" in final["content"]
    session_id = final["metadata"]["session_id"]

    memory = next(e for e in events if e.get("type") == "memory")
    added_names = {e["name"] for e in memory["metadata"]["added_entities"]}
    assert added_names == {"Anthropic", "Dario Amodei"}

    # Session persisted with both messages and run metrics.
    detail = (await client.get(f"/api/sessions/{session_id}")).json()
    assert [m["role"] for m in detail["messages"]] == ["user", "assistant"]
    assert detail["runs"][0]["status"] == "done"
    assert detail["runs"][0]["entities_added"] == 2
    assert detail["runs"][0]["relations_added"] == 1

    # Graph endpoints reflect the new knowledge.
    graph = (await client.get("/api/memory/graph")).json()
    assert len(graph["nodes"]) == 2
    assert len(graph["edges"]) == 1

    stats = (await client.get("/api/memory/stats")).json()
    assert stats["entities"] == 2 and stats["relations"] == 1

    timeline = (await client.get("/api/memory/timeline")).json()
    assert timeline[-1]["total_entities"] == 2

    # Second turn on the same topic recalls memory into the agent context.
    resp2 = await client.post(
        "/api/chat/stream",
        json={"message": "More about Anthropic please", "session_id": session_id},
    )
    events2 = _parse_sse(resp2.text)
    assert any(e.get("type") == "recall" for e in events2 if e)
    assert "LONG-TERM MEMORY" in fake_agent.last_memory_context

    entity_id = graph["nodes"][0]["id"]
    entity = (await client.get(f"/api/memory/entities/{entity_id}")).json()
    assert entity["node"]["id"] == entity_id
    assert len(entity["edges"]) == 1


async def test_sessions_crud(client):
    resp = await client.post("/api/chat/stream", json={"message": "First research question"})
    session_id = next(
        e for e in _parse_sse(resp.text) if e.get("type") == "final"
    )["metadata"]["session_id"]

    sessions = (await client.get("/api/sessions")).json()
    assert len(sessions) == 1
    assert sessions[0]["message_count"] == 2
    assert sessions[0]["title"].startswith("First research")

    assert (await client.delete(f"/api/sessions/{session_id}")).status_code == 200
    assert (await client.get("/api/sessions")).json() == []
    assert (await client.get(f"/api/sessions/{session_id}")).status_code == 404
