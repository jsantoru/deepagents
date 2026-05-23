from sqlalchemy.ext.asyncio import AsyncSession

from fastapi import APIRouter, Depends

from deepagents_app.api.deps import get_agent_service, get_db_session
from deepagents_app.schemas.admin import AdminOverviewResponse, AdminRunListResponse
from deepagents_app.schemas.chat import ChatRequest, ChatResponse
from deepagents_app.services.agent_service import AgentService
from deepagents_app.services.metrics_service import MetricsService

api_router = APIRouter()


@api_router.get("/health", tags=["health"])
async def api_healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@api_router.post("/chat", response_model=ChatResponse, tags=["chat"])
async def chat(
    payload: ChatRequest,
    agent_service: AgentService = Depends(get_agent_service),
    db_session: AsyncSession = Depends(get_db_session),
) -> ChatResponse:
    metrics_service = MetricsService(db_session)
    return await metrics_service.run_chat(payload=payload, agent_service=agent_service)


@api_router.get("/admin/overview", response_model=AdminOverviewResponse, tags=["admin"])
async def admin_overview(
    db_session: AsyncSession = Depends(get_db_session),
) -> AdminOverviewResponse:
    metrics_service = MetricsService(db_session)
    return await metrics_service.get_overview()


@api_router.get("/admin/runs", response_model=AdminRunListResponse, tags=["admin"])
async def admin_runs(
    limit: int = 20,
    db_session: AsyncSession = Depends(get_db_session),
) -> AdminRunListResponse:
    metrics_service = MetricsService(db_session)
    return await metrics_service.list_runs(limit=limit)
