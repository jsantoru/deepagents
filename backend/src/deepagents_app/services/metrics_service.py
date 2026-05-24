import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from time import perf_counter

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from deepagents_app.core.config import get_settings
from deepagents_app.core.pricing import estimate_cost_usd
from deepagents_app.models.chat import AgentRun, Conversation, Message, MessageAttachment, TraceEvent
from deepagents_app.schemas.admin import (
    AdminOverviewResponse,
    ConversationDetailResponse,
    ConversationMessage,
    ConversationSummary,
    ConversationSummaryListResponse,
    AdminRunListResponse,
    AdminRunSummary,
)
from deepagents_app.schemas.chat import (
    AgentRunStatus,
    ChatRequest,
    ChatResponse,
    ChatRunMetrics,
    ChatTraceEvent,
    ConversationAttachment,
)
from deepagents_app.services.agent_service import AgentRunResult, AgentService


@dataclass(slots=True)
class PersistedChatArtifacts:
    conversation: Conversation
    run: AgentRun


class MetricsService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def run_chat(self, payload: ChatRequest, agent_service: AgentService) -> ChatResponse:
        conversation = await self.prepare_chat(payload)
        conversation_messages = await self.build_conversation_messages(conversation.id)

        started_at = perf_counter()
        agent_result = await agent_service.chat(payload, conversation_messages=conversation_messages)
        latency_ms = int((perf_counter() - started_at) * 1000)
        return await self._finalize_chat(conversation.id, agent_result, latency_ms)

    async def run_chat_stream(
        self,
        payload: ChatRequest,
        agent_service: AgentService,
        on_event: Callable[[ChatTraceEvent], Awaitable[None]],
    ) -> ChatResponse:
        conversation = await self.prepare_chat(payload)
        conversation_messages = await self.build_conversation_messages(conversation.id)

        started_at = perf_counter()
        agent_result = await agent_service.stream_chat(
            payload,
            on_event,
            conversation_messages=conversation_messages,
        )
        latency_ms = int((perf_counter() - started_at) * 1000)
        return await self._finalize_chat(conversation.id, agent_result, latency_ms)

    async def prepare_chat(self, payload: ChatRequest) -> Conversation:
        conversation = await self._get_or_create_conversation(payload.conversation_id)
        user_message = Message(conversation_id=conversation.id, role="user", content=payload.message)
        self.session.add(user_message)
        await self.session.flush()

        for index, attachment in enumerate(payload.attachments):
            self.session.add(
                MessageAttachment(
                    conversation_id=conversation.id,
                    message_id=user_message.id,
                    name=attachment.name,
                    mime_type=attachment.mime_type,
                    size_bytes=attachment.size_bytes,
                    sha256=hashlib.sha256(attachment.text_content.encode("utf-8")).hexdigest(),
                    text_content=attachment.text_content,
                    order_index=index,
                )
            )

        await self.session.commit()
        return conversation

    async def create_pending_run(self, conversation_id: str) -> AgentRun:
        run = AgentRun(
            conversation_id=conversation_id,
            model_name=get_settings().agent_model,
            status="pending",
        )
        self.session.add(run)
        await self.session.commit()
        await self.session.refresh(run)
        return run

    async def build_conversation_messages(self, conversation_id: str) -> list[dict[str, str]]:
        messages = await self._load_conversation_messages(conversation_id)
        attachments_by_message_id = await self._load_attachments_by_message_id(
            [message.id for message in messages]
        )

        conversation_messages: list[dict[str, str]] = []
        for message in messages:
            if message.role == "user":
                content = self._format_user_message_for_agent(
                    message.content,
                    attachments_by_message_id.get(message.id, []),
                )
            else:
                content = message.content

            conversation_messages.append({"role": message.role, "content": content})

        return conversation_messages

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

    async def list_conversations(self, limit: int = 50) -> ConversationSummaryListResponse:
        conversations = (
            await self.session.execute(
                select(Conversation)
                .order_by(Conversation.created_at.desc())
                .limit(limit)
            )
        ).scalars().all()

        summaries: list[ConversationSummary] = []
        for conversation in conversations:
            messages = (
                await self.session.execute(
                    select(Message)
                    .where(Message.conversation_id == conversation.id)
                    .order_by(Message.created_at.asc())
                )
            ).scalars().all()
            if not messages:
                continue

            title = _derive_conversation_title(messages)
            preview = messages[-1].content[:140]
            summaries.append(
                ConversationSummary(
                    conversation_id=conversation.id,
                    title=title,
                    preview=preview,
                    message_count=len(messages),
                    last_message_at=messages[-1].created_at.isoformat(),
                    active_run=await self.get_active_run_status(conversation.id),
                )
            )

        summaries.sort(key=lambda item: item.last_message_at, reverse=True)
        return ConversationSummaryListResponse(conversations=summaries)

    async def get_conversation(self, conversation_id: str) -> ConversationDetailResponse | None:
        conversation = await self.session.get(Conversation, conversation_id)
        if conversation is None:
            return None

        messages = await self._load_conversation_messages(conversation_id)
        if not messages:
            return ConversationDetailResponse(
                conversation_id=conversation_id,
                title="Untitled conversation",
                messages=[],
            )

        run_ids = [message.run_id for message in messages if message.run_id]
        runs_by_id: dict[str, AgentRun] = {}
        if run_ids:
            runs = (
                await self.session.execute(select(AgentRun).where(AgentRun.id.in_(run_ids)))
            ).scalars().all()
            runs_by_id = {run.id: run for run in runs}

        attachments_by_message_id = await self._load_attachments_by_message_id(
            [message.id for message in messages]
        )

        return ConversationDetailResponse(
            conversation_id=conversation_id,
            title=_derive_conversation_title(messages),
            messages=[
                ConversationMessage(
                    id=message.id,
                    role=message.role,
                    content=message.content,
                    created_at=message.created_at.isoformat(),
                    metrics=self._to_metrics(runs_by_id[message.run_id])
                    if message.run_id and message.run_id in runs_by_id
                    else None,
                    attachments=[
                        ConversationAttachment(
                            id=attachment.id,
                            name=attachment.name,
                            mime_type=attachment.mime_type,
                            size_bytes=attachment.size_bytes,
                            sha256=attachment.sha256,
                            text_content=attachment.text_content,
                            created_at=attachment.created_at.isoformat(),
                        )
                        for attachment in attachments_by_message_id.get(message.id, [])
                    ],
                    trace=self._deserialize_trace(runs_by_id[message.run_id].trace_data)
                    if message.run_id and message.run_id in runs_by_id
                    else [],
                )
                for message in messages
            ],
            active_run=await self.get_active_run_status(conversation_id),
        )

    async def get_agent_run(self, run_id: str) -> AgentRun | None:
        return await self.session.get(AgentRun, run_id)

    async def get_active_run_status(self, conversation_id: str) -> AgentRunStatus | None:
        run = (
            await self.session.execute(
                select(AgentRun)
                .where(AgentRun.conversation_id == conversation_id)
                .where(AgentRun.status.in_(("pending", "running")))
                .order_by(AgentRun.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if run is None:
            return None
        return AgentRunStatus(
            run_id=run.id,
            conversation_id=run.conversation_id,
            status=run.status,
            error_message=run.error_message,
        )

    async def append_trace_event(self, run_id: str, event: ChatTraceEvent) -> ChatTraceEvent:
        current_max = await self.session.scalar(
            select(func.max(TraceEvent.sequence)).where(TraceEvent.run_id == run_id)
        )
        sequence = int(current_max or 0) + 1
        record = TraceEvent(
            event_id=event.id,
            run_id=run_id,
            sequence=sequence,
            event_type=event.type,
            title=event.title,
            content=event.content,
            metadata_json=json.dumps(event.metadata),
        )
        self.session.add(record)
        await self.session.commit()
        return ChatTraceEvent(
            id=event.id,
            sequence=sequence,
            type=event.type,
            title=event.title,
            content=event.content,
            metadata=event.metadata,
        )

    async def get_trace_events(
        self,
        run_id: str,
        after_sequence: int = 0,
    ) -> list[ChatTraceEvent]:
        events = (
            await self.session.execute(
                select(TraceEvent)
                .where(TraceEvent.run_id == run_id)
                .where(TraceEvent.sequence > after_sequence)
                .order_by(TraceEvent.sequence.asc())
            )
        ).scalars().all()
        return [
            ChatTraceEvent(
                id=event.event_id,
                sequence=event.sequence,
                type=event.event_type,
                title=event.title,
                content=event.content,
                metadata=self._deserialize_metadata(event.metadata_json),
            )
            for event in events
        ]

    async def mark_run_running(self, run_id: str) -> AgentRun:
        run = await self._require_run(run_id)
        run.status = "running"
        run.error_message = None
        await self.session.commit()
        return run

    async def mark_run_failed(self, run_id: str, error_message: str) -> AgentRun:
        run = await self._require_run(run_id)
        run.status = "failed"
        run.error_message = error_message
        run.completed_at = datetime.now(timezone.utc)
        await self.session.commit()
        return run

    async def mark_run_cancelled(self, run_id: str, error_message: str = "Run cancelled.") -> AgentRun:
        run = await self._require_run(run_id)
        run.status = "cancelled"
        run.error_message = error_message
        run.completed_at = datetime.now(timezone.utc)
        await self.session.commit()
        return run

    async def finalize_run(
        self,
        run_id: str,
        agent_result: AgentRunResult,
        latency_ms: int,
    ) -> ChatResponse:
        run = await self._require_run(run_id)
        existing_trace = await self.get_trace_events(run_id)
        existing_keys = {(event.id, event.type) for event in existing_trace}
        for event in agent_result.trace:
            if (event.id, event.type) in existing_keys:
                continue
            existing_trace.append(await self.append_trace_event(run_id, event))
            existing_keys.add((event.id, event.type))

        run.model_name = agent_result.model_name
        run.status = "completed"
        run.latency_ms = latency_ms
        run.input_tokens = agent_result.input_tokens
        run.output_tokens = agent_result.output_tokens
        run.total_tokens = agent_result.total_tokens
        run.estimated_cost_usd = estimate_cost_usd(
            model_name=agent_result.model_name,
            input_tokens=agent_result.input_tokens,
            output_tokens=agent_result.output_tokens,
        )
        run.search_calls = agent_result.search_calls
        trace = sorted(
            existing_trace,
            key=lambda event: (event.sequence or 0, event.type == "final"),
        )
        run.trace_data = json.dumps([event.model_dump() for event in trace])
        run.completed_at = datetime.now(timezone.utc)
        run.error_message = None
        self.session.add(
            Message(
                conversation_id=run.conversation_id,
                run_id=run.id,
                role="assistant",
                content=agent_result.answer,
            )
        )
        await self.session.commit()
        return ChatResponse(
            conversation_id=run.conversation_id,
            run_id=run.id,
            answer=agent_result.answer,
            trace=trace,
            metrics=self._to_metrics(run),
        )

    async def get_final_response(self, run_id: str) -> ChatResponse:
        run = await self._require_run(run_id)
        message = (
            await self.session.execute(
                select(Message)
                .where(Message.run_id == run_id)
                .where(Message.role == "assistant")
                .order_by(Message.created_at.desc())
                .limit(1)
            )
        ).scalar_one()
        trace = await self.get_trace_events(run_id)
        return ChatResponse(
            conversation_id=run.conversation_id,
            run_id=run.id,
            answer=message.content,
            trace=trace,
            metrics=self._to_metrics(run),
        )

    async def _get_or_create_conversation(self, conversation_id: str | None) -> Conversation:
        if conversation_id:
            conversation = await self.session.get(Conversation, conversation_id)
            if conversation:
                return conversation

        conversation = Conversation()
        self.session.add(conversation)
        await self.session.flush()
        return conversation

    async def _load_conversation_messages(self, conversation_id: str) -> list[Message]:
        return (
            await self.session.execute(
                select(Message)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.created_at.asc())
            )
        ).scalars().all()

    async def _load_attachments_by_message_id(
        self,
        message_ids: list[str],
    ) -> dict[str, list[MessageAttachment]]:
        attachments_by_message_id: dict[str, list[MessageAttachment]] = {}
        if not message_ids:
            return attachments_by_message_id

        attachments = (
            await self.session.execute(
                select(MessageAttachment)
                .where(MessageAttachment.message_id.in_(message_ids))
                .order_by(MessageAttachment.order_index.asc(), MessageAttachment.created_at.asc())
            )
        ).scalars().all()
        for attachment in attachments:
            attachments_by_message_id.setdefault(attachment.message_id, []).append(attachment)

        return attachments_by_message_id

    @staticmethod
    def _format_user_message_for_agent(
        content: str,
        attachments: list[MessageAttachment],
    ) -> str:
        if not attachments:
            return content

        sections = [f"User request:\n{content}", "", "Attached files:"]
        for attachment in attachments:
            sections.extend(
                [
                    f"--- FILE: {attachment.name} ({attachment.mime_type}) ---",
                    attachment.text_content,
                    "",
                ]
            )

        sections.extend(
            [
                "",
                "Instructions:",
                "Use the attached file contents as primary context for this request. "
                "When referring to attached material, cite the filename.",
            ]
        )
        return "\n".join(sections).strip()

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
            trace_data=json.dumps([event.model_dump() for event in agent_result.trace]),
        )
        self.session.add(run)
        await self.session.flush()
        return run

    async def _require_run(self, run_id: str) -> AgentRun:
        run = await self.session.get(AgentRun, run_id)
        if run is None:
            raise ValueError(f"Run {run_id} not found.")
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

    @staticmethod
    def _deserialize_trace(trace_data: str) -> list[ChatTraceEvent]:
        """Deserialize trace events from JSON string."""
        try:
            trace_list = json.loads(trace_data)
            return [ChatTraceEvent(**event) for event in trace_list]
        except (json.JSONDecodeError, TypeError, ValueError):
            return []

    @staticmethod
    def _deserialize_metadata(metadata_json: str) -> dict[str, str | int | float]:
        try:
            parsed = json.loads(metadata_json)
            if isinstance(parsed, dict):
                return {
                    str(key): value
                    for key, value in parsed.items()
                    if isinstance(value, (str, int, float))
                }
        except (json.JSONDecodeError, TypeError, ValueError):
            return {}
        return {}


def _derive_conversation_title(messages: list[Message]) -> str:
    first_user_message = next((message for message in messages if message.role == "user"), None)
    if first_user_message is None:
        return "Untitled conversation"

    title = " ".join(first_user_message.content.split())
    if len(title) <= 48:
        return title
    return f"{title[:45].rstrip()}..."
