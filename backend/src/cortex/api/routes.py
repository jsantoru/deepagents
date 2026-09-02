import asyncio
import json
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from cortex.agent.service import AgentService
from cortex.api.deps import get_agent_service, get_extractor
from cortex.db import get_db, get_session_factory
from cortex.memory.extractor import EntityExtractor
from cortex.memory.graph import GraphStore
from cortex.models import Entity, GraphEvent, Message, Relation, Run, Session
from cortex.orchestrator import ChatOrchestrator
from cortex.schemas import (
    ChatRequest,
    EntityDetail,
    GraphEdge,
    GraphEventOut,
    GraphNode,
    GraphOut,
    MemoryStats,
    MessageOut,
    RunOut,
    SessionDetail,
    SessionSummary,
    TimelinePoint,
    TraceEvent,
)

router = APIRouter(prefix="/api")


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Chat (SSE)
# ---------------------------------------------------------------------------


@router.post("/chat/stream")
async def chat_stream(
    payload: ChatRequest,
    agent_service: AgentService = Depends(get_agent_service),
    extractor: EntityExtractor = Depends(get_extractor),
) -> StreamingResponse:
    queue: asyncio.Queue[TraceEvent | None] = asyncio.Queue()

    async def on_event(event: TraceEvent) -> None:
        await queue.put(event)

    async def worker() -> None:
        factory = get_session_factory()
        try:
            async with factory() as db:
                orchestrator = ChatOrchestrator(db, agent_service, extractor)
                await orchestrator.run_turn(payload, on_event)
        except Exception as exc:  # already surfaced as an error event when possible
            await queue.put(TraceEvent(id="error", type="error", title="Error", content=str(exc)))
        finally:
            await queue.put(None)

    async def event_stream():
        task = asyncio.create_task(worker())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield f"event: {event.type}\ndata: {json.dumps(event.model_dump(), default=str)}\n\n"
            yield "event: end\ndata: {}\n\n"
        finally:
            task.cancel()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


@router.get("/sessions", response_model=list[SessionSummary])
async def list_sessions(db: AsyncSession = Depends(get_db)) -> list[SessionSummary]:
    counts = {
        row[0]: row[1]
        for row in await db.execute(
            select(Message.session_id, func.count(Message.id)).group_by(Message.session_id)
        )
    }
    sessions = await db.scalars(select(Session).order_by(Session.updated_at.desc()))
    return [
        SessionSummary(
            id=s.id, title=s.title, created_at=s.created_at, updated_at=s.updated_at,
            message_count=counts.get(s.id, 0),
        )
        for s in sessions
    ]


@router.get("/sessions/{session_id}", response_model=SessionDetail)
async def get_session(session_id: str, db: AsyncSession = Depends(get_db)) -> SessionDetail:
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    messages = await db.scalars(
        select(Message).where(Message.session_id == session_id).order_by(Message.created_at)
    )
    runs = await db.scalars(
        select(Run).where(Run.session_id == session_id).order_by(Run.created_at)
    )
    return SessionDetail(
        id=session.id, title=session.title,
        created_at=session.created_at, updated_at=session.updated_at,
        messages=[
            MessageOut(id=m.id, role=m.role, content=m.content, run_id=m.run_id,
                       created_at=m.created_at)
            for m in messages
        ],
        runs=[_run_out(r) for r in runs],
    )


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str, db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    await db.delete(session)
    await db.commit()
    return {"status": "deleted"}


# ---------------------------------------------------------------------------
# Memory graph
# ---------------------------------------------------------------------------


@router.get("/memory/graph", response_model=GraphOut)
async def memory_graph(db: AsyncSession = Depends(get_db)) -> GraphOut:
    nodes, edges = await GraphStore(db).full_graph()
    degree: dict[str, int] = defaultdict(int)
    for e in edges:
        degree[e.source_id] += 1
        degree[e.target_id] += 1
    return GraphOut(
        nodes=[_node_out(n, degree.get(n.id, 0)) for n in nodes],
        edges=[_edge_out(e) for e in edges],
    )


@router.get("/memory/timeline", response_model=list[TimelinePoint])
async def memory_timeline(db: AsyncSession = Depends(get_db)) -> list[TimelinePoint]:
    runs = await db.scalars(select(Run).order_by(Run.created_at))
    points: list[TimelinePoint] = []
    total_entities = total_relations = 0
    for run in runs:
        total_entities += run.entities_added
        total_relations += run.relations_added
        points.append(TimelinePoint(
            run_id=run.id, session_id=run.session_id, created_at=run.created_at,
            entities_added=run.entities_added, relations_added=run.relations_added,
            total_entities=total_entities, total_relations=total_relations,
        ))
    return points


@router.get("/memory/events", response_model=list[GraphEventOut])
async def memory_events(limit: int = 100, db: AsyncSession = Depends(get_db)) -> list[GraphEventOut]:
    events = await db.scalars(
        select(GraphEvent).order_by(GraphEvent.created_at.desc()).limit(min(limit, 500))
    )
    return [
        GraphEventOut(id=e.id, kind=e.kind, label=e.label, session_id=e.session_id,
                      created_at=e.created_at)
        for e in events
    ]


@router.get("/memory/stats", response_model=MemoryStats)
async def memory_stats(db: AsyncSession = Depends(get_db)) -> MemoryStats:
    store = GraphStore(db)
    entities, relations, events = await store.counts()
    sessions = await db.scalar(select(func.count(Session.id))) or 0
    runs = await db.scalar(select(func.count(Run.id))) or 0
    top = list(await db.scalars(
        select(Entity).order_by(Entity.mention_count.desc()).limit(8)
    ))
    return MemoryStats(
        entities=entities, relations=relations, sessions=sessions, runs=runs, events=events,
        top_entities=[_node_out(n, 0) for n in top],
    )


@router.get("/memory/entities/{entity_id}", response_model=EntityDetail)
async def entity_detail(entity_id: str, db: AsyncSession = Depends(get_db)) -> EntityDetail:
    entity, neighbors, edges, events = await GraphStore(db).entity_with_neighborhood(entity_id)
    if entity is None:
        raise HTTPException(status_code=404, detail="Entity not found")
    degree = len(edges)
    return EntityDetail(
        node=_node_out(entity, degree),
        neighbors=[_node_out(n, 0) for n in neighbors],
        edges=[_edge_out(e) for e in edges],
        events=[
            GraphEventOut(id=e.id, kind=e.kind, label=e.label, session_id=e.session_id,
                          created_at=e.created_at)
            for e in events
        ],
    )


def _run_out(r: Run) -> RunOut:
    return RunOut(
        id=r.id, status=r.status, model=r.model, latency_ms=r.latency_ms,
        input_tokens=r.input_tokens, output_tokens=r.output_tokens,
        search_calls=r.search_calls, entities_added=r.entities_added,
        relations_added=r.relations_added, created_at=r.created_at,
    )


def _node_out(n, degree: int) -> GraphNode:
    return GraphNode(
        id=n.id, name=n.name, type=n.type, summary=n.summary,
        mention_count=n.mention_count, degree=degree,
        first_session_id=n.first_session_id, created_at=n.created_at, updated_at=n.updated_at,
    )


def _edge_out(e: Relation) -> GraphEdge:
    return GraphEdge(
        id=e.id, source=e.source_id, target=e.target_id, type=e.type,
        description=e.description, weight=e.weight, created_at=e.created_at,
    )
