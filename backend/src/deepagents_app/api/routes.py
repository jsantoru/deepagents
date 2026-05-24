import json

from sqlalchemy.ext.asyncio import AsyncSession

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from deepagents_app.api.deps import get_agent_service, get_db_session
from deepagents_app.core.db import get_session_factory
from deepagents_app.schemas.admin import (
    AdminOverviewResponse,
    AdminRunListResponse,
    ConversationDetailResponse,
    ConversationSummaryListResponse,
)
from deepagents_app.schemas.chat import ChatRequest, ChatResponse
from deepagents_app.services.background_runner import get_background_runner
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


@api_router.post("/chat/stream", tags=["chat"])
async def chat_stream(
    payload: ChatRequest,
    agent_service: AgentService = Depends(get_agent_service),
) -> StreamingResponse:
    runner = get_background_runner()
    session_factory = get_session_factory()

    async with session_factory() as session:
        metrics_service = MetricsService(session)
        conversation = await metrics_service.prepare_chat(payload)
        run = await metrics_service.create_pending_run(conversation.id)
        conversation_messages = await metrics_service.build_conversation_messages(conversation.id)

    async def event_generator():
        queue = await runner.subscribe(run.id)
        await runner.start_run(run.id, payload, conversation_messages, agent_service)
        try:
            yield _format_sse(
                "status",
                {
                    "state": "started",
                    "conversation_id": conversation.id,
                    "run_id": run.id,
                },
            )
            while True:
                event_type, data = await queue.get()
                if event_type == "done":
                    break
                yield _format_sse(event_type, data)
        finally:
            await runner.unsubscribe(run.id, queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@api_router.get("/chat/stream/{run_id}", tags=["chat"])
async def reconnect_chat_stream(
    run_id: str,
    after_sequence: int = 0,
) -> StreamingResponse:
    session_factory = get_session_factory()

    async with session_factory() as session:
        metrics_service = MetricsService(session)
        run = await metrics_service.get_agent_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")

    runner = get_background_runner()

    async def event_generator():
        current_run = run
        yield _format_sse(
            "status",
            {
                "state": current_run.status,
                "conversation_id": current_run.conversation_id,
                "run_id": current_run.id,
            },
        )
        async with session_factory() as session:
            metrics_service = MetricsService(session)
            historical_events = await metrics_service.get_trace_events(
                current_run.id,
                after_sequence=after_sequence,
            )
        for event in historical_events:
            yield _format_sse("trace", event)

        async with session_factory() as session:
            metrics_service = MetricsService(session)
            current_run = await metrics_service.get_agent_run(run_id) or current_run
        if current_run.status == "completed":
            async with session_factory() as session:
                metrics_service = MetricsService(session)
                final_response = await metrics_service.get_final_response(current_run.id)
            yield _format_sse("final", final_response)
            return
        if current_run.status == "failed":
            yield _format_sse("error", {"message": current_run.error_message or "Run failed."})
            return
        if current_run.status == "cancelled":
            yield _format_sse("error", {"message": current_run.error_message or "Run cancelled."})
            return

        queue = await runner.subscribe(current_run.id)
        try:
            async with session_factory() as session:
                metrics_service = MetricsService(session)
                current_run = await metrics_service.get_agent_run(run_id) or current_run
            if current_run.status == "completed":
                async with session_factory() as session:
                    metrics_service = MetricsService(session)
                    final_response = await metrics_service.get_final_response(current_run.id)
                yield _format_sse("final", final_response)
                return
            if current_run.status == "failed":
                yield _format_sse("error", {"message": current_run.error_message or "Run failed."})
                return
            if current_run.status == "cancelled":
                yield _format_sse("error", {"message": current_run.error_message or "Run cancelled."})
                return
            while True:
                event_type, data = await queue.get()
                if event_type == "done":
                    break
                yield _format_sse(event_type, data)
        finally:
            await runner.unsubscribe(current_run.id, queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@api_router.post("/chat/stream/{run_id}/cancel", tags=["chat"])
async def cancel_chat_stream(run_id: str) -> dict[str, bool]:
    session_factory = get_session_factory()
    async with session_factory() as session:
        metrics_service = MetricsService(session)
        run = await metrics_service.get_agent_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="Run not found.")
        if run.status not in ("pending", "running"):
            return {"cancelled": False}
        await metrics_service.mark_run_cancelled(run_id)

    runner = get_background_runner()
    cancelled = await runner.cancel_run(run_id)
    return {"cancelled": cancelled}


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


@api_router.get("/conversations", response_model=ConversationSummaryListResponse, tags=["chat"])
async def conversations(
    limit: int = 50,
    db_session: AsyncSession = Depends(get_db_session),
) -> ConversationSummaryListResponse:
    metrics_service = MetricsService(db_session)
    return await metrics_service.list_conversations(limit=limit)


@api_router.get(
    "/conversations/{conversation_id}",
    response_model=ConversationDetailResponse,
    tags=["chat"],
)
async def conversation_detail(
    conversation_id: str,
    db_session: AsyncSession = Depends(get_db_session),
) -> ConversationDetailResponse:
    metrics_service = MetricsService(db_session)
    conversation = await metrics_service.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return conversation


def _format_sse(event: str, data: object) -> str:
    if hasattr(data, "model_dump"):
        payload = data.model_dump()
    else:
        payload = data
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=True, default=str)}\n\n"
