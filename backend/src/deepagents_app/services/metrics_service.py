from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from time import perf_counter

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from deepagents_app.core.pricing import estimate_cost_usd
from deepagents_app.models.chat import AgentRun, Conversation, Message
from deepagents_app.schemas.admin import (
    AdminOverviewResponse,
    AdminRunListResponse,
    AdminRunSummary,
)
from deepagents_app.schemas.chat import ChatRequest, ChatResponse, ChatRunMetrics, ChatTraceEvent
from deepagents_app.services.agent_service import AgentRunResult, AgentService


@dataclass(slots=True)
class PersistedChatArtifacts:
    conversation: Conversation
    run: AgentRun


class MetricsService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def run_chat(self, payload: ChatRequest, agent_service: AgentService) -> ChatResponse:
        conversation = await self._get_or_create_conversation(payload.conversation_id)
        self.session.add(Message(conversation_id=conversation.id, role="user", content=payload.message))

        started_at = perf_counter()
        agent_result = await agent_service.chat(payload)
        latency_ms = int((perf_counter() - started_at) * 1000)
        return await self._finalize_chat(conversation.id, agent_result, latency_ms)

    async def run_chat_stream(
        self,
        payload: ChatRequest,
        agent_service: AgentService,
        on_event: Callable[[ChatTraceEvent], Awaitable[None]],
    ) -> ChatResponse:
        conversation = await self._get_or_create_conversation(payload.conversation_id)
        self.session.add(Message(conversation_id=conversation.id, role="user", content=payload.message))

        started_at = perf_counter()
        agent_result = await agent_service.stream_chat(payload, on_event)
        latency_ms = int((perf_counter() - started_at) * 1000)
        return await self._finalize_chat(conversation.id, agent_result, latency_ms)

    async def _finalize_chat(
        self,
        conversation_id: str,
        agent_result: AgentRunResult,
        latency_ms: int,
    ) -> ChatResponse:
        run = await self._persist_run(conversation_id, agent_result, latency_ms)
        self.session.add(
            Message(
                conversation_id=conversation_id,
                run_id=run.id,
                role="assistant",
                content=agent_result.answer,
            )
        )
        await self.session.commit()
        return ChatResponse(
            conversation_id=conversation_id,
            run_id=run.id,
            answer=agent_result.answer,
            trace=agent_result.trace,
            metrics=self._to_metrics(run),
        )

    async def get_overview(self) -> AdminOverviewResponse:
        conversation_count = await self.session.scalar(select(func.count(Conversation.id))) or 0
        aggregates = await self.session.execute(
            select(
                func.count(AgentRun.id),
                func.coalesce(func.sum(AgentRun.total_tokens), 0),
                func.coalesce(func.sum(AgentRun.estimated_cost_usd), 0.0),
                func.coalesce(func.avg(AgentRun.latency_ms), 0.0),
            )
        )
        run_count, total_tokens, total_cost, average_latency = aggregates.one()

        return AdminOverviewResponse(
            conversation_count=int(conversation_count),
            run_count=int(run_count or 0),
            total_tokens=int(total_tokens or 0),
            total_estimated_cost_usd=round(float(total_cost or 0.0), 6),
            average_latency_ms=round(float(average_latency or 0.0), 2),
        )

    async def list_runs(self, limit: int = 20) -> AdminRunListResponse:
        query = (
            select(AgentRun, Message)
            .join(Message, Message.run_id == AgentRun.id)
            .where(Message.role == "assistant")
            .order_by(AgentRun.created_at.desc())
            .limit(limit)
        )
        rows = (await self.session.execute(query)).all()
        runs = [
            AdminRunSummary(
                run_id=run.id,
                conversation_id=run.conversation_id,
                answer_preview=message.content[:140],
                metrics=self._to_metrics(run),
                created_at=run.created_at.isoformat(),
            )
            for run, message in rows
        ]
        return AdminRunListResponse(runs=runs)

    async def _get_or_create_conversation(self, conversation_id: str | None) -> Conversation:
        if conversation_id:
            conversation = await self.session.get(Conversation, conversation_id)
            if conversation:
                return conversation

        conversation = Conversation()
        self.session.add(conversation)
        await self.session.flush()
        return conversation

    async def _persist_run(
        self,
        conversation_id: str,
        agent_result: AgentRunResult,
        latency_ms: int,
    ) -> AgentRun:
        run = AgentRun(
            conversation_id=conversation_id,
            model_name=agent_result.model_name,
            latency_ms=latency_ms,
            input_tokens=agent_result.input_tokens,
            output_tokens=agent_result.output_tokens,
            total_tokens=agent_result.total_tokens,
            estimated_cost_usd=estimate_cost_usd(
                model_name=agent_result.model_name,
                input_tokens=agent_result.input_tokens,
                output_tokens=agent_result.output_tokens,
            ),
            search_calls=agent_result.search_calls,
        )
        self.session.add(run)
        await self.session.flush()
        return run

    @staticmethod
    def _to_metrics(run: AgentRun) -> ChatRunMetrics:
        return ChatRunMetrics(
            model_name=run.model_name,
            latency_ms=run.latency_ms,
            input_tokens=run.input_tokens,
            output_tokens=run.output_tokens,
            total_tokens=run.total_tokens,
            estimated_cost_usd=round(run.estimated_cost_usd, 6),
            search_calls=run.search_calls,
        )
