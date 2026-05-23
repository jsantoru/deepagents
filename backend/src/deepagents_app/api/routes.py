from fastapi import APIRouter, Depends

from deepagents_app.api.deps import get_agent_service
from deepagents_app.schemas.chat import ChatRequest, ChatResponse
from deepagents_app.services.agent_service import AgentService

api_router = APIRouter()


@api_router.get("/health", tags=["health"])
async def api_healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@api_router.post("/chat", response_model=ChatResponse, tags=["chat"])
async def chat(
    payload: ChatRequest,
    agent_service: AgentService = Depends(get_agent_service),
) -> ChatResponse:
    return await agent_service.chat(payload)
