"""Full chat-turn pipeline: recall memory → run agent → persist → grow the graph."""

import time
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from cortex.agent.service import AgentService, OnEvent
from cortex.memory.extractor import EntityExtractor
from cortex.memory.graph import GraphStore, format_memory_context
from cortex.models import Message, Run, Session
from cortex.schemas import ChatRequest, TraceEvent


class ChatOrchestrator:
    def __init__(
        self, db: AsyncSession, agent_service: AgentService, extractor: EntityExtractor
    ) -> None:
        self.db = db
        self.agent_service = agent_service
        self.extractor = extractor
        self.graph = GraphStore(db)

    async def run_turn(self, payload: ChatRequest, on_event: OnEvent) -> None:
        session = await self._get_or_create_session(payload)
        run = Run(session_id=session.id, status="running")
        self.db.add(run)
        user_message = Message(session_id=session.id, role="user", content=payload.message)
        self.db.add(user_message)
        await self.db.flush()
        user_message.run_id = run.id
        await self.db.commit()

        await on_event(TraceEvent(
            id=run.id, type="meta", title="run",
            metadata={"run_id": run.id, "session_id": session.id, "title": session.title},
        ))
        started = time.monotonic()

        try:
            # 1. Recall relevant long-term memory.
            await on_event(_phase("recalling", "Recalling long-term memory"))
            recalled_entities, recalled_edges = await self.graph.recall(payload.message)
            memory_context = format_memory_context(recalled_entities, recalled_edges)
            if recalled_entities:
                await on_event(TraceEvent(
                    id=uuid4().hex, type="recall", title="Memory recall",
                    content=f"Recalled {len(recalled_entities)} entities from prior sessions.",
                    metadata={
                        "entities": [
                            {"id": e.id, "name": e.name, "type": e.type,
                             "mention_count": e.mention_count}
                            for e in recalled_entities
                        ],
                    },
                ))

            # 2. Run the deep agent over the whole conversation.
            await on_event(_phase("researching", "Researching"))
            history = await self._conversation_history(session.id)
            result = await self.agent_service.stream_chat(
                history, payload.research_mode, memory_context, on_event
            )

            await on_event(_phase("synthesizing", "Synthesizing answer"))
            assistant_message = Message(
                session_id=session.id, run_id=run.id, role="assistant", content=result.answer
            )
            self.db.add(assistant_message)
            run.status = "done"
            run.model = result.model_name
            run.latency_ms = int((time.monotonic() - started) * 1000)
            run.input_tokens = result.input_tokens
            run.output_tokens = result.output_tokens
            run.search_calls = result.search_calls
            session.updated_at = datetime.now(UTC)
            await self.db.commit()

            await on_event(TraceEvent(
                id=assistant_message.id, type="final", title="Answer", content=result.answer,
                metadata={
                    "run_id": run.id, "session_id": session.id,
                    "latency_ms": run.latency_ms, "search_calls": run.search_calls,
                    "input_tokens": run.input_tokens, "output_tokens": run.output_tokens,
                    "model": run.model,
                },
            ))

            # 3. Grow the knowledge graph from this exchange.
            await on_event(_phase("memorizing", "Updating knowledge graph"))
            entities, relations = await self.extractor.extract(payload.message, result.answer)
            delta = await self.graph.upsert(
                entities, relations, session_id=session.id, run_id=run.id
            )
            run.entities_added = len(delta.entities_added)
            run.relations_added = len(delta.relations_added)
            await self.db.commit()

            await on_event(TraceEvent(
                id=uuid4().hex, type="memory", title="Memory updated",
                content=(
                    f"+{len(delta.entities_added)} entities, "
                    f"+{len(delta.relations_added)} relations, "
                    f"{len(delta.entities_reinforced) + len(delta.relations_reinforced)} reinforced"
                ),
                metadata={
                    "added_entities": [
                        {"id": e.id, "name": e.name, "type": e.type}
                        for e in delta.entities_added
                    ],
                    "reinforced_entities": [
                        {"id": e.id, "name": e.name, "type": e.type,
                         "mention_count": e.mention_count}
                        for e in delta.entities_reinforced
                    ],
                    "added_relations": len(delta.relations_added),
                    "reinforced_relations": len(delta.relations_reinforced),
                },
            ))
            await on_event(_phase("done", "Done"))
        except Exception as exc:  # surface failures on the stream, keep the run recorded
            run.status = "error"
            run.latency_ms = int((time.monotonic() - started) * 1000)
            await self.db.commit()
            await on_event(TraceEvent(
                id=uuid4().hex, type="error", title="Run failed", content=str(exc)
            ))
            raise

    async def _get_or_create_session(self, payload: ChatRequest) -> Session:
        if payload.session_id:
            session = await self.db.get(Session, payload.session_id)
            if session is not None:
                return session
        title = payload.message.strip().replace("\n", " ")
        session = Session(title=title[:80] + ("…" if len(title) > 80 else ""))
        self.db.add(session)
        await self.db.flush()
        return session

    async def _conversation_history(self, session_id: str) -> list[dict[str, str]]:
        messages = await self.db.scalars(
            select(Message).where(Message.session_id == session_id).order_by(Message.created_at)
        )
        return [{"role": m.role, "content": m.content} for m in messages]


def _phase(phase: str, label: str) -> TraceEvent:
    return TraceEvent(
        id=uuid4().hex, type="phase", title=label, metadata={"phase": phase}
    )
