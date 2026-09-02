from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ResearchMode = Literal["light", "standard"]


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    session_id: str | None = None
    research_mode: ResearchMode = "light"


class TraceEvent(BaseModel):
    """One event on the agent's live activity stream."""

    id: str
    type: str  # phase|note|note_delta|tool|tool_result|tool_error|recall|memory|final|error|meta
    title: str = ""
    content: str = ""
    metadata: dict[str, object] = Field(default_factory=dict)


class MessageOut(BaseModel):
    id: str
    role: str
    content: str
    run_id: str | None
    created_at: datetime


class RunOut(BaseModel):
    id: str
    status: str
    model: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    search_calls: int
    entities_added: int
    relations_added: int
    created_at: datetime


class SessionSummary(BaseModel):
    id: str
    title: str
    created_at: datetime
    updated_at: datetime
    message_count: int = 0


class SessionDetail(BaseModel):
    id: str
    title: str
    created_at: datetime
    updated_at: datetime
    messages: list[MessageOut]
    runs: list[RunOut]


class GraphNode(BaseModel):
    id: str
    name: str
    type: str
    summary: str
    mention_count: int
    degree: int = 0
    first_session_id: str | None
    created_at: datetime
    updated_at: datetime


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    type: str
    description: str
    weight: int
    created_at: datetime


class GraphOut(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class GraphEventOut(BaseModel):
    id: str
    kind: str
    label: str
    session_id: str | None
    created_at: datetime


class TimelinePoint(BaseModel):
    """Cumulative graph size after each run — memory growth over time."""

    run_id: str
    session_id: str
    created_at: datetime
    entities_added: int
    relations_added: int
    total_entities: int
    total_relations: int


class MemoryStats(BaseModel):
    entities: int
    relations: int
    sessions: int
    runs: int
    events: int
    top_entities: list[GraphNode]


class EntityDetail(BaseModel):
    node: GraphNode
    neighbors: list[GraphNode]
    edges: list[GraphEdge]
    events: list[GraphEventOut]
