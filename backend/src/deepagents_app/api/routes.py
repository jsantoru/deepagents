import asyncio
import contextlib
import json

from sqlalchemy.ext.asyncio import AsyncSession

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from deepagents_app.api.deps import get_agent_service, get_db_session
from deepagents_app.schemas.admin import (
    AdminOverviewResponse,
    AdminRunListResponse,
    ConversationDetailResponse,
    ConversationSummaryListResponse,
)
from deepagents_app.schemas.chat import ChatRequest, ChatResponse, ChatTraceEvent
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
    db_session: AsyncSession = Depends(get_db_session),
) -> StreamingResponse:
    metrics_service = MetricsService(db_session)

    async def event_generator():
        conversation = await metrics_service.prepare_chat(payload)
        conversation_messages = await metrics_service.build_conversation_messages(conversation.id)
        queue: asyncio.Queue[tuple[str, object | None]] = asyncio.Queue()

        async def on_event(event: ChatTraceEvent) -> None:
            await queue.put(("trace", event))

        async def run_agent() -> None:
            try:
                started_at = asyncio.get_running_loop().time()
                agent_result = await agent_service.stream_chat(
                    payload,
                    on_event,
                    conversation_messages=conversation_messages,
                )
                latency_ms = int((asyncio.get_running_loop().time() - started_at) * 1000)
                response = await metrics_service._finalize_chat(
                    conversation.id,
                    agent_result,
                    latency_ms,
                )
                await queue.put(("final", response))
            except Exception as exc:
                await queue.put(("error", {"message": str(exc)}))
            finally:
                await queue.put(("done", None))

        task = asyncio.create_task(run_agent())

        # Buffer assistant_delta / tool_delta events and flush at most every 150 ms.
        # This prevents one SSE round-trip per token and keeps React renders smooth.
        FLUSH_INTERVAL = 0.15
        delta_buffer: dict[str, tuple[ChatTraceEvent, str]] = {}  # id -> (template, content)

        def drain_buffer() -> list[str]:
            chunks: list[str] = []
            for _id, (template, content) in delta_buffer.items():
                if content:
                    chunks.append(_format_sse("trace", ChatTraceEvent(
                        id=template.id,
                        type=template.type,
                        title=template.title,
                        content=content,
                        metadata=template.metadata,
                    )))
            delta_buffer.clear()
            return chunks

        try:
            yield _format_sse("status", {"state": "started", "conversation_id": conversation.id})
            while True:
                try:
                    event_type, data = await asyncio.wait_for(
                        queue.get(), timeout=FLUSH_INTERVAL
                    )
                except asyncio.TimeoutError:
                    for chunk in drain_buffer():
                        yield chunk
                    continue

                if event_type == "done":
                    for chunk in drain_buffer():
                        yield chunk
                    break

                if event_type == "trace" and isinstance(data, ChatTraceEvent):
                    if data.type in ("assistant_delta", "tool_delta"):
                        if data.id in delta_buffer:
                            tmpl, existing = delta_buffer[data.id]
                            delta_buffer[data.id] = (tmpl, existing + data.content)
                        else:
                            delta_buffer[data.id] = (data, data.content)
                        continue
                    # Non-delta: flush buffer first to preserve event ordering
                    for chunk in drain_buffer():
                        yield chunk

                yield _format_sse(event_type, data)
        finally:
            if not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    return StreamingResponse(event_generator(), media_type="text/event-stream")


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
