from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient

from deepagents_app.api.deps import get_agent_service
from deepagents_app.main import create_application
from deepagents_app.schemas.chat import ChatRequest, ChatResponse
from deepagents_app.services.agent_service import AgentService


class StubAgentService(AgentService):
    async def chat(self, payload: ChatRequest) -> ChatResponse:
        return ChatResponse(answer=f"echo: {payload.message}")


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    app = create_application()
    app.dependency_overrides[get_agent_service] = StubAgentService

    with TestClient(app) as test_client:
        yield test_client
