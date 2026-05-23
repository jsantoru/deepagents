from collections.abc import Awaitable, Callable, Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from deepagents_app.api.deps import get_agent_service
from deepagents_app.core.config import get_settings
from deepagents_app.core.db import dispose_engine
from deepagents_app.main import create_application
from deepagents_app.schemas.chat import ChatRequest, ChatTraceEvent
from deepagents_app.services.agent_service import AgentRunResult, AgentService


class StubAgentService(AgentService):
    async def chat(self, payload: ChatRequest) -> AgentRunResult:
        return AgentRunResult(
            answer=f"echo: {payload.message}",
            trace=[
                ChatTraceEvent(
                    id="note-1",
                    type="assistant",
                    title="Agent note",
                    content="Searching for relevant information.",
                ),
                ChatTraceEvent(
                    id="tool-1",
                    type="tool",
                    title="Tool call: internet_search",
                    content='{"query":"hello"}',
                    metadata={"tool_name": "internet_search"},
                ),
                ChatTraceEvent(
                    id="final-1",
                    type="final",
                    title="Final answer",
                    content=f"echo: {payload.message}",
                ),
            ],
            model_name="openai:gpt-5-nano",
            input_tokens=11,
            output_tokens=7,
            total_tokens=18,
            search_calls=1,
            raw_payload={"messages": []},
        )

    async def stream_chat(
        self,
        payload: ChatRequest,
        on_event: Callable[[ChatTraceEvent], Awaitable[None]],
    ) -> AgentRunResult:
        trace = [
            ChatTraceEvent(
                id="note-1",
                type="assistant",
                title="Agent note",
                content="Searching for relevant information.",
            ),
            ChatTraceEvent(
                id="tool-1",
                type="tool",
                title="Tool call: internet_search",
                content='{"query":"hello"}',
                metadata={"tool_name": "internet_search"},
            ),
            ChatTraceEvent(
                id="tool-1",
                type="tool_result",
                title="Tool result: internet_search",
                content='{"results":[{"title":"Example"}]}',
                metadata={"tool_name": "internet_search"},
            ),
            ChatTraceEvent(
                id="final-1",
                type="final",
                title="Final answer",
                content=f"echo: {payload.message}",
            ),
        ]
        for event in trace[:-1]:
            await on_event(event)

        return AgentRunResult(
            answer=f"echo: {payload.message}",
            trace=trace,
            model_name="openai:gpt-5-nano",
            input_tokens=11,
            output_tokens=7,
            total_tokens=18,
            search_calls=1,
            raw_payload={"messages": []},
        )


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Generator[TestClient, None, None]:
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{db_path}")
    get_settings.cache_clear()

    app = create_application()
    app.dependency_overrides[get_agent_service] = StubAgentService

    with TestClient(app) as test_client:
        yield test_client

    get_settings.cache_clear()
    import asyncio

    asyncio.run(dispose_engine())
