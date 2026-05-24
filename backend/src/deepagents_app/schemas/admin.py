from pydantic import BaseModel

from deepagents_app.schemas.chat import (
    AgentRunStatus,
    ChatRunMetrics,
    ChatTraceEvent,
    ConversationAttachment,
)


class AdminOverviewResponse(BaseModel):
    conversation_count: int
    run_count: int
    total_tokens: int
    total_estimated_cost_usd: float
    average_latency_ms: float


class AdminRunSummary(BaseModel):
    run_id: str
    conversation_id: str
    answer_preview: str
    metrics: ChatRunMetrics
    created_at: str


class AdminRunListResponse(BaseModel):
    runs: list[AdminRunSummary]


class ConversationSummary(BaseModel):
    conversation_id: str
    title: str
    preview: str
    message_count: int
    last_message_at: str
    active_run: AgentRunStatus | None = None


class ConversationSummaryListResponse(BaseModel):
    conversations: list[ConversationSummary]


class ConversationMessage(BaseModel):
    id: str
    role: str
    content: str
    created_at: str
    metrics: ChatRunMetrics | None = None
    attachments: list[ConversationAttachment] = []
    trace: list[ChatTraceEvent] = []


class ConversationDetailResponse(BaseModel):
    conversation_id: str
    title: str
    messages: list[ConversationMessage]
    active_run: AgentRunStatus | None = None
