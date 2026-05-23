from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from deepagents_app.core.db import get_session_factory
from deepagents_app.services.agent_service import AgentService, DeepAgentsService


def get_agent_service() -> AgentService:
    return DeepAgentsService()


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    session_factory = get_session_factory()
    async with session_factory() as session:
        yield session
