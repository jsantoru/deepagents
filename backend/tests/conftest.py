from collections.abc import Sequence

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import cortex.db as db_module
from cortex.agent.service import AgentRunResult, AgentService, OnEvent
from cortex.api.deps import get_agent_service, get_extractor
from cortex.main import create_app
from cortex.memory.graph import ExtractedEntity, ExtractedRelation
from cortex.models import Base
from cortex.schemas import ResearchMode, TraceEvent


class FakeAgentService(AgentService):
    async def stream_chat(
        self,
        messages: Sequence[dict[str, str]],
        mode: ResearchMode,
        memory_context: str,
        on_event: OnEvent,
    ) -> AgentRunResult:
        self.last_memory_context = memory_context
        await on_event(TraceEvent(id="n1", type="note", title="Reasoning", content="thinking"))
        await on_event(TraceEvent(id="t1", type="tool", title="internet_search", content="{}"))
        await on_event(
            TraceEvent(id="t1", type="tool_result", title="internet_search", content="{}")
        )
        return AgentRunResult(
            answer="Anthropic is an AI safety company founded by Dario Amodei.",
            model_name="fake-model", input_tokens=10, output_tokens=20, search_calls=1,
        )


class FakeExtractor:
    async def extract(self, user_message: str, assistant_message: str):
        return (
            [
                ExtractedEntity(name="Anthropic", type="organization", summary="AI safety company"),
                ExtractedEntity(name="Dario Amodei", type="person", summary="CEO of Anthropic"),
            ],
            [
                ExtractedRelation(
                    source="Anthropic", target="Dario Amodei", type="founded_by",
                    description="Founded in 2021",
                )
            ],
        )


@pytest.fixture
async def test_db():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    db_module._engine = engine
    db_module._session_factory = factory
    yield factory
    db_module._engine = None
    db_module._session_factory = None
    await engine.dispose()


@pytest.fixture
async def db_session(test_db):
    async with test_db() as session:
        yield session


@pytest.fixture
def fake_agent():
    return FakeAgentService()


@pytest.fixture
async def client(test_db, fake_agent):
    app = create_app()
    app.dependency_overrides[get_agent_service] = lambda: fake_agent
    app.dependency_overrides[get_extractor] = lambda: FakeExtractor()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
